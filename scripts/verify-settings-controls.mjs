// 实际 Edge：设置持久化、选区触发与 DeepSeek 参数；合成 Key/接口，不读取日常配置。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=process.cwd(),arg=name=>process.argv[process.argv.indexOf(name)+1];
const {chromium}=createRequire(import.meta.url)(arg('--playwright'));
const output=resolve(root,process.argv.includes('--output')?arg('--output'):'artifacts/qa/settings-controls-2026-10-13');
const profile=resolve(root,'.local/browser-profile/settings-controls',`run-${Date.now()}`);
mkdirSync(output,{recursive:true});
const checks=[],requests=[],errors=[];
let context,worker,popup,page,browserVersion;
const server=createServer(async(req,res)=>{
  if(req.url==='/sample'){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end('<!doctype html><html><body><p id="word">serendipity</p><p>Simple synthetic content.</p></body></html>');return;
  }
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);requests.push(body);
  const items=[...body.messages[1].content.split('\n输出要求：')[0].matchAll(/<<<DS_ITEM_([A-Za-z0-9_]+)>>>([\s\S]*?)<<<DS_END_\1>>>/g)];
  const content=items.length?items.map(item=>`<<<DS_ITEM_${item[1]}>>>模拟译文<<<DS_END_${item[1]}>>>`).join('\n'):'**模拟回答**：意外发现的机缘。';
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const delta={content,...(body.thinking?.type==='enabled'?{reasoning_content:'合成思考片段'}:{})};
  res.end(`data: ${JSON.stringify({choices:[{delta}]})}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
async function check(name,fn){try{const evidence=await fn();checks.push({name,status:'passed',evidence});console.log('PASSED: '+name);}catch(error){checks.push({name,status:'failed',error:error.stack});throw error;}}
async function save(){await popup.locator('#save-btn').click();await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('已保存'));}
async function reopen(){await popup.reload();await popup.waitForFunction(()=>document.querySelector('#explain-model').value==='deepseek-flash');}
async function select(){await page.evaluate(()=>{const el=document.querySelector('#word');el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));const range=document.createRange();range.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(range);el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));});}
async function contentState(){return worker.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>triggerMode});return result.result;},page.url());}
async function waitMode(mode){for(let i=0;i<50;i++){if(await contentState()===mode)return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Content trigger mode did not update');}
async function route(request){
  const message=request.type==='STREAM_TRANSLATE_BATCH'?request:{...request,type:'STREAM_REQUEST',promptType:request.type==='STREAM_TRANSLATE'?'translate':'explain'};
  return popup.evaluate(request=>new Promise((resolve,reject)=>{const port=chrome.runtime.connect({name:'stream-settings-control-qa'});const messages=[];const timer=setTimeout(()=>{port.disconnect();reject(Error('Stream timeout'));},5000);port.onMessage.addListener(message=>{messages.push(message);if(message.type==='done'||message.type==='error'){clearTimeout(timer);port.disconnect();resolve(messages);}});port.postMessage(request);}),message);
}
try{
  context=await chromium.launchPersistentContext(profile,{channel:'msedge',headless:true,viewport:{width:1000,height:800},args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`,'--no-first-run'],ignoreDefaultArgs:['--disable-extensions']});
  browserVersion=context.browser().version();
  await context.route('**/*',route=>!route.request().url().startsWith('http')||route.request().url().startsWith(base)?route.continue():route.abort());
  worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  await worker.evaluate(async base=>{
    const nativeFetch=fetch;
    globalThis.qaSettingsModelsFail=false;
    globalThis.fetch=(url,options={})=>{
      if(String(url).endsWith('/models')){
        if(globalThis.qaSettingsModelsFail)return Promise.resolve(Response.json({error:{message:'synthetic invalid key'}},{status:401}));
        return Promise.resolve(Response.json({data:[{id:'deepseek-flash'}]}));
      }
      if(String(url).endsWith('/chat/completions'))return nativeFetch(base+'/chat/completions',options);
      return Promise.reject(Error('QA blocks external network'));
    };
    AIModelCatalog.refresh=async()=>({...AIModelCatalog.BUILTIN,providers:AIModelCatalog.BUILTIN.providers.map(provider=>({...provider,stale:false}))});
    await chrome.storage.local.clear();
    await chrome.storage.local.set(AIConfig.migrate({apiConfigVersion:1,providerConfigVersion:1,modelCatalogVersion:1,
      explainManufacturer:'deepseek',translateManufacturer:'deepseek',explainModel:'deepseek-flash',translateModel:'deepseek-flash',modelList:['deepseek-flash'],
      providerConnections:{deepseek:{apiKey:'synthetic-settings-only',availableModels:['deepseek-flash']}}}));
  },base);
  popup=await context.newPage();popup.on('pageerror',error=>errors.push(error.message));
  await popup.setViewportSize({width:390,height:600});
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);await reopen();
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/sample');
  await check('首次默认自动触发；DeepSeek 总开关位于深度思考上方且默认关闭',async()=>{
    assert.equal(await popup.locator('#trigger-mode').inputValue(),'auto');
    assert.equal(await popup.locator('#explain-deepseek-thinking').isVisible(),true);
    assert.equal(await popup.locator('#explain-deepseek-thinking').isChecked(),false);
    assert.equal(await popup.locator('#explain-thinking').isEnabled(),false);
    assert.equal(await popup.evaluate(()=>!!(document.querySelector('#explain-deepseek-thinking-section').compareDocumentPosition(document.querySelector('#explain-thinking'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
    await popup.locator('body').screenshot({path:resolve(output,'deepseek-off.png')});
  });
  await check('仅右键保存/重开保留，已打开网页实时停止自动请求，菜单消息仍显示回答',async()=>{
    await popup.locator('#trigger-mode').selectOption('contextMenu');await save();await reopen();
    assert.equal(await popup.locator('#trigger-mode').inputValue(),'contextMenu');await waitMode('contextMenu');
    const before=requests.length;await select();await page.waitForTimeout(350);
    assert.equal(requests.length,before);assert.equal(await page.locator('#deepseek-explain-tooltip.ds-visible').count(),0);
    await page.evaluate(()=>document.querySelector('#word').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:30,clientY:30})));
    await worker.evaluate(async url=>{await chrome.contextMenus.update('deepseek-explain',{title:'📖 说文：解释选中文字'});const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);await chrome.tabs.sendMessage(tab.id,{type:'TRIGGER_EXPLAIN',text:'serendipity'});},page.url());
    await page.locator('#deepseek-explain-tooltip.ds-visible .ds-actions').waitFor({state:'visible'});
    assert.equal(requests.length,before+1);assert.deepEqual(requests.at(-1).thinking,{type:'disabled'});
    assert.match(await page.locator('.ds-body').textContent(),/模拟回答/);
    return{boundary:'Native menu registration verified; native OS menu click replaced by real tabs.sendMessage; Range and content port executed in Edge'};
  });
  await check('改回自动触发实时生效，左键选区自动生成',async()=>{
    await popup.locator('#trigger-mode').selectOption('auto');await save();await waitMode('auto');
    await page.reload();const before=requests.length;await select();
    await page.locator('#deepseek-explain-tooltip.ds-visible .ds-actions').waitFor({state:'visible'});
    assert.equal(requests.length,before+1);
  });
  await check('打开总开关但关闭深度思考：真实解释端口 enabled，无 effort；独立翻译仍 disabled',async()=>{
    await popup.locator('#explain-deepseek-thinking').check();assert.equal(await popup.locator('#explain-thinking').isEnabled(),true);await save();await reopen();
    assert.equal(await popup.locator('#explain-deepseek-thinking').isChecked(),true);
    const messages=await route({type:'STREAM_EXPLAIN',text:'master enabled'});
    assert.deepEqual(requests.at(-1).thinking,{type:'enabled'});assert.equal(requests.at(-1).reasoning_effort,undefined);
    assert.ok(messages.some(message=>message.type==='reasoning-token'));
    await route({type:'STREAM_TRANSLATE',text:'translation master off'});assert.deepEqual(requests.at(-1).thinking,{type:'disabled'});
  });
  await check('深度思考与强度保存/重开；触发选择位于强度下方；真实解释端口携带 effort',async()=>{
    await popup.locator('#explain-thinking').check();await popup.locator('#explain-effort').selectOption('low');await save();await reopen();
    assert.equal(await popup.locator('#explain-thinking').isChecked(),true);assert.equal(await popup.locator('#explain-effort').inputValue(),'low');
    assert.equal(await popup.evaluate(()=>!!(document.querySelector('#explain-effort-section').compareDocumentPosition(document.querySelector('#trigger-mode-section'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
    await route({type:'STREAM_EXPLAIN',text:'deep enabled'});assert.deepEqual(requests.at(-1).thinking,{type:'enabled'});assert.equal(requests.at(-1).reasoning_effort,'low');
    await popup.locator('#explain-deepseek-thinking').scrollIntoViewIfNeeded();await popup.locator('body').screenshot({path:resolve(output,'deepseek-on.png')});
  });
  await check('关闭总开关立即清除/禁用深度思考并隐藏强度，保存后 disabled 无 effort；重新打开不恢复深度思考',async()=>{
    await popup.locator('#explain-deepseek-thinking').uncheck();assert.equal(await popup.locator('#explain-thinking').isChecked(),false);assert.equal(await popup.locator('#explain-thinking').isEnabled(),false);assert.equal(await popup.locator('#explain-effort-section').isVisible(),false);
    await save();await reopen();await route({type:'STREAM_EXPLAIN',text:'master disabled again'});
    assert.deepEqual(requests.at(-1).thinking,{type:'disabled'});assert.equal(requests.at(-1).reasoning_effort,undefined);
    await popup.locator('#explain-deepseek-thinking').check();assert.equal(await popup.locator('#explain-thinking').isChecked(),false);
  });
  await check('全文翻译独立开关/强度保存并用于 B 分类、全文和批量三条真实端口',async()=>{
    await popup.locator('#tab-translate').click();await popup.locator('#translate-deepseek-thinking').check();await popup.locator('#translate-thinking').check();await popup.locator('#translate-effort').selectOption('medium');await save();await reopen();
    for(const request of[{type:'STREAM_SMART_EXPLAIN',mode:'B',text:'A complete translated sentence.'},{type:'STREAM_TRANSLATE',text:'full page'},{type:'STREAM_TRANSLATE_BATCH',items:[{id:'control1',text:'batch'}]}]){
      const messages=await route(request);assert.equal(messages.at(-1).type,'done',JSON.stringify(messages));assert.deepEqual(requests.at(-1).thinking,{type:'enabled'});assert.equal(requests.at(-1).reasoning_effort,'medium');
    }
    const state=await worker.evaluate(()=>chrome.storage.local.get(['explainDeepSeekThinkingEnabled','translateDeepSeekThinkingEnabled','translateThinkingEnabled']));
    assert.equal(state.translateDeepSeekThinkingEnabled,true);assert.equal(state.translateThinkingEnabled,true);
  });
  await check('非 DeepSeek 厂家隐藏专用开关；显式自定义官方地址显示；外观切换不保存开关草稿',async()=>{
    await popup.locator('#explain-manufacturer').selectOption('openai');assert.equal(await popup.locator('#explain-deepseek-thinking-section').isVisible(),false);assert.equal(await popup.locator('#explain-thinking').isEnabled(),true);
    await popup.locator('#explain-manufacturer').selectOption('deepseek');
    const before=await worker.evaluate(()=>chrome.storage.local.get(['explainDeepSeekThinkingEnabled','translateDeepSeekThinkingEnabled','triggerMode']));
    await popup.locator('#explain-deepseek-thinking').uncheck();await popup.locator('#trigger-mode').selectOption('contextMenu');await popup.locator('#ui-theme').selectOption('playful');await popup.waitForFunction(()=>!document.querySelector('#ui-theme').disabled);
    assert.deepEqual(await worker.evaluate(()=>chrome.storage.local.get(['explainDeepSeekThinkingEnabled','translateDeepSeekThinkingEnabled','triggerMode'])),before);
    await worker.evaluate(()=>chrome.storage.local.set({explainManufacturer:'custom',providerConnections:{custom:{apiBaseUrl:'https://api.deepseek.com/v1',apiKey:'synthetic-only',availableModels:['deepseek-flash']}}}));await reopen();
    assert.equal(await popup.locator('#explain-deepseek-thinking-section').isVisible(),true);
  });
  await check('保存失败反馈准确，不写入触发方式和开关草稿；320px 无横向溢出、底部操作可访问',async()=>{
    const before=await worker.evaluate(()=>chrome.storage.local.get(['triggerMode','explainDeepSeekThinkingEnabled']));
    await popup.locator('#trigger-mode').selectOption('contextMenu');await popup.locator('#explain-deepseek-thinking').check();
    await popup.evaluate(()=>{globalThis.qaSet=chrome.storage.local.set;chrome.storage.local.set=()=>Promise.reject(Error('synthetic failure'));});
    await popup.locator('#save-btn').click();await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('保存失败'));
    assert.deepEqual(await worker.evaluate(()=>chrome.storage.local.get(['triggerMode','explainDeepSeekThinkingEnabled'])),before);
    await popup.evaluate(()=>{chrome.storage.local.set=qaSet;});
    await popup.setViewportSize({width:320,height:600});assert.equal(await popup.evaluate(()=>document.body.scrollWidth<=innerWidth),true);
    // 滚动偏移取整、控件保留小数CSS像素，边界允许不足1px的舍入差。
    for(const selector of['#explain-deepseek-thinking','#explain-thinking','#trigger-mode-trigger','#save-btn']){await popup.locator(selector).scrollIntoViewIfNeeded();const r=await popup.locator(selector).boundingBox();assert.ok(r.y>=-1&&r.y+r.height<=601,JSON.stringify({selector,r,viewport:await popup.evaluate(()=>({height:innerHeight,scrollY}))}));}
  });
  async function seedModels(availableModels){
    await worker.evaluate(async availableModels=>{
      await chrome.storage.local.clear();
      await chrome.storage.local.set(AIConfig.migrate({apiConfigVersion:1,providerConfigVersion:1,modelCatalogVersion:1,
        explainManufacturer:'deepseek',translateManufacturer:'deepseek',explainModel:'deepseek-flash',translateModel:'deepseek-flash',
        modelList:['deepseek-flash'],providerConnections:{deepseek:{apiKey:'synthetic-settings-only',availableModels}}}));
    },availableModels);
    await popup.reload();
    await popup.waitForFunction(()=>document.querySelector('#explain-manufacturer').options.length>0);
  }
  await check('模型列表不可用时仍显示并保存已选模型（回归）',async()=>{
    await popup.setViewportSize({width:390,height:700});
    await worker.evaluate(()=>{globalThis.qaSettingsModelsFail=true;});
    await seedModels([]);
    assert.equal(await popup.locator('#explain-model').inputValue(),'deepseek-flash');
    assert.equal(await popup.locator('#translate-model').inputValue(),'deepseek-flash');
    await popup.locator('#trigger-mode').selectOption('contextMenu');
    await save();
    const stored=await worker.evaluate(()=>chrome.storage.local.get(['explainModel','translateModel','triggerMode']));
    assert.deepEqual(stored,{explainModel:'deepseek-flash',translateModel:'deepseek-flash',triggerMode:'contextMenu'});
    await worker.evaluate(()=>{globalThis.qaSettingsModelsFail=false;});
    return {stored,detail:await popup.locator('#translate-model-detail').innerText()};
  });
  await check('换 Key 后列表失败不清空型号，后续保存仍保留（回归）',async()=>{
    await worker.evaluate(()=>{globalThis.qaSettingsModelsFail=false;});
    await seedModels(['deepseek-flash']);
    await popup.waitForFunction(()=>document.querySelector('#explain-model').value==='deepseek-flash');
    await worker.evaluate(()=>{globalThis.qaSettingsModelsFail=true;});
    await popup.locator('#rewrite-key').click();
    await popup.locator('#api-key').fill('synthetic-settings-key-2');
    await popup.locator('#save-key').click();
    await popup.waitForFunction(()=>document.querySelector('#key-editor').hidden);
    await popup.waitForFunction(()=>document.querySelector('#catalog-status').textContent.includes('无效'));
    const afterKey=await worker.evaluate(()=>chrome.storage.local.get(['explainModel','translateModel']));
    assert.deepEqual(afterKey,{explainModel:'deepseek-flash',translateModel:'deepseek-flash'});
    assert.equal(await popup.locator('#explain-model').inputValue(),'deepseek-flash');
    await popup.locator('#trigger-mode').selectOption('auto');
    await save();
    const afterSave=await worker.evaluate(()=>chrome.storage.local.get(['explainModel','translateModel','triggerMode']));
    assert.deepEqual(afterSave,{explainModel:'deepseek-flash',translateModel:'deepseek-flash',triggerMode:'auto'});
    await worker.evaluate(()=>{globalThis.qaSettingsModelsFail=false;});
    return {afterKey,afterSave,catalog:await popup.locator('#catalog-status').innerText()};
  });
  assert.deepEqual(errors,[]);
}finally{
  const report={date:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),node:process.version,browser:browserVersion,profile:relative(root,profile),kind:'actual isolated Edge; synthetic provider',passed:checks.filter(check=>check.status==='passed').length,failed:checks.filter(check=>check.status==='failed').length,checks,errors,unverified:['Real provider credentials/generation/latency','Native OS context menu mouse click','Native toolbar popup']};
  writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  if(context)await context.close();await new Promise(resolve=>server.close(resolve));
}
