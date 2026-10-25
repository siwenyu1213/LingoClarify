// 文件职责：设置持久化、厂家模型查询、Key 编辑、DeepSeek 开关联动与触发方式保存。
// 按接口开放列表选模型，Key 保存后收起，保留上下文偏好。
const $ = id => document.getElementById(id);
const $apiKey = $('api-key'), $apiBaseUrl = $('api-base-url');
const $catalogStatus = $('catalog-status'), $status = $('status');
const tabs = ['explain', 'translate'].map(kind => ({
  kind, key: kind + 'Model', manufacturer: $(kind + '-manufacturer'),
  select: $(kind + '-model'), detail: $(kind + '-model-detail')
}));
let activeTabIndex = 0, connectionProvider = 'openai';
let providerConnections = {}, savedKeys = {}, modelList = [], savedConfig = {};
let catalogSnapshot = AIModelCatalog.BUILTIN, catalogRefreshing = false, catalogError = '';
const providerErrors = new Map(), providerRequests = new Map();
const editingKeys = new Set();
LingoTheme.attach(document.body);
LingoTheme.subscribe(theme => { $('ui-theme').value = theme; });
LingoTheme.ready.then(theme => { $('ui-theme').value = theme; });
$('ui-theme').addEventListener('change', async () => {
  const select = $('ui-theme'), requested = LingoTheme.normalize(select.value);
  select.disabled = true;
  try {
    await chrome.storage.local.set({uiTheme:requested});
    LingoTheme.apply(requested);
    $('theme-status').textContent = ''; $('theme-status').className = 'hint';
  } catch {
    select.value = LingoTheme.current;
    $('theme-status').textContent = '主题保存失败，请重试。'; $('theme-status').className = 'inline-error';
  } finally { select.disabled = false; }
});

function providerConnection(provider) {
  const entry = providerConnections[provider] || {};
  return { ...entry, apiBaseUrl: AIConfig.endpointFor(provider, entry),
    apiKey: entry.apiKey || '', availableModels: entry.availableModels || [], modelEntries: entry.modelEntries || [] };
}
function captureConnection() {
  const previous = providerConnection(connectionProvider);
  const apiKey = $apiKey.value.trim() || savedKeys[connectionProvider] || '';
  providerConnections[connectionProvider] = { ...previous, apiKey,
    ...(apiKey !== previous.apiKey ? {availableModels:[], modelEntries:[], modelsCheckedAt:''} : {}) };
}
function showConnection() {
  connectionProvider = tabs[activeTabIndex].manufacturer.value;
  const connection = providerConnection(connectionProvider);
  $apiBaseUrl.value = connection.apiBaseUrl;
  $apiKey.value = connection.apiKey;
  $apiKey.placeholder = '填写所选厂家的 API Key';
  const edit = !savedKeys[connectionProvider] || editingKeys.has(connectionProvider);
  $('key-editor').hidden = !edit;
  $('rewrite-key').hidden = edit;
  $('key-saved').hidden = edit;
  $('cancel-key').hidden = !savedKeys[connectionProvider];
  $('custom-connection-button').hidden = connectionProvider !== 'custom';
  $('key-msg').textContent = '';
  renderCatalogStatus();
}
function renderCatalogStatus() {
  const missingAddress = connectionProvider === 'custom' && !providerConnection(connectionProvider).apiBaseUrl;
  const message = missingAddress ? '请先配置自定义接口地址。' : providerErrors.get(connectionProvider) || catalogError;
  $catalogStatus.textContent = message;
  $catalogStatus.hidden = !message;
}
function catalogState(message = '') { catalogError = message; renderCatalogStatus(); }
// 设置页显示模型品牌简称；连接仍使用原厂家 ID。
const manufacturerLabels = {openai:'GPT',anthropic:'Claude',google:'Gemini',qwen:'Qwen',
  moonshot:'Kimi',zai:'GLM',xai:'Grok',mistral:'Mistral'};
