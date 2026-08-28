const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.json'), 'utf8'));
const required = [manifest.icon, ...manifest.requiredFiles, ...Object.values(manifest.componentHost.service.entrypoints), ...manifest.componentHost.contributions.map(item => item.entry).filter(Boolean)];
for (const relative of new Set(required)) {
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(`${root}${path.sep}`) || !fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing or unsafe component file: ${relative}`);
}
console.log(`Verified ${new Set(required).size} video-transcription component files.`);
