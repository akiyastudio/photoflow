const assert = require('assert');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const legalRoot = path.join(root, 'docs', 'legal');
const documentNames = [
  'README.md',
  'RELEASE_EVIDENCE_GUIDE.md',
  'PIPIA_TEMPLATE.md',
  'DATA_RETENTION_AND_RIGHTS_RUNBOOK_TEMPLATE.md',
  'THIRD_PARTY_DISTRIBUTION_EVIDENCE.md',
];

const assertNotIgnored = repositoryPath => {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', repositoryPath], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status === 0) assert.fail(`release-critical legal path must not be ignored: ${repositoryPath}`);
  assert.strictEqual(result.status, 1, `git check-ignore failed for ${repositoryPath} (status ${result.status}): ${String(result.stderr || '').trim()}`);
};

assert(fs.existsSync(legalRoot), 'missing legal document directory: docs/legal/');
const documents = new Map(documentNames.map(name => {
  const file = path.join(legalRoot, name);
  assert(fs.existsSync(file), `missing legal evidence document: ${name}`);
  assertNotIgnored(`docs/legal/${name}`);
  return [name, fs.readFileSync(file, 'utf8')];
}));

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert(documents.get('README.md').includes(`适用版本：照片流 ${packageJson.version} 公测版`), 'legal README version must match package.json');

const publicDocumentSection = (documents.get('README.md').split('## 对外文件')[1] || '').split(/^## /m)[0];
const publicDocumentNames = [...publicDocumentSection.matchAll(/`([^`]+\.(?:html|txt))`/gi)].map(match => match[1]);
assert(publicDocumentNames.length > 0, 'legal README must list public HTML/TXT documents');
for (const name of publicDocumentNames) {
  assert(fs.existsSync(path.join(legalRoot, name)), `missing public legal document: ${name}`);
  assertNotIgnored(`docs/legal/${name}`);
}

const blockerSection = documents.get('README.md').split('## 发布阻断项')[1] || '';
const blockerItems = blockerSection.match(/^\d+\. /gm) || [];
assert.strictEqual(blockerItems.length, 5, 'legal README must retain exactly five release blockers');
assert(!/^\s*- \[[xX]\]/m.test(blockerSection), 'release blockers must not be checked as complete');

for (const [name, markdown] of documents) {
  const links = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(match => match[1]);
  for (const link of links) {
    if (/^(?:https?:|mailto:|#)/i.test(link)) continue;
    const target = decodeURIComponent(link.split('#')[0]);
    assert(fs.existsSync(path.resolve(legalRoot, target)), `${name} has missing local link target: ${link}`);
  }
}

for (const [name, required] of Object.entries({
  'RELEASE_EVIDENCE_GUIDE.md': ['营业执照扫描件', '文件 ID', 'SHA-256', 'SLA', '身份核验', '内部证据库'],
  'PIPIA_TEMPLATE.md': ['第五十五条', '第五十六条', '单独同意', '未成年人', '至少保存三年', '[待填写]'],
  'DATA_RETENTION_AND_RIGHTS_RUNBOOK_TEMPLATE.md': ['180 天', '修复后 90 天', '最迟不超过 1 年', 'type` 为 `timer`', '幂等', '复制/导出', '[待核验]'],
  'THIRD_PARTY_DISTRIBUTION_EVIDENCE.md': ['基础 Windows 安装包', '可选组件', 'SBOM', 'PairDETR', '不得公开发行', '[待填写]'],
})) {
  for (const text of required) assert(documents.get(name).includes(text), `${name} must include: ${text}`);
}

const vendorRoot = path.join(root, 'extensions', 'video-tools', 'media-runtime', 'vendor', 'windows-x64');
for (const repositoryPath of [
  'package.json',
  'services/cloudbase/telemetry-function/index.js',
  'docs/CLOUDBASE_ANALYTICS_GUIDE.md',
  'extensions/team-retouch/MODEL-SOURCE.md',
]) assert(fs.existsSync(path.join(root, repositoryPath)), `documented repository path is missing: ${repositoryPath}`);

const normalizeText = buffer => Buffer.from(buffer.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
const sha256 = content => crypto.createHash('sha256').update(content).digest('hex');
const sumsFile = path.join(vendorRoot, 'SHA256SUMS.txt');
assert(fs.existsSync(sumsFile), 'missing FFmpeg release material: SHA256SUMS.txt');
const normalizedSums = normalizeText(fs.readFileSync(sumsFile));
const sumsText = normalizedSums.toString('utf8');
const sumsDocumentHash = sha256(normalizedSums);
const declaredSums = new Map(sumsText.trim().split('\n').map(line => {
  const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
  assert(match, `invalid SHA256SUMS line: ${line}`);
  return [match[2], match[1].toLowerCase()];
}));
const vendorFiles = [
  'ffmpeg-runtime-manifest.json',
  'ffmpeg-runtime-windows-x64.zip',
  'ffmpeg-corresponding-source.zip',
  'ffmpeg-licenses.zip',
];
assert.deepStrictEqual([...declaredSums.keys()].sort(), [...vendorFiles].sort(), 'SHA256SUMS.txt must declare exactly the expected vendor files');
const manifest = JSON.parse(normalizeText(fs.readFileSync(path.join(vendorRoot, 'ffmpeg-runtime-manifest.json'))).toString('utf8'));
assert(manifest.artifacts && typeof manifest.artifacts === 'object', 'FFmpeg manifest must declare artifacts');
const manifestSums = new Map(Object.values(manifest.artifacts).map(artifact => [artifact.file, artifact.sha256.toLowerCase()]));
const hashFindings = vendorFiles.map(name => {
  const file = path.join(vendorRoot, name);
  assert(fs.existsSync(file), `missing FFmpeg release material: ${name}`);
  const raw = fs.readFileSync(file);
  const content = name.endsWith('.json') || name.endsWith('.txt') ? normalizeText(raw) : raw;
  const actual = sha256(content);
  const sumsDeclared = declaredSums.get(name);
  assert(sumsDeclared, `SHA256SUMS.txt must declare: ${name}`);
  assert.strictEqual(actual, sumsDeclared, `${name} hash must match SHA256SUMS.txt`);
  const manifestDeclared = manifestSums.get(name);
  if (name !== 'ffmpeg-runtime-manifest.json') {
    assert(manifestDeclared, `FFmpeg manifest must declare artifact: ${name}`);
    assert.strictEqual(actual, manifestDeclared, `${name} hash must match FFmpeg manifest`);
  }
  return {
    name,
    actual,
    sumsDeclared,
    manifestDeclared: manifestDeclared || null,
  };
});

for (const artifactName of manifestSums.keys()) {
  assert(vendorFiles.includes(artifactName), `FFmpeg manifest declares an unexpected artifact: ${artifactName}`);
}

const openFields = [...documents.values()].reduce((count, text) => count + (text.match(/\[(?:待填写|待核验)[^\]]*\]/g) || []).length, 0);
console.log('Legal release evidence structural, local-link, and FFmpeg integrity checks completed.');
console.log(JSON.stringify({ releaseReady: false, openTemplateFields: openFields, sumsDocumentHash, ffmpegHashFindings: hashFindings }, null, 2));
console.log('Release remains blocked until user-owned facts, controlled evidence, approvals, and signatures are supplied.');