function renderManufacturers() {
  tabs.forEach(tab => {
    const selected = tab.manufacturer.value || 'openai';
    tab.manufacturer.replaceChildren();
    for (const maker of [...catalogSnapshot.providers, {id:'custom',name:'自定义接口'}]) {
      const option = document.createElement('option');
      option.value = maker.id; option.textContent = manufacturerLabels[maker.id] || maker.name;
      tab.manufacturer.append(option);
    }
    tab.manufacturer.value = selected;
  });
}
// 只在该用途仍指向已保存的厂家时沿用旧型号；未保存的厂家切换不能借用旧值。
// 接口列表已成功返回（包括合法空列表）时以接口结果为准，不再回退旧型号。
function persistedModel(tab) {
  if (tab.manufacturer.value !== savedConfig[tab.kind + 'Manufacturer']) return '';
  if (providerConnection(tab.manufacturer.value).modelsCheckedAt) return '';
  return savedConfig[tab.key] || '';
}
function renderModelOptions(tab) {
  const selected = tab.select.value, provider = tab.manufacturer.value;
  const connection = providerConnection(provider);
  const missingAddress = provider === 'custom' && !connection.apiBaseUrl;
  const entries = missingAddress ? [] : AIModelCatalog.interfaceModels(connection.modelEntries.length ? connection.modelEntries :
    connection.availableModels.map(id => ({id})), provider);
  const catalog = catalogSnapshot.providers.find(p => p.id === provider)?.models || [];
  tab.select.replaceChildren();
  for (const entry of entries) {
    const known = catalog.find(m => entry.id === m.id || entry.id === AIModelCatalog.nativeId(m));
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.name !== entry.id ? entry.name : known?.name || entry.id;
    tab.select.append(option);
    if (!modelList.includes(entry.id)) modelList.push(entry.id);
  }
  if (entries.some(entry => entry.id === selected)) tab.select.value = selected;
  tab.select.disabled = !entries.length;
  // 列表查询失败时保留已保存型号；成功返回空列表（modelsCheckedAt 已更新）则尊重接口结果。
  const persisted = missingAddress ? '' : persistedModel(tab);
  if (!entries.length) {
    const option = document.createElement('option');
    option.value = persisted;
    option.textContent = persisted
      ? (catalog.find(m => persisted === m.id || persisted === AIModelCatalog.nativeId(m))?.name || persisted)
      : (missingAddress ? '先配置自定义接口地址' : connection.apiKey ? '暂无可用模型' : '填写 API Key 后加载模型');
    tab.select.append(option);
    tab.select.value = persisted;
    if (persisted && !modelList.includes(persisted)) modelList.push(persisted);
  }
  tab.detail.textContent = !entries.length && connection.apiKey
    ? (persisted ? '模型列表暂不可用，已保留已保存的模型。' : '模型列表由当前接口提供。') : '';
  tab.detail.hidden = !tab.detail.textContent;
  renderThinkingControls(tab);
}
function renderThinkingControls(tab) {
  const kind = tab.kind;
  const deepSeek = AIConfig.isDeepSeekEndpoint(providerConnection(tab.manufacturer.value).apiBaseUrl);
  $(kind+'-deepseek-thinking-section').hidden = !deepSeek;
  const blocked = deepSeek && !$(kind+'-deepseek-thinking').checked;
  $(kind+'-thinking').disabled = blocked;
  if (blocked) $(kind+'-thinking').checked = false;
  $(kind+'-effort-section').style.display = $(kind+'-thinking').checked ? '' : 'none';
}
function renderAllModelOptions() { tabs.forEach(renderModelOptions); }
function setTabSelection(tab, id) {
  if ([...tab.select.options].some(option => option.value === id)) tab.select.value = id;
}
function manufacturerSettings() {
  return {providerConfigVersion:1, providerConnections:AIConfig.normalizeConnections(providerConnections),
    explainManufacturer:tabs[0].manufacturer.value, translateManufacturer:tabs[1].manufacturer.value};
}
function modelSettings() {
  // 空下拉框只代表列表不可用；只有活动厂家已改回原厂家时才沿用已保存型号。
  const models = tabs.map(tab => tab.select.value || persistedModel(tab));
  for (const model of models) if (model && !modelList.includes(model)) modelList.push(model);
  return {modelList:modelList.slice(), explainModel:models[0], translateModel:models[1]};
}
function showStatus(message, type = 'success') {
  $status.textContent = message; $status.className = 'status ' + type;
  clearTimeout($status.hideTimer);
  $status.hideTimer = setTimeout(() => {$status.textContent='';$status.className='status';}, 4000);
}

