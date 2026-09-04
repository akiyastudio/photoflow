const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const { parseMediaPlaybackBackendContributions } = require('../electron/contracts/media-playback-backend-contract.cjs');
const { MAX_FRAME_BYTES, PROTOCOL, createPlaybackEnvelopeWriter, validatePlaybackEnvelope } = require('../electron/contracts/media-playback-backend-v1.cjs');
const { createMediaPlaybackProcessAdapter } = require('../electron/services/media-playback-process-adapter.cjs');
const { cleanPlaybackDiagnostics } = require('../electron/contracts/playback-diagnostics.cjs');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts/fixtures/playback-backend-manifest-v1.json'), 'utf8'));
const [contribution] = parseMediaPlaybackBackendContributions(manifest);
assert.equal(contribution.protocolVersion, 1);
assert.equal(contribution.displayName, 'Fixture decoder'); assert.equal(contribution.backendVersion, '1.2.3');
assert(contribution.probe.containers.includes('mp4') && contribution.probe.codecs.video.includes('hevc'));
assert(contribution.features.transforms.rotation && contribution.features.hdr.passthrough && contribution.features.hdr.algorithms.includes('bt2390'));
assert.equal(contribution.features.statistics.maxUpdateHz, 4);assert.equal(contribution.features.statistics.gpu,true);
assert.equal(contribution.features.capture.displayedFrame, true);
for (const schema of ['component-manifest-v2.schema.json', 'media-playback-backend-v1.schema.json', 'media-playback-backend-wire-v1.schema.json']) JSON.parse(fs.readFileSync(path.join(root, 'electron/contracts/schemas', schema), 'utf8'));
const compileManifestSchema = file => {
  const source = JSON.parse(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))).replaceAll('#/$defs/', '#/definitions/'));
  source.definitions = source.$defs; delete source.$defs; delete source.$schema; delete source.$id;
  return new Ajv({ allErrors: true }).compile(source);
};
const runtimeOnlyManifest = JSON.parse(fs.readFileSync(path.join(root, 'extensions', 'video-playback-mpv', 'component.template.json'), 'utf8'));
const canonicalManifestSchemaPath = path.join(root, 'electron', 'contracts', 'schemas', 'component-manifest-v2.schema.json');
const vendoredManifestSchemaPath = path.join(root, 'extensions', 'video-playback-mpv', 'protocol', 'component-manifest-v2.schema.json');
assert.deepEqual(JSON.parse(fs.readFileSync(vendoredManifestSchemaPath, 'utf8')), JSON.parse(fs.readFileSync(canonicalManifestSchemaPath, 'utf8')), 'vendored component manifest schema must remain structurally identical to the canonical contract');
const manifestSchemas = [canonicalManifestSchemaPath, vendoredManifestSchemaPath].map(compileManifestSchema);
for (const validate of manifestSchemas) {
  assert.equal(validate(runtimeOnlyManifest), true, JSON.stringify(validate.errors));
  const missingRuntime = structuredClone(runtimeOnlyManifest); delete missingRuntime.runtimeContributions;
  assert.equal(validate(missingRuntime), false, 'manifest requires componentHost or runtimeContributions');
  assert.equal(validate({ ...runtimeOnlyManifest, runtimeContributions: [] }), false, 'runtime-only manifest requires at least one runtime contribution');
}
assert.throws(()=>parseMediaPlaybackBackendContributions({runtimeContributions:[{...manifest.runtimeContributions[0],unknown:true}]}),/Unknown/);assert.throws(()=>parseMediaPlaybackBackendContributions({runtimeContributions:[{...manifest.runtimeContributions[0],backendVersion:'latest'}]}),/backendVersion/);
assert.equal(contribution.features.capture.sourceFrame,false);assert.equal(contribution.features.capture.displayedFrame,true);assert.equal(contribution.features.transforms.crop,false);assert.equal(contribution.features.hardwareDecoding.selectable,false);assert.throws(()=>parseMediaPlaybackBackendContributions({runtimeContributions:[{...manifest.runtimeContributions[0],features:{...manifest.runtimeContributions[0].features,statistics:{...manifest.runtimeContributions[0].features.statistics,maxUpdateHz:5}}}]}),/maxUpdateHz/);

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
const processLines=[];const adapter=createMediaPlaybackProcessAdapter({sessionId:'adapter-session',writeLine:line=>processLines.push(JSON.parse(line)),now:()=>2000});adapter.sendLegacy('open',{path:'C:/media.mp4'});assert.equal(processLines[0].event,'command.media.open');adapter.sendLegacy('tone-mapping',{toneMapping:'bt2390',targetPeakNits:600});assert.equal(processLines[1].event,'command.video.tone-mapping');const received=adapter.receiveLine(JSON.stringify({protocol:PROTOCOL,protocolVersion:1,sessionId:'adapter-session',sequence:1,timestamp:2000,event:'event.runtime.ready',payload:{}}));assert.equal(received.type,'ready');adapter.close();assert.throws(()=>adapter.sendLegacy('play'),/closed/);
assert.deepEqual(cleanPlaybackDiagnostics({code:'GPU_DEVICE_LOST',severity:'warning',phase:'render',recoverable:true}),{code:'GPU_DEVICE_LOST',severity:'warning',phase:'render',recoverable:true});assert.throws(()=>cleanPlaybackDiagnostics({code:'X',severity:'info',environment:{PATH:'secret'}}),/unsupported/);

console.log('Media playback backend v1 manifest and wire protocol tests passed.');
