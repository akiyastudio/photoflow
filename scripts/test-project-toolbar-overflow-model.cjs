const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/features/workspace/project-toolbar-overflow-model.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const model = { exports: {} };
new Function('module', 'exports', compiled)(model, model.exports);
const { resolveProjectToolbarOverflow } = model.exports;
const actions = {
  primary: ['rename', 'copy'],
  contextual: ['image-tools', 'video-tools'],
  components: ['component:one', 'component:two'],
};

assert.deepStrictEqual(resolveProjectToolbarOverflow(1200, actions), {
  visible: ['rename', 'copy', 'image-tools', 'video-tools', 'component:one', 'component:two'], overflow: [],
}, 'wide toolbars keep built-in and every contributed component action visible');
assert.deepStrictEqual(resolveProjectToolbarOverflow(900, actions), {
  visible: ['image-tools', 'video-tools', 'component:one', 'component:two'], overflow: ['rename', 'copy'],
}, 'the first tier only collapses primary file operations');
assert.deepStrictEqual(resolveProjectToolbarOverflow(700, actions), {
  visible: [], overflow: ['rename', 'copy', 'image-tools', 'video-tools', 'component:one', 'component:two'],
}, 'narrow toolbars merge built-in contextual tools and all component contributions into overflow');
assert.deepStrictEqual([700, 1200].map(width => resolveProjectToolbarOverflow(width, actions).visible), [
  [], ['rename', 'copy', 'image-tools', 'video-tools', 'component:one', 'component:two'],
], 'actions return to the toolbar after resize restores available width');

const layout = fs.readFileSync(path.join(root, 'src/features/workspace/ProjectWorkspaceLayout.tsx'), 'utf8');
const workspace = fs.readFileSync(path.join(root, 'src/features/workspace/ProjectWorkspace.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');
assert(layout.includes("overflow ? 'project-menu-item' : 'project-action-button'") && layout.includes("role={overflow ? 'menuitem' : undefined}"), 'component contributions have a normal accessible overflow-menu rendering');
assert(workspace.includes('<ComponentToolbarActions overflow actions={componentHostActions}') && css.includes('.project-toolbar-component-actions { display:none !important; }'), 'the contextual breakpoint swaps independent component entries for menu entries');
assert(workspace.includes('event.key === \'Escape\'') && workspace.includes('previousElementSibling'), 'Escape closes the overflow menu and restores trigger focus');
assert(workspace.includes("window.visualViewport?.addEventListener('resize', closeToolbarOverflow)") && workspace.includes('setShowToolbarOverflowMenu(false)'), 'window resize and display zoom close stale overflow menus before responsive placement changes');
console.log('Project toolbar overflow model tests passed');