function renderEnabledState() { $('disabled-extension').hidden = savedConfig.enabled !== false; }
chrome.storage.onChanged.addListener((changes,area) => {
  if (area !== 'local') return;
  for (const key of ['explainManufacturer','translateManufacturer','explainModel','translateModel']) {
    if (changes[key]) savedConfig[key] = changes[key].newValue;
  }
  if (changes.enabled) {
    savedConfig.enabled = changes.enabled.newValue !== false;
    renderEnabledState();
  }
});
$('enable-extension').addEventListener('click',async()=>{
  $('enable-extension').disabled=true;
  try {
    await chrome.storage.local.set({enabled:true});
    savedConfig.enabled=true; renderEnabledState(); showStatus('扩展已启用。');
  } catch {showStatus('启用失败，请重试。','error');}
  finally {$('enable-extension').disabled=false;}
});

// 每个厂家独立查询；仅将响应写回请求使用的连接，不覆盖中途修改的 Key/地址。
async function queryWithFallback(message, fallback) {
  let result;
  try { result = await chrome.runtime.sendMessage(message); }
  catch (err) {
    if (!/receiving end does not exist|could not establish connection|message port closed|message channel closed/i.test(err.message)) throw err;
  }
  // 无回复/通信中断才恢复；后台明确的接口错误交给各自调用方处理。
  return result == null ? fallback() : result;
}
function requestProviderModels(connection) {
  return queryWithFallback({type:'LIST_MODELS',connection},()=>AIModelCatalog.fetchInterface(connection));
}
function modelFailureMessage(result, provider) {
  const name = catalogSnapshot.providers.find(p=>p.id===provider)?.name || '模型接口';
  const code = result?.code || ({401:'key_invalid',402:'balance',403:'forbidden',404:'unsupported',429:'rate_limit'})[result?.status];
  const messages = {
    key_missing:'请先填写 API Key。', key_invalid:'API Key 无效，请重新填写。',
    balance:'账户余额不足，请检查账户。', forbidden:'API Key 无权获取模型，请检查权限。',
    unsupported:'当前接口不支持获取模型列表。', rate_limit:'请求过于频繁，请稍后重试。',
    timeout:'获取模型超时，请稍后重试。', network:`无法连接 ${name}，请检查网络。`,
    format:'模型列表格式异常，请稍后重试。', address:'接口地址无效，请检查配置。',
    service:'模型服务暂不可用，请稍后重试。'
  };
  return messages[code] || '无法获取模型，请重新加载扩展后重试。';
}
async function refreshProviderModels(provider = connectionProvider) {
  const connection = providerConnection(provider);
  if (provider === 'custom' && !connection.apiBaseUrl) {
    providerErrors.set(provider, '请先配置自定义接口地址。');
    renderCatalogStatus();
    return;
  }
  if (!connection.apiKey || connection.apiKey !== savedKeys[provider]) return;
  const signature = JSON.stringify([connection.apiBaseUrl, connection.apiKey]);
  if (providerRequests.get(provider)?.signature === signature) return providerRequests.get(provider).promise;
  const request = {signature};
  const unchanged = () => {
    const current = providerConnection(provider);
    return JSON.stringify([current.apiBaseUrl,current.apiKey]) === signature && providerRequests.get(provider) === request;
  };
  providerRequests.set(provider,request);
  request.promise = (async () => {
    try {
      const result = await requestProviderModels(connection);
      if (!unchanged()) return;
      if (!result?.ok) {
        const error = new Error(modelFailureMessage(result,provider));
        error.modelFailure = result;
        throw error;
      }
      const entries = AIModelCatalog.interfaceModels(result.entries || result.models.map(id => ({id})), provider);
      providerConnections[provider] = { ...connection, availableModels:entries.map(m => m.id), modelEntries:entries,
        modelsCheckedAt:new Date().toISOString() };
      providerErrors.delete(provider);
      const currentSelections = tabs.map(tab => tab.select.value);
      renderAllModelOptions();
      tabs.forEach((tab,index) => setTabSelection(tab,currentSelections[index]));
      const renderedSelections = tabs.map(tab => tab.select.value);
      const stored = await chrome.storage.local.get(['providerConnections','explainManufacturer','translateManufacturer','explainModel','translateModel','modelList']);
      if (!unchanged()) return;
      // 首次从无缓存加载列表时恢复仍开放的已保存型号，不把自动首项当作用户选择。
      tabs.forEach((tab,index)=>{
        if (!currentSelections[index] && tab.select.value===renderedSelections[index] &&
            tab.manufacturer.value===provider && stored[tab.kind+'Manufacturer']===provider) {
          setTabSelection(tab,stored[tab.key]);
        }
      });
      const connections = AIConfig.normalizeConnections(stored.providerConnections);
      connections[provider] = providerConnections[provider];
      const updates = {providerConnections:connections,modelList:AIConfig.normalizeModels([...(stored.modelList||[]),...entries.map(m=>m.id)])};
      // 只更新已保存为该厂家的用途，避免把未保存的厂家选择写入后台。
      for (const tab of tabs) {
        if (stored[tab.kind+'Manufacturer'] === provider && !entries.some(m=>m.id === stored[tab.key])) {
          updates[tab.key] = entries[0]?.id || '';
        }
      }
      await chrome.storage.local.set(updates);
      for (const key of ['explainModel','translateModel']) if (Object.hasOwn(updates, key)) savedConfig[key] = updates[key];
    } catch (err) {
      if (unchanged()) {
        const cached=providerConnection(provider).modelEntries.length || providerConnection(provider).availableModels.length;
        const message = err.modelFailure ? modelFailureMessage(err.modelFailure,provider) : '无法获取模型，请重新加载扩展后重试。';
        providerErrors.set(provider,message + (cached ? ' 已保留已有列表。' : ''));
        console.warn('接口模型列表更新失败：', {provider,code:err.modelFailure?.code || 'communication',status:err.modelFailure?.status});
      }
    } finally {
      if (providerRequests.get(provider) === request) providerRequests.delete(provider);
      renderCatalogStatus();
    }
  })();
  return request.promise;
}

