// ========== 说文 · LingoClarify — Service Worker ==========
// 文件职责：右键菜单与消息分发、流式 API 代理、DeepSeek 思考参数、请求缓存和笔记下载。

const CACHE = new Map();
const CACHE_MAX = 100;
const MAX_STREAM_CHARS = 2048;
let cacheRevision = 0;

importScripts('model-catalog.js');
importScripts('config.js');
importScripts('selection.js');
importScripts('selection-prompts.js');

// ═══════════════════════════════════════════
// 右键菜单：安装/更新时创建（精简为两项）
// ═══════════════════════════════════════════

chrome.runtime.onInstalled.addListener(() => {
  // 先清除旧菜单再重建，避免扩展更新/浏览器升级时重复 create 同 id 报错
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'deepseek-explain',
      title: '📖 说文：解释选中文字',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'deepseek-fullpage',
      title: '🌐 说文：全文翻译',
      contexts: ['page']
    });
  });
});

// ═══════════════════════════════════════════
// 右键菜单点击分发
// ═══════════════════════════════════════════

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'deepseek-explain' && info.selectionText && tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'TRIGGER_EXPLAIN',
      text: info.selectionText.trim()
    }).catch(() => {});
  }
  if (info.menuItemId === 'deepseek-fullpage' && tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'TRIGGER_FULLPAGE_TRANSLATE'
    }).catch(() => {});
  }
});

// ═══════════════════════════════════════════
// 消息路由
// ═══════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REFRESH_MODEL_CATALOG') {
    refreshModelCatalog()
      .then(snapshot => sendResponse({ ok: true, snapshot }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === 'DOWNLOAD') {
    handleDownload(message.text, message.explanation)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: '下载失败，请重试' }));
    return true;
  }
  // 全文翻译注入
  if (message.type === 'INJECT_FULLPAGE_TRANSLATE') {
    injectFullPageTranslator(sender);
    return false;
  }
  if (message.type === 'LIST_MODELS') {
    listModels(message.connection)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  // 查询模型列表不代表已经完成一次生成请求。
  if (message.type === 'VALIDATE_MODEL') {
    validateModel(message.model, message.connection)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, error: err.message || '模型检测失败' }));
    return true; // 异步响应
  }
});

let catalogRefresh = null;
function refreshModelCatalog() {
  if (!catalogRefresh) catalogRefresh = (async () => {
    const stored = await chrome.storage.local.get('catalogSnapshot');
    // 公开目录不带用户 Key、地址或任何网页数据。
    const snapshot = await AIModelCatalog.refresh(stored.catalogSnapshot);
    await chrome.storage.local.set({ catalogSnapshot: snapshot });
    return snapshot;
  })().finally(() => { catalogRefresh = null; });
  return catalogRefresh;
}

// ═══════════════════════════════════════════
// 全文翻译脚本注入
// ═══════════════════════════════════════════

async function injectFullPageTranslator(sender) {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-fullpage.js']
    });
  } catch (err) {
    console.error('[AI] 全文翻译注入失败:', err);
  }
}

// ═══════════════════════════════════════════
// 流式连接入口：explain 和 translate 共用
// ═══════════════════════════════════════════

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('stream-')) return;

  port.onMessage.addListener((msg) => {
    if (msg.type === 'STREAM_REQUEST') {
      handleStreamRequest(port, msg);
    }
    // 全文翻译批量流式请求
    if (msg.type === 'STREAM_BATCH') {
      handleStreamRequest(port, {
        promptType: msg.promptType || 'translate',
        text: msg.text,
        context: msg.context,
        batchId: msg.batchId
      });
    }
    if (msg.type === 'STREAM_TRANSLATE_BATCH') {
      handleTranslateBatchRequest(port, msg);
    }
  });
});

// ═══════════════════════════════════════════
// 统一流式处理器
// ═══════════════════════════════════════════

async function handleStreamRequest(rawPort, request) {
  const controller = new AbortController();
  let closed = false;
  // Listen before configuration/storage awaits, including migration and cache reads.
  rawPort.onDisconnect.addListener(() => { closed = true; controller.abort(); });
  const port = {
    postMessage(message) {
      if (closed) return false;
      try { rawPort.postMessage(message); return true; }
      catch { closed = true; controller.abort(); return false; }
    },
    disconnect() {
      if (closed) return;
      closed = true;
      controller.abort();
      try { rawPort.disconnect(); } catch {}
    }
  };
  try {
    await performStreamRequest(port, request, controller);
  } catch (error) {
    if (!controller.signal.aborted) port.postMessage({ type: 'error', error: error.message || '请求失败', batchId: request.batchId });
  } finally { port.disconnect(); }
}

