const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { translateLegacyMediaProcessV7 } = require('../electron/compatibility/legacy-media-process-v7.cjs');

const descriptor = { service: { events: ['fixture.progress.v1'] } };
const split = translateLegacyMediaProcessV7({ action: 'video.split', idempotencyKey: 'legacy-split', relativePaths: ['video.mp4'], inputTokens: [] }, descriptor);
assert.equal(split.action, 'execute');
assert.equal(split.runtimeCapability, 'media.video.processing.cli');
assert.deepEqual(split.arguments, ['cut_video']);
assert.equal(split.operationKey, 'split');
assert.equal(split.eventName, 'fixture.progress.v1');

const explicit = translateLegacyMediaProcessV7({ action: 'video.split', idempotencyKey: 'legacy-split-args', relativePaths: [], inputTokens: [], runtimeArgs: ['--opaque'] }, descriptor);
assert.deepEqual(explicit.arguments, ['cut_video', '--opaque']);
assert.throws(() => translateLegacyMediaProcessV7({ action: 'video.split', runtimeArgs: 'invalid' }, descriptor), error => error.code === 'COMPONENT_UPGRADE_REQUIRED');
for (const action of ['video.transcode', 'video.transcode.inspect']) assert.throws(() => translateLegacyMediaProcessV7({ action }, descriptor), error => error.code === 'COMPONENT_UPGRADE_REQUIRED');

const stableHost = fs.readFileSync(path.join(__dirname, '..', 'electron', 'services', 'component-project-write-capabilities.cjs'), 'utf8');
for (const forbidden of ['video.split', 'cut_video', 'video.transcode', 'ffmpeg_transcode', 'LEGACY_MEDIA_PROCESS']) assert(!stableHost.includes(forbidden), `legacy vocabulary leaked into stable Host service: ${forbidden}`);
console.log('Legacy media-process v7 descriptor translation tests passed.');
