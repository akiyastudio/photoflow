// Optional native integration check; supply a real local video with --media.
// The decoder creates its existing offscreen window; audio stays muted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const argument = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : process.argv[index + 1];
};
const media = argument('--media');
if (!media || !fs.statSync(media).isFile()) throw new Error('Supply --media with a readable video');
const decoder = path.resolve(argument('--decoder') || path.join(__dirname, '../dist/components/video-playback-mpv/advanced-video-decoder.exe'));
const sessionId = crypto.randomUUID();
const startedAt = performance.now();
const timing = {};
let sequence = 0;
let completed = false;
let failure;
let buffer = '';
const child = spawn(decoder, ['--session-id', sessionId], {
  cwd: path.dirname(decoder), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
const send = (event, payload = {}) => child.stdin.write(`${JSON.stringify({
  protocol: 'media-playback-backend-v1', protocolVersion: 1, sessionId,
  sequence: ++sequence, timestamp: Date.now(), event: `command.${event}`, payload,
})}\n`);
const timeout = setTimeout(() => { failure = new Error('Native playback timed out'); child.kill(); }, 20000);
child.on('error', error => { failure = error; clearTimeout(timeout); process.exitCode = 1; console.error(error.message); });
child.stdout.on('data', data => {
  buffer += data;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line.trim() || failure || completed) continue;
    try {
      const value = JSON.parse(line);
      assert.equal(value.sessionId, sessionId);
      const elapsed = Math.round(performance.now() - startedAt);
      if (value.event === 'event.runtime.ready') {
        timing.readyMs = elapsed;
        send('audio.mute', { value: true });
        send('media.open', { path: path.resolve(media) });
        send('playback.play');
      }
      if (value.event === 'event.media.loaded') timing.loadedMs = elapsed;
      if (value.event === 'event.error' || value.event === 'event.fatal') throw new Error(value.payload.error || 'Native playback failed');
      if (value.event === 'event.state.changed' && value.payload.time > 0 && !value.payload.buffering) {
        timing.playingMs ??= elapsed;
        if (value.payload.time >= 2 && timing.loadedMs) {
          completed = true;
          timing.stablePlaybackMs = elapsed;
          child.stdin.end();
        }
      }
    } catch (error) { failure = error; child.kill(); }
  }
});
child.on('exit', code => {
  clearTimeout(timeout);
  if (failure || code !== 0 || !completed) {
    process.exitCode = 1;
    console.error(failure?.message || `Native decoder exited before clean playback: ${code}`);
    return;
  }
  console.log(JSON.stringify({ success: true, ...timing, exitCode: code }));
});