async function performStreamRequest(port, { promptType, text, context, batchId, mode, batchItems, analysis, explicitTask }, controller) {
  const config = await getConfig();
  controller.signal.throwIfAborted();
  if (config.enabled === false) {
    port.postMessage({ type: 'error', error: '扩展已禁用', batchId });
    port.disconnect();
    return;
  }

  let prompt, systemPrompt, model, thinkingEnabled, reasoningEffort;

  // 🆕 四分类模式（来自智能解释的本地分类）
  if (mode) {
    if (mode === 'B') {
      // 浮层翻译原意及文中含义 → 使用翻译标签的模型
      model = config.translateModel;
      thinkingEnabled = config.translateThinkingEnabled || false;
      reasoningEffort = config.translateReasoningEffort || 'high';
    } else {
      model = config.explainModel;
      thinkingEnabled = config.explainThinkingEnabled || false;
      reasoningEffort = config.explainReasoningEffort || 'high';
    }
    systemPrompt = SELECTION_SYSTEM_PROMPT;

    if (analysis && !batchItems) {
      prompt = buildSelectionPrompt(text, context, analysis, mode, config, explicitTask);
    } else if (mode === 'A') {
      prompt = buildTranslateExplainPrompt(text, context);
    } else if (mode === 'B') {
      prompt = buildPureTranslatePrompt(text, config.targetLanguage || 'zh', context);
    } else if (mode === 'C') {
      prompt = buildExplainPrompt(text, config.language, context);
    } else if (mode === 'D') {
      prompt = buildContextualInterpretPrompt(text, context);
    }
  } else if (promptType === 'explain') {
    // 兼容旧路径
    model = config.explainModel;
    thinkingEnabled = config.explainThinkingEnabled || false;
    reasoningEffort = config.explainReasoningEffort || 'high';
    systemPrompt = SELECTION_SYSTEM_PROMPT;
    prompt = buildExplainPrompt(text, config.language, context);
  } else {
    // translate (fullpage / pdf)
    model = config.translateModel;
    thinkingEnabled = config.translateThinkingEnabled || false;
    reasoningEffort = config.translateReasoningEffort || 'high';
    systemPrompt = '你是一个专业的翻译引擎。只输出译文，不要任何解释、说明。';
    prompt = buildTranslatePrompt(text, config.targetLanguage || 'zh', context);
  }

  if (batchItems) {
    prompt = buildBatchTranslatePrompt(batchItems, config.targetLanguage || 'zh', context);
    systemPrompt = '你是一个专业的翻译引擎。只输出规定格式的译文，不要任何解释、说明。';
  }

  const kind = mode ? (mode === 'B' ? 'translate' : 'explain') : (promptType === 'explain' ? 'explain' : 'translate');
  if (!model) {
    port.postMessage({ type: 'error', error: kind === 'translate'
      ? '请先在设置的「全文翻译」标签选择模型并保存设置'
      : '请先在设置的「解释」标签选择模型并保存设置', batchId });
    port.disconnect();
    return;
  }
  let baseUrl;
  let connection;
  try {
    connection = AIConfig.connectionFor(config, kind);
    baseUrl = AIConfig.normalizeBaseUrl(connection.apiBaseUrl);
  }
  catch (err) {
    port.postMessage({ type: 'error', error: err.message, batchId });
    port.disconnect();
    return;
  }
  const apiKey = connection.apiKey;
  if (!apiKey) {
    port.postMessage({ type: 'error', error: '请先填写所选厂家的 API Key', batchId });
    port.disconnect();
    return;
  }
  if ((connection.modelsCheckedAt || connection.availableModels.length) && !connection.availableModels.includes(model)) {
    port.postMessage({type:'error',error:'请重新选择当前厂家的可用模型',batchId});
    port.disconnect();
    return;
  }

  // 官方端点显式控制思考；第三方网关不凭模型名发送厂家专用参数。
  const deepSeek = AIConfig.isDeepSeekEndpoint(baseUrl);
  const deepSeekThinkingEnabled = deepSeek && config[kind + 'DeepSeekThinkingEnabled'] === true;
  if (deepSeek && !deepSeekThinkingEnabled) thinkingEnabled = false;

  // 缓存检查（键包含思考开关，避免开关切换后命中旧缓存）
  const cacheKey = JSON.stringify([cacheRevision, baseUrl, model, systemPrompt, prompt,
    deepSeekThinkingEnabled, thinkingEnabled, reasoningEffort]);
  const doneMessage = output => {
    if (!batchItems) return { type: 'done', model, batchId };
    const items = parseBatchTranslation(output, batchItems.map(item => item.id));
    if (!items) throw new Error('批量译文解析失败，将回退为逐块翻译');
    return { type: 'done', model, batchId, items };
  };
  const postChunk = (type, token) => {
    if (batchItems) return;
    for (let i = 0; i < token.length; i += MAX_STREAM_CHARS) {
      if (!port.postMessage({ type, token: token.slice(i, i + MAX_STREAM_CHARS), batchId })) return;
    }
  };
  if (CACHE.has(cacheKey)) {
    // 缓存也交给前端播放，不在后台人为延迟。
    const cached = CACHE.get(cacheKey);
    controller.signal.throwIfAborted();
    postChunk('token', cached);
    port.postMessage(doneMessage(cached));
    port.disconnect();
    return;
  }

  let timedOut = false;
  let timeout;
  const resetTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
  };
  resetTimeout();

  try {
    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      stream: true
    };
    // 默认使用最小公共参数，避免不同模型对 temperature / token 上限的差异。
    if (deepSeek) body.thinking = { type: deepSeekThinkingEnabled ? 'enabled' : 'disabled' };
    if (thinkingEnabled) body.reasoning_effort = reasoningEffort;
    const endpoint = `${baseUrl}/chat/completions`;

    const res = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      const errMsg = await parseApiError(res);
      port.postMessage({ type: 'error', error: errMsg, batchId });
      return;
    }

    if (!res.body) throw new Error('接口没有返回响应流');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', fullText = '', finished = false, sawFinish = false;
    let chunks = [];
    const enqueue = (type, token) => {
      const last = chunks[chunks.length - 1];
      if (last?.type === type) last.token += token;
      else chunks.push({ type, token });
    };
    const flush = () => {
      for (const { type, token } of chunks) postChunk(type, token);
      chunks = [];
    };
    function consume(line) {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data) return;
      if (data === '[DONE]') { finished = true; return; }
      let parsed;
      try { parsed = JSON.parse(data); }
      catch { throw new Error('接口返回了无效的流式 JSON'); }
      if (parsed.error) throw new Error(parsed.error.message || '接口流式响应报错');
      const choice = parsed?.choices?.[0];
      const reasoning = choice?.delta?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning) enqueue('reasoning-token', reasoning);
      const token = choice?.delta?.content;
      if (typeof token === 'string' && token) {
        fullText += token;
        enqueue('token', token);
      }
      if (choice?.finish_reason === 'length') throw new Error('模型输出达到长度上限，请缩短待翻译文本');
      if (choice?.finish_reason === 'content_filter') throw new Error('接口过滤了模型输出');
      if (choice?.finish_reason) sawFinish = true;
    }
    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        resetTimeout();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        try {
          for (const line of lines) { consume(line); if (finished) break; }
        } finally { flush(); }
      }
      if (!finished) {
        buffer += decoder.decode();
        try {
          for (const line of buffer.split('\n')) { consume(line); if (finished) break; }
        } finally { flush(); }
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (!fullText) throw new Error('模型没有返回文本，请确认该模型支持流式 Chat Completions');
    if (!finished && !sawFinish) throw new Error('响应流意外中断，请重试');
    const result = doneMessage(fullText);
    if (fullText.length > 10) {
      CACHE.set(cacheKey, fullText);
      if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
    }
    port.postMessage(result);
  } catch (err) {
    if (timedOut || err.name !== 'AbortError') {
      port.postMessage({ type: 'error', error: timedOut ? '接口响应超时，请检查网络或接口地址' : err.message, batchId });
    }
  } finally {
    clearTimeout(timeout);
    port.disconnect();
  }
}

