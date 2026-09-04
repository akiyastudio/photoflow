const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.template.json'), 'utf8'));
const settings = fs.readFileSync(path.join(root, 'renderer', 'src', 'team-settings-content.tsx'), 'utf8') + fs.readFileSync(path.join(root, 'renderer', 'src', 'settings-main.tsx'), 'utf8');
assert(manifest.componentHost.contributions.some(item => item.type === 'application.settingsPage' && item.id === 'settings'));
assert(settings.includes("team.settings.update.v1"));
console.log('Team-retouch current settings contract passed');
