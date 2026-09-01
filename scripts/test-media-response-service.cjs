const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMediaAccessService, takeVerifiedMediaHandle } = require('../electron/services/media-access-service.cjs');
const { createMediaFileResponse } = require('../electron/services/media-response-service.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-media-response-'));
const access = createMediaAccessService({ getWorkspaceRoots: () => [root] });

const createAsset = (name, contents) => {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
};

const protocolRequest = (url, { method = 'GET', headers } = {}) => ({
  url,
  method,
  headers: new Headers(headers),
});

const withCloseCount = async callback => {
  const originalClose = fs.close;
  let closeCount = 0;
  fs.close = (descriptor, done) => originalClose(descriptor, error => {
    closeCount += 1;
    done(error);
  });
  try {
    await callback(() => closeCount);
  } finally {
    fs.close = originalClose;
  }
};

const resolve = (token, expectedPath) => {
  const resolved = access.resolveToken(token);
  assert.equal(resolved, path.resolve(expectedPath));
  return resolved;
};

const run = async () => {
  try {
    const basicPath = createAsset('basic.mp4', '0123456789');
    const basicToken = access.grantPath(basicPath);

    let resolved = resolve(basicToken, basicPath);
    let response = await createMediaFileResponse(resolved, protocolRequest(`photoflow-media://file/${basicToken}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), '10');
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(await response.text(), '0123456789');

    response = await createMediaFileResponse(resolved, protocolRequest(`photoflow-media://file/${basicToken}`));
    assert.equal(response.status, 404, 'a verified-handle ticket must be single-consumer');

    resolved = resolve(basicToken, basicPath);
    response = await createMediaFileResponse(resolved, protocolRequest(`photoflow-media://file/${basicToken}`, { method: 'HEAD' }));
    assert.equal(response.status, 200);
    assert.equal(response.body, null);
    assert.equal(response.headers.get('content-length'), '10');

    resolved = resolve(basicToken, basicPath);
    response = await createMediaFileResponse(resolved, protocolRequest(`photoflow-media://file/${basicToken}`, { headers: { Range: 'bytes=2-5' } }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await response.text(), '2345');

    resolved = resolve(basicToken, basicPath);
    response = await createMediaFileResponse(resolved, protocolRequest(`photoflow-media://file/${basicToken}`, { headers: { Range: 'bytes=99-100' } }));
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */10');

    resolved = resolve(basicToken, basicPath);
    response = await createMediaFileResponse(resolved, protocolRequest(`photoflow-media://file/${basicToken}`, { method: 'POST' }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.equal(takeVerifiedMediaHandle(basicToken, basicPath), null, '405 must consume and close its verified ticket');

    const largePath = createAsset('large.mp4', Buffer.alloc(192 * 1024, 7));
    const largeToken = access.grantPath(largePath);
    resolved = resolve(largeToken, largePath);
    await withCloseCount(async closeCount => {
      const streamed = await createMediaFileResponse(resolved, protocolRequest(`photoflow-media://file/${largeToken}`));
      const reader = streamed.body.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.equal(first.value.byteLength, 64 * 1024);
      await reader.cancel('consumer stopped');
      assert.equal(closeCount(), 1, 'stream cancellation must close the verified descriptor exactly once');
    });

    const originalPath = createAsset('replace.mp4', 'ORIGINAL');
    const originalToken = access.grantPath(originalPath);
    resolved = resolve(originalToken, originalPath);
    const movedPath = path.join(root, 'replace-moved.mp4');
    fs.renameSync(originalPath, movedPath);
    fs.writeFileSync(originalPath, 'REPLACEMENT');
    response = await createMediaFileResponse(resolved, protocolRequest(`photoflow-media://file/${originalToken}`));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ORIGINAL', 'a valid protocol response must read only the pre-verified descriptor');

    response = await createMediaFileResponse(originalPath, new Request('https://media.internal/replace.mp4'));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'REPLACEMENT', 'non-protocol internal callers retain explicit path mode');

    const rejectPath = createAsset('reject.mp4', 'SAFE');
    const invalidTargets = [
      token => `photoflow-media://evil/${token}`,
      token => `photoflow-media://user@file/${token}`,
      token => `photoflow-media://user:password@file/${token}`,
      token => `photoflow-media://file:123/${token}`,
      token => `photoflow-media://file/${token}/extra`,
      token => `photoflow-media://file/${token}#fragment`,
    ];
    for (const makeUrl of invalidTargets) {
      const token = access.grantPath(rejectPath);
      const rejectedPath = resolve(token, rejectPath);
      await withCloseCount(async closeCount => {
        const rejected = await createMediaFileResponse(rejectedPath, protocolRequest(makeUrl(token)));
        assert.equal(rejected.status, 404, `${makeUrl(token)} must fail closed`);
        assert.equal(closeCount(), 1, 'an invalid protocol target must close its freshly registered ticket exactly once');
        const repeated = await createMediaFileResponse(rejectedPath, protocolRequest(makeUrl(token)));
        assert.equal(repeated.status, 404);
        assert.equal(closeCount(), 1, 'rejecting the same invalid target twice must not double-close a descriptor');
      });
      assert.equal(takeVerifiedMediaHandle(token, rejectPath), null, 'invalid protocol targets must not leak handle tickets');
    }

    response = await createMediaFileResponse(rejectPath, protocolRequest('photoflow-media://file/not-a-token'));
    assert.equal(response.status, 404, 'an invalid token must never enter path mode');

    const evilPath = createAsset('evil-replace.mp4', 'EVIL-ORIGINAL');
    const evilToken = access.grantPath(evilPath);
    resolved = resolve(evilToken, evilPath);
    fs.renameSync(evilPath, path.join(root, 'evil-replace-moved.mp4'));
    fs.writeFileSync(evilPath, 'EVIL-REPLACEMENT');
    response = await createMediaFileResponse(resolved, protocolRequest(`photoflow-media://evil/${evilToken}`));
    assert.equal(response.status, 404, 'a non-file host must not reopen a replaced path');
    assert.notEqual(await response.text(), 'EVIL-REPLACEMENT');

    const mismatchPath = createAsset('mismatch.mp4', 'MISMATCH');
    const mismatchToken = access.grantPath(rejectPath);
    resolve(mismatchToken, rejectPath);
    response = await createMediaFileResponse(mismatchPath, protocolRequest(`photoflow-media://file/${mismatchToken}`));
    assert.equal(response.status, 404, 'a ticket must remain bound to its verified path');
    assert.equal(takeVerifiedMediaHandle(mismatchToken, rejectPath), null, 'a path mismatch must consume the unusable ticket');

    console.log('Media response service tests passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