async function requestCatalogSnapshot() {
  const result = await queryWithFallback({type:'REFRESH_MODEL_CATALOG'},async()=>{
    const stored = await chrome.storage.local.get('catalogSnapshot');
    const snapshot = await AIModelCatalog.refresh(stored.catalogSnapshot);
    await chrome.storage.local.set({catalogSnapshot:snapshot});
    return {ok:true,snapshot};
  });
  if (!result.ok) throw new Error(result.error || '后台未提供更新结果');
  if (result.snapshot?.source !== AIModelCatalog.SOURCE || !Array.isArray(result.snapshot.providers)) throw new Error('模型目录无效');
  return {snapshot:result.snapshot};
}
async function refreshCatalog() {
  if (catalogRefreshing) return;
  catalogRefreshing = true; catalogState();
  try {
    const {snapshot} = await requestCatalogSnapshot();
    const selections = tabs.map(tab=>tab.select.value);
    catalogSnapshot = AIModelCatalog.normalizeSnapshot(snapshot);
    renderManufacturers(); renderAllModelOptions();
    tabs.forEach((tab,index)=>setTabSelection(tab,selections[index]));
    await chrome.storage.local.set({catalogLastCheckedAt:new Date().toISOString()});
    catalogState(catalogSnapshot.providers.some(p=>p.stale) ? '部分厂家的模型暂未更新，已保留已有列表。' : '');
  } catch (err) {
    catalogState('暂时无法获取模型，已保留已有列表。');
    console.warn('公开模型目录刷新失败：',err.message);
  } finally {catalogRefreshing=false;}
}

