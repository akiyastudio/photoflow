const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.template.json'), 'utf8'));
const settings = fs.readFileSync(path.join(root, 'renderer', 'src', 'team-settings-content.tsx'), 'utf8') + fs.readFileSync(path.join(root, 'renderer', 'src', 'settings-main.tsx'), 'utf8');
assert(manifest.componentHost.contributions.some(item => item.type === 'application.settingsPage' && item.id === 'settings'));
const page = manifest.componentHost.contributions.find(item => item.type === 'application.settingsPage' && item.id === 'settings');
for (const method of ['team.advanced.preflight.v1', 'team.advanced.package.verify.v1', 'team.advanced.install.v1', 'team.advanced.uninstall.v1', 'team.operation.run.v1', 'team.operation.get.v1']) {
  assert(page.rpcMethods.includes(method), `Settings durable lifecycle flow is missing Host permission: ${method}`);
}
assert(settings.includes("team.settings.update.v1"));
for (const label of ['检查安装环境', '打开高级版安装目录', '检测安装包', '安装增强版', '卸载增强版']) assert(settings.includes(label), `Guided advanced setup is missing: ${label}`);
assert.equal(settings.includes('developmentRuntime'), false, 'development runtime no longer hides lifecycle management');
assert(settings.includes("dedupeKey: 'team-advanced-setup-error'"), 'advanced setup errors use one stable notification dedupe key');
assert(manifest.componentHost.service.lifecycleActions['verify-package'], 'package verification has a declared lifecycle action');
console.log('Team-retouch current settings contract passed');
