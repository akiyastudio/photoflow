const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseMediaPlaybackBackendContributions } = require('../electron/contracts/media-playback-backend-contract.cjs');
const { MAX_FRAME_BYTES, PROTOCOL, createPlaybackEnvelopeWriter, validatePlaybackEnvelope } = require('../electron/contracts/media-playback-backend-v1.cjs');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extensions/video-playback-mpv/component.template.json'), 'utf8'));
const [contribution] = parseMediaPlaybackBackendContributions(manifest);
assert.equal(contribution.protocolVersion, 1);
assert(contribution.probe.containers.includes('mp4') && contribution.probe.codecs.video.includes('hevc'));
assert(contribution.features.transforms.includes('rotate') && contribution.features.hdr.modes.includes('hdr-passthrough'));
assert.deepEqual(contribution.features.statistics, { levels: ['basic', 'detailed'], maxUpdateHz: 10 });
assert.equal(contribution.features.capture.appliesTransforms, true);
for (const schema of ['media-playback-backend-v1.schema.json', 'media-playback-backend-wire-v1.schema.json']) JSON.parse(fs.readFileSync(path.join(root, 'electron/contracts/schemas', schema), 'utf8'));

let now = 1000; const sent = [];
const writer = createPlaybackEnvelopeWriter({ sessionId: 'session-fixture', direction: 'event', send: value => sent.push(value), now: () => now, maxHighFrequencyHz: 10 });
assert.equal(writer.emit('state', { time: 1 }, { highFrequency: true }), true);
now += 20;
assert.equal(writer.emit('state', { time: 2 }, { highFrequency: true }), false);
assert.equal(writer.emit('statistics', { droppedFrames: 3 }, { highFrequency: true }), false);
now += 100; writer.flush();
assert.deepEqual(sent.map(value => value.event), ['event.state', 'event.state', 'event.statistics']);
assert(sent.every((value, index) => value.protocol === PROTOCOL && value.sequence === index + 1 && value.sessionId === 'session-fixture'));

const receiveState = { sessionId: 'session-fixture', lastSequence: 0, closed: false };
validatePlaybackEnvelope(sent[0], receiveState, { direction: 'event', now: sent[0].timestamp });
assert.throws(() => validatePlaybackEnvelope(sent[0], receiveState, { direction: 'event', now: sent[0].timestamp }), /ordering/);
assert.throws(() => writer.emit('state', { frame: 'not allowed' }), /binary field/);
assert.throws(() => writer.emit('state', { text: 'x'.repeat(MAX_FRAME_BYTES) }), /256 KiB/);
writer.close();
assert.throws(() => writer.emit('state', {}), /closed/);
receiveState.closed = true;
assert.throws(() => validatePlaybackEnvelope(sent[1], receiveState, { direction: 'event', now: sent[1].timestamp }), /closed/);

console.log('Media playback backend v1 manifest and wire protocol tests passed.');