document.querySelectorAll('.tab-btn').forEach(button => button.addEventListener('click', () => {
  captureConnection();
  $('custom-connection-dialog').close();
  activeTabIndex = button.dataset.tab === 'translate' ? 1 : 0;
  document.querySelectorAll('.tab-btn').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-selected',String(b===button));});
  document.querySelectorAll('.tab-panel').forEach(p=>{const active=p.id==='panel-'+button.dataset.tab;p.classList.toggle('active',active);p.hidden=!active;});
  showConnection(); renderAllModelOptions();
}));
document.querySelector('.tab-bar').addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  const buttons = [...document.querySelectorAll('.tab-btn')];
  const index = buttons.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 2) % 2;
  buttons[next].focus(); buttons[next].click();
});
tabs.forEach(tab => tab.manufacturer.addEventListener('change', () => {
  if (tab === tabs[activeTabIndex]) {captureConnection();showConnection();}
  renderModelOptions(tab);
  refreshProviderModels(tab.manufacturer.value);
}));
for (const kind of ['explain','translate']) {
  const tab = tabs.find(tab=>tab.kind===kind);
  $(kind+'-thinking').addEventListener('change',()=>renderThinkingControls(tab));
  $(kind+'-deepseek-thinking').addEventListener('change',()=>renderThinkingControls(tab));
}
$('rewrite-key').addEventListener('click',()=>{
  editingKeys.add(connectionProvider);
  $('key-editor').hidden=false; $('rewrite-key').hidden=true; $('key-saved').hidden=true;
  $apiKey.value=''; $apiKey.focus();
});
$('cancel-key').addEventListener('click',async()=> {
  editingKeys.delete(connectionProvider);
  const provider = connectionProvider;
  const stored = await chrome.storage.local.get('providerConnections');
  providerConnections[provider] = AIConfig.normalizeConnections(stored.providerConnections)[provider] || {};
  if (connectionProvider === provider) showConnection();
  renderAllModelOptions();
});
$('save-key').addEventListener('click', async()=>{
  const key=$apiKey.value.trim(), provider=connectionProvider;
  if (!key) {$('key-msg').textContent='请输入 API Key。';$apiKey.focus();return;}
  $('save-key').disabled=true;
  try {
    captureConnection();
    const stored=await chrome.storage.local.get(['providerConnections','explainManufacturer','translateManufacturer']);
    const connections=AIConfig.normalizeConnections(stored.providerConnections);
    connections[provider]=providerConnections[provider];
    // 换 Key 只使接口列表失效；型号属于当前厂家/地址，等新列表成功返回后再纠正。
    // 查询失败或弹窗提前关闭时保留已保存的型号，避免下一次保存把它静默清空。
    const updates={providerConnections:connections,requiresApiSetup:false};
    await chrome.storage.local.set(updates);
    savedKeys[provider]=key; editingKeys.delete(provider);
    if (connectionProvider===provider) showConnection();
    renderAllModelOptions();
    refreshProviderModels(provider);
  } catch (err) {$('key-msg').textContent='保存失败，请重试。';}
  finally {$('save-key').disabled=false;}
});
$('custom-connection-button').addEventListener('click',()=>{
  $apiBaseUrl.value=providerConnection('custom').apiBaseUrl;
  $('custom-msg').textContent='';
  $('custom-connection-dialog').showModal(); $apiBaseUrl.focus();
});
$('custom-cancel').addEventListener('click',()=>$('custom-connection-dialog').close());
$('custom-save').addEventListener('click',async()=>{
  let previous;
  $('custom-save').disabled=true;
  try {
    const apiBaseUrl=AIConfig.normalizeBaseUrl($apiBaseUrl.value);
    previous=providerConnection('custom');
    // 先使旧地址的在途列表响应失效；内存仍保留未保存的 Key 草稿。
    const draftProfile={...previous,apiBaseUrl,
      ...(previous.apiBaseUrl!==apiBaseUrl ? {availableModels:[],modelEntries:[],modelsCheckedAt:''} : {})};
    providerConnections.custom=draftProfile;
    const stored=await chrome.storage.local.get(['providerConnections','explainManufacturer','translateManufacturer']);
    const connections=AIConfig.normalizeConnections(stored.providerConnections);
    const saved=connections.custom || {apiKey:'',availableModels:[],modelEntries:[],modelsCheckedAt:''};
    const changed=(saved.apiBaseUrl || '')!==apiBaseUrl;
    // 地址保存只保存地址和已保存 Key，不能顺带保存切换标签时捕获的 Key 草稿。
    const profile={...saved,apiBaseUrl,
      ...(changed ? {availableModels:[],modelEntries:[],modelsCheckedAt:''} : {})};
    connections.custom=profile;
    const updates={providerConnections:connections};
    if (changed) for (const tab of tabs) if (stored[tab.kind+'Manufacturer']==='custom') {
      updates[tab.key]=''; savedConfig[tab.key]='';
    }
    await chrome.storage.local.set(updates);
    providerConnections.custom={...profile,apiKey:draftProfile.apiKey};
    if (draftProfile.apiKey!==profile.apiKey) Object.assign(providerConnections.custom,{availableModels:[],modelEntries:[],modelsCheckedAt:''});
    providerErrors.delete('custom');
    $('custom-connection-dialog').close(); renderAllModelOptions();
    refreshProviderModels('custom');
  } catch(err) {if(previous) providerConnections.custom=previous;$('custom-msg').textContent=err.message;}
  finally {$('custom-save').disabled=false;}
});
$('save-btn').addEventListener('click',async()=>{
  try {
    captureConnection();
    renderAllModelOptions();
    const config={...manufacturerSettings(),...modelSettings(),
      explainThinkingEnabled:$('explain-thinking').checked,explainReasoningEffort:$('explain-effort').value,
      translateThinkingEnabled:$('translate-thinking').checked,translateReasoningEffort:$('translate-effort').value,
      explainDeepSeekThinkingEnabled:$('explain-deepseek-thinking').checked,
      translateDeepSeekThinkingEnabled:$('translate-deepseek-thinking').checked,
      language:$('explain-language').value,targetLanguage:$('target-language').value,
      enabled:savedConfig.enabled!==false,usePageContext:savedConfig.usePageContext!==false,
      triggerMode:$('trigger-mode').value,requiresApiSetup:false};
    await chrome.storage.local.set(config);
    savedConfig = {...savedConfig, ...config};
    for (const [provider,connection] of Object.entries(providerConnections)) savedKeys[provider]=connection.apiKey;
    editingKeys.clear();showConnection();
    const missing = tabs.filter(tab => !config[tab.key]).map(tab => tab.kind === 'explain' ? '解释' : '全文翻译');
    showStatus(missing.length ? `设置已保存；请在「${missing.join('」「')}」选择模型。` : '设置已保存。');
    const providers=new Set(tabs.map(tab=>tab.manufacturer.value));
    for (const provider of providers) refreshProviderModels(provider);
  } catch(err) {showStatus('保存失败，请重试。','error');}
});

