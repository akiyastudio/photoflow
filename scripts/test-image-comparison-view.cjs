const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const shared = fs.readFileSync(path.join(root, 'src', 'components', 'ImageComparisonView.tsx'), 'utf8');
const versionManager = fs.readFileSync(path.join(root, 'src', 'components', 'VersionManager.tsx'), 'utf8');
const returnReview = fs.readFileSync(path.join(root, 'src', 'components', 'PersonIdentityManager.tsx'), 'utf8');
const trackingPreview = fs.readFileSync(path.join(root, 'src', 'features', 'versioning', 'ProgressPairPreview.tsx'), 'utf8');

for (const mode of ['side-by-side', 'split', 'overlay', 'blink', 'difference']) {
  assert(shared.includes(`['${mode}'`), `shared comparison view must expose ${mode}`);
}
assert(shared.includes('aria-label="拖动图片分割线"') && shared.includes('onPointerMove={event => { if (splitDragRef.current === event.pointerId) updateSplit(event.clientX); }}'), 'split comparison must drag the divider directly over stationary images');
assert(shared.includes("mode === 'blink'") && shared.includes('visibility: blinkRight') && shared.includes('700'), 'blink mode must visibly alternate layers and identify the active side');
assert(shared.includes('旋转 {rotation}°') && shared.includes('重置') && shared.includes('图片缩放') && shared.includes('交换 A/B'), 'all shared comparison controls must be present');
for (const [name, source] of [['version manager', versionManager], ['return review', returnReview], ['tracking preview', trackingPreview]]) {
  assert(source.includes('ImageComparisonView'), `${name} must use the shared comparison view`);
}

console.log('image comparison view tests passed');
