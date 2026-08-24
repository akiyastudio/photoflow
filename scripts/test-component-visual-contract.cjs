const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const contract = read('component-sdk/ui.css');
const hostStyle = read('src/index.css');
const html = read('extensions/team-retouch/renderer/index.html');
const entry = read('extensions/team-retouch/renderer/src/legacy-main.tsx');
const style = read('extensions/team-retouch/renderer/src/legacy-style.css');
const steps = read('extensions/team-retouch/renderer/src/legacy/TeamRetouchSteps.tsx');
const dialogs = read('extensions/team-retouch/renderer/src/legacy/legacy-dialog.tsx');
const activeEntry = read('extensions/team-retouch/renderer/ACTIVE_ENTRY.md');

for (const token of ['canvas', 'surface', 'subtle', 'elevated', 'border', 'text', 'muted', 'primary', 'focus', 'success', 'warn', 'danger', 'radius-sm', 'shadow-sm', 'space-3', 'control-md']) assert(contract.includes(`--pf-${token}:`), `shared UI contract missing --pf-${token}`);
for (const primitive of ['.pf-canvas', '.pf-surface', '.pf-card', '.pf-toolbar', '.pf-modal', '.pf-button', '.pf-input', '.pf-banner', '.pf-status']) assert(contract.includes(primitive), `shared UI primitive missing ${primitive}`);
assert(hostStyle.includes("@import '../component-sdk/ui.css'"), 'host must consume the shared component UI contract');
for (const tokenUse of ['var(--pf-canvas)', 'var(--pf-surface)', 'var(--pf-subtle)', 'var(--pf-border)', 'var(--pf-border-subtle)', 'var(--pf-text)', 'var(--pf-muted)', 'var(--pf-primary)', 'var(--pf-focus)']) assert(hostStyle.includes(tokenUse), `host core utility mapping does not consume ${tokenUse}`);
assert(entry.includes("import '../../../../component-sdk/ui.css'"), 'active team renderer must consume the same contract source');
assert(entry.includes("document.body.classList.add('legacy-root', 'pf-canvas')"), 'portal roots must remain inside the active renderer theme scope');
assert(entry.includes('onActivate') && entry.includes('onDeactivate') && entry.includes('componentActive') && entry.includes('stopActivate()') && entry.includes('stopDeactivate()'), 'active entry must suspend and resume component work with WebContentsView visibility');
for (const semanticDom of ['team-shell', 'team-toolbar', 'team-card', 'pf-card', 'pf-modal']) assert(entry.includes(semanticDom) || steps.includes(semanticDom) || dialogs.includes(semanticDom), `active state DOM missing shared primitive ${semanticDom}`);
assert(html.includes('/src/legacy-main.tsx') && !html.includes('/src/main.tsx'), 'legacy-main must remain the only production entry');
assert(activeEntry.includes('non-production migration') && activeEntry.includes('not imported by the HTML entry') && activeEntry.includes('visual source of'), 'inactive renderer reference must be explicitly isolated');
assert(!/linear-gradient|radial-gradient|(?:#6d5dfc|#9b62ef|#6558e8)/i.test(style), 'active CSS must not introduce gradients or a purple product palette');
assert((style.match(/#[0-9a-f]{6}/gi) || []).every(value => ['#ffffff', '#020617'].includes(value.toLowerCase())), 'product colors belong in the shared contract');
for (const tokenUse of ['var(--pf-canvas)', 'var(--pf-surface)', 'var(--pf-border-subtle)', 'var(--pf-text)', 'var(--pf-primary)', 'var(--pf-focus)']) assert(style.includes(tokenUse), `active CSS does not use ${tokenUse}`);
assert(steps.includes('pf-surface') && steps.includes('pf-button') && dialogs.includes('pf-modal-backdrop') && dialogs.includes('pf-modal') && dialogs.includes('pf-input'), 'key navigation and dialog DOM must use shared primitives');
assert(style.includes('@media (max-width: 1120px)') && style.includes('@media (max-width: 760px)') && style.includes('overflow-x: auto'), 'active renderer must retain compact and narrow responsive behavior');
assert(contract.includes('prefers-reduced-motion') && contract.includes(':focus-visible'), 'shared contract must cover reduced motion and keyboard focus');

console.log('Component visual contract tests passed');
