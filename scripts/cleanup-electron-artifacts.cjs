const fs = require('fs');
const path = require('path');
const packageJson = require('../package.json');

const root = path.resolve(__dirname, '..');
const outputDirectory = path.resolve(root, packageJson.build?.directories?.output || 'dist');
const outputRelative = path.relative(root, outputDirectory);
if (!outputRelative || outputRelative.startsWith('..') || path.isAbsolute(outputRelative)) {
  throw new Error(`Unsafe Electron output directory: ${outputDirectory}`);
}

const unpackedDirectory = path.join(outputDirectory, 'win-unpacked');
if (path.dirname(unpackedDirectory) !== outputDirectory || path.basename(unpackedDirectory) !== 'win-unpacked') {
  throw new Error(`Unsafe unpacked application path: ${unpackedDirectory}`);
}
if (fs.existsSync(unpackedDirectory)) {
  fs.rmSync(unpackedDirectory, { recursive: true, force: true });
  console.log(`Removed unpacked application directory: ${unpackedDirectory}`);
}

// Component ZIPs use the PhotoFlow-<component> prefix and must remain beside
// the NSIS installer. Remove only legacy application ZIP artifacts.
const productPrefix = `${packageJson.productName}-`;
if (fs.existsSync(outputDirectory)) {
  for (const entry of fs.readdirSync(outputDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(productPrefix) || !entry.name.endsWith('-win.zip')) continue;
    const artifactPath = path.join(outputDirectory, entry.name);
    if (path.dirname(artifactPath) !== outputDirectory) throw new Error(`Unsafe ZIP artifact path: ${artifactPath}`);
    fs.rmSync(artifactPath, { force: true });
    console.log(`Removed legacy application ZIP: ${artifactPath}`);
  }
}
