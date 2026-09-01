const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const isolatedId = 'team-retouch';
const pluginRoot = path.join(root, 'extensions', isolatedId);
const adoptionPolicyPath = path.join(root, 'electron', 'compatibility', 'component-data-adoption-policy.json');
const ignored = new Set(['.git','node_modules','artifacts','.cache','.venv','dist']);
const walk = directory => fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
  if(ignored.has(entry.name)) return [];
  const absolute=path.join(directory,entry.name);
  return entry.isDirectory()?walk(absolute):[absolute];
});
const normalize = value => value.replaceAll('\\', '/');
const productionRoots = new Set(['component-sdk', 'electron', 'extensions', 'public', 'python', 'services', 'src']);
const buildAndConfigRoots = new Set(['.github', 'packaging']);
const scannedTextExtensions = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.py', '.json', '.md', '.txt', '.html', '.ps1', '.sh', '.toml', '.yml', '.yaml', '.css', '.cs', '.c', '.svg', '.nsh', '.manifest', '.patch']);
const explicitlyBinaryExtensions = new Set(['.onnx', '.zip', '.ico']);
const isTestOrDocumentationPath = relativePath => {
  const segments = normalize(relativePath).split('/');
  const fileName = segments.at(-1) || '';
  return segments.some(segment => /^(?:docs?|tests?|__tests__|fixtures?)$/i.test(segment))
    || /^(?:test[-_.]|.*\.(?:test|spec)\.)/i.test(fileName)
    || /^(?:README|CHANGELOG|CONTRIBUTING|MODEL-SOURCE)(?:\.|$)/i.test(fileName);
};
const isProductionBuildOrConfigPath = relativePath => {
  const normalized = normalize(relativePath);
  if (isTestOrDocumentationPath(normalized)) return false;
  const [topLevel] = normalized.split('/');
  if (productionRoots.has(topLevel) || buildAndConfigRoots.has(topLevel)) return true;
  if (topLevel === 'scripts') return !/^scripts\/(?:test[-_.]|run-(?:full-)?test)/i.test(normalized);
  return !normalized.includes('/') && /^(?:package(?:-lock)?\.json|requirements\.txt|.*\.config\.[cm]?[jt]s|tsconfig(?:\.[^.]+)?\.json|index\.html|toast-view\.html)$/i.test(normalized);
};
const shouldScanArchitectureTextPath = relativePath => {
  const normalized = normalize(relativePath);
  const extension = path.extname(normalized).toLowerCase();
  return !explicitlyBinaryExtensions.has(extension)
    && scannedTextExtensions.has(extension)
    && isProductionBuildOrConfigPath(normalized);
};
const forbidden = new RegExp([
  'team-retouch',
  'team_retouch',
  'team\\s+retouch',
  'teamRetouch',
  'workspace-team',
  'team_patch',
  'team_person',
  'team_workspace',
  'component_identity',
  'component_patch',
  'component_person',
  'edited_patch_path',
  'sample_component_photos',
  'personDetection',
  '\\u56e2\\u7247',
].join('|'), 'iu');
const isArchitectureTextLeak = (relativePath, source) => shouldScanArchitectureTextPath(relativePath)
  && (forbidden.test(source) || forbidden.test(normalize(relativePath)));
const leaks=[];
for(const file of walk(root)){
  if(path.resolve(file).startsWith(`${path.resolve(pluginRoot)}${path.sep}`)||path.resolve(file)===path.resolve(adoptionPolicyPath)) continue;
  const relativeFile=path.relative(root,file);
  if(!shouldScanArchitectureTextPath(relativeFile)) continue;
  const source=fs.readFileSync(file,'utf8'); if(isArchitectureTextLeak(relativeFile, source)) leaks.push(relativeFile);
}
assert.deepEqual(leaks,[],`component-specific semantics escaped the plugin boundary:\n${leaks.join('\n')}`);
assert.equal(isArchitectureTextLeak('src/styles/native-leak.css', isolatedId), true, 'a production CSS semantic leak must fail the policy');
assert.equal(isArchitectureTextLeak('electron/native/source.c', isolatedId), true, 'a native source semantic leak must fail the policy');
assert.equal(isArchitectureTextLeak('packaging/include/installer.nsh', isolatedId), true, 'an installer-script semantic leak must fail the policy');
assert.equal(isArchitectureTextLeak('packaging/app.manifest', isolatedId), true, 'an installer-manifest semantic leak must fail the policy');
assert.equal(isArchitectureTextLeak('packaging/update.patch', isolatedId), true, 'a build-patch semantic leak must fail the policy');
for (const binaryPath of ['python/models/model.onnx', 'packaging/archive.zip', 'packaging/icon.ico']) assert.equal(shouldScanArchitectureTextPath(binaryPath), false, `${binaryPath} must not be decoded as text`);
const policy=JSON.parse(fs.readFileSync(adoptionPolicyPath,'utf8'));
assert.deepEqual(Object.keys(policy).sort(),['legacyDomainDatabaseOwners','legacySettingsAdoptions','version']);
assert.equal(policy.version,1);
assert.deepEqual(policy.legacyDomainDatabaseOwners,[{componentId:isolatedId,paths:[`${isolatedId}.sqlite3`]}]);
assert.deepEqual(policy.legacySettingsAdoptions,[{componentId:isolatedId,topLevelKey:'personDetection'},{componentId:'video-tools',topLevelKey:'videoTools'}]);
const policyApi=require('../electron/compatibility/component-data-adoption-policy.cjs');
assert(Object.isFrozen(policyApi.defaultComponentDataAdoptionPolicy));
assert(Object.isFrozen(policyApi.defaultComponentDataAdoptionPolicy.legacyDomainDatabaseOwners));
assert(Object.isFrozen(policyApi.defaultComponentDataAdoptionPolicy.legacySettingsAdoptions));
assert.throws(()=>policyApi.createComponentDataAdoptionPolicy({...policy,legacySettingsAdoptions:[...policy.legacySettingsAdoptions,{componentId:'fixture',topLevelKey:policy.legacySettingsAdoptions[0].topLevelKey}]}),/Duplicate/);
assert.throws(()=>policyApi.authorizesLegacySettingsAdoption('fixture','legacyFixture',{legacySettingsAdoptions:[{componentId:'fixture',topLevelKey:'legacyFixture'}]}),/Unvalidated/);
const main=fs.readFileSync(path.join(root,'electron','main.cjs'),'utf8');
const builder=fs.readFileSync(path.join(root,'scripts','build-components.cjs'),'utf8');
const catalog=fs.readFileSync(path.join(root,'electron','plugins','plugin-catalog.cjs'),'utf8');
const capabilities=fs.readFileSync(path.join(root,'electron','services','component-project-capabilities.cjs'),'utf8');
assert(!main.includes('extensions')&&!main.includes('developmentAlgorithmRuntimes'));
assert(builder.includes('photoflowComponent')&&builder.includes("scripts?.['package:host']"));
assert(!catalog.includes('LEGACY_PLUGIN_DEFINITIONS'));
assert(capabilities.includes("payload.action === 'adopt'")&&capabilities.includes('project.output.existing.v1'));
for(const removed of [`component-${isolatedId}-v1-adapter.cjs`,`component-${isolatedId}-rpc-v1.cjs`,'component-v1-metadata.cjs','component-host-v1.cjs','component-preload-v1.cjs']) assert(!fs.existsSync(path.join(root,'electron','compatibility',removed)));
console.log('Architecture and plugin isolation tests passed.');

module.exports = { isArchitectureTextLeak, isProductionBuildOrConfigPath, isTestOrDocumentationPath, shouldScanArchitectureTextPath };
