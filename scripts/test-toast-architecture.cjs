const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const isolatedComponentDirectory = ['team', 'retouch'].join('-');
const sourceRoots = ['src', 'extensions']
  .map(directory => path.join(root, directory))
  .filter(directory => fs.existsSync(directory));
const ignoredDirectories = new Set(['node_modules', 'artifacts', 'dist', 'build', '.git']);

const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  if (ignoredDirectories.has(entry.name)) return [];
  const absolute = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(absolute) : [absolute];
});
const relative = file => path.relative(root, file).replaceAll('\\', '/');
const read = file => fs.readFileSync(file, 'utf8');
const occurrences = (source, pattern) => [...source.matchAll(pattern)].length;
const lineOf = (source, index) => source.slice(0, index).split(/\r?\n/).length;

const productFiles = sourceRoots.flatMap(walk);
const reactFiles = productFiles.filter(file => /\.(?:jsx|tsx)$/.test(file));
const styleFiles = productFiles.filter(file => /\.css$/.test(file));

// The provider and viewport are root infrastructure, not page-level conveniences.
const mainFile = path.join(root, 'src', 'main.tsx');
const mainSource = read(mainFile);
const providerUsages = reactFiles.flatMap(file => {
  const source = read(file);
  return occurrences(source, /<TopToastProvider\b/g)
    ? Array.from({ length: occurrences(source, /<TopToastProvider\b/g) }, () => relative(file))
    : [];
});
const viewportUsages = reactFiles.flatMap(file => {
  const source = read(file);
  return occurrences(source, /<TopToastViewport\b/g)
    ? Array.from({ length: occurrences(source, /<TopToastViewport\b/g) }, () => relative(file))
    : [];
});

