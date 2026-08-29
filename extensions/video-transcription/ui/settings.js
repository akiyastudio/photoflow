(() => {
  'use strict';
  const api = window.photoFlowComponent;
  const form = document.querySelector('#settings-form');
  const status = document.querySelector('#save-status');
  let initialized = false;
  let newestRevision = 0;
  const applyTheme = resolvedTheme => { const dark = resolvedTheme === 'dark'; document.documentElement.classList.toggle('dark', dark); document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; };
  const setStatus = (state, revision, detail) => {
    if (revision < newestRevision) return;
    status.dataset.state = state;
    status.textContent = state === 'saving' ? '正在保存…' : state === 'saved' ? '已保存' : `保存失败：${detail?.message || '未知错误'}`;
  };
  const values = () => {
    const result = Object.fromEntries(new FormData(form));
    for (const name of ['vadFilter', 'simplifyChinese', 'cpuFallback']) result[name] = form.elements[name].checked;
    result.beamSize = Number(result.beamSize);
    return result;
  };
  const apply = settings => {
    for (const element of form.elements) {
      if (!element.name) continue;
      if (element.type === 'checkbox') element.checked = settings[element.name] !== false;
      else element.value = settings[element.name] ?? (element.name === 'language' ? 'auto' : '');
    }
  };
  const saver = window.VideoTranscriptionSettingsSave.createDebouncedSerialSaver({
    save: payload => api.rpc('transcript.settings.update.v1', payload),
    onState: (state, revision, result) => {
      setStatus(state, revision, result);
      if (state === 'saved' && revision === newestRevision && result?.settings) apply(result.settings);
    },
  });
  const diagnose = async () => {
    const node = document.querySelector('#runtime-detail');
    const button = document.querySelector('#diagnose');
    node.textContent = '正在诊断…';
    button.disabled = true;
    try {
      const result = await api.rpc('transcript.runtime.status.v1', {});
      node.textContent = result.ready ? `可用（${result.source}${result.packaged ? '，自包含发布运行时' : ''}）` : `不可用：${result.message}`;
      node.dataset.ready = String(result.ready);
    } catch (error) { node.textContent = error.message; }
    finally { button.disabled = false; }
  };
  form.addEventListener('change', () => {
    if (!initialized) return;
    newestRevision = saver.schedule(values());
  });
  window.addEventListener('pagehide', () => saver.flush());
  document.querySelector('#diagnose').addEventListener('click', diagnose);
  api.rpc('transcript.settings.get.v1', {}).then(result => { apply(result.settings); initialized = true; }).catch(error => { status.dataset.state = 'failed'; status.textContent = `读取失败：${error.message}`; });
  void diagnose();
  api.getContext().then(context => applyTheme(context.resolvedTheme));
  api.onThemeChange(value => applyTheme(value.resolvedTheme));
})();
