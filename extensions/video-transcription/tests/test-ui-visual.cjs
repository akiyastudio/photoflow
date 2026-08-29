const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const repo = path.resolve(root, '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const app = read('ui/app.js'); const autoStart = read('ui/auto-start-model.js'); const settings = read('ui/settings.js'); const index = read('ui/index.html'); const settingsHtml = read('ui/settings.html'); const style = read('ui/style.css'); const tokens = read('ui/host-api-ui.css');
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
assert(index.includes('重新处理当前选择')); assert(index.includes('请回到文件页面')); assert(settingsHtml.includes('settings-card pf-card')); assert(settingsHtml.includes('setting-row'));
console.log('video-transcription official visual tokens, theme synchronization, selection-only entry, and auto-start contract tests passed');
