const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const absolute = path.join(directory, entry.name);
  if (entry.isDirectory()) return entry.name === 'compatibility' ? [] : walk(absolute);
  return /\.(?:cjs|mjs|js|ts|tsx)$/.test(entry.name) ? [absolute] : [];
});
const coreFiles = [
  path.join(root, 'electron', 'main.cjs'),
  ...walk(path.join(root, 'electron', 'services')),
  path.join(root, 'src', 'App.tsx'),
  path.join(root, 'src', 'features', 'settings', 'SettingsFeature.tsx'),
  path.join(root, 'src', 'features', 'inspiration', 'InspirationLibrary.tsx'),
];
const forbidden = [
  ['playback component id', /video-playback-mpv/],
  ['component-owned transcode script', /ffmpeg_transcode\.py/],
  ['component-owned cut script', /cut_video\.py/],
  ['component-owned progress event', /video-tools\.operation\.progress\.v1/],
  ['component-owned process action', /['"]video\.(?:transcode|split)['"]/],
  ['fixed video-tools runtime lookup', /(?:runJson|resolveRunConfig|componentRuntimeIsAvailable)\([^\n]*['"]video-tools['"]/],
];

for (const file of coreFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const [label, pattern] of forbidden) assert(!pattern.test(source), `${label} leaked into core: ${path.relative(root, file)}`);
}

const compatibilityFiles = walk(path.join(root, 'electron', 'compatibility'));
for (const file of compatibilityFiles) {
  const source = fs.readFileSync(file, 'utf8');
  if (forbidden.some(([, pattern]) => pattern.test(source))) assert.match(source, /Delete|删除|remove/i, `compatibility exception needs a deletion note: ${path.relative(root, file)}`);
}

console.log('Plugin implementation boundary leak gate passed.');
