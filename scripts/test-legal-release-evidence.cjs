const assert = require('assert');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
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
const approvalTemplatePath = path.join(legalRoot, 'RELEASE_APPROVAL_TEMPLATE.json');
const approvalPath = path.join(legalRoot, 'RELEASE_APPROVAL.json');
const requireReady = process.argv.includes('--require-ready');
const installerArgumentIndex = process.argv.indexOf('--installer');
const installerArgument = installerArgumentIndex >= 0 ? process.argv[installerArgumentIndex + 1] : '';
const deliveryManifestArgumentIndex = process.argv.indexOf('--delivery-manifest');
const deliveryManifestArgument = deliveryManifestArgumentIndex >= 0 ? process.argv[deliveryManifestArgumentIndex + 1] : '';
const blockerIds = [
  'operatorAddress',
  'rightsRequestChannel',
  'cloudbaseRetention',
  'faceRecognitionPipia',
  'thirdPartyDistribution',
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

assert(fs.existsSync(approvalTemplatePath), 'missing legal release approval template');
assertNotIgnored('docs/legal/RELEASE_APPROVAL_TEMPLATE.json');

const exactKeys = (value, expected, label) => {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepStrictEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has missing or unexpected fields`);
};
const isIsoDate = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && !Number.isNaN(Date.parse(value))
  && new Date(value).toISOString() === value;
const isPlaceholder = value => typeof value !== 'string'
  || !value.trim()
  || /(?:\[待|TODO|TBD|PLACEHOLDER|CHANGE_ME|YYYY|64_HEX|APPROVER_ROLE|EVIDENCE_ID)/i.test(value);
const assertNonSensitiveIndexValue = (value, label, maxLength) => {
  assert(!isPlaceholder(value), `${label} must be complete and non-placeholder`);
  assert(value.length <= maxLength && !/[\r\n]/.test(value), `${label} must be a short opaque index value`);
  assert(!/(?:data:|base64|password|secret|token|private[ _-]?key|签名|证照|密钥)/i.test(value), `${label} must not contain sensitive originals or credentials`);
};
const assertNoSensitiveApprovalContent = approval => {
  const forbiddenKeys = /(?:signature|signedDocument|credential|secret|token|privateKey|idNumber|licenseImage|签名|证照|密钥)/i;
  const visit = (value, trail = 'approval') => {
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${trail}[${index}]`));
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert(!forbiddenKeys.test(key), `${trail}.${key} must not contain sensitive originals or credentials`);
      visit(child, `${trail}.${key}`);
    }
  };
  visit(approval);
  assert(!/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/.test(JSON.stringify(approval)), 'approval index must not embed keys or certificates');
};
const validateApprovalShape = (approval, { strict }) => {
  exactKeys(approval, ['schemaVersion', 'releaseVersion', 'buildSourceCommit', 'status', 'approvedAt', 'installerSha256', 'deliveryManifestSha256', 'approvalRoles', 'blockers'], 'release approval');
  assert.strictEqual(approval.schemaVersion, 2, 'release approval schemaVersion must be 2');
  exactKeys(approval.approvalRoles, ['business', 'privacy', 'legal'], 'release approval roles');
  exactKeys(approval.blockers, blockerIds, 'release approval blockers');
  for (const blockerId of blockerIds) {
    exactKeys(approval.blockers[blockerId], ['evidenceId', 'sha256', 'approvedAt', 'approvedByRole'], `release approval blocker ${blockerId}`);
  }
  assertNoSensitiveApprovalContent(approval);
  if (!strict) return;
  assert.strictEqual(approval.releaseVersion, packageJson.version, 'release approval version must match package.json');
  assert.strictEqual(approval.status, 'approved', 'release approval status must be approved');
  assert(isIsoDate(approval.approvedAt), 'release approval approvedAt must be an exact ISO UTC timestamp');
  assert(/^[a-f0-9]{64}$/i.test(approval.installerSha256), 'release approval installerSha256 must be 64 hexadecimal characters');
  assert(/^[a-f0-9]{64}$/i.test(approval.deliveryManifestSha256), 'release approval deliveryManifestSha256 must be 64 hexadecimal characters');
  assert(/^[a-f0-9]{40}$/i.test(approval.buildSourceCommit), 'release approval buildSourceCommit must be a full Git SHA');
  for (const [area, role] of Object.entries(approval.approvalRoles)) {
    assertNonSensitiveIndexValue(role, `release approval ${area} role`, 80);
  }
  for (const blockerId of blockerIds) {
    const blocker = approval.blockers[blockerId];
    assertNonSensitiveIndexValue(blocker.evidenceId, `release approval blocker ${blockerId} evidenceId`, 128);
    assert(/^[a-f0-9]{64}$/i.test(blocker.sha256), `release approval blocker ${blockerId} sha256 must be 64 hexadecimal characters`);
    assert(isIsoDate(blocker.approvedAt), `release approval blocker ${blockerId} approvedAt must be an exact ISO UTC timestamp`);
    assertNonSensitiveIndexValue(blocker.approvedByRole, `release approval blocker ${blockerId} approvedByRole`, 80);
  }
};

