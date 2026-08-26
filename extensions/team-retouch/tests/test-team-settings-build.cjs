const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist', 'ui');
const settingsHtml = fs.readFileSync(path.join(dist, 'settings.html'), 'utf8');
const cssFiles = fs.readdirSync(path.join(dist, 'assets')).filter(name => name.endsWith('.css'));
assert(cssFiles.length > 0, 'independent plugin build must emit CSS assets');
const css = cssFiles.map(name => fs.readFileSync(path.join(dist, 'assets', name), 'utf8')).join('\n');
assert(!css.includes('@tailwind'), 'compiled plugin CSS must not retain Tailwind directives');
for (const marker of ['.team-settings-container', '.team-settings-row', '.team-settings-select', '.team-settings-button', '.animate-spin', '.sr-only']) {
  assert(css.includes(marker), `compiled settings CSS missing representative Host/utility style: ${marker}`);
}
const linkedCss = [...settingsHtml.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map(match => match[1]);
assert(linkedCss.length > 0, 'settings.html must reference compiled CSS');
for (const href of linkedCss) assert(fs.existsSync(path.resolve(dist, href)), `settings.html references missing CSS: ${href}`);
assert(settingsHtml.includes('<div id="app"></div>'), 'settings.html retains the isolated application.settings mount');

console.log('Team settings independent-build contract tests passed');
