const path = require('node:path');
const { readPeDependencies } = require('./pe-dependency-closure.cjs');

// This runtime recipe links shaderc dynamically. Merely bundling its DLL or
// enabling mpv's own shaderc option does not enable libplacebo's compiler.
const verifyLibplaceboCompiler = (root, manifest, readDependencies = readPeDependencies) => {
  const files = manifest.files || [];
  const library = files.find(entry => /^libplacebo-[\d]+\.dll$/i.test(entry.file));
  const compiler = files.find(entry => /^libshaderc_shared\.dll$/i.test(entry.file));
  if (!library || !compiler) throw new Error('gpu-next 运行时缺少 libplacebo 或 shaderc DLL');
  const dependencies = readDependencies(path.resolve(root, library.file));
  if (!dependencies.some(name => name.toLowerCase() === 'libshaderc_shared.dll')) {
    throw new Error('libplacebo 未启用 shaderc；不能用这份运行时生成 gpu-next 高级解码组件，请重建 libplacebo');
  }
  return true;
};

module.exports = { verifyLibplaceboCompiler };
