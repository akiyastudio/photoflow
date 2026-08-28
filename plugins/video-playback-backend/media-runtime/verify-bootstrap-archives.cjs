const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [manifestArg, sourceArg, licenseArg] = process.argv.slice(2);
if (!manifestArg || !sourceArg || !licenseArg) {
  throw new Error('Usage: node verify-bootstrap-archives.cjs <runtime-manifest.json> <source.zip> <licenses.zip>');
}

const sha256File = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestArg), 'utf8'));
if (manifest.kind !== 'photoflow-libmpv-runtime' || manifest.reproducibleSource !== true) {
  throw new Error('Bootstrap manifest is not a reproducible PhotoFlow libmpv runtime manifest');
}

const verify = (label, filePath, expected) => {
  if (!expected?.sha256 || !/^[a-f0-9]{64}$/i.test(expected.sha256)) throw new Error(`Bootstrap manifest is missing ${label} SHA-256`);
  const actual = sha256File(path.resolve(filePath));
  if (actual.toLowerCase() !== expected.sha256.toLowerCase()) throw new Error(`Bootstrap ${label} SHA-256 does not match the trusted manifest`);
};

verify('source archive', sourceArg, manifest.complianceArtifacts?.sourceArchive);
verify('license archive', licenseArg, manifest.complianceArtifacts?.licenseArchive);