(async()=>{
  const config=await AIConfig.load(); savedConfig=config;
  renderEnabledState();
  modelList=config.modelList.slice();
  catalogSnapshot=AIModelCatalog.normalizeSnapshot(config.catalogSnapshot);
  providerConnections=AIConfig.normalizeConnections(config.providerConnections);
  savedKeys=Object.fromEntries(Object.entries(providerConnections).map(([id,c])=>[id,c.apiKey]));
  renderManufacturers();
  for (const tab of tabs) {
    tab.manufacturer.value=config[tab.kind+'Manufacturer'];
    $(tab.kind+'-thinking').checked=config[tab.kind+'ThinkingEnabled']===true;
    $(tab.kind+'-deepseek-thinking').checked=config[tab.kind+'DeepSeekThinkingEnabled']===true;
    $(tab.kind+'-effort').value=config[tab.kind+'ReasoningEffort']||'high';
    $(tab.kind+'-effort-section').style.display=$(tab.kind+'-thinking').checked ? '' : 'none';
  }
  $('explain-language').value=config.language||'auto';$('target-language').value=config.targetLanguage||'zh';
  $('trigger-mode').value=config.triggerMode;
  showConnection();renderAllModelOptions();
  tabs.forEach(tab=>setTabSelection(tab,config[tab.key]));
  refreshCatalog();
  for (const provider of new Set(tabs.map(tab=>tab.manufacturer.value))) refreshProviderModels(provider);
})().catch(err=>showStatus('读取设置失败，请重新打开。','error'));
