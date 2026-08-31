import assert from 'node:assert/strict';
import { chromiumFrameGeometry, chromiumVideoStyle, drawTransformedVideoFrame, hdrModeAvailability, normalizeVideoTransform, playbackCapabilityPresentation, transformedFrameSize } from '../src/contracts/video-playback.ts';

const approximately = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
const matrixValues = style => {
  const match = String(style.transform).match(/^matrix\(([^)]+)\)$/);
  assert(match, `Chromium transforms must be emitted as a CSS matrix, got ${style.transform}`);
  return match[1].split(',').map(Number);
};

const transformed = normalizeVideoTransform({ aspectMode: '16:9', rotation: 90, flipHorizontal: true });
assert.deepEqual(transformed, { aspectMode: '16:9', rotation: 90, flipHorizontal: true, flipVertical: false });
const transformedStyle = chromiumVideoStyle(transformed, 1920, 1080);
assert.equal(transformedStyle.objectFit, 'fill', 'the element must expose the full frame to the geometry matrix');
assert.equal(transformedStyle.aspectRatio, 'auto');
const transformedMatrix = matrixValues(transformedStyle);
approximately(transformedMatrix[0], 0, '90 degree rotation matrix a');
approximately(transformedMatrix[1], -0.5625, 'horizontal flip after rotation matrix b');
approximately(transformedMatrix[2], -16 / 9, '90 degree rotation matrix c');
approximately(transformedMatrix[3], 0, '90 degree rotation matrix d');
assert.deepEqual(transformedFrameSize(1920, 1080, transformed), { width: 1080, height: 608 });

const coverGeometry = chromiumFrameGeometry(normalizeVideoTransform({ aspectMode: 'cover' }), 1920, 1080, 1000, 1000);
assert.deepEqual(coverGeometry.visibleSize, { width: 1000, height: 1000 }, 'cover must fill the complete visible viewport');
approximately(coverGeometry.targetDisplaySize.width, 16000 / 9, 'cover must overflow horizontally');
approximately(coverGeometry.targetDisplaySize.height, 1000, 'cover viewport height');
const coverMatrix = matrixValues(chromiumVideoStyle(normalizeVideoTransform({ aspectMode: 'cover' }), 1000, 1000, 1920, 1080));
approximately(coverMatrix[0], 16 / 9, 'cover horizontal scale');
approximately(coverMatrix[3], 1, 'cover vertical scale');

const calls = [];
const drawing = { save() { calls.push('save'); }, translate(...v) { calls.push(['translate', ...v]); }, rotate(v) { calls.push(['rotate', v]); }, scale(...v) { calls.push(['scale', ...v]); }, drawImage(...v) { calls.push(['drawImage', ...v.slice(1)]); }, restore() { calls.push('restore'); } };
const video = { videoWidth: 1920, videoHeight: 1080 };
const cropped = normalizeVideoTransform({ ...transformed, crop: { x: .1, y: .2, width: .5, height: .6 } });
const clipMatch = String(chromiumVideoStyle(cropped).clipPath).match(/^inset\(([^%]+)% ([^%]+)% ([^%]+)% ([^%]+)%\)$/);
assert(clipMatch, 'cropped Chromium display must express the visible source rectangle as an inset');
[20, 40, 20, 10].forEach((expected, index) => approximately(Number(clipMatch[index + 1]), expected, `crop inset ${index}`));
const capturedSize = drawTransformedVideoFrame(drawing, video, cropped);
assert.deepEqual(capturedSize, transformedFrameSize(1920, 1080, cropped), 'displayed-frame capture must use the same output geometry as the display model');
assert.equal(calls[0], 'save');
assert.equal(calls.at(-1), 'restore');
approximately(calls.find(value => Array.isArray(value) && value[0] === 'rotate')[1], Math.PI / 2, 'capture rotation');
assert.deepEqual(calls.find(value => Array.isArray(value) && value[0] === 'scale'), ['scale', -1, 1], 'capture must preserve horizontal flip');
const cropDraw = calls.find(value => Array.isArray(value) && value[0] === 'drawImage');
assert.deepEqual(cropDraw.slice(1, 5), [192, 216, 960, 648], 'capture must sample precisely the normalized crop rectangle');
assert.deepEqual(cropDraw.slice(5), [-182.5, -324, 365, 648], 'capture destination must match the rotated 16:9 visible frame');

const fixedRatioStyle = chromiumVideoStyle(normalizeVideoTransform({ aspectMode: '4:3' }), 1600, 900);
assert.deepEqual({ aspectRatio: fixedRatioStyle.aspectRatio, objectFit: fixedRatioStyle.objectFit, width: fixedRatioStyle.width, height: fixedRatioStyle.height, margin: fixedRatioStyle.margin, backgroundColor: fixedRatioStyle.backgroundColor }, { aspectRatio: 'auto', objectFit: 'fill', width: '100%', height: '100%', margin: '0', backgroundColor: '#000' });
const fixedRatioMatrix = matrixValues(fixedRatioStyle);
approximately(fixedRatioMatrix[0], .75, '4:3 visible-width scale in a 16:9 viewport');
approximately(fixedRatioMatrix[3], 1, '4:3 visible-height scale in a 16:9 viewport');
const hdr={passthrough:true,toneMapping:true,algorithms:['auto','bt2390'],targetPeakControl:true};assert.deepEqual(hdrModeAvailability({requested:'hdr-passthrough',hdrFeatures:hdr,hdrDisplayAvailable:false}),{available:false,reason:'当前显示器未报告可用 HDR 输出'});assert.equal(hdrModeAvailability({requested:'tone-map',hdrFeatures:hdr,hdrDisplayAvailable:false,toneMapping:'bt2390'}).available,true);
const ui=playbackCapabilityPresentation({transforms:{aspectModes:['contain'],rotation:true,flip:true,crop:false},hdr,statistics:{basic:true,decode:true,hdr:true,timing:true,cache:true,gpu:true},subtitles:{embedded:true,external:true,ass:true,styles:true},capture:{sourceFrame:false,displayedFrame:true}},false);assert.equal(ui.hdrPassthroughAvailable,false);assert.equal(ui.hdrControlsAvailable,true);assert.equal(ui.subtitlesAvailable,true);assert.deepEqual(ui.subtitleFormats,['vtt','srt','ass','ssa']);assert.equal(ui.captureAvailable,true);assert.equal(ui.displayedCaptureAvailable,true);const chromiumUi=playbackCapabilityPresentation({transforms:{aspectModes:['contain'],rotation:true,flip:true,crop:true},hdr:{passthrough:false,toneMapping:false,algorithms:[],targetPeakControl:false},statistics:{basic:true,decode:false,hdr:false,timing:true,cache:false,gpu:false},subtitles:{embedded:false,external:false,ass:false,styles:false},capture:{sourceFrame:true,displayedFrame:true}},false);assert.equal(chromiumUi.hdrControlsAvailable,false);assert.equal(chromiumUi.subtitlesAvailable,false);
console.log('Video transform, capture geometry, and HDR capability model tests passed.');
