const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { privateOutputPath } = require('./project-output-paths.cjs');

const repositoryRoot = path.resolve(__dirname, '..');
const run = async () => {
  const parent = privateOutputPath(repositoryRoot, 'diagnostics', 'folder-rename');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'run-'));
  const workspace = path.join(root, 'workspace');
  const userData = path.join(root, 'user-data');
  const sessionData = path.join(root, 'session-data');
  const cache = path.join(root, 'cache');
  for (const directory of [workspace, userData, sessionData, cache]) fs.mkdirSync(directory);
  const workspaceId = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(path.join(workspace, '.photoflow-workspace-id'), `${workspaceId}\n`);
  fs.writeFileSync(path.join(userData, 'photoflow_config.json'), JSON.stringify({
    workspacePath: workspace, usagePreferencesVersion: 1, mediaCache: { directory: cache, maxSizeGB: 1 }, backup: { enabled: false, targetPath: '' },
  }));
  // Test-only onboarding fixture in the isolated profile; never touches the
  // user's consent record and never opts the fixture into telemetry.
  const { CURRENT_PRIVACY_NOTICE_VERSION, CURRENT_TERMS_VERSION } = require('../electron/privacy-service.cjs');
  fs.writeFileSync(path.join(userData, 'privacy-consent.json'), JSON.stringify({
    privacyNoticeVersion: CURRENT_PRIVACY_NOTICE_VERSION, termsVersion: CURRENT_TERMS_VERSION,
    experienceProgramGranted: false, usageTelemetryGranted: false, crashReportingGranted: false,
  }));
  for (const [name, size] of [['Rename-small', 20], ['Rename-large', 1000]]) {
    const project = path.join(workspace, name);
    fs.mkdirSync(project);
    fs.mkdirSync(path.join(project, '000-ordinary-a'));
    for (let index = 0; index < size; index += 1) fs.mkdirSync(path.join(project, `fixture-${String(index).padStart(4, '0')}`));
  }
  const databaseDirectory = path.join(userData, 'workspace-data');
  fs.mkdirSync(databaseDirectory);
  execFileSync(path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe'), [path.join(repositoryRoot, 'python', 'workspace_db.py'),
    'catalog_sync', '--root', workspace, '--database', path.join(databaseDirectory, `${workspaceId}.sqlite3`), '--payload', '{}'],
  { encoding: 'utf8', windowsHide: true });
  const stdout = fs.createWriteStream(path.join(root, 'stdout.log'));
  const stderr = fs.createWriteStream(path.join(root, 'stderr.log'));
  const child = spawn(require('electron'), ['--disable-gpu', repositoryRoot], {
    cwd: repositoryRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', PHOTOFLOW_SMOKE_TEST: '1', PHOTOFLOW_RENAME_BENCHMARK: '1',
      PHOTOFLOW_USER_DATA_DIR: userData, PHOTOFLOW_SMOKE_SESSION_DATA_DIR: sessionData,
      PYTHONDONTWRITEBYTECODE: '1' },
  });
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  console.log(`Private benchmark directory: ${root}`);
  const timer = setTimeout(() => child.kill(), 240_000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timer);
  const reportPath = path.join(userData, 'rename-performance.json');
  if (!fs.existsSync(reportPath)) throw new Error(`Benchmark exited ${code} without a report; evidence retained at ${root}`);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const readableReportPath = path.join(root, 'report.md');
  fs.writeFileSync(readableReportPath, require('./folder-rename-report.cjs').renderRenameReport(report));
  console.log(JSON.stringify({ reportPath, readableReportPath, code, summary: report.summary, error: report.error }, null, 2));
  if (report.error || code !== 0) process.exitCode = 1;
};
run().catch(error => { console.error(error.message); process.exitCode = 1; });
