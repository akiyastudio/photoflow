const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createFileClipboardService } = require('../electron/services/file-clipboard-service.cjs');

const root = path.resolve(__dirname, '..');
const nativeSource = fs.readFileSync(path.join(root, 'electron', 'native', 'FileClipboardService.cs'), 'utf8');
const serviceSource = fs.readFileSync(path.join(root, 'electron', 'services', 'file-clipboard-service.cjs'), 'utf8');
const buildSource = fs.readFileSync(path.join(root, 'scripts', 'build-file-clipboard-service.cjs'), 'utf8');

assert(nativeSource.includes('[STAThread]'), 'native clipboard commands must run in an STA apartment');
assert(nativeSource.includes('data.SetFileDropList(files)') && nativeSource.includes('Preferred DropEffect'), 'native writes must publish CF_HDROP and Preferred DropEffect');
assert(nativeSource.includes('operation == "cut" ? 2 : 1'), 'copy and cut drop effects must be DWORD values 1 and 2');
assert(nativeSource.includes('GetClipboardSequenceNumber') && nativeSource.includes('case "clear-if-current"'), 'native reads and conditional clearing must use Windows clipboard sequence numbers');
assert(nativeSource.includes('Write(ReadRequest())') && nativeSource.includes('写入后回读验证失败'), 'native writes must immediately verify the persisted clipboard payload');
assert(nativeSource.includes('RetryCount') && nativeSource.includes('Thread.Sleep'), 'clipboard busy handling must use bounded short retries');
assert(serviceSource.includes("path.join(process.resourcesPath, 'file-clipboard-service.exe')") && serviceSource.includes("path.join(projectRoot, 'electron', 'bin', 'file-clipboard-service.exe')"), 'the wrapper must resolve packaged and development executables separately');
assert(serviceSource.includes('FILE_CLIPBOARD_SERVICE_MISSING') && !serviceSource.includes('powershell.exe'), 'missing native service errors must be explicit and must not fall back to PowerShell');
assert(buildSource.includes('System.Windows.Forms.dll') && buildSource.includes('FileClipboardService.cs'), 'the build must compile the Windows Forms clipboard helper');

const run = async () => {
if (process.platform === 'win32') {
  const builtExecutable = path.join(root, 'electron', 'bin', 'file-clipboard-service.exe');
  if (fs.existsSync(builtExecutable)) {
    const readResult = spawnSync(builtExecutable, ['read'], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(readResult.status, 0, readResult.stderr);
    const snapshot = JSON.parse(readResult.stdout.trim());
    assert(Array.isArray(snapshot.sources) && Number.isInteger(snapshot.sequence), 'native read must return sources and the Windows sequence number');
    const clearResult = spawnSync(builtExecutable, ['clear-if-current'], { input: JSON.stringify({ sequence: snapshot.sequence + 1, sources: snapshot.sources }), encoding: 'utf8', windowsHide: true });
    assert.strictEqual(clearResult.status, 0, clearResult.stderr);
    assert.strictEqual(JSON.parse(clearResult.stdout.trim()).cleared, false, 'a stale sequence must never clear the clipboard');
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-file-clipboard-missing-'));
  try {
    const service = createFileClipboardService({ app: { isPackaged: false }, projectRoot: sandbox });
    assert(service.executable().endsWith(path.join('electron', 'bin', 'file-clipboard-service.exe')));
    await assert.rejects(service.read(), error => error.code === 'FILE_CLIPBOARD_SERVICE_MISSING');
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
}
console.log('file clipboard service tests passed');
};
run().catch(error => { console.error(error); process.exit(1); });
