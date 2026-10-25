// 可选 Edge 验收工具。使用外部已有 Playwright，不给扩展添加 npm 依赖。
// node scripts/verify-browser.mjs --playwright <已有包目录> [--edge <msedge.exe>] [--compare-ref <Git 提交>]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv.includes('--playwright') ? arg('--playwright') : 'playwright');
const evidence = resolve(root, 'artifacts/qa');
mkdirSync(evidence, { recursive: true });
const profileRoot=resolve(root,'.local/browser-profile/api-qa');
const profile=resolve(profileRoot,`run-${Date.now()}`);
assert.equal(dirname(profile),profileRoot);assert.equal(existsSync(profile),false);
const compareRef=process.argv.includes('--compare-ref') ? arg('--compare-ref') : null;
const oldPopupCss=compareRef ? execFileSync('git',['show',`${compareRef}:popup.css`],{cwd:root,encoding:'utf8'}) : null;
const profileCleanup={path:relative(root,profile),removed:false};
const checks = [], requests = [], providerRequests = [], errors = [];
let browserVersion, context, liveCatalog, liveDeepSeekProbe;
let batchFixtureMode='normal',batchFixtureDelay=0;
const server = createServer(async (req, res) => {
  if (req.url === '/sample') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><head><title>Extension QA fixture</title></head><body><h1>Browser acceptance fixture</h1><p id="word">ubiquitous</p><p id="paragraph">This is a longer English paragraph used to verify full page translation and preserve original text.</p><p id="inline-fixture">Inline text <span>with a <a href="#fixture">preserved link</a></span><img alt="fixture" src="data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA="><script type="application/json">{"fixture":"preserve"}</script></p></body></html>');
    return;
  }
  let payload = ''; for await (const chunk of req) payload += chunk;
  const authenticated = req.headers.authorization === 'Bearer local-qa-only';
  const body=payload ? JSON.parse(payload) : null;
  const batchItems=[...(body?.messages?.[1]?.content || '').split('\n输出要求：')[0].matchAll(/<<<DS_ITEM_([A-Za-z0-9_]+)>>>([\s\S]*?)<<<DS_END_\1>>>/g)]
    .map(match=>({id:match[1],text:match[2].trim()}));
  requests.push({ path: req.url, method: req.method, authenticated,batchIds:batchItems.map(item=>item.id),
    model: payload ? JSON.parse(payload).model : undefined,
    parameters: payload ? Object.keys(JSON.parse(payload)) : [] });
  if (!authenticated) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"invalid test key"}}'); return; }
  if (req.url.endsWith('/models')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'mock-chat' }, { id: 'gateway/model-large' }, { id: 'mock-chat' }] }));
    return;
  }
  if (req.url.endsWith('/chat/completions')) {
    const mode=batchFixtureMode,delay=batchFixtureDelay;
    if(batchItems.length && delay) await new Promise(resolve=>setTimeout(resolve,delay));
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const output=batchItems.length && mode!=='invalid' ? [...batchItems].reverse().map(item=>
      `<<<DS_ITEM_${item.id}>>>这是本机模拟接口的流式翻译结果。${item.text}<<<DS_END_${item.id}>>>`).join('\n') : null;
    for (const token of output ? [output.slice(0,20),output.slice(20)] : ['这是', '本机模拟接口的', '流式翻译结果。']) {
      res.write(`data:${JSON.stringify({ choices: [{ delta: { content: token } }] })}\r\n\r\n`);
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    res.end('data: [DONE]'); return;
  }
  res.writeHead(404); res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function check(name, fn) {
  try { await fn(); checks.push({ name, status: 'passed' }); console.log('PASSED: ' + name); }
  catch (err) { checks.push({ name, status: 'failed', error: err.message }); throw err; }
}
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(process.argv.includes('--edge') ? { executablePath: arg('--edge') } : { channel: 'msedge' }),
    headless: true, viewport: { width: 900, height: 1200 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-first-run'],
    ignoreDefaultArgs: ['--disable-extensions']
  });
  browserVersion = context.browser()?.version();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;
  await check('实际 Edge Worker 可访问 DeepSeek 官方模型接口：不带凭据返回 401',async()=>{
    liveDeepSeekProbe=await worker.evaluate(async()=>{
      const url='https://api.deepseek.com/models';
      const response=await fetch(url,{signal:AbortSignal.timeout(20000),cache:'no-store'});
      return {url,status:response.status,authenticated:false};
    });
    assert.equal(liveDeepSeekProbe.status,401);
  });
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 1200 });
  popup.on('pageerror', err => errors.push(err.message));
  // Seed only synthetic legacy keys to exercise actual extension storage migration.
  await worker.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ apiKey: 'legacy-test-only', qwenApiKey: 'legacy-test-only',
      explainModel: 'deepseek-flash', translateModel: 'qwen3.7-flash',
      modelList: ['deepseek-flash', 'qwen3.7-flash', 'retained/custom'], targetLanguage: 'zh', enabled:true, usePageContext:false, triggerMode:'auto' });
  });
  await worker.evaluate(() => {
    globalThis.qaNativeFetch=globalThis.fetch;
    globalThis.qaFactoryRequests=[];
    globalThis.qaFactoryModels={
      openai:[{id:'gpt-4.1-mini'},{id:'gpt-4.1'},{id:'text-embedding-3-small'},{id:'gpt-image-1'}],
      deepseek:[{id:'deepseek-flash',name:'DeepSeek V4.1 Flash',input_modalities:['text','image'],output_modalities:['text']},
        {id:'deepseek-v4-pro',name:'DeepSeek V4 Pro'},{id:'gpt-4.1'},{id:'deepseek-embedding'}],
      google:[{id:'gemini-3.8-flash',name:'Gemini Flash'},{id:'gemini-3.8-pro',name:'Gemini Pro'},{id:'gemini-embedding'}]
    };
    globalThis.fetch=(url,options={})=>{
      if (url===AIModelCatalog.SOURCE) {
        if(globalThis.qaCatalogFail) return Promise.resolve(new Response('{}',{status:503}));
        return qaNativeFetch(url,options);
      }
      if (url.startsWith('http://127.0.0.1:')) return qaNativeFetch(url,options);
      const provider=Object.entries(AIConfig.PROVIDER_ENDPOINTS).find(([,base])=>url.startsWith(base+'/'))?.[0];
      if(!provider) throw new Error('Unexpected QA URL');
      const authenticated=options.headers.Authorization==='Bearer qa-'+provider || options.headers.Authorization==='Bearer qa-'+provider+'-new';
      qaFactoryRequests.push({url,provider,method:options.method||'GET',authenticated,
        model:options.body ? JSON.parse(options.body).model : undefined});
      if(!authenticated) return Promise.resolve(new Response('{}',{status:401}));
      if(url.endsWith('/models')) {
        if(globalThis.qaProviderFail===provider) return Promise.resolve(new Response('{}',{status:503}));
        const data=structuredClone(qaFactoryModels[provider]||[]);
        if(provider==='deepseek' && globalThis.qaDelayDeepSeek) return new Promise(resolve=> {
          globalThis.qaReleaseModels=()=>resolve(Response.json({data}));
        });
        return Promise.resolve(Response.json({data}));
      }
      return Promise.resolve(new Response('data: {"choices":[{"delta":{"content":"浏览器内模拟厂家流式输出，验证独立路由与 Key。"}}]}\n\ndata: [DONE]\n',
        {headers:{'Content-Type':'text/event-stream'}}));
    };
  });
  await popup.goto('chrome-extension://'+extensionId+'/popup.html');
  await popup.locator('#explain-manufacturer option').first().waitFor({state:'attached'});
  const settle=()=>popup.waitForFunction(()=>!catalogRefreshing && providerRequests.size===0,null,{timeout:25000});
  const compareAppearance=async state=>{
    if(!oldPopupCss) return;
    await check(`优化前后 ${state} 所有元素计算样式/布局一致`,async()=>{
      const snapshots=await popup.evaluate(css=>{
        const snapshot=()=>[...document.querySelectorAll('.container,.container *')].map(el=>{
          const style=getComputedStyle(el),rect=el.getBoundingClientRect();
          return {tag:el.tagName,id:el.id,className:el.className,
            rect:[rect.x,rect.y,rect.width,rect.height],
            style:Object.fromEntries([...style].map(key=>[key,style.getPropertyValue(key)]))};
        });
        const current=snapshot(),link=document.querySelector('link[rel="stylesheet"]');
        const baseline=document.createElement('style');baseline.textContent=css;
        document.head.append(baseline);link.disabled=true;
        const original=snapshot();baseline.remove();link.disabled=false;
        return {current,original};
      },oldPopupCss);
      assert.deepEqual(snapshots.current,snapshots.original);
    });
  };
  const saveKey=async key=>{
    if(await popup.locator('#rewrite-key').isVisible()) await popup.locator('#rewrite-key').click();
    await popup.locator('#api-key').fill(key);
    await popup.locator('#save-key').click();
    await popup.locator('#rewrite-key').waitFor({state:'visible'});
    await settle();
  };
  const stream=data=>popup.evaluate(data=>new Promise((resolve,reject)=>{
    const port=chrome.runtime.connect({name:'stream-compact-qa'}),messages=[];
    const timer=setTimeout(()=>{port.disconnect();reject(new Error('stream timeout'));},10000);
    port.onMessage.addListener(message=>{
      messages.push(message);
      if(message.type==='done'||message.type==='error'){clearTimeout(timer);port.disconnect();resolve(messages);}
    });
    port.postMessage(data);
  }),data);
  await settle();
  await compareAppearance('首次 Key 输入');
  await check('实际 Edge 初次加载：10 家入口、调用名/通用设置/地址隐藏、首次 Key 输入可见',async()=>{
    assert.equal(await popup.locator('#explain-manufacturer option').count(),11);
    assert.equal(await popup.locator('#explain-custom-model').count(),0);
    assert.equal(await popup.locator('#enabled').count(),0);
    assert.equal(await popup.locator('#api-base-url').isVisible(),false);
    assert.equal(await popup.locator('#api-key').isVisible(),true);
    assert.equal(await popup.locator('#explain-model').isDisabled(),true);
    assert.equal(await worker.evaluate(async()=>(await chrome.storage.local.get(null)).qwenApiKey),undefined);
    assert.equal(await popup.locator('#refresh-catalog').count(),0);
    await popup.locator('.container').screenshot({path:resolve(evidence,'popup-key-first.png')});
  });
  await check('每次打开真实公开目录刷新，成功静默；无 Key 不展示未经接口确认的型号',async()=>{
    const before=await worker.evaluate(async()=>(await chrome.storage.local.get('catalogSnapshot')).catalogSnapshot.updatedAt);
    await popup.reload();await popup.locator('#explain-manufacturer option').first().waitFor({state:'attached'});await settle();
    const snapshot=await worker.evaluate(async()=>(await chrome.storage.local.get('catalogSnapshot')).catalogSnapshot);
    assert.notEqual(snapshot.updatedAt,before);
    assert.equal(snapshot.providers.length,10);
    assert.equal(await popup.locator('#catalog-status').isVisible(),false);
    assert.equal(await popup.locator('#explain-model option').count(),1);
    const makers=await popup.locator('#explain-manufacturer option').evaluateAll(items=>items.map(o=>o.value).filter(id=>id!=='custom'));
    for(const maker of makers){
      await popup.locator('#explain-manufacturer').selectOption(maker);
      assert.equal(await popup.locator('#explain-model').isDisabled(),true);
      assert.equal(await popup.locator('#api-key').inputValue(),'');
      assert.equal(await popup.locator('#api-base-url').isVisible(),false);
    }
    liveCatalog={source:snapshot.source,updatedAt:snapshot.updatedAt,providers:snapshot.providers.map(p=>({id:p.id,count:p.models.length}))};
  });
  await check('保存 DeepSeek Key 后自动收起；仅当前接口两款文本模型，无历史/其他厂家/嵌入项',async()=>{
    await popup.locator('#explain-manufacturer').selectOption('deepseek');
    await saveKey('qa-deepseek');
    assert.equal(await popup.locator('#api-key').isVisible(),false);
    assert.equal(await popup.locator('#rewrite-key').isVisible(),true);
    assert.deepEqual(await popup.locator('#explain-model option').evaluateAll(items=>items.map(o=>o.value)),['deepseek-flash','deepseek-v4-pro']);
    assert.equal(await popup.locator('#explain-model option[value="deepseek-v4-flash"]').count(),0);
    assert.equal(await popup.locator('#explain-model option[value="gpt-4.1"]').count(),0);
    await compareAppearance('已保存厂家 Key');
    await popup.locator('.container').screenshot({path:resolve(evidence,'popup-compact-saved.png')});
  });
  await check('重新填写入口、空值提示和取消恢复；旧 Key 保留且不在界面显示',async()=>{
    await popup.locator('#rewrite-key').click();
    assert.equal(await popup.locator('#api-key').inputValue(),'');
    await popup.locator('#save-key').click();
    assert.equal(await popup.locator('#key-msg').innerText(),'请输入 API Key。');
    await popup.locator('#cancel-key').click();
    await popup.locator('#rewrite-key').waitFor({state:'visible'});
    assert.equal(await worker.evaluate(async()=>(await chrome.storage.local.get('providerConnections')).providerConnections.deepseek.apiKey==='qa-deepseek'),true);
    await popup.locator('.container').screenshot({path:resolve(evidence,'popup-key-rewrite.png')});
  });
  await check('翻译使用 Gemini 独立 Key 和接口模型；保存、重开 Key 仍隐藏且自动查询两厂家',async()=>{
    await popup.locator('[data-tab="translate"]').click();
    await popup.locator('#translate-manufacturer').selectOption('google');
    await saveKey('qa-google');
    assert.deepEqual(await popup.locator('#translate-model option').evaluateAll(items=>items.map(o=>o.value)),['gemini-3.8-flash','gemini-3.8-pro']);
    await popup.locator('#translate-model').selectOption('gemini-3.8-pro');
    await popup.locator('#save-btn').click();await popup.locator('#status.success').waitFor();await settle();
    const before=await worker.evaluate(()=>qaFactoryRequests.filter(r=>r.method==='GET').length);
    await popup.reload();await popup.locator('#explain-manufacturer option').first().waitFor({state:'attached'});await settle();
    assert.equal(await popup.locator('#explain-manufacturer').inputValue(),'deepseek');
    assert.equal(await popup.locator('#translate-manufacturer').inputValue(),'google');
    assert.equal(await popup.locator('#translate-model').inputValue(),'gemini-3.8-pro');
    assert.equal(await popup.locator('#api-key').isVisible(),false);
    assert.ok(await worker.evaluate(()=>qaFactoryRequests.filter(r=>r.method==='GET').length)>before);
  });
  await check('实际运行时端口分别使用厂家地址/Key/模型，B 与全文使用翻译连接（网络模拟）',async()=>{
    for(const data of [
      {type:'STREAM_REQUEST',mode:'C',text:'中文解释验证'},
      {type:'STREAM_REQUEST',mode:'B',text:'translation route'},
      {type:'STREAM_BATCH',text:'full page route',batchId:'compact-qa'}
    ]) assert.equal((await stream(data)).at(-1).type,'done');
    const calls=await worker.evaluate(()=>qaFactoryRequests.filter(r=>r.method==='POST'));
    assert.deepEqual(calls.map(r=>[r.provider,r.authenticated,r.model]),[
      ['deepseek',true,'deepseek-flash'],['google',true,'gemini-3.8-pro'],['google',true,'gemini-3.8-pro']
    ]);
  });
  await check('新 Key 的列表先返回，旧查询晚返回不会覆盖新连接与模型（模拟延迟）',async()=>{
    await worker.evaluate(()=>{globalThis.qaDelayDeepSeek=true;});
    const pending=popup.evaluate(()=>refreshProviderModels('deepseek'));
    pending.catch(()=>{});
    await worker.evaluate(async()=>{
      for(let retry=0;retry<200&&!globalThis.qaReleaseModels;retry++) await new Promise(resolve=>setTimeout(resolve,10));
      if(!globalThis.qaReleaseModels) throw new Error('delayed request not started');
    });
    await worker.evaluate(()=>{
      globalThis.qaDelayDeepSeek=false;
      qaFactoryModels.deepseek=[{id:'deepseek-flash',name:'当前账号 Flash'}];
    });
    await popup.locator('#rewrite-key').click();
    await popup.locator('#api-key').fill('qa-deepseek-new');
    await popup.locator('#save-key').click();
    await popup.locator('#explain-model option').filter({hasText:'当前账号 Flash'}).waitFor({state:'attached'});
    await worker.evaluate(()=>qaReleaseModels());await pending;await settle();
    assert.equal(await popup.locator('#explain-model option').count(),1);
    assert.equal(await worker.evaluate(async()=>{
      const c=(await chrome.storage.local.get('providerConnections')).providerConnections;
      return c.deepseek.apiKey==='qa-deepseek-new' && c.deepseek.availableModels.length===1 && c.google.apiKey==='qa-google';
    }),true);
  });
  await check('厂家列表失败保留当前缓存，顶部红字；重新打开成功后静默恢复（模拟 503）',async()=>{
    await worker.evaluate(()=>{globalThis.qaProviderFail='deepseek';});
    await popup.reload();await popup.locator('#explain-manufacturer option').first().waitFor({state:'attached'});await settle();
    assert.equal(await popup.locator('#explain-model').inputValue(),'deepseek-flash');
    assert.equal(await popup.locator('#catalog-status').innerText(),'模型服务暂不可用，请稍后重试。 已保留已有列表。');
    // 1.0.0 主题 --lc-error 为 #b42318。
    assert.equal(await popup.locator('#catalog-status').evaluate(el=>getComputedStyle(el).color),'rgb(180, 35, 24)');
    await popup.locator('.container').screenshot({path:resolve(evidence,'popup-interface-error.png')});
    await worker.evaluate(()=>{globalThis.qaProviderFail='';});
    await popup.reload();await popup.locator('#explain-manufacturer option').first().waitFor({state:'attached'});await settle();
    assert.equal(await popup.locator('#catalog-status').isVisible(),false);
  });
  await check('公开目录失败和后台无回复恢复均保留接口模型列表（模拟故障，恢复真实网络）',async()=>{
    await worker.evaluate(()=>{globalThis.qaCatalogFail=true;});
    await popup.evaluate(()=>refreshCatalog());await settle();
    assert.equal(await popup.locator('#catalog-status').innerText(),'暂时无法获取模型，已保留已有列表。');
    assert.equal(await popup.locator('#explain-model').inputValue(),'deepseek-flash');
    await worker.evaluate(()=>{globalThis.qaCatalogFail=false;});
    await popup.evaluate(()=>{
      globalThis.qaSend=chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage=(message,...args)=>message.type==='REFRESH_MODEL_CATALOG'?Promise.resolve(undefined):qaSend(message,...args);
    });
    try {await popup.evaluate(()=>refreshCatalog());await settle();assert.equal(await popup.locator('#catalog-status').isVisible(),false);}
    finally{await popup.evaluate(()=>{chrome.runtime.sendMessage=qaSend;delete globalThis.qaSend;});}
  });
  await check('当前接口开放列表变为空时清除旧型号，后台不回填预设或发送生成请求',async()=>{
    await worker.evaluate(()=>{globalThis.qaFactoryModels.deepseek=[];});
    await popup.evaluate(()=>refreshProviderModels('deepseek'));await settle();
    assert.equal(await popup.locator('#explain-model').isDisabled(),true);
    assert.equal(await popup.locator('#explain-model').inputValue(),'');
    const before=await worker.evaluate(()=>qaFactoryRequests.filter(r=>r.method==='POST').length);
    assert.equal((await stream({type:'STREAM_REQUEST',mode:'C',text:'无可用模型'}))[0].type,'error');
    assert.equal(await worker.evaluate(()=>qaFactoryRequests.filter(r=>r.method==='POST').length),before);
    await worker.evaluate(()=>{qaFactoryModels.deepseek=[{id:'deepseek-flash',name:'DeepSeek V4.1 Flash'}];});
    await popup.evaluate(()=>refreshProviderModels('deepseek'));await settle();
    assert.equal(await popup.locator('#explain-model').inputValue(),'deepseek-flash');
  });
  await check('自定义地址仅在独立弹窗中出现；错误地址提示，正确地址归一化并保存',async()=>{
    await popup.locator('#explain-manufacturer').selectOption('custom');
    assert.equal(await popup.locator('#api-base-url').isVisible(),false);
    await popup.locator('#custom-connection-button').click();
    await compareAppearance('自定义地址弹窗');
    await popup.locator('#api-base-url').fill('not-url');await popup.locator('#custom-save').click();
    assert.match(await popup.locator('#custom-msg').innerText(),/有效/);
    await popup.locator('#api-base-url').fill(base+'/custom/v1/chat/completions/');
    await popup.locator('#custom-save').click();
    await popup.locator('#custom-connection-dialog').waitFor({state:'hidden'});
    assert.equal(await worker.evaluate(async()=>(await chrome.storage.local.get('providerConnections')).providerConnections.custom.apiBaseUrl),base+'/custom/v1');
  });
  await check('自定义 Key 保存后经实际 runtime/HTTP 查询，仅列此接口型号，不混入官方厂家缓存',async()=>{
    await saveKey('local-qa-only');
    assert.deepEqual(await popup.locator('#explain-model option').evaluateAll(items=>items.map(o=>o.value)),['mock-chat','gateway/model-large']);
    assert.equal(await popup.locator('#explain-model option[value="deepseek-flash"]').count(),0);
    assert.ok(requests.some(r=>r.path==='/custom/v1/models'&&r.authenticated));
    await popup.locator('#explain-model').selectOption('mock-chat');
    await popup.locator('[data-tab="translate"]').click();await popup.locator('#translate-manufacturer').selectOption('custom');await settle();
    assert.equal(await popup.locator('#api-key').isVisible(),false);
    await popup.locator('#translate-model').selectOption('gateway/model-large');
    await popup.locator('#save-btn').click();await popup.locator('#status.success').waitFor();await settle();
  });
  await check('厂家查询后台无回复或消息断开时，设置页按原连接经真实 HTTP 恢复（模拟通信故障）',async()=>{
    await popup.evaluate(()=>{globalThis.qaSend=chrome.runtime.sendMessage.bind(chrome.runtime);});
    try {
      for(const mode of ['empty','closed']) {
        await popup.evaluate(mode=>{
          chrome.runtime.sendMessage=(message,...args)=>message.type==='LIST_MODELS' ?
            (mode==='empty' ? Promise.resolve(undefined) : Promise.reject(new Error('The message port closed before a response was received.'))) : qaSend(message,...args);
        },mode);
        const before=requests.length;
        await popup.evaluate(()=>refreshProviderModels('custom'));await settle();
        assert.equal(await popup.locator('#catalog-status').isVisible(),false);
        assert.equal(await popup.locator('#translate-model option').count(),2);
        assert.ok(requests.slice(before).some(r=>r.path==='/custom/v1/models' && r.authenticated));
      }
    } finally {
      await popup.evaluate(()=>{chrome.runtime.sendMessage=qaSend;delete globalThis.qaSend;});
    }
  });
  await check('后台明确鉴权失败不直接重试绕过，错误类型精确且不显示 Key（模拟 401）',async()=>{
    const before=requests.length;
    await popup.evaluate(()=>{
      globalThis.qaSend=chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage=(message,...args)=>message.type==='LIST_MODELS' ?
        Promise.resolve({ok:false,code:'key_invalid',status:401,error:'synthetic-private-body'}) : qaSend(message,...args);
    });
    try {
      await popup.evaluate(()=>refreshProviderModels('custom'));await settle();
      assert.equal(requests.length,before);
      assert.match(await popup.locator('#catalog-status').innerText(),/^API Key 无效，请重新填写。/);
      assert.equal(await popup.locator('#catalog-status').innerText().then(t=>t.includes('synthetic-private-body')),false);
      await popup.locator('.container').screenshot({path:resolve(evidence,'popup-model-auth-error.png')});
    } finally {
      await popup.evaluate(()=>{chrome.runtime.sendMessage=qaSend;delete globalThis.qaSend;});
    }
    await popup.evaluate(()=>refreshProviderModels('custom'));await settle();
  });
  await check('隐藏设置保留已有启用/上下文/触发值，两个模型保存并重开仍保留',async()=>{
    const settings=await worker.evaluate(async()=>chrome.storage.local.get(['enabled','usePageContext','triggerMode']));
    assert.deepEqual(settings,{enabled:true,usePageContext:false,triggerMode:'auto'});
    await popup.reload();await popup.locator('#explain-manufacturer option').first().waitFor({state:'attached'});await settle();
    assert.equal(await popup.locator('#explain-model').inputValue(),'mock-chat');
    assert.equal(await popup.locator('#translate-model').inputValue(),'gateway/model-large');
    assert.equal(await popup.locator('#api-key').isVisible(),false);
  });
  const page=await context.newPage();page.on('pageerror',err=>errors.push(err.message));await page.goto(base+'/sample');
  const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,base+'/sample');
  const waitFullPageDone=()=>page.waitForFunction(()=>{
    const counts=document.querySelector('#ds-tb-progress')?.textContent.split('/').map(Number);
    return counts?.[1]>0 && counts[0]===counts[1];
  });
  await check('实际划词 → Worker → 本机 HTTP SSE → 结果卡片完整输出',async()=>{
    await page.evaluate(()=>{
      const p=document.querySelector('#word'),range=document.createRange();range.selectNodeContents(p);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
      p.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));
    });
    await page.locator('.ds-body').filter({hasText:'流式翻译结果。'}).waitFor();
    assert.ok(requests.some(r=>r.path==='/custom/v1/chat/completions'&&r.model==='mock-chat'&&r.authenticated));
    await page.screenshot({path:resolve(evidence,'selection-stream.png')});
    await page.keyboard.press('Escape');
  });
  await check('实际 B 分类使用翻译模型，经本机 HTTP SSE 完成',async()=>{
    assert.equal((await stream({type:'STREAM_REQUEST',mode:'B',text:'Long English translation request for QA'})).at(-1).type,'done');
    assert.ok(requests.some(r=>r.model==='gateway/model-large'&&r.authenticated));
  });
  await check('划词点击内部保持、选区折叠不误关、点击外部/Esc 可关闭（实际 Edge）',async()=>{
    const open=()=>page.evaluate(()=>{
      const word=document.querySelector('#word'),range=document.createRange();
      word.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));range.selectNodeContents(word);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      word.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));
    });
    await open();await page.locator('#deepseek-explain-tooltip.ds-visible .ds-body').filter({hasText:'流式翻译结果。'}).waitFor();
    await page.locator('.ds-quote').click();
    await page.evaluate(()=>getSelection().removeAllRanges());await page.waitForTimeout(300);
    assert.equal(await page.locator('#deepseek-explain-tooltip').evaluate(el=>el.classList.contains('ds-visible')),true);
    await page.locator('#paragraph').click();
    await page.locator('#deepseek-explain-tooltip.ds-hidden').waitFor({state:'attached'});
    await open();await page.locator('#deepseek-explain-tooltip.ds-visible').waitFor({state:'attached'});
    await page.keyboard.press('Escape');await page.locator('#deepseek-explain-tooltip.ds-hidden').waitFor({state:'attached'});
  });
  await check('实际按需注入全文脚本，翻译与原文切换/取消恢复',async()=>{
    const inlineOriginal=await page.locator('#inline-fixture').innerHTML();
    const before=requests.length;
    await page.evaluate(()=>{window.qaLink=document.querySelector('#inline-fixture a');window.qaText=document.querySelector('#paragraph').firstChild;});
    await worker.evaluate(async id=>chrome.tabs.sendMessage(id,{type:'TRIGGER_FULLPAGE_TRANSLATE'}),tabId);
    await page.locator('#paragraph').filter({hasText:'流式翻译结果。'}).waitFor();
    await page.locator('#inline-fixture').filter({hasText:'流式翻译结果。'}).waitFor();
    assert.ok(requests.slice(before).some(request=>request.batchIds.length>1));
    assert.match(await page.locator('#paragraph').innerText(),/This is a longer English paragraph/);
    assert.equal(await page.locator('#inline-fixture img').count(),1);
    assert.equal(await page.locator('#inline-fixture a').getAttribute('href'),'#fixture');
    assert.equal(await page.locator('#inline-fixture script').textContent(),'{"fixture":"preserve"}');
    await page.locator('#ds-tb-show-original').click();
    await page.locator('#paragraph').filter({hasText:'This is a longer English paragraph'}).waitFor();
    await page.locator('#ds-tb-show-original').click();
    await page.locator('#paragraph').filter({hasText:'流式翻译结果。'}).waitFor();
    await page.locator('#ds-tb-cancel').click();
    await page.locator('#paragraph').filter({hasText:'This is a longer English paragraph'}).waitFor();
    assert.equal(await page.locator('#inline-fixture').innerHTML(),inlineOriginal);
    assert.equal(await page.evaluate(()=>qaLink===document.querySelector('#inline-fixture a') && qaText===document.querySelector('#paragraph').firstChild),true);
  });
  await check('批量格式错误实际回退逐块翻译，进度完成且取消恢复（本机模拟 API）',async()=>{
    await worker.evaluate(()=>CACHE.clear());
    batchFixtureMode='invalid';const before=requests.length;
    try {
      await worker.evaluate(async id=>chrome.tabs.sendMessage(id,{type:'TRIGGER_FULLPAGE_TRANSLATE'}),tabId);
      await page.locator('#paragraph').filter({hasText:'流式翻译结果。'}).waitFor();
      await waitFullPageDone();
      const run=requests.slice(before);
      assert.ok(run.some(r=>r.batchIds.length>1));assert.ok(run.some(r=>r.path.endsWith('/chat/completions')&&r.batchIds.length===0));
      await page.locator('#ds-tb-cancel').click();
      await page.locator('#paragraph').filter({hasText:'This is a longer English paragraph'}).waitFor();
    } finally {batchFixtureMode='normal';}
  });
  await check('请求途中显示原文保持原文，切回译文正常；取消重启隔离旧会话（实际 Edge）',async()=>{
    await worker.evaluate(()=>CACHE.clear());
    batchFixtureDelay=350;
    await worker.evaluate(async id=>chrome.tabs.sendMessage(id,{type:'TRIGGER_FULLPAGE_TRANSLATE'}),tabId);
    await page.locator('#ds-tb-show-original').click();
    await waitFullPageDone();
    assert.equal(await page.locator('#paragraph').innerText(),'This is a longer English paragraph used to verify full page translation and preserve original text.');
    await page.locator('#ds-tb-show-original').click();await page.locator('#paragraph').filter({hasText:'流式翻译结果。'}).waitFor();
    await page.locator('#ds-tb-cancel').click();
    await worker.evaluate(()=>CACHE.clear());
    batchFixtureDelay=600;const before=requests.length;
    await worker.evaluate(async id=>chrome.tabs.sendMessage(id,{type:'TRIGGER_FULLPAGE_TRANSLATE'}),tabId);
    // 全文工具栏显示总体状态；以真实接口已收到请求确认取消发生在途中。
    const startedAt=Date.now();
    while(requests.length===before && Date.now()-startedAt<10000) await page.waitForTimeout(30);
    assert.ok(requests.length>before,'全文请求应在取消前实际开始');
    await page.locator('#ds-tb-cancel').click();
    batchFixtureDelay=0;
    await worker.evaluate(async id=>chrome.tabs.sendMessage(id,{type:'TRIGGER_FULLPAGE_TRANSLATE'}),tabId);
    await waitFullPageDone();
    await page.waitForTimeout(750);
    const progress=await worker.evaluate(async id=>(await chrome.scripting.executeScript({target:{tabId:id},
      func:()=>window.__dsFullPageTranslator.progress}))[0].result,tabId);
    assert.equal(progress.total,progress.completed);assert.ok(requests.length>before);
    await page.locator('#ds-tb-cancel').click();
    assert.equal(await page.locator('#paragraph').innerText(),'This is a longer English paragraph used to verify full page translation and preserve original text.');
    assert.equal(await page.locator('.ds-translating-indicator').count(),0);
  });
  await check('无效 Key 的接口错误可见，重填后列表恢复；无相关页面异常',async()=>{
    await saveKey('invalid-test-only');
    assert.equal(await popup.locator('#catalog-status').innerText(),'API Key 无效，请重新填写。');
    await saveKey('local-qa-only');
    assert.equal(await popup.locator('#catalog-status').isVisible(),false);
    assert.equal(await popup.locator('#explain-model option').count(),2);
    assert.deepEqual(errors,[]);
    providerRequests.push(...await worker.evaluate(()=>qaFactoryRequests));
    await popup.locator('.container').screenshot({path:resolve(evidence,'popup-compact-final.png')});
  });
} catch (err) {
  console.error(err.message);
  if (!checks.some(check => check.status === 'failed')) checks.push({ name: 'Browser setup or unhandled operation', status: 'failed', error: err.message });
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
  // 只删除本轮工具创建的配置目录；先核对解析后的绝对路径。
  try {
    assert.equal(dirname(resolve(profile)),profileRoot);
    rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
    profileCleanup.removed=!existsSync(profile);
  } catch(err) {profileCleanup.error=err.message;process.exitCode=1;}
  const report = { date: new Date().toISOString(), node: process.version, browserVersion,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    kind: 'Actual Edge compact popup, live public directory, unauthenticated live DeepSeek probe, localhost API and intercepted provider model/generation fixtures, synthetic credentials', compareRef, profileCleanup, liveCatalog, liveDeepSeekProbe, checks, requests, providerRequests, errors,
    unverified: ['真实供应商/模型、账号权限、模型质量、原生扩展工具栏和右键菜单的鼠标操作'] };
  writeFileSync(resolve(evidence, 'browser-check.json'), JSON.stringify(report, null, 2) + '\n');
}
