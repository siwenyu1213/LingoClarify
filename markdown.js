// 文件职责：本地 Markdown 安全排版、流式增量排版、rAF 文本播放与阅读位置保持。
// Loaded in the isolated content-script world.
(() => {
  const parser = new marked.Marked({ gfm: true, breaks: true });
  const escape = value => String(value).replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  parser.use({ renderer: {
    // Model HTML is displayed as text, never interpreted as webpage code.
    html({ text }) { return escape(text); },
    image({ text }) { return escape(text || '图片'); }
  } });
  const tags = ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em',
    'del', 's', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'];
  const MAX_CHARS_PER_FRAME = 2048;
  const MAX_TEXT_NODE_CHARS = 8192;
  // 正文流式播放：网络chunk进入蓄水池，按恒定速度逐帧释放；
  // 已完成块只排版一次，当前尾部用纯文本游标追加，再定期补排版。
  const STREAM_COMMIT_MS = 100;
  const STREAM_FORMAT_MS = 100;
  const STREAM_PRE_ROLL_MS = 120;
  const STREAM_TARGET_BUFFER_MS = 250;
  const STREAM_RATE_WINDOW_MS = 800;
  const STREAM_MIN_STEADY_RATE = 0.09; // 有蓄水时约90字/秒
  const STREAM_MIN_STARVED_RATE = 0.02; // 蓄水将空时约20字/秒
  const STREAM_MAX_RATE = 0.6; // 稳态上限约600字/秒，避免突发整块倒出
  const STREAM_FINAL_MAX_RATE = 2.5;
  const STREAM_FRAME_CAP = 60;
  const STREAM_BUDGET_MAX = 2;
  const STREAM_FINAL_RATE_FACTOR = 1.2;
  const STREAM_FINAL_SNAP = 12000;

  function buildFragment(source) {
    try {
      const fragment = DOMPurify.sanitize(parser.parse(String(source || '')), {
        ALLOWED_TAGS: tags,
        ALLOWED_ATTR: ['href', 'title', 'start', 'type', 'checked', 'disabled', 'align'],
        ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true
      });
      for (const link of fragment.querySelectorAll('a')) {
        const href = link.getAttribute('href') || '';
        // Relative/model-invented URLs must not resolve against the user's private page.
        if (!/^https?:\/\//i.test(href)) link.removeAttribute('href');
        else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      }
      for (const input of fragment.querySelectorAll('input')) {
        input.type = 'checkbox'; input.disabled = true;
      }
      for (const table of fragment.querySelectorAll('table')) {
        const wrapper = document.createElement('div');
        wrapper.className = 'ds-md-table'; wrapper.tabIndex = 0;
        wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', '表格，可横向滚动');
        table.replaceWith(wrapper); wrapper.append(table);
      }
      for (const pre of fragment.querySelectorAll('pre')) {
        pre.tabIndex = 0; pre.setAttribute('aria-label', '代码块，可横向滚动');
      }
      return fragment;
    } catch {
      return null;
    }
  }

  function render(container, source, { followBottom = true } = {}) {
    const top = container.scrollTop;
    const atBottom = followBottom && container.hasChildNodes() &&
      container.scrollHeight - container.clientHeight - top <= 24;
    container.classList.remove('ds-text-playback');
    const horizontal = [...container.querySelectorAll('pre, .ds-md-table')].map(el => el.scrollLeft);
    const focusable = [...container.querySelectorAll('pre, .ds-md-table, a[href]')];
    const focused = focusable.find(el => el === document.activeElement);
    const focus = focused ? {
      tag: focused.tagName, table: focused.classList.contains('ds-md-table'),
      href: focused.getAttribute('href'), text: focused.textContent.slice(0, 128),
      index: focusable.filter(el => el.tagName === focused.tagName &&
        el.getAttribute('href') === focused.getAttribute('href') &&
        el.textContent.startsWith(focused.textContent.slice(0, 128))).indexOf(focused)
    } : null;
    const fragment = buildFragment(source);
    if (fragment) {
      container.replaceChildren(fragment);
      [...container.querySelectorAll('pre, .ds-md-table')].forEach((el, index) => {
        el.scrollLeft = horizontal[index] || 0;
      });
      if (focus) {
        const candidates = [...container.querySelectorAll('pre, .ds-md-table, a[href]')]
          .filter(el => el.tagName === focus.tag && el.classList.contains('ds-md-table') === focus.table &&
            el.getAttribute('href') === focus.href && el.textContent.startsWith(focus.text));
        const target = candidates[focus.index] || candidates[0];
        target?.focus({ preventScroll: true });
      }
    } else {
      // A parser failure must still leave the model response readable and inert.
      container.textContent = String(source || '');
    }
    container.scrollTop = atBottom ? container.scrollHeight : top;
  }

  function createStreamingTextRenderer(container) {
    let textNode = document.createTextNode('');
    container.replaceChildren(textNode);
    container.scrollTop = 0;
    let pending = '', displayed = '', rafId = 0, stopped = false, idleCallback = null;
    const notifyIdle = () => {
      if (stopped || pending || !idleCallback) return;
      const callback = idleCallback;
      idleCallback = null;
      callback();
    };
    const schedule = () => {
      if (!stopped && !rafId && pending) rafId = requestAnimationFrame(step);
    };
    function step() {
      rafId = 0;
      if (stopped) return;
      if (!pending) { notifyIdle(); return; }
      // 限制单个 TextNode 的长度，避免超长段落每帧重排同一个巨型文本节点。
      if (textNode.length >= MAX_TEXT_NODE_CHARS) {
        textNode = document.createTextNode('');
        container.appendChild(textNode);
      }
      const adaptive = Math.max(1, Math.ceil(pending.length / 12));
      let take = Math.min(pending.length, MAX_CHARS_PER_FRAME, adaptive);
      // 尽量不在一帧末尾切开代理对（emoji 等）。
      if (take < pending.length && /[\uD800-\uDBFF]/.test(pending[take - 1])) {
        take = take === 1 ? 2 : take - 1;
      }
      textNode.appendData(pending.slice(0, take));
      displayed += pending.slice(0, take);
      pending = pending.slice(take);
      schedule();
      notifyIdle();
    }
    return {
      push(chunk) {
        if (stopped || !chunk) return;
        pending += chunk;
        schedule();
      },
      setFinal(text) {
        if (stopped) return;
        const final = String(text || '');
        // 正常 done 不清空、不重播；只有最终文本改变已显示前缀时才重新排队。
        if (final.startsWith(displayed)) pending = final.slice(displayed.length);
        else {
          textNode = document.createTextNode('');
          container.replaceChildren(textNode);
          displayed = ''; pending = final;
        }
        schedule();
        notifyIdle();
      },
      onIdle(callback) {
        if (stopped) return;
        idleCallback = callback;
        notifyIdle();
      },
      cancel() {
        stopped = true;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0; pending = ''; displayed = ''; idleCallback = null;
      }
    };
  }

  // 流式中途的尾部常常只有半个 **、` 或 ~~；为显示补上闭合标记，
  // 避免把原始 Markdown 符号暴露给用户。最终渲染始终使用完整原文。
  function closePartialMarkers(source) {
    // 未闭合的围栏代码交给 marked 自然渲染成代码块，不再补标记。
    if ((source.match(/^\s*```/gm) || []).length % 2) return source;
    // 已闭合的代码块/行内代码里的符号不算正文标记。
    const prose = source.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    let text = source;
    if (((prose.match(/\*\*/g) || []).length) % 2) text += '**';
    if (((prose.match(/~~/g) || []).length) % 2) text += '~~';
    if (((prose.match(/`/g) || []).length) % 2) text += '`';
    return text;
  }

  // 逐帧追加的纯文本游标：先把 Markdown 控制符藏掉，等下一次排版
  // 再把同一段文字替换成带格式的 DOM。代码块内保持原样。
  function cursorText(raw, code) {
    if (code) return raw;
    return raw
      // 单个字符也藏起来：Markdown 标记经常被 chunk 边界拆成两半。
      .replace(/[*_~`|]+/g, '')
      .replace(/(^|\n)[ \t]*\|?[ \t:|-]+\|?[ \t]*(?=\n|$)/g, '$1')
      .replace(/(^|\n) {0,3}(?:#{1,6}|[-*>])(?:[ \t]|$)/g, '$1')
      .replace(/\n/g, ' ');
  }

  function createStreamingRenderer(container) {
    container.classList.add('ds-markdown');
    container.classList.remove('ds-text-playback');
    container.replaceChildren();
    container.scrollTop = 0;

    // 已完成块只排版一次；正在生成的尾部用纯文本逐帧追加。
    const stableEl = document.createElement('div');
    stableEl.className = 'ds-stream-stable';
    stableEl.style.display = 'contents';
    const tailEl = document.createElement('div');
    tailEl.className = 'ds-stream-tail';
    tailEl.style.display = 'contents';
    container.append(stableEl, tailEl);

    let received = '', revealed = 0, committed = 0;
    let stopped = false, completed = false, frameId = 0, lastFrame = 0;
    let lastCommitCheck = 0, lastTailFormat = 0;
    let arrivalSamples = [], arrivalRate = 0;
    let velocity = 0, budget = 0, streamStartAt = 0;
    let finalText = null, finalCallback = null;

    const preserveScroll = fn => {
      const top = container.scrollTop;
      fn();
      container.scrollTop = top;
    };

    // 只提交“最后一个非空白块之前”的内容：当前段落/列表/表格/代码块
    // 即使已有换行，也可能继续增长，必须留在尾部。
    function stableLengthInTail() {
      const tail = received.slice(committed, revealed);
      if (!tail) return 0;
      let tokens;
      try { tokens = parser.lexer(tail); } catch { return 0; }
      let last = tokens.length - 1;
      while (last >= 0 && tokens[last].type === 'space') last--;
      if (last <= 0) return 0;
      let length = 0;
      for (let i = 0; i < last; i++) length += tokens[i].raw.length;
      return length;
    }

    function commitStable(now) {
      if (now - lastCommitCheck < STREAM_COMMIT_MS) return false;
      lastCommitCheck = now;
      const extra = stableLengthInTail();
      if (!extra) return false;
      const fragment = buildFragment(received.slice(committed, committed + extra));
      if (!fragment) return false;
      preserveScroll(() => stableEl.append(fragment));
      committed += extra;
      return true;
    }

    // 定期把纯文本尾部替换成完整 Markdown 排版；两次排版之间
    // 文字仍逐帧追加，因此视觉上是连续的。
    function formatTail(now, force = false) {
      if (!force && now - lastTailFormat < STREAM_FORMAT_MS) return;
      lastTailFormat = now;
      const tail = received.slice(committed, revealed);
      preserveScroll(() => {
        if (!tail) { tailEl.replaceChildren(); return; }
        const fragment = buildFragment(closePartialMarkers(tail));
        if (fragment) tailEl.replaceChildren(fragment);
        else tailEl.textContent = tail;
      });
    }

    function updateArrival(now) {
      while (arrivalSamples.length > 1 && now - arrivalSamples[0].t > STREAM_RATE_WINDOW_MS) {
        arrivalSamples.shift();
      }
      if (arrivalSamples.length >= 2) {
        const first = arrivalSamples[0];
        const last = arrivalSamples[arrivalSamples.length - 1];
        const dt = last.t - first.t;
        if (dt > 0) arrivalRate = Math.max(0, (last.end - first.end) / dt);
      }
    }

    function appendTarget() {
      const last = tailEl.lastElementChild;
      if (!last) return null;
      if (last.matches('.ds-md-table')) return last.querySelector('td:last-child, th:last-child') || last;
      if (last.matches('ul, ol')) return last.querySelector('li:last-child') || last;
      if (last.matches('blockquote')) return last.querySelector('p:last-child') || last;
      if (last.matches('pre')) return last.querySelector('code') || last;
      if (last.matches('p, li, h1, h2, h3, h4, h5, h6, td, th')) return last;
      return null;
    }

    function appendTailText(raw) {
      if (!raw) return;
      let target = appendTarget();
      if (!target) {
        const p = document.createElement('p');
        preserveScroll(() => tailEl.append(p));
        target = p;
      }
      const text = cursorText(raw, !!target.closest('pre'));
      if (!text) return;
      const node = document.createTextNode(text);
      preserveScroll(() => target.append(node));
    }

    function finishFinal() {
      if (completed) return;
      completed = true;
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
      const callback = finalCallback;
      finalCallback = null;
      // 完整原文最后排版一次，保证引用链接、表格和焦点等最终态一致。
      render(container, finalText, { followBottom: false });
      requestAnimationFrame(() => { if (!stopped) callback?.(); });
    }

    function frame(now) {
      frameId = 0;
      if (stopped || completed) return;
      const elapsed = lastFrame ? Math.max(1, now - lastFrame) : 16;
      const stepDt = Math.min(20, elapsed);
      lastFrame = now;

      // 先攒一小段再开始，第一波不会刚吐两个字就断流。
      if (finalText == null && received.length < 24 && now - streamStartAt < STREAM_PRE_ROLL_MS) {
        frameId = requestAnimationFrame(frame);
        return;
      }

      updateArrival(now);
      const buffer = received.length - revealed;
      const targetBuffer = Math.max(20, arrivalRate * STREAM_TARGET_BUFFER_MS);

      let desired;
      if (finalText != null) {
        desired = Math.max(velocity, arrivalRate, STREAM_MIN_STARVED_RATE) * STREAM_FINAL_RATE_FACTOR;
        desired = Math.min(desired, STREAM_FINAL_MAX_RATE);
      } else if (buffer < targetBuffer * 0.5) {
        // 蓄水将空时跟着到达速度（略慢），不要把最后几个字一口气吐完。
        desired = Math.max(arrivalRate * 0.95, STREAM_MIN_STARVED_RATE);
      } else {
        desired = Math.max(arrivalRate * 1.05, STREAM_MIN_STEADY_RATE);
        if (buffer > targetBuffer * 1.5) desired += (buffer - targetBuffer) / 900;
        desired = Math.min(desired, STREAM_MAX_RATE);
      }

      // 速度本身也做平滑，避免一个突发chunk把这一帧的速度拉高。
      velocity = velocity ? velocity * 0.86 + desired * 0.14 : desired;

      if (buffer > 0) {
        budget = Math.min(budget + velocity * stepDt, STREAM_FRAME_CAP + STREAM_BUDGET_MAX);
        let take = Math.floor(budget);
        if (take > STREAM_FRAME_CAP) take = STREAM_FRAME_CAP;
        take = Math.min(take, buffer);
        if (take > 0) {
          const previous = revealed;
          revealed += take;
          budget = Math.max(0, budget - take);
          appendTailText(received.slice(previous, revealed));
        }
      } else {
        budget = Math.min(budget, 1);
      }

      // 提交后必须同帧重画尾部，否则旧尾部会和已提交块短暂重复。
      if (commitStable(now)) formatTail(now, true);
      else formatTail(now);

      if (finalText != null && revealed >= received.length) { finishFinal(); return; }
      frameId = requestAnimationFrame(frame);
    }

    return {
      push(chunk) {
        if (stopped || completed || finalText != null || !chunk) return;
        const now = performance.now();
        if (!streamStartAt) streamStartAt = now;
        received += chunk;
        arrivalSamples.push({ t: now, end: received.length });
        if (!frameId) frameId = requestAnimationFrame(frame);
      },
      setFinal(text, onComplete) {
        if (stopped || completed || finalText != null) return;
        const next = String(text || '');
        if (next.startsWith(received)) received = next;
        else {
          received = next; revealed = 0; committed = 0;
          arrivalSamples = []; arrivalRate = 0; velocity = 0; budget = 0;
          stableEl.replaceChildren(); tailEl.replaceChildren();
        }
        finalText = next;
        finalCallback = onComplete;
        if (!streamStartAt) streamStartAt = performance.now();
        if (revealed >= received.length) { finishFinal(); return; }
        if (received.length - revealed > STREAM_FINAL_SNAP) {
          revealed = received.length;
          finishFinal();
          return;
        }
        if (!frameId) frameId = requestAnimationFrame(frame);
      },
      cancel() {
        stopped = true;
        if (frameId) cancelAnimationFrame(frameId);
        frameId = 0;
      }
    };
  }
  globalThis.AIMarkdown = Object.freeze({ render, createStreamingRenderer, createStreamingTextRenderer });
})();