const approvalTemplate = JSON.parse(fs.readFileSync(approvalTemplatePath, 'utf8'));
validateApprovalShape(approvalTemplate, { strict: false });

const approvalIsTrackedAndClean = () => {
  const repositoryPath = 'docs/legal/RELEASE_APPROVAL.json';
  const runGit = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git ${args.join(' ')} failed with status ${result.status}: ${String(result.stderr || '').trim()}`);
    }
    return result.status;
  };
  return runGit(['ls-files', '--error-unmatch', '--', repositoryPath]) === 0
    && runGit(['diff', '--quiet', '--', repositoryPath]) === 0
    && runGit(['diff', '--cached', '--quiet', '--', repositoryPath]) === 0;
};

const publicDocumentSection = (documents.get('README.md').split('## 对外文件')[1] || '').split(/^## /m)[0];
const publicDocumentNames = [...publicDocumentSection.matchAll(/`([^`]+\.(?:html|txt))`/gi)].map(match => match[1]);
assert(publicDocumentNames.length > 0, 'legal README must list public HTML/TXT documents');
for (const name of publicDocumentNames) {
  assert(fs.existsSync(path.join(legalRoot, name)), `missing public legal document: ${name}`);
  assertNotIgnored(`docs/legal/${name}`);
}
const legalExtraResources = (packageJson.build?.extraResources || []).filter(entry => entry?.from === 'docs/legal');
assert.strictEqual(legalExtraResources.length, 1, 'package build must have exactly one docs/legal extraResources rule');
assert.deepStrictEqual(legalExtraResources[0].filter, ['*.html'], 'runtime legal resources must include public HTML only');
assert(!legalExtraResources[0].filter.some(pattern => /(?:\.md|\.json|RELEASE_APPROVAL)/i.test(pattern)), 'release approval indexes and internal Markdown must never enter runtime legal resources');
const publicHtmlNames = publicDocumentNames.filter(name => name.toLowerCase().endsWith('.html')).sort();
const legalHtmlNames = fs.readdirSync(legalRoot).filter(name => name.toLowerCase().endsWith('.html')).sort();
assert.deepStrictEqual(legalHtmlNames, publicHtmlNames, 'the *.html package filter must resolve exactly to the README public HTML set');

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
  'electron/services/telemetry-service.cjs',
  'docs/CLOUD_API_CONTRACT.md',
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

const sha256File = filePath => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  stream.on('error', reject);
  stream.on('data', chunk => hash.update(chunk));
  stream.on('end', () => resolve(hash.digest('hex')));
});

