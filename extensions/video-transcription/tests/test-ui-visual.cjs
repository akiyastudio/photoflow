const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const app = read('ui/app.js'); const autoStart = read('ui/auto-start-model.js'); const settings = read('ui/settings.js'); const saveModel = read('ui/settings-save-model.js'); const index = read('ui/index.html'); const settingsHtml = read('ui/settings.html'); const style = read('ui/style.css'); const tokens = read('ui/host-api-ui.css');
const icon = read('ui/icon.svg');
const officialTokens = fs.readFileSync(path.join(repo, 'component-sdk', 'ui.css'), 'utf8');

for (const contractToken of ['--pf-canvas', '--pf-surface', '--pf-border', '--pf-text', '--pf-primary', '--pf-focus', '--pf-radius-sm', '--pf-control-md', '.pf-card', '.pf-button', '.pf-input']) assert(tokens.includes(contractToken) && officialTokens.includes(contractToken), `vendored Host API UI contract is missing ${contractToken}`);
for (const token of ['--pf-canvas', '--pf-surface', '--pf-border', '--pf-text', '--pf-primary', '--pf-focus', '--pf-radius-sm', '--pf-control-md']) assert(tokens.includes(token));
assert(tokens.includes('html.dark')); assert(tokens.includes('prefers-reduced-motion')); assert(tokens.includes(':focus-visible'));
assert(style.includes('var(--pf-canvas)')); assert(style.includes('var(--pf-border-subtle)')); assert(!/radial-gradient|#11100e|#e9a23b/i.test(style));
assert(icon.includes('#2563eb')); assert(!/#191713|#e9a23b/i.test(icon));
assert(index.includes('host-api-ui.css')); assert(settingsHtml.includes('host-api-ui.css')); assert(!index.includes('source-grid')); assert(!index.includes('class="hero"'));
for (const source of [app, autoStart, index, settingsHtml, settings]) { assert(!source.includes('data-start')); assert(!source.includes('openFiles')); assert(!source.includes('openDirectory')); assert(!source.includes('transcript.inputs.start.v1')); }
assert(autoStart.includes("context?.surface === 'project.contextAction'")); assert(autoStart.includes("context?.surface === 'project'")); assert(!autoStart.includes("surface === 'media.contextAction'")); assert(app.includes("rpc('transcript.project.start.v1'")); assert(app.includes("rpc('transcript.operation.run.v1'"));
assert(autoStart.includes("storage.getItem(key)")); assert(autoStart.includes("storage.setItem(key, 'started')")); assert(app.includes('api.onContextChange')); assert(app.includes('autoStartGate.contextChanged(context)')); assert(!/onActivate\([^)]*startCurrentSelection/.test(app));
assert(index.includes('auto-start-model.js') && index.indexOf('auto-start-model.js') < index.indexOf('app.js'));
for (const source of [app, settings]) { assert(source.includes("classList.toggle('dark'")); assert(source.includes('style.colorScheme')); assert(source.includes('onThemeChange')); }
assert(index.includes('重新处理当前选择')); assert(index.includes('请回到文件页面'));
assert.equal((settingsHtml.match(/class="settings-group"/g) || []).length, 3); assert.equal((settingsHtml.match(/class="settings-card"/g) || []).length, 3); assert.equal((settingsHtml.match(/class="setting-row"/g) || []).length, 9);
for (const title of ['识别', '性能', '算法运行时']) assert(new RegExp(`<section class="settings-group">\\s*<h2>${title}</h2>\\s*<div class="settings-card">`).test(settingsHtml), `${title} heading must remain outside its card`);
assert(!settingsHtml.includes('settings-group-title')); assert(!settingsHtml.includes('class="settings-save"')); assert(!settingsHtml.includes('保存设置')); assert(!settingsHtml.includes('type="submit"'));
for (const obsoleteSelector of ['settings-group-title', 'settings-rows', 'settings-save', 'runtime-card']) assert(!style.includes(obsoleteSelector), `obsolete settings selector remains in CSS: ${obsoleteSelector}`);
assert.equal((style.match(/\/\* SettingsPage \/ SettingsPageGroup \/ SettingsRow contract\. \*\//g) || []).length, 1, 'settings CSS must have one authoritative contract block');
for (const declaration of ['.settings-main{display:grid', '#settings-form{display:grid', '.settings-card{display:block', '.setting-row{display:grid']) assert.equal((style.match(new RegExp(declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1, `non-media settings declaration must be unique: ${declaration}`);
assert(!style.includes('.settings-main{max-width:860px')); assert(!style.includes('grid-template-columns:190px minmax(0,1fr)')); assert(!style.includes('.setting-row{display:flex'));
for (const contract of ['max-width:1152px', 'padding:40px 32px', 'gap:40px', 'font-size:24px', 'gap:12px', 'padding:14px 16px', 'grid-template-columns:minmax(220px,1fr) minmax(280px,1.25fr)', 'max-width:384px', '.setting-row+.setting-row{border-top:1px solid var(--pf-border-subtle)}', '@media(max-width:800px){.setting-row{grid-template-columns:1fr']) assert(style.includes(contract), `settings CSS is missing ${contract}`);
assert(style.includes('.settings-header #save-status,.settings-header #save-status:empty{position:absolute'), 'save feedback must not shift the settings layout');
for (const token of ['var(--pf-canvas)', 'var(--pf-surface)', 'var(--pf-border-subtle)', 'var(--pf-text)', 'var(--pf-text-strong)', 'var(--pf-muted)', 'var(--pf-primary)', 'var(--pf-focus)', 'var(--pf-danger)']) assert(`${style}\n${tokens}`.includes(token), `settings styling must use official token ${token}`);
assert(settingsHtml.includes('role="status"')); assert(settings.includes("form.addEventListener('change'")); assert(!settings.includes("form.addEventListener('submit'")); assert(settings.includes("window.addEventListener('pagehide'")); assert(settings.includes('initialized = true')); assert(saveModel.includes('maxWait = 1200')); assert(saveModel.includes('if (running || !pending) return')); assert(settingsHtml.indexOf('settings-save-model.js') < settingsHtml.indexOf('settings.js'));
assert(tokens.includes('html.dark')); assert(settings.includes("classList.toggle('dark'")); assert(settings.includes('style.colorScheme')); assert(settings.includes('onThemeChange'));
console.log('video-transcription official visual tokens, theme synchronization, selection-only entry, and auto-start contract tests passed');
