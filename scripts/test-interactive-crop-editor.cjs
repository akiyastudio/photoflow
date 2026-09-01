const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const sourcePath = path.join(__dirname, '..', 'src', 'components', 'InteractiveCropEditor.tsx');
const source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n?/g, '\n');
const modelStart = source.indexOf('const normalizeCropRectangle');
const modelEnd = source.indexOf('const InteractiveCropEditor');
assert(modelStart >= 0 && modelEnd > modelStart, 'the crop keyboard model must remain colocated with the editor');

const sandbox = {};
const modelSource = stripTypeScriptTypes(source.slice(modelStart, modelEnd), { mode: 'transform' });
vm.runInNewContext(`${modelSource}\nglobalThis.adjustCropRectangleFromKeyboard = adjustCropRectangleFromKeyboard;`, sandbox);
const adjust = sandbox.adjustCropRectangleFromKeyboard;
const imageSize = { width: 1_000, height: 800 };
const base = { x: 10, y: 20, width: 200, height: 160 };
const run = (handle, key, crop = base, accelerated = false, minimumSize = 40, size = imageSize) =>
  JSON.parse(JSON.stringify(adjust({ crop, imageSize: size, minimumSize, handle, key, accelerated })));

assert.deepEqual(run('move', 'ArrowRight'), { ...base, x: 11 }, 'arrow keys must move by one image pixel');
assert.deepEqual(run('move', 'ArrowDown', base, true), { ...base, y: 30 }, 'Shift+Arrow must use the accelerated step');
assert.deepEqual(run('move', 'ArrowLeft', { ...base, x: 0 }), { ...base, x: 0 }, 'moving must clamp to the left image edge');
assert.deepEqual(run('move', 'ArrowDown', { x: 900, y: 700, width: 100, height: 100 }, true), { x: 900, y: 700, width: 100, height: 100 }, 'moving must clamp to the bottom image edge');
assert.deepEqual(run('nw', 'ArrowRight'), { x: 11, y: 20, width: 199, height: 160 }, 'the north-west handle must move its west edge');
assert.deepEqual(run('ne', 'ArrowDown'), { x: 10, y: 21, width: 200, height: 159 }, 'the north-east handle must move its north edge');
assert.deepEqual(run('sw', 'ArrowUp'), { x: 10, y: 20, width: 200, height: 159 }, 'the south-west handle must move its south edge');
assert.deepEqual(run('se', 'ArrowRight'), { x: 10, y: 20, width: 201, height: 160 }, 'the south-east handle must move its east edge');
assert.deepEqual(run('nw', 'ArrowRight', { x: 10, y: 20, width: 40, height: 40 }), { x: 10, y: 20, width: 40, height: 40 }, 'keyboard resizing must preserve the minimum crop size');
assert.deepEqual(run('se', 'ArrowRight', { x: 800, y: 700, width: 200, height: 100 }, true), { x: 800, y: 700, width: 200, height: 100 }, 'keyboard resizing must clamp to the image bounds');
assert.deepEqual(run('move', 'ArrowRight', { x: -5, y: -8, width: 2, height: 3 }, false, 40), { x: 1, y: 0, width: 40, height: 40 }, 'keyboard input must normalize an incoming crop before adjusting it');
assert.deepEqual(run('se', 'ArrowRight', { x: 0, y: 0, width: 4, height: 3 }, false, 40, { width: 4, height: 3 }), { x: 0, y: 0, width: 4, height: 3 }, 'minimum size must remain valid for images smaller than the normal minimum');

for (const marker of [
  'role="button" tabIndex={0}',
  'aria-label={handleLabels.move}',
  'aria-label={handleLabels[corner.handle]}',
  'aria-describedby={cropDescriptionId}',
  'aria-keyshortcuts={keyboardShortcuts}',
  'onKeyDown={event => handleKeyboardAdjustment',
  'accelerated: event.shiftKey',
  "focusedHandle === 'move'",
  'focusedHandle === corner.handle',
  'onPointerDown={event => beginDrag',
  'nearestGuide',
  'setActiveGuides',
]) assert(source.includes(marker), `crop editor accessibility or pointer contract missing: ${marker}`);
assert.equal((source.match(/tabIndex=\{0\}/g) || []).length, 2, 'the move surface and mapped corner handles must both be keyboard-focusable');
assert(source.includes('<desc id={cropDescriptionId}>{cropDescription}</desc>'), 'all crop controls must reference the live rectangle description');

console.log('Interactive crop pointer, keyboard geometry, bounds, minimum size, ARIA, and focus contracts passed.');