// ═══════════════════════════════════════════
// Prompt 构建
// ═══════════════════════════════════════════

const SELECTION_SYSTEM_PROMPT = AISelectionPrompts.SYSTEM;

function buildSelectionPrompt(text, context, analysis, mode, config, explicitTask) {
  return AISelectionPrompts.build(text, context, analysis, mode, config, explicitTask);
}

function buildExplainPrompt(text, language, context) {
  return buildSelectionPrompt(text, context, AISelection.analyze(text), 'C', { language });
}

function buildTranslatePrompt(text, targetLanguage, context) {
  const langNames = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español', pt: 'Português', ru: 'Русский', ar: 'العربية' };
  const targetName = langNames[targetLanguage] || targetLanguage;

  let contextBlock = '';
  if (context && (context.before || context.after)) {
    contextBlock = `\n[上下文]\n标题：${context.title || '未知'}\n上文：${context.before || ''}\n下文：${context.after || ''}\n`;
  }

  return `你是一个专业的翻译引擎。请将以下文本翻译为${targetName}。
${contextBlock}
[待翻译文本]
"""
${text}
"""

规则：
- 只输出翻译结果，不要任何解释、说明、开场白
- 翻译要准确、自然、符合目标语言习惯
- 结合上下文理解多义词和指代，确保翻译准确
- 保持原文的语气和风格（正式/非正式、技术/日常）
- 如果文本中包含专有名词、数字、代码等，保持原样
- 不要使用任何 Markdown 格式`;
}

