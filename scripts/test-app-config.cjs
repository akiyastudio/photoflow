const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

global.window = { navigator: { userAgent: 'node' } };
const root = path.join(__dirname, '..');
const compile = relative => ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleUnderTest = { exports: {} };
new Function('module', 'exports', 'require', compile('src/features/app/app-config.ts'))(moduleUnderTest, moduleUnderTest.exports, request => {
  if (request === '../../types') return { BUILT_IN_PROJECT_STATUSES: ['未分类', '进行中'], DEFAULT_PROGRESS_NAME_PRESETS: ['修图'], PROJECT_TOOLBAR_ACTION_IDS: ['video-tools', 'image-tools', 'backup'] };
  if (request === './video-player-settings') return { DEFAULT_SUBTITLE_FONT_SIZE: 32 };
  if (request === '../../contracts/video-shortcuts') return { defaultVideoShortcutBindings: () => [] };
  return require(request);
});
const { DEFAULT_CONFIG, normalizeProjectToolbar } = moduleUnderTest.exports;
assert.deepEqual(normalizeProjectToolbar({ order: ['storyboard', 'backup'], hidden: ['video-split', 'png-converter'] }), { order: ['video-tools', 'backup', 'image-tools'], hidden: ['video-tools', 'image-tools'], onlyShowAvailable: false }, 'legacy hidden ids migrate with the same mapping while saved order stays authoritative');
const first = DEFAULT_CONFIG('C:/one');
const second = DEFAULT_CONFIG('C:/two');
first.homeOrder.push('mutated');
assert(!second.homeOrder.includes('mutated'), 'default config calls must not share mutable arrays');
console.log('app config regression tests passed');
