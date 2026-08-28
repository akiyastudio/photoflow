(() => {
  'use strict';
  const api = window.photoFlowComponent; const form = document.querySelector('#settings-form'); const status = document.querySelector('#save-status');
  const diagnose = async () => { const node = document.querySelector('#runtime-detail'); node.textContent = '正在诊断…'; try { const result = await api.rpc('transcript.runtime.status.v1', {}); node.textContent = result.ready ? `可用（${result.source}${result.packaged ? '，自包含发布运行时' : ''}）` : `不可用：${result.message}`; node.dataset.ready = String(result.ready); } catch (error) { node.textContent = error.message; } };
  const apply = settings => { for (const element of form.elements) if (element.name) element.type === 'checkbox' ? element.checked = settings[element.name] !== false : element.value = settings[element.name] ?? (element.name === 'language' ? 'auto' : ''); };
  form.addEventListener('submit', async event => { event.preventDefault(); status.textContent = '保存中…'; const values = Object.fromEntries(new FormData(form)); for (const name of ['vadFilter', 'simplifyChinese', 'cpuFallback']) values[name] = form.elements[name].checked; values.beamSize = Number(values.beamSize); try { const result = await api.rpc('transcript.settings.update.v1', values); apply(result.settings); status.textContent = '已保存'; } catch (error) { status.textContent = error.message; } });
  document.querySelector('#diagnose').addEventListener('click', diagnose); api.rpc('transcript.settings.get.v1', {}).then(result => apply(result.settings)).catch(error => { status.textContent = error.message; }); void diagnose();
})();