// 🆕 模式 A：外语短词 → 先翻译成中文，再解释
function buildTranslateExplainPrompt(text, context) {
  return buildSelectionPrompt(text, context, AISelection.analyze(text), 'A', { language: 'zh' });
}

// 模式 B：外语句段 → 浮层原意译文和文中含义（旧消息兼容入口）
function buildPureTranslatePrompt(text, targetLanguage, context) {
  return buildSelectionPrompt(text, context, AISelection.analyze(text), 'B', { targetLanguage });
}

// 🆕 模式 D：中文长段 → 语境解读
function buildContextualInterpretPrompt(text, context) {
  return buildSelectionPrompt(text, context, AISelection.analyze(text), 'D', { language: 'zh' }, 'interpret');
}

// ═══════════════════════════════════════════
// 配置读取
// ═══════════════════════════════════════════

// 会话级配置缓存：避免全文翻译高并发时每个请求都读 storage
let configCache = null;
let configLoad = null;
let configRevision = 0;
const GENERATION_FIELDS = new Set(['enabled', 'usePageContext', 'triggerMode',
  'language', 'targetLanguage', 'explainModel', 'translateModel',
  'explainManufacturer', 'translateManufacturer', 'explainThinkingEnabled',
  'translateThinkingEnabled', 'explainReasoningEffort', 'translateReasoningEffort',
  'explainDeepSeekThinkingEnabled', 'translateDeepSeekThinkingEnabled',
  'apiBaseUrl', 'apiKey', 'availableModels', 'modelList', 'modelManufacturers',
  'apiConfigVersion', 'providerConfigVersion', 'modelCatalogVersion',
  'qwenApiKey', 'customModels', 'model', 'thinkingEnabled', 'reasoningEffort']);
