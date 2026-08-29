const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const isolatedId = ['team', 'retouch'].join('-');
const pluginRoot = path.join(root, 'extensions', isolatedId);
const adoptionPolicyPath = path.join(root, 'electron', 'compatibility', 'component-data-adoption-policy.json');
const ignored = new Set(['.git','node_modules','artifacts','.cache','.venv','dist']);
const walk = directory => fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
  if(ignored.has(entry.name)) return [];
  const absolute=path.join(directory,entry.name);
  if(path.resolve(absolute)===path.resolve(pluginRoot)||path.resolve(absolute)===path.resolve(adoptionPolicyPath)) return [];
  return entry.isDirectory()?walk(absolute):[absolute];
});
const forbidden = new RegExp([
  isolatedId,
  ['team','retouch'].join('_'),
  ['team','\\s+','retouch'].join(''),
  ['team','Retouch'].join(''),
  ['workspace','team'].join('-'),
  ['team','patch'].join('_'),
  ['team','person'].join('_'),
  ['team','workspace'].join('_'),
  ['component','identity'].join('_'),
  ['component','patch'].join('_'),
  ['component','person'].join('_'),
  ['edited','patch','path'].join('_'),
  ['sample','component','photos'].join('_'),
  ['person','Detection'].join(''),
  '\\u56e2\\u7247',
].join('|'), 'iu');
const leaks=[];
for(const file of walk(root)){
  if(!/\.(?:cjs|mjs|js|ts|tsx|py|json|md|txt|html|ps1|sh|toml|yml|yaml)$/.test(file)) continue;
  const source=fs.readFileSync(file,'utf8'); if(forbidden.test(source)||forbidden.test(path.relative(root,file))) leaks.push(path.relative(root,file));
}
assert.deepEqual(leaks,[],`component-specific semantics escaped the plugin boundary:\n${leaks.join('\n')}`);
const policy=JSON.parse(fs.readFileSync(adoptionPolicyPath,'utf8'));
assert.deepEqual(Object.keys(policy).sort(),['legacyDomainDatabaseOwners','legacySettingsAdoptions','version']);
assert.equal(policy.version,1);
assert.deepEqual(policy.legacyDomainDatabaseOwners,[{componentId:isolatedId,paths:[`${isolatedId}.sqlite3`]}]);
assert.deepEqual(policy.legacySettingsAdoptions,[{componentId:isolatedId,topLevelKey:['person','Detection'].join('')},{componentId:'video-tools',topLevelKey:'videoTools'}]);
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
