import assert from 'node:assert/strict';
import { extractBrowserImageUrls, hasBrowserImageDragData, hasImportableExternalDragData, readBrowserProvidedImageFiles } from '../src/features/workspace/browser-image-drop-model.ts';

const dragData = (values, types = Object.keys(values)) => ({
  types,
  getData: type => values[type] || '',
});

const uriDrag = dragData({
  'text/uri-list': '# dragged image\r\nhttps://images.example.test/photo.JPG?size=large\r\nhttps://images.example.test/photo.JPG?size=large',
  'text/plain': 'https://images.example.test/photo.JPG?size=large',
});
assert.strictEqual(hasBrowserImageDragData(uriDrag), true);
assert.strictEqual(hasImportableExternalDragData(uriDrag), true);
assert.deepStrictEqual(extractBrowserImageUrls(uriDrag), ['https://images.example.test/photo.JPG?size=large']);

const htmlDrag = dragData({
  'text/html': '<a href="https://example.test/page"><img alt="preview" src="https://cdn.example.test/a.webp?x=1&amp;y=2"></a>',
});
assert.deepStrictEqual(extractBrowserImageUrls(htmlDrag), ['https://cdn.example.test/a.webp?x=1&y=2']);

const plainDrag = dragData({ 'text/plain': 'https://cdn.example.test/plain.png' });
assert.strictEqual(hasBrowserImageDragData(plainDrag), true);
assert.deepStrictEqual(extractBrowserImageUrls(plainDrag), ['https://cdn.example.test/plain.png']);

const unsafeDrag = dragData({ 'text/uri-list': 'file:///C:/private/photo.jpg\r\nblob:https://example.test/id\r\ndata:image/png;base64,AAAA' });
assert.deepStrictEqual(extractBrowserImageUrls(unsafeDrag), []);

const localFilesDrag = dragData({}, ['Files']);
assert.strictEqual(hasImportableExternalDragData(localFilesDrag), true);

const providedBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer;
const browserProvidedImages = await readBrowserProvidedImageFiles([
  { name: 'browser-image', type: 'image/png', size: 4, arrayBuffer: async () => providedBytes },
  { name: 'unreadable.jpg', type: 'image/jpeg', size: 10, arrayBuffer: async () => { throw new Error('virtual file unavailable'); } },
]);
assert.strictEqual(browserProvidedImages.length, 1);
assert.strictEqual(browserProvidedImages[0].name, 'browser-image');
assert.deepStrictEqual(new Uint8Array(browserProvidedImages[0].bytes), new Uint8Array(providedBytes));

console.log('browser image drop model tests passed');
