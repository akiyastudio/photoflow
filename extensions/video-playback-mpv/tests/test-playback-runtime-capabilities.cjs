const assert = require('node:assert/strict');
const { verifyLibplaceboCompiler } = require('../scripts/vendor/playback-runtime-capabilities.cjs');
const manifest = { files: [{ file: 'libplacebo-351.dll' }, { file: 'libshaderc_shared.dll' }] };
assert.equal(verifyLibplaceboCompiler('.', manifest, () => ['kernel32.dll', 'libshaderc_shared.dll']), true);
assert.throws(() => verifyLibplaceboCompiler('.', manifest, () => ['kernel32.dll']), /未启用 shaderc/,
  'Bundling shaderc alone must not admit a compiler-disabled libplacebo');
assert.throws(() => verifyLibplaceboCompiler('.', { files: [manifest.files[0]] }), /缺少/);
assert.throws(() => verifyLibplaceboCompiler('.', { files: [manifest.files[1]] }), /缺少/);
console.log('libplacebo shader compiler admission tests passed.');