const run = async () => {
  const openFields = [...documents.values()].reduce((count, text) => count + (text.match(/\[(?:待填写|待核验)[^\]]*\]/g) || []).length, 0);
  let approval = null;
  let releaseReady = false;
  if (fs.existsSync(approvalPath)) {
    assertNotIgnored('docs/legal/RELEASE_APPROVAL.json');
    approval = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
    validateApprovalShape(approval, { strict: true });
    releaseReady = approvalIsTrackedAndClean();
  }

  if (requireReady && !approval) {
    throw new Error('legal release approval is missing: copy RELEASE_APPROVAL_TEMPLATE.json to RELEASE_APPROVAL.json and complete only the non-sensitive evidence index');
  }
  if (requireReady && !releaseReady) {
    throw new Error('legal release approval must be tracked by Git and identical in the work tree, index, and HEAD');
  }
  if (requireReady && installerArgument) {
    const installerPath = path.resolve(installerArgument);
    assert(fs.existsSync(installerPath) && fs.statSync(installerPath).isFile(), `release installer does not exist: ${installerPath}`);
    const installerSha256 = await sha256File(installerPath);
    assert.strictEqual(installerSha256.toLowerCase(), approval.installerSha256.toLowerCase(), 'release approval installerSha256 must match the selected installer');
  }
  if (requireReady && deliveryManifestArgument) {
    const manifestPath = path.resolve(deliveryManifestArgument);
    assert(fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile(), `delivery manifest does not exist: ${manifestPath}`);
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifestSha256 = sha256(manifestBytes);
    const deliveryManifest = JSON.parse(manifestBytes);
    assert.strictEqual(manifestSha256.toLowerCase(), approval.deliveryManifestSha256.toLowerCase(), 'release approval deliveryManifestSha256 must match the selected manifest');
    assert.strictEqual(deliveryManifest.buildSourceCommit, approval.buildSourceCommit, 'release approval buildSourceCommit must match the selected manifest');
    assert.strictEqual(deliveryManifest.version, approval.releaseVersion, 'release approval version must match the selected manifest');
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', approval.buildSourceCommit, 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(ancestry.status, 0, 'approval commit must descend from the immutable buildSourceCommit');
  }

  console.log('Legal release evidence structural, local-link, and FFmpeg integrity checks completed.');
  console.log(JSON.stringify({
    releaseReady,
    approvalIndex: approval ? 'docs/legal/RELEASE_APPROVAL.json' : null,
    openTemplateFields: openFields,
    sumsDocumentHash,
    ffmpegHashFindings: hashFindings,
  }, null, 2));
  if (!releaseReady) console.log('Release remains blocked until the non-sensitive approval index references completed evidence and approvals in the controlled evidence repository.');

  if (requireReady) return;

  const strict = spawnSync(process.execPath, [__filename, '--require-ready'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (releaseReady) {
    assert.strictEqual(strict.status, 0, 'strict legal release readiness must pass for a valid, tracked, clean approval index');
  } else {
    assert.notStrictEqual(strict.status, 0, 'strict legal release readiness must fail until a valid, tracked, clean approval index exists');
  }

  if (!approval) {
    assert.match(`${strict.stdout}\n${strict.stderr}`, /legal release approval is missing/i);
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-legal-release-gate-'));
    try {
    const installerPath = path.join(fixtureRoot, 'Photoflow Setup 99.99.99.exe');
    const networkSentinel = path.join(fixtureRoot, 'network-called');
    const preloadPath = path.join(fixtureRoot, 'deny-network.cjs');
    fs.writeFileSync(installerPath, 'not a real installer; legal gate must fail before publishing');
    fs.writeFileSync(preloadPath, `global.fetch=async()=>{require('fs').writeFileSync(${JSON.stringify(networkSentinel)},'called');throw new Error('network must not be called')};\n`);
    const childEnv = {
      ...process.env,
      NODE_OPTIONS: `${String(process.env.NODE_OPTIONS || '').trim()} --require=${preloadPath}`.trim(),
      PHOTOFLOW_ADMIN_TOKEN: 'test-token-must-not-be-used',
    };
    const publish = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'publish-release.cjs'),
      '--installer', installerPath,
      '--notes', 'legal gate regression',
      '--mandatory', 'false',
      '--skip-upload-pause', 'true',
    ], { cwd: root, env: childEnv, encoding: 'utf8', windowsHide: true });
    assert.notStrictEqual(publish.status, 0, 'publish-release must fail closed when the approval index is absent');
    assert.match(`${publish.stdout}\n${publish.stderr}`, /发布必须显式提供 --manifest|legal release approval is missing/i);

    const releaseVersion = `99.${crypto.randomInt(10, 90)}.${crypto.randomInt(10, 90)}`;
    const candidatePath = path.join(root, 'artifacts', 'cloudbase', `app-release-${releaseVersion}.json`);
    assert(!fs.existsSync(candidatePath), 'legal gate regression candidate must start absent');
    const generate = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'generate-release-json.cjs'),
      '--version', releaseVersion,
      '--installer', installerPath,
      '--notes', 'legal gate regression',
      '--publish', 'true',
    ], { cwd: root, env: childEnv, encoding: 'utf8', windowsHide: true });
    assert.notStrictEqual(generate.status, 0, 'generate-release-json --publish true must fail closed when the approval index is absent');
    assert.match(`${generate.stdout}\n${generate.stderr}`, /只能生成未发布草稿/i);
    assert(!fs.existsSync(candidatePath), 'strict legal gate must fail before writing a release JSON');

    const publishedOnly = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'generate-release-json.cjs'),
      '--version', releaseVersion,
      '--installer', installerPath,
      '--notes', 'legal gate regression',
      '--published', 'true',
      '--publish', 'false',
    ], { cwd: root, env: childEnv, encoding: 'utf8', windowsHide: true });
    assert.notStrictEqual(publishedOnly.status, 0, 'generate-release-json --published true must fail closed even without network publishing');
    assert.match(`${publishedOnly.stdout}\n${publishedOnly.stderr}`, /只能生成未发布草稿/i);
    assert(!fs.existsSync(candidatePath), 'strict legal gate must fail before writing an importable published release JSON');
    assert(!fs.existsSync(networkSentinel), 'strict legal gate must fail before any release network request');
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }

  const publishSource = fs.readFileSync(path.join(root, 'scripts', 'publish-release.cjs'), 'utf8');
  const publishRun = publishSource.slice(publishSource.indexOf('const run = async'));
  assert(publishRun.indexOf('runLegalReleaseReadyGate(installerPath, manifestPath)') < publishRun.indexOf('process.env.PHOTOFLOW_ADMIN_TOKEN'), 'publish-release must run the strict staged gate before reading an admin token');
  assert(publishRun.indexOf('runLegalReleaseReadyGate(installerPath, manifestPath)') < publishRun.indexOf('assertPublisherReady(token)'), 'publish-release must run the strict staged gate before network readiness checks');
  assert(publishRun.includes("'--delivery-manifest', manifestPath"), 'publish-release must bind legal approval to the stable delivery manifest');
  assert(publishRun.includes("'--installer', installerPath"), 'publish-release must pass the approved installer path to generate-release-json');
  const generateSource = fs.readFileSync(path.join(root, 'scripts', 'generate-release-json.cjs'), 'utf8');
  const generateRun = generateSource.slice(generateSource.indexOf('const run = async'));
  assert(generateRun.indexOf('runLegalReleaseReadyGate(installerPath)') < generateRun.indexOf('publishRelease(record)'), 'generate-release-json must run the strict gate before publishing');
  assert(generateRun.includes('const published = booleanValue(args.published, false)'), 'candidate release JSON must default to published false');
  assert(generateRun.includes('const requiresReleaseApproval = shouldPublish || published'), 'both network publishing and importable published JSON must require approval');
};

run().catch(error => {
  console.error(`Legal release evidence check failed: ${error.message || error}`);
  process.exitCode = 1;
});