assert.deepEqual(providerUsages, ['src/main.tsx'], 'TopToastProvider must be mounted exactly once at the renderer root');
assert.deepEqual(viewportUsages, ['src/main.tsx'], 'TopToastViewport must be the single renderer-root toast outlet');
assert.match(mainSource, /import\s*\{[^}]*\bTopToastProvider\b[^}]*\bTopToastViewport\b[^}]*\}\s*from\s*['"]\.\/features\/app\/useTopToastStack(?:\.tsx)?['"]/, 'the root toast provider and viewport must come from the unified toast module');

// Known page-local notification implementations must not return under new names.
const legacyChecks = [
  ['src/components/ProjectNavigator.tsx', /\bcreateNotice\b/, 'ProjectNavigator.createNotice'],
  ['src/features/workspace/ProjectWorkspace.tsx', /\bprogressTask\b/, 'ProjectWorkspace.progressTask'],
];
for (const [filename, pattern, label] of legacyChecks) {
  const absolute = path.join(root, filename);
  if (fs.existsSync(absolute)) assert.doesNotMatch(read(absolute), pattern, `${label} must use the unified toast stack or BackgroundTask`);
}
const appSource = read(path.join(root, 'src', 'App.tsx'));
const workspaceSource = read(path.join(root, 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'));
const settingsSource = read(path.join(root, 'src', 'features', 'settings', 'SettingsFeature.tsx'));
const trackingSource = read(path.join(root, 'src', 'features', 'versioning', 'TrackingConfirmationPanel.tsx'));
const trackingIpcSource = read(path.join(root, 'electron', 'modules', 'version-tracking-ipc.cjs'));
for (const [source, pattern, label] of [
  [appSource, /手动备份已开始/, 'manual backup started'],
  [settingsSource, /备份(?:清理)?任务已开始|备份验证已开始/, 'backup task started'],
  [workspaceSource, /已开始后台比较|正在后台比较版本|视频剪辑失败：\$\{task\./, 'workspace BackgroundTask duplicate'],
  [trackingSource, /已转入后台提交|提交跟踪结果失败|跟踪结果已提交。/, 'tracking commit duplicate'],
]) assert.doesNotMatch(source, pattern, `${label} must be represented only by its BackgroundTask card`);

const trackingCommitSource = trackingSource.slice(trackingSource.indexOf('const commit = () =>'), trackingSource.indexOf('const release = async'));
const trackingCommitFailureStart = trackingCommitSource.indexOf('if (!result.success)');
const trackingCommitReleaseStart = trackingCommitSource.indexOf('const released');
assert(trackingCommitFailureStart >= 0 && trackingCommitReleaseStart > trackingCommitFailureStart, 'tracking commit failure and release boundaries must remain inspectable');
assert.doesNotMatch(trackingCommitSource.slice(0, trackingCommitReleaseStart), /\bonNotice\s*\(|trackingCommitFailureMessage/, 'tracking commit failure must not emit a renderer notice under a renamed helper or catch path');
assert.match(trackingIpcSource, /type:\s*'version-tracking-commit'[\s\S]*?notificationPolicy:\s*'progress-toast'/, 'tracking commit status and failures must be owned by the BackgroundTask progress-toast card');

const domainHealthFile = path.join(root, 'src', 'features', 'app', 'DomainHealthBanner.tsx');
if (fs.existsSync(domainHealthFile)) {
  const source = read(domainHealthFile);
  assert.match(source, /\bapp-titlebar-control\b/, 'domain health actions must live in the normal titlebar content');
  assert.doesNotMatch(source, /<div\b[^>]*\brole=['"]status['"][^>]*(?:\bfixed\b|\bsticky\b|\bborder-b\b)/s, 'DomainHealthBanner must not restore its page-top banner JSX');
}

const teamLegacyMain = path.join(root, 'extensions', isolatedComponentDirectory, 'renderer', 'src', 'legacy-main.tsx');
if (fs.existsSync(teamLegacyMain)) {
  const source = read(teamLegacyMain);
  assert.doesNotMatch(source, /role=['"](?:status|alert)['"][^>]*className=['"][^'"]*\bfixed\b[^'"]*\btop-/, 'legacy component warnings/errors must use the host toast API');
}

const teamManager = path.join(root, 'extensions', isolatedComponentDirectory, 'renderer', 'src', 'legacy', ['Team', 'RetouchManager.tsx'].join(''));
if (fs.existsSync(teamManager)) {
  const source = read(teamManager);
  assert.doesNotMatch(source, /className=\{`team-banner\b/, 'advanced component status must live in normal page content, not a top banner');
  assert.doesNotMatch(source, /\{running\s*&&\s*<div\s+className=['"]border-b\b/, 'batch recognition progress must use BackgroundTask instead of a page-top progress strip');
}

const teamRendererMain = path.join(root, 'extensions', isolatedComponentDirectory, 'renderer', 'src', 'main.tsx');
if (fs.existsSync(teamRendererMain)) {
  assert.doesNotMatch(read(teamRendererMain), /className=['"]task-progress['"]/, 'component workflow progress must not render its own sticky top strip');
}
const teamRendererStyle = path.join(root, 'extensions', isolatedComponentDirectory, 'renderer', 'src', 'style.css');
if (fs.existsSync(teamRendererStyle)) {
  assert.doesNotMatch(read(teamRendererStyle), /\.task-progress\s*\{[^}]*\bposition\s*:\s*sticky\b[^}]*\btop\s*:/s, 'component renderer CSS must not restore the sticky task progress strip');
}

// General regression guard: notification-like JSX cannot position itself at the top.
// Requiring both notification semantics and top positioning deliberately permits topbars,
// context menus, fullscreen controls, dialogs, and modal backdrops.
const notificationSemantics = /\b(?:toast|notice|notification|banner|warning|error|progress|activity)\b|\brole\s*=\s*['"](?:status|alert)['"]|\baria-live\s*=/i;
const positionedAtTop = /(?:\b(?:fixed|sticky)\b[^>]*\btop-(?:\d|\[)|\btop-(?:\d|\[)[^>]*\b(?:fixed|sticky)\b)/i;
const jsxViolations = [];
for (const file of reactFiles) {
  const source = read(file);
  for (const match of source.matchAll(/<[A-Za-z][^>]*>/gs)) {
    if (notificationSemantics.test(match[0]) && positionedAtTop.test(match[0])) {
      jsxViolations.push(`${relative(file)}:${lineOf(source, match.index)}`);
    }
  }
}
assert.deepEqual(jsxViolations, [], `notification-like fixed/sticky top JSX exists outside TopToastViewport:\n${jsxViolations.join('\n')}`);

// CSS equivalent of the JSX guard. Only the unified stack itself may own fixed top placement.
const cssViolations = [];
for (const file of styleFiles) {
  const source = read(file);
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/gs)) {
    const selector = match[1].trim();
    const declarations = match[2];
    if (!/(?:toast|notice|notification|banner|warning|error|progress|activity)/i.test(selector)) continue;
    if (!/\bposition\s*:\s*(?:fixed|sticky)\b/i.test(declarations) || !/\btop\s*:/i.test(declarations)) continue;
    if (relative(file) === 'src/index.css' && /\.top-toast-stack\b/.test(selector)) continue;
    cssViolations.push(`${relative(file)}:${lineOf(source, match.index)} (${selector.slice(0, 80)})`);
  }
}
assert.deepEqual(cssViolations, [], `notification-like fixed/sticky top CSS exists outside TopToastViewport:\n${cssViolations.join('\n')}`);

console.log('Toast architecture tests passed.');
