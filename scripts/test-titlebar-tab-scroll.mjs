import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  measureTitlebarTabScroll,
  titlebarTabScrollOffset,
  titlebarTabWheelOffset,
} from '../src/features/app/titlebar-tab-scroll-model.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

assert.deepEqual(
  measureTitlebarTabScroll({ scrollWidth: 501, clientWidth: 500, scrollLeft: 20 }),
  { overflow: false, canScrollLeft: false, canScrollRight: false },
  'one-pixel layout jitter must not show titlebar scroll controls',
);
assert.deepEqual(
  measureTitlebarTabScroll({ scrollWidth: 700, clientWidth: 500, scrollLeft: 2 }),
  { overflow: true, canScrollLeft: true, canScrollRight: true },
  'an overflowing titlebar must expose both directions away from its edges',
);
assert.deepEqual(
  measureTitlebarTabScroll({ scrollWidth: 700, clientWidth: 500, scrollLeft: 199 }),
  { overflow: true, canScrollLeft: true, canScrollRight: false },
  'the right affordance must turn off within the original one-pixel edge tolerance',
);
assert.equal(titlebarTabScrollOffset(-1, 200), -180, 'narrow titlebars keep the 180px minimum button step');
assert.equal(titlebarTabScrollOffset(1, 400), 260, 'wide titlebars scroll by 65% of the viewport');
assert.equal(titlebarTabWheelOffset(10, -20), -20, 'wheel handling uses the dominant vertical delta');
assert.equal(titlebarTabWheelOffset(-30, 20), -30, 'wheel handling uses the dominant horizontal delta');

const appSource = read('src/App.tsx');
const hookSource = read('src/features/app/useTitlebarTabScroll.ts');
assert(appSource.includes("import { useTitlebarTabScroll } from './features/app/useTitlebarTabScroll';"), 'App must delegate titlebar scrolling to the hook');
assert(appSource.includes('tabsRef: titlebarTabsRef'), 'App must pass its rendered titlebar ref explicitly');
assert(appSource.includes('titlebarTabScroll, titlebarTabDragProps, scrollTitlebarTabs, handleTitlebarTabWheel'), 'App must consume the hook state, drag props, and both scroll handlers');
for (const marker of ['new ResizeObserver(updateTabScroll)', "element.addEventListener('scroll', updateTabScroll, { passive: true })", "querySelector<HTMLElement>('[data-active-tab=\"true\"]')", "behavior: 'smooth'", "behavior: 'auto'"]) {
  assert(hookSource.includes(marker), `titlebar hook lost interaction contract: ${marker}`);
}
assert(hookSource.includes('[componentPages.length, configLoaded, projectPages.length, settingsTabOpen, updateTabScroll, workspaceToolTabs.length]'), 'observer effect dependencies must match the original App effect');
assert(hookSource.includes('[componentPages.length, configLoaded, activeTab, activePageId, projectPages.length, settingsTabOpen, updateTabScroll, workspaceToolTabs.length]'), 'active-tab visibility dependencies must match the original App effect');
for (const duplicate of ['new ResizeObserver(', "addEventListener('scroll'", 'scrollIntoView(', 'Math.max(180, element.clientWidth * 0.65)']) {
  assert(!appSource.includes(duplicate), `App retained extracted titlebar behavior: ${duplicate}`);
}

console.log('titlebar tab scroll model and source contract tests passed');
