const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProcessSupervisor } = require('../electron/services/process-supervisor.cjs');

if (process.platform !== 'win32') { console.log('Skipping Windows component Job host test'); process.exit(0); }
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const waitFor = async (predicate, timeoutMs = 10000) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await predicate()) return; await sleep(25); } throw new Error('Timed out waiting for Job fixture'); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

(async () => {
  const keepAlive = setInterval(() => undefined, 1000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-job-test-'));
  const childScript = path.join(root, 'child.ps1'); const rootScript = path.join(root, 'root.ps1');
  const echoScript = path.join(root, 'echo.ps1');
  const childPidFile = path.join(root, 'child.pid'); const grandchildPidFile = path.join(root, 'grandchild.pid');
  fs.writeFileSync(childScript, `param([string]$ChildPid,[string]$GrandchildPid)\nSet-Content -LiteralPath $ChildPid -Value $PID\n$g=Start-Process -WindowStyle Hidden -PassThru powershell.exe -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 60')\nSet-Content -LiteralPath $GrandchildPid -Value $g.Id\nStart-Sleep -Seconds 60\n`, 'utf8');
  fs.writeFileSync(rootScript, `param([string]$ChildScript,[string]$ChildPid,[string]$GrandchildPid)\nStart-Process -WindowStyle Hidden powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$ChildScript,$ChildPid,$GrandchildPid)\n$deadline=(Get-Date).AddSeconds(5)\nwhile((!(Test-Path -LiteralPath $GrandchildPid)) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 25}\n`, 'utf8');
  fs.writeFileSync(echoScript, `param([string]$Value)\n[Console]::Out.WriteLine((@{value=$Value}|ConvertTo-Json -Compress))\nexit 0\n`, 'utf8');
  const supervisor = createProcessSupervisor({ nativeJobHostPath: path.join(__dirname, '..', 'electron', 'bin', 'component-job-host.exe') });
  let managed;
  try {
    managed = supervisor.launch({ id: `job-fixture:${crypto.randomUUID()}`, kind: 'component-test', owner: { componentId: 'fixture-a' }, windowsJob: true, command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', rootScript, childScript, childPidFile, grandchildPidFile], options: { stdio: ['ignore', 'pipe', 'pipe'] } });
    await managed.child.__photoFlowJobControl.ready;
    await waitFor(() => fs.existsSync(childPidFile) && fs.existsSync(grandchildPidFile));
    const childPid = Number(fs.readFileSync(childPidFile, 'utf8')); const grandchildPid = Number(fs.readFileSync(grandchildPidFile, 'utf8'));
    const orphanHost=managed.child;await waitFor(() => !alive(childPid) && !alive(grandchildPid));await waitFor(()=>orphanHost.exitCode!=null);
    assert.equal(orphanHost.exitCode,250,'a successful root that leaves descendants must not report success');assert.equal(orphanHost.__photoFlowJobControl.emptyConfirmed,true);
    assert.equal(managed.lifecycle.terminationFailed, false); assert.equal(managed.child, null);

    const secret = `sensitive-${crypto.randomUUID()} with spaces and \"quotes\"`;
    const echo = supervisor.launch({ id: `job-echo:${crypto.randomUUID()}`, kind: 'component-test', owner: { componentId: 'fixture-echo' }, windowsJob: true, command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', echoScript, secret], options: { stdio: ['ignore', 'pipe', 'pipe'] }, ephemeral: true });
    const echoChild=echo.child;assert(!echoChild.spawnargs.join(' ').includes(secret), 'target arguments must not appear in the Job host command line');
    let stdout = ''; echoChild.stdout.on('data', chunk => { stdout += chunk; });
    await waitFor(() => stdout.length > 0); assert.deepEqual(JSON.parse(stdout.trim()), { value: secret });
    await waitFor(()=>echoChild.exitCode!=null,5000).catch(async()=>{const status=await echoChild.__photoFlowJobControl.status();throw new Error(`echo host stuck: targetAlive=${alive(echoChild.__photoFlowTargetPid)} active=${status.active}`);});assert.equal(echoChild.exitCode,0);assert.equal(echoChild.__photoFlowJobControl.emptyConfirmed, true, 'natural JSONL EOF requires tree-zero evidence');

    const nonzero=supervisor.launch({id:`job-nonzero:${crypto.randomUUID()}`,kind:'component-test',owner:{componentId:'fixture-nonzero'},windowsJob:true,command:'powershell.exe',args:['-NoProfile','-Command','exit 7'],options:{stdio:['ignore','pipe','pipe']},ephemeral:true});const nonzeroChild=nonzero.child;await nonzeroChild.__photoFlowJobControl.ready;await waitFor(()=>nonzeroChild.exitCode!=null);assert.equal(nonzeroChild.exitCode,7);assert.equal(nonzeroChild.__photoFlowJobControl.emptyConfirmed,true);

    const disconnectPidFile = path.join(root, 'disconnect.pid');
    const disconnected = supervisor.launch({ id: `job-disconnect:${crypto.randomUUID()}`, kind: 'component-test', owner: { componentId: 'fixture-disconnect' }, windowsJob: true, command: 'powershell.exe', args: ['-NoProfile', '-Command', `Set-Content -LiteralPath '${disconnectPidFile}' -Value $PID; Start-Sleep -Seconds 60`], options: { stdio: ['ignore', 'pipe', 'pipe'] } });
    const disconnectedChild=disconnected.child;await disconnectedChild.__photoFlowJobControl.ready.catch(error=>{error.message=`disconnect ready: ${error.message}`;throw error;}); await waitFor(() => fs.existsSync(disconnectPidFile)); const disconnectedPid = Number(fs.readFileSync(disconnectPidFile, 'utf8'));
    disconnectedChild.__photoFlowJobControl.socket.destroy(); await waitFor(() => !alive(disconnectedPid)); await waitFor(() => disconnectedChild.exitCode != null);
  } finally {
    await supervisor.stopAll('fixture-finally').catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
    clearInterval(keepAlive);
  }
  console.log('Windows component Job host parent/child/grandchild test passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
