const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pluginRoot = path.join(root, 'extensions', ['team', 'retouch'].join('-'));
const shared = fs.readFileSync(path.join(root, 'src', 'components', 'ImageComparisonView.tsx'), 'utf8');
const pluginComparison = fs.readFileSync(path.join(pluginRoot, 'renderer', 'src', 'legacy', 'ImageComparisonView.tsx'), 'utf8');
const versionManager = fs.readFileSync(path.join(root, 'src', 'components', 'VersionManager.tsx'), 'utf8');
const advancedVideoPlayer = fs.readFileSync(path.join(root, 'src', 'components', 'AdvancedVideoPlayer.tsx'), 'utf8');
const projectWorkspace = fs.readFileSync(path.join(root, 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
const returnReview = fs.readFileSync(path.join(pluginRoot, 'renderer', 'src', 'legacy', 'PersonIdentityManager.tsx'), 'utf8');
const trackingPreview = fs.readFileSync(path.join(root, 'src', 'features', 'versioning', 'ProgressPairPreview.tsx'), 'utf8');

for (const mode of ['side-by-side', 'split', 'overlay', 'blink', 'difference']) {
  assert(shared.includes(`['${mode}'`), `shared comparison view must expose ${mode}`);
  assert(pluginComparison.includes(`['${mode}'`), `plugin comparison view must expose ${mode}`);
}
assert(shared.includes('aria-label="拖动图片分割线"') && shared.includes('onPointerMove={event => { if (splitDragRef.current === event.pointerId) updateSplit(event.clientX); }}'), 'split comparison must drag the divider directly over stationary images');
assert(shared.includes("mode === 'blink'") && shared.includes('visibility: blinkRight') && shared.includes('700'), 'blink mode must visibly alternate layers and identify the active side');
assert(shared.includes('旋转 {rotation}°') && shared.includes('重置') && shared.includes('图片缩放') && shared.includes('交换 A/B'), 'all shared comparison controls must be present');
assert(shared.includes("item.interactive ? 'pointer-events-auto' : 'pointer-events-none'"), 'interactive video comparison content must keep its playback controls clickable');
assert(pluginComparison.includes('aria-label="拖动图片分割线"') && pluginComparison.includes('splitDragRef.current === event.pointerId'), 'plugin return review must preserve direct split-divider interaction');
assert(pluginComparison.includes("mode !== 'blink'") && pluginComparison.includes('visibility: blinkRight') && pluginComparison.includes('700'), 'plugin return review must preserve active-only blink comparison');
assert(pluginComparison.includes('旋转 {rotation}°') && pluginComparison.includes('重置') && pluginComparison.includes('图片缩放') && pluginComparison.includes('交换 A/B'), 'plugin comparison controls must remain complete');
assert(versionManager.includes("interactive: active && mediaKind(left.filePath) === 'video'") && versionManager.includes("interactive: active && mediaKind(right.filePath) === 'video'"), 'active version video comparisons must opt into interactive content');
assert(versionManager.includes('videoPlayback={active}'), 'inactive version tabs must unmount their advanced-video sessions');
assert(projectWorkspace.includes("previewPaneOpen && active && activeView === 'project'")
  && projectWorkspace.includes("renderedVersionEntry && <div className={activeView === 'version' ? 'contents' : 'hidden'}")
  && projectWorkspace.includes("<VersionManager active={active && activeView === 'version'}")
  && projectWorkspace.includes("setVersionEntry(null)") && projectWorkspace.includes("onCloseToolTab('version')"), 'inactive or closed version surfaces must stop underlying video previews');
assert(advancedVideoPlayer.includes('visiblePlayers.length > 1') && advancedVideoPlayer.includes('playerRootRef.current?.contains(document.activeElement)'), 'multiple advanced players must scope global arrow keys to the focused player');
assert(versionManager.includes('compareVersions.length === 2 ? null : selected ? <SingleVersionView'), 'the hidden single-version player must unmount while two versions are being compared');
for (const [name, source] of [['version manager', versionManager], ['return review', returnReview], ['tracking preview', trackingPreview]]) {
  assert(source.includes('ImageComparisonView'), `${name} must use the shared comparison view`);
}
assert(returnReview.includes("from './ImageComparisonView'") && returnReview.includes('active={componentActive}') && returnReview.includes('comparisonKey=') && returnReview.includes('unavailable={!activeCandidate?.patchPath}'), 'plugin return review must use its public comparison module with lifecycle and unavailable-state bindings');

console.log('image comparison view tests passed');