function generationConnections(value) {
  return Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const entry = value || {}, models = AIConfig.normalizeModels(entry.availableModels).sort();
      return [id, entry.apiBaseUrl, entry.apiKey, models, Boolean(entry.modelsCheckedAt || models.length)];
    });
}
function affectsGeneration(changes) {
  return Object.keys(changes).length === 0 || Object.entries(changes).some(([key, change]) => {
    if (key === 'providerConnections') {
      return JSON.stringify(generationConnections(change.oldValue)) !==
        JSON.stringify(generationConnections(change.newValue));
    }
    return GENERATION_FIELDS.has(key) && JSON.stringify(change.oldValue) !== JSON.stringify(change.newValue);
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // 每次保存都防止陈旧配置读回；仅生成语义变化使回答缓存失效。
  configCache = null; configLoad = null; configRevision++;
  if (affectsGeneration(changes)) { cacheRevision++; CACHE.clear(); }
});
async function getConfig() {
  while (!configCache) {
    const revision = configRevision;
    if (!configLoad) configLoad = AIConfig.load({ isCurrent: () => revision === configRevision });
    const pending = configLoad;
    let config;
    try { config = await pending; }
    catch (error) {
      if (revision !== configRevision) continue;
      if (configLoad === pending) configLoad = null;
      throw error;
    }
    // An old storage read must never repopulate a cache invalidated while awaiting it.
    if (revision !== configRevision) continue;
    if (!config) { if (configLoad === pending) configLoad = null; continue; }
    configCache = config;
    if (configLoad === pending) configLoad = null;
  }
  return configCache;
}

// ═══════════════════════════════════════════
// API 错误解析
// ═══════════════════════════════════════════

// 批量协议复用通用生成路径，厂家路由、Key、超时、SSE 校验与缓存保持一致。
function buildBatchTranslatePrompt(items, targetLanguage, context) {
  const langNames = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español', pt: 'Português', ru: 'Русский', ar: 'العربية' };
  const blocks = items.map(item => `<<<DS_ITEM_${item.id}>>>\n${item.text}\n<<<DS_END_${item.id}>>>`).join('\n\n');
  return `你是一个专业的翻译引擎，请将下面每个标记块中的文本翻译为${langNames[targetLanguage] || targetLanguage}。
${context?.title ? `网页标题：${context.title}\n\n` : ''}${blocks}

输出要求：
- 只输出翻译后的标记块，保持 <<<DS_ITEM_xxx>>> 和 <<<DS_END_xxx>>> 标记原样
- 标记中的 xxx 是 id，必须与输入完全一致
- 不要合并、遗漏、新增任何标记块
- 不要输出解释、说明、Markdown 代码块
- 保留原文段落结构和换行`;
}

function parseBatchTranslation(raw, expectedIds) {
  const map = new Map();
  const re = /<<<DS_ITEM_([A-Za-z0-9_]+)>>>([\s\S]*?)<<<DS_END_\1>>>/g;
  for (const match of String(raw || '').matchAll(re)) {
    if (map.has(match[1]) || !expectedIds.includes(match[1])) return null;
    map.set(match[1], match[2].trim());
  }
  if (expectedIds.some(id => !map.get(id))) return null;
  return expectedIds.map(id => ({ id, text: map.get(id) }));
}

async function handleTranslateBatchRequest(port, { items, context, batchId }) {
  if (!Array.isArray(items) || !items.length || items.length > 8 ||
      items.some(item => !item || typeof item.id !== 'string' || !/^[A-Za-z0-9_]+$/.test(item.id) ||
        typeof item.text !== 'string' || !item.text.trim()) ||
      new Set(items.map(item => item.id)).size !== items.length) {
    try { port.postMessage({ type: 'error', error: '批量翻译内容或标记无效', batchId }); } catch {}
    try { port.disconnect(); } catch {}
    return;
  }
  await handleStreamRequest(port, { promptType: 'translate', text: '', context, batchId, batchItems: items });
}

// 保留 main 的生成退避重试，取消/超时信号在等待期间也立即生效。
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    let response;
    try {
      response = await fetch(url, options);
      if ((response.status !== 429 && response.status < 500) || attempt >= maxRetries) return response;
    } catch (error) {
      if (options.signal?.aborted || error.name === 'AbortError' || attempt >= maxRetries) throw error;
    }
    const retryAfter = Number(response?.headers.get('Retry-After') || 0);
    await response?.body?.cancel().catch(() => {});
    const delay = retryAfter > 0 ? Math.min(8000, retryAfter * 1000) : Math.min(8000, 500 * 2 ** attempt);
    await new Promise((resolve, reject) => {
      const signal = options.signal;
      const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(finish, delay);
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}

async function parseApiError(res) {
  try {
    const body = await res.text();
    if (res.status === 401) return 'API Key 无效，请检查设置';
    if (res.status === 402) return '账户余额不足，请充值';
    if (res.status === 403) return 'API Key 无权访问，请检查';
    if (res.status === 429) return '请求过于频繁，请稍后再试';
    if (res.status === 400) return '请求参数或模型不受支持，请检查模型名；若开启思考，请尝试关闭';
    if (res.status === 404) return '接口路径或模型不存在，请检查 Base URL 和模型名';
    return `API 错误 (${res.status}): ${body.slice(0, 100)}`;
  } catch {
    return `API 错误 (${res.status})`;
  }
}

// ═══════════════════════════════════════════
// 模型可用性检测
// ═══════════════════════════════════════════

async function listModels(connection) {
  const config = connection || AIConfig.connectionFor(await getConfig());
  return AIModelCatalog.fetchInterface(config);
}

async function validateModel(inputModel, connection) {
  const model = AIConfig.normalizeModel(inputModel);
  if (!model || /\s/.test(model)) return { ok: false, error: '请输入不含空格的模型调用名' };
  const result = await listModels(connection);
  if (!result.ok) return result;
  if (!result.models.includes(model)) return { ok: false, error: `接口模型列表中未找到：${model}` };
  return { ok: true, model: { id: model } };
}

// ═══════════════════════════════════════════
// 下载
// ═══════════════════════════════════════════

async function handleDownload(selectedText, explanation) {
  if (typeof selectedText !== 'string' || typeof explanation !== 'string' || !explanation.trim()) {
    return { ok: false, error: '没有可下载的内容' };
  }
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const filename = `笔记/说文_${timestamp}.txt`;

  const content = [
    `说文 · LingoClarify`,
    `生成时间: ${now.toLocaleString('zh-CN')}`,
    ``,
    `── 选中原文 ──`,
    selectedText,
    ``,
    `── 解释内容 ──`,
    explanation,
    ``,
  ].join('\n');

  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const dataUrl = 'data:text/plain;charset=utf-8;base64,' + btoa(binary);

  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: filename,
    saveAs: false
  });
  return Number.isInteger(downloadId) ? { ok: true, downloadId } : { ok: false, error: '下载未启动' };
}
