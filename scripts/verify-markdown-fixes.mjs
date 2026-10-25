// Actual Edge extension + synthetic local SSE. --ref <commit> --expect-vulnerable
// reproduces the review baseline without changing the user's checkout.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const vulnerable = process.argv.includes('--expect-vulnerable');
const ref = process.argv.includes('--ref') ? arg('--ref') : null;
assert.ok(!vulnerable || ref, 'Use an explicit --ref for vulnerable controls');
const { chromium } = createRequire(import.meta.url)(process.argv.includes('--playwright') ? arg('--playwright') : 'playwright');
const output = resolve(root, 'artifacts/qa/markdown-fix-2026-10-11', vulnerable ? 'baseline' : 'fixed', process.argv.includes('--filter') ? 'focused' : '.');
const profile = resolve(root, '.local/browser-profile/markdown-fixes', `run-${Date.now()}`);
mkdirSync(output, { recursive: true }); mkdirSync(profile, { recursive: true });
let extension = root;
if (ref) {
  const commit = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  extension = resolve(root, '.local/tmp/markdown-fix-baseline', commit);
  for (const path of execFileSync('git', ['ls-tree', '-rz', '--name-only', commit], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)) {
    const target = resolve(extension, path); assert.ok(target.startsWith(extension + '\\') || target.startsWith(extension + '/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, maxBuffer: 10 * 1024 * 1024 }));
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const long = '## Structured answer\n\n' + Array.from({ length: 35 }, (_, i) => `Paragraph ${i} gives enough detail to render a scrollable answer.\n\n`).join('');
let fixture = { chunks: [long], delay: 30 }, context, worker, page, version, sequence = 0;
const checks = [], requests = [], errors = [];
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/sample/')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Markdown fix QA</title><style>body{margin:0;font-family:Arial;height:2200px}#word{position:absolute;top:300px;left:40px;margin:0}#outside{position:absolute;top:0}#last{position:absolute;top:1100px}</style><button id="outside">Outside</button><p id="word">The bank offers loans.</p><p id="last">Another visible paragraph.</p>'); return;
  }
  if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const request = JSON.parse(raw); requests.push(request);
  if (req.headers.authorization !== 'Bearer fix-synthetic-only') { res.writeHead(401); res.end('{}'); return; }
  const active = fixture;
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  const send = delta => res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  if (request.model === 'qa-translate') {
    const ids = [...request.messages[1].content.matchAll(/<<<DS_ITEM_([A-Za-z0-9_]+)>>>/g)].map(m => m[1]);
    send({ content: ids.length ? ids.map(id => `<<<DS_ITEM_${id}>>>合成译文<<<DS_END_${id}>>>`).join('\n') : '合成译文' });
  } else {
    if (active.reasoning) send({ reasoning_content: active.reasoning });
    for (const chunk of active.chunks) { if (res.destroyed) return; send({ content: chunk }); await sleep(active.delay); }
  }
  if (!res.destroyed) res.end('data: [DONE]\n\n');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const tabId = () => worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, page.url());
async function op(name, args = null) {
  return worker.evaluate(async ({ id, name, args }) => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: id }, func: async (name, args) => {
      if (name === 'ready') return typeof AIMarkdown !== 'undefined' && typeof triggerWithStream === 'function';
      if (name === 'render') { AIMarkdown.render(document.querySelector('.ds-body'), args); return true; }
      if (name === 'anchor') return { saved: tooltipAnchor, original: getSelectionDocCoords(currentSelection.range) };
      if (name === 'fallback') {
        getSelection().removeAllRanges(); lastContextMenuPos = { x: innerWidth - 3 + scrollX, y: innerHeight - 3 + scrollY };
        await triggerWithStream({ text: 'saved word', snapshot: { text: 'saved word', range: null, analysis: AISelection.analyze('saved word'), context: null } }); return true;
      }
      if (name === 'instrument') {
        const original = document.createTreeWalker.bind(document);
        globalThis.qaTraversal = { tooltipNodes: 0, tooltipCalls: 0 };
        document.createTreeWalker = (root, ...args) => {
          const walker = original(root, ...args), next = walker.nextNode.bind(walker);
          const inside = root.id === 'deepseek-explain-tooltip' || root.closest?.('#deepseek-explain-tooltip');
          if (inside) qaTraversal.tooltipCalls++;
          walker.nextNode = () => { const node = next(); if (node && inside) qaTraversal.tooltipNodes++; return node; };
          return walker;
        }; return true;
      }
      if (name === 'observer-render') {
        Object.keys(qaTraversal).forEach(k => qaTraversal[k] = 0);
        const body = getTooltip().querySelector('.ds-body');
        const source = Array.from({ length: 2000 }, (_, i) => `- synthetic row ${i} **bold**`).join('\n');
        for (let i = 0; i < 5; i++) { AIMarkdown.render(body, source + '\n' + i); await new Promise(r => setTimeout(r, 60)); }
        return { ...qaTraversal };
      }
      if (name === 'unanswered') {
        globalThis.qaOriginalSend = safeSendMessage;
        safeSendMessage = msg => msg.type === 'DOWNLOAD' ? Promise.resolve(undefined) : qaOriginalSend(msg); return true;
      }
      if (name === 'restore-send') { safeSendMessage = qaOriginalSend; return true; }
    }, args: [name, args] }); return result.result;
  }, { id: await tabId(), name, args });
}
async function fresh(next, viewport = { width: 1000, height: 900 }) {
  fixture = next; await worker.evaluate(() => CACHE.clear()); if (page) await page.close();
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize(viewport); await page.goto(`${base}/sample/${sequence++}`); assert.equal(await op('ready'), true);
}
async function select() {
  await page.evaluate(() => {
    const node = document.querySelector('#word').firstChild, range = document.createRange();
    range.setStart(node, 4); range.setEnd(node, 8); getSelection().removeAllRanges(); getSelection().addRange(range);
    node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  });
}
const done = () => page.waitForFunction(() => document.querySelector('#deepseek-explain-tooltip.ds-visible .ds-actions')?.style.display === 'flex', null, { timeout: 15000 });
async function rects() {
  return page.evaluate(() => {
    const tip = document.querySelector('#deepseek-explain-tooltip'), action = tip.querySelector('.ds-actions');
    const r = tip.getBoundingClientRect(), a = action.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, actionsTop: a.top, actionsBottom: a.bottom, viewport: innerHeight, width: innerWidth };
  });
}
const fits = r => r.top >= 9 && r.bottom <= r.viewport - 9 && r.left >= 9 && r.right <= r.width - 9 && r.actionsBottom <= r.viewport - 9;
async function check(name, fn) {
  if (process.argv.includes('--filter') && !name.includes(arg('--filter'))) return;
  try { const evidence = await fn(); checks.push({ name, status: 'passed', evidence }); console.log('PASSED: ' + name); }
  catch (error) { checks.push({ name, status: 'failed', error: error.message }); throw error; }
}
const label = () => page.locator('.ds-btn-download .ds-btn-label').textContent();
async function storageSet(values) { await worker.evaluate(async values => chrome.storage.local.set(values), values); await sleep(100); }
async function seedCache() { await worker.evaluate(() => { CACHE.clear(); CACHE.set('qa-probe', 'synthetic'); }); }
const cachePresent = () => worker.evaluate(() => CACHE.has('qa-probe'));
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run'], ignoreDefaultArgs: ['--disable-extensions'] });
  version = context.browser().version(); worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(async base => {
    await chrome.storage.local.clear(); await chrome.storage.local.set(AIConfig.migrate({ apiConfigVersion: 1, modelCatalogVersion: 1, providerConfigVersion: 1,
      enabled: true, triggerMode: 'auto', usePageContext: true, language: 'zh', targetLanguage: 'zh', explainManufacturer: 'custom', translateManufacturer: 'custom',
      explainModel: 'qa-explain', translateModel: 'qa-translate', modelList: ['qa-explain', 'qa-translate'], providerConnections: { custom: {
        apiBaseUrl: base + '/v1', apiKey: 'fix-synthetic-only', availableModels: ['qa-explain', 'qa-translate'], modelEntries: [], modelsCheckedAt: '2026-10-10' } } }));
  }, base);
  await check('Growing answer stays in viewport with visible actions', async () => {
    await fresh({ chunks: [long], delay: 30 }, { width: 1000, height: 600 }); await select(); await done(); await sleep(120);
    const r = await rects(); assert.equal(fits(r), !vulnerable); await page.screenshot({ path: resolve(output, 'growth.png') }); return r;
  });
  await check('Original anchor survives selecting result text and scrolling', async () => {
    await fresh({ chunks: [long], delay: 30 }); await select(); await done(); await sleep(120);
    await page.evaluate(() => { const n = document.querySelector('.ds-body p').firstChild, r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 11); getSelection().removeAllRanges(); getSelection().addRange(r); });
    const before = await rects(), beforeAnchor = await op('anchor');
    await page.evaluate(() => scrollTo(0, 100)); await sleep(150);
    const after = await rects(), afterAnchor = await op('anchor');
    // 视口空间改变可合法切换选区右侧/下方；锚点必须仍是原文 Range。
    if (vulnerable) assert.equal(Math.abs(after.top - (before.top - 100)) < 2, false);
    else { assert.deepEqual(afterAnchor, beforeAnchor); assert.equal(fits(after), true); }
    return { before, after, beforeAnchor, afterAnchor };
  });
  const reading = '## Reading\n\n```js\n' + 'identifier'.repeat(100) + '\n```\n\n| First | Second |\n| --- | --- |\n| ' + 'wide'.repeat(80) + ' | Other |\n\n[Reference](https://example.com/docs)';
  for (const selector of ['pre', '.ds-md-table', 'a[href]']) await check(`Keyboard focus survives Markdown replacement: ${selector}`, async () => {
    await fresh({ chunks: [reading, '\n\nPhase two.', '\n\nPhase three.'], delay: 700 }); await select();
    if (!vulnerable) await done(); // 流式阶段持续重排 Markdown，完成后再固定焦点。
    const target = page.locator('.ds-body ' + selector); await target.waitFor(); await target.focus();
    const focused = () => target.evaluate(el => el === document.activeElement);
    assert.equal(await focused(), true);
    if (vulnerable) await page.waitForFunction(() => document.querySelector('.ds-body').textContent.includes('Phase two.'));
    else await op('render', reading + '\n\nPhase two.');
    const incremental = await focused();
    if (vulnerable) await done();
    else await op('render', reading + '\n\nPhase two.\n\nPhase three.');
    const final = await focused();
    assert.equal(incremental, !vulnerable); assert.equal(final, !vulnerable); return { incremental, final };
  });
  await check('First complete answer starts at top', async () => {
    await fresh({ chunks: [long], delay: 30 }); await select(); await done();
    const top = await page.locator('.ds-body').evaluate(el => el.scrollTop); assert.equal(top === 0, !vulnerable); return { scrollTop: top };
  });
  await check('Hidden card leaves keyboard tab sequence and restores on reopen', async () => {
    await page.keyboard.press('Escape'); await page.locator('#outside').focus(); await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => document.querySelector('#deepseek-explain-tooltip').contains(document.activeElement)); assert.equal(inside, vulnerable);
    await select(); await done(); await page.locator('.ds-close').focus(); assert.equal(await page.locator('.ds-close').evaluate(el => el === document.activeElement), true);
    return { hiddenFocused: inside, reopenedCloseFocusable: true };
  });
  await check('Download rejection reports failure', async () => {
    await worker.evaluate(() => { globalThis.qaDownload = chrome.downloads.download; chrome.downloads.download = () => Promise.reject(Error('Synthetic download failure')); });
    await page.locator('.ds-btn-download').click(); await sleep(150); const text = await label();
    assert.equal(text.includes('失败'), !vulnerable); await worker.evaluate(() => { chrome.downloads.download = qaDownload; }); return { label: text, injected: 'downloads.download rejection' };
  });
  if (!vulnerable) {
    await check('No response reports failure and leaves retry enabled', async () => {
      await op('unanswered'); await page.locator('.ds-btn-download').click(); await page.waitForFunction(() => document.querySelector('.ds-btn-download .ds-btn-label').textContent.includes('失败'));
      assert.equal(await page.locator('.ds-btn-download').isEnabled(), true); await op('restore-send'); return { injected: 'undefined DOWNLOAD message response' };
    });
    await check('Pending download does not claim success; retry acknowledges initiation', async () => {
      await worker.evaluate(() => { chrome.downloads.download = () => new Promise(r => { globalThis.qaResolveDownload = r; }); });
      await page.locator('.ds-btn-download').click(); await sleep(100); assert.equal(await label(), '下载中…'); assert.equal(await page.locator('.ds-btn-download').isEnabled(), false);
      await worker.evaluate(() => qaResolveDownload(42)); await page.waitForFunction(() => document.querySelector('.ds-btn-download .ds-btn-label').textContent === '已开始下载');
      await worker.evaluate(() => { chrome.downloads.download = qaDownload; }); return { pending: '下载中…', accepted: '已开始下载', injected: 'delayed synthetic download ID' };
    });
    await check('Late download response cannot overwrite a new result', async () => {
      await worker.evaluate(() => { chrome.downloads.download = () => new Promise(r => { globalThis.qaResolveDownload = r; }); });
      await page.locator('.ds-btn-download').click(); await sleep(100); await page.keyboard.press('Escape'); await select(); await done();
      await worker.evaluate(() => qaResolveDownload(43)); await sleep(100); assert.equal(await label(), '下载');
      await worker.evaluate(() => { chrome.downloads.download = qaDownload; }); return { label: await label() };
    });
    await check('Resize and compact viewport retain actions with reasoning', async () => {
      await fresh({ chunks: [long], delay: 30, reasoning: '思考说明。'.repeat(300) }); await select(); await done(); await sleep(100);
      const layouts = [];
      for (const viewport of [{ width: 1000, height: 600 }, { width: 320, height: 360 }, { width: 320, height: 240 }]) {
        await page.setViewportSize(viewport); await sleep(150); const r = await rects(); assert.equal(fits(r), true, JSON.stringify({ viewport, rects: r })); layouts.push(r);
      }
      await page.screenshot({ path: resolve(output, 'compact.png') }); return layouts;
    });
    await check('Collapsed right-click fallback stays within lower-right viewport', async () => {
      await fresh({ chunks: [long], delay: 30 }, { width: 600, height: 400 }); await op('fallback'); await done(); await sleep(150); const r = await rects(); assert.ok(fits(r), JSON.stringify(r)); return r;
    });
  }
  await check('Full-page observer skips new tooltip subtrees before TreeWalker', async () => {
    await fresh({ chunks: ['## Short\n\nAnswer.'], delay: 30 }); await select(); await done(); await op('instrument');
    await worker.evaluate(async id => chrome.scripting.executeScript({ target: { tabId: id }, files: ['content-fullpage.js'] }), await tabId());
    await page.waitForFunction(() => document.querySelector('.ds-tb-status')?.textContent === '翻译完成'); await sleep(100);
    const before = requests.length, traversal = await op('observer-render'); assert.equal(traversal.tooltipNodes > 0, vulnerable); assert.equal(requests.length, before);
    await page.locator('#ds-tb-cancel').click(); await sleep(100); const control = await op('observer-render'); assert.equal(control.tooltipNodes, 0);
    return { traversal, control, extraRequests: requests.length - before };
  });
  await check('Catalog display metadata preserves answer cache', async () => {
    await seedCache(); await storageSet({ catalogLastCheckedAt: new Date().toISOString(), catalogSnapshot: { updatedAt: new Date().toISOString(), models: [] } });
    assert.equal(await cachePresent(), !vulnerable); return { cachePresent: await cachePresent() };
  });
  await check('Model names and refresh timestamps preserve answer cache', async () => {
    const connections = await worker.evaluate(async () => (await chrome.storage.local.get('providerConnections')).providerConnections);
    connections.custom.modelsCheckedAt = new Date().toISOString(); connections.custom.modelEntries = [{ id: 'qa-explain', name: 'Updated display name' }];
    connections.custom.availableModels.reverse(); await seedCache(); await storageSet({ providerConnections: connections }); assert.equal(await cachePresent(), !vulnerable);
    return { cachePresent: await cachePresent() };
  });
  await check('Same answer after display refresh replays cache without a generation POST', async () => {
    await fresh({ chunks: ['## Cached answer\n\nComplete explanation.'], delay: 30 }); await select(); await done();
    const before = requests.length;
    await storageSet({ catalogLastCheckedAt: '2026-10-11T23:00:00.000Z' });
    await page.keyboard.press('Escape'); await select(); await done();
    assert.equal(requests.length - before, vulnerable ? 1 : 0);
    assert.ok((await page.locator('.ds-body').textContent()).includes('Complete explanation.'));
    return { extraGenerationRequests: requests.length - before };
  });
  if (!vulnerable) {
    for (const [key, value] of [['targetLanguage', 'ja'], ['explainModel', 'qa-translate'], ['explainThinkingEnabled', true], ['explainManufacturer', 'openai']]) {
      await check(`Generation field invalidates cache: ${key}`, async () => { await seedCache(); await storageSet({ [key]: value }); assert.equal(await cachePresent(), false); return { cachePresent: false }; });
    }
    for (const key of ['apiKey', 'apiBaseUrl', 'availableModels']) await check(`Connection generation change invalidates cache: ${key}`, async () => {
      const c = await worker.evaluate(async () => (await chrome.storage.local.get('providerConnections')).providerConnections);
      c.custom[key] = key === 'apiKey' ? 'another-synthetic-only' : key === 'apiBaseUrl' ? base + '/other/v1' : ['qa-translate'];
      await seedCache(); await storageSet({ providerConnections: c }); assert.equal(await cachePresent(), false); return { cachePresent: false };
    });
  }
  await check('No page JavaScript errors', async () => { assert.deepEqual(errors, []); return { errors }; });
} finally {
  if (context) await context.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
  writeFileSync(resolve(output, 'report.json'), JSON.stringify({ date: new Date().toISOString(), timezone: 'Asia/Shanghai',
    baseline: ref, expected: vulnerable ? 'known defects reproduced' : 'fixed behavior', node: process.version, browser: version,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workingTree: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim(),
    profile: relative(root, profile), profileClosed: true, checks, requestCount: requests.length,
    boundary: 'Actual isolated Edge extension; synthetic pages/Key/SSE, explicit download fault injection. No real supplier quality or credentials tested.' }, null, 2) + '\n');
}
