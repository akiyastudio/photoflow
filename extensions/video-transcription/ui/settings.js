(() => {
  'use strict';
  const api = window.photoFlowComponent;
  const form = document.querySelector('#settings-form');
  const language = document.querySelector('#language-select');
  const model = document.querySelector('#model-select');
  const beamSize = document.querySelector('#beam-size');
  const vadFilter = document.querySelector('#vad-filter');
  const simplifyChinese = document.querySelector('#simplify-chinese');
  const device = document.querySelector('#device-select');
  const computeType = document.querySelector('#compute-type');
  const cpuFallback = document.querySelector('#cpu-fallback');
  const saveStatus = document.querySelector('#save-status');
  let initialized = false;
  let newestRevision = 0;

  const applyTheme = resolvedTheme => { const dark = resolvedTheme === 'dark'; document.documentElement.classList.toggle('dark', dark); document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; };
  const setSaveStatus = (state, revision, detail = '') => { if (revision < newestRevision) return; saveStatus.textContent = state === 'saving' ? '正在保存…' : state === 'saved' ? '已保存' : state === 'failed' ? `保存失败：${detail || '未知错误'}` : ''; saveStatus.dataset.state = state; };
  const applySettings = settings => {
    language.value = settings.language || 'auto';
    if (settings.model) model.value = settings.model;
    beamSize.value = String(settings.beamSize ?? 5);
    vadFilter.checked = settings.vadFilter !== false;
    simplifyChinese.checked = settings.simplifyChinese !== false;
    device.value = settings.device || 'cuda';
    computeType.value = settings.computeType || (device.value === 'cpu' ? 'int8' : 'float16');
    cpuFallback.checked = settings.cpuFallback !== false;
  };
  const values = () => {
    const result = {
      language: language.value,
      beamSize: Math.min(10, Math.max(1, Number(beamSize.value) || 5)),
      vadFilter: vadFilter.checked,
      simplifyChinese: simplifyChinese.checked,
      device: device.value,
      computeType: computeType.value,
      cpuFallback: cpuFallback.checked,
    };
    const selectedModel = model.selectedOptions[0];
    if (!model.disabled && model.value && !selectedModel?.disabled) result.model = model.value;
    return result;
  };
  const saver = window.VideoTranscriptionSettingsSave.createDebouncedSerialSaver({
    save: patch => api.rpc('transcript.settings.update.v1', patch),
    onState: (state, revision, result) => { setSaveStatus(state, revision, result?.message); if (state === 'saved' && revision === newestRevision && result?.settings) applySettings(result.settings); },
  });
  const scheduleSave = () => { if (initialized) newestRevision = saver.schedule(values()); };
  const populateModels = (modelResult, currentModel) => {
    const installed = modelResult.models.filter(item => item.installed);
    model.replaceChildren();
    for (const item of installed) { const option = document.createElement('option'); option.value = item.id; option.textContent = `${item.label} · ${item.category}`; model.append(option); }
    if (currentModel && !installed.some(item => item.id === currentModel)) { const option = document.createElement('option'); option.value = currentModel; option.textContent = `${currentModel} · 未安装`; option.disabled = true; model.append(option); }
    model.disabled = installed.length === 0;
    if (currentModel) model.value = currentModel;
    document.querySelector('#model-summary').textContent = installed.length ? `已安装 ${installed.length} 个：${installed.map(item => item.id).join('、')}` : '未发现完整模型；请手动安装后刷新';
    document.querySelector('#model-placement').textContent = `放置位置：${modelResult.placement}`;
  };
  const loadSettings = async () => {
    initialized = false;
    const [settingsResult, modelResult] = await Promise.all([api.rpc('transcript.settings.get.v1', {}), api.rpc('transcript.models.list.v1', {})]);
    populateModels(modelResult, settingsResult.settings.model);
    applySettings(settingsResult.settings);
    initialized = true;
  };
  const refreshModels = async () => { const currentModel = model.value; populateModels(await api.rpc('transcript.models.list.v1', {}), currentModel); };
  const diagnose = async () => {
    const detail = document.querySelector('#runtime-detail'); const button = document.querySelector('#diagnose'); detail.textContent = '正在诊断…'; button.disabled = true;
    try { const result = await api.rpc('transcript.runtime.status.v1', {}); const source = ({ 'host-development': '开发环境', 'plugin-development': '插件私有环境', packaged: '内置运行时', 'system-python': '系统 Python', 'environment-python': '自定义 Python', environment: '自定义运行时' })[result.source] || '本地运行时'; detail.textContent = result.ready ? `可用（${source}${result.packaged ? '，自包含发布运行时' : ''}）` : `不可用（${source}）：${result.message}`; detail.dataset.ready = String(result.ready); }
    catch (error) { detail.textContent = error.message; } finally { button.disabled = false; }
  };

  form.addEventListener('change', scheduleSave);
  window.addEventListener('pagehide', () => saver.flush());
  document.querySelector('#refresh-models').addEventListener('click', () => void refreshModels().catch(error => { document.querySelector('#model-summary').textContent = error.message; }));
  document.querySelector('#diagnose').addEventListener('click', () => void diagnose());
  api.getContext().then(context => applyTheme(context.resolvedTheme));
  api.onThemeChange(value => applyTheme(value.resolvedTheme));
  api.onActivate(() => { void Promise.all([refreshModels(), diagnose()]); });
  void Promise.all([loadSettings(), diagnose()]).catch(error => setSaveStatus('failed', newestRevision, error.message));
})();
