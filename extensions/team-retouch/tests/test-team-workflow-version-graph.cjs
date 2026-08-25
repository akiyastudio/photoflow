const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHostSimulator } = require('./host-simulator.cjs');
const root = path.resolve(__dirname, '..');
const renderer = ['legacy-main.tsx','legacy/PersonIdentityManager.tsx','legacy/TeamRetouchOutputProgress.tsx','legacy/useTeamOutputProgress.ts','legacy/legacy-api.ts'].map(file => fs.readFileSync(path.join(root,'renderer','src',file),'utf8')).join('\n');
const model = fs.readFileSync(path.join(root,'renderer','src','interaction-model.ts'),'utf8');
assert(model.includes("folder.mediaKind === 'image'") && model.includes("folder.nodeRole === 'progress'"));
assert(renderer.includes('legacyApi.getProgressFolders') && renderer.includes('legacyApi.registerProgressWithGraph'));
const calls=[];
const simulator=createHostSimulator({service:path.join(root,'service.cjs'),context:{componentId:'team-retouch',componentVersion:'test',surface:'project',projectId:'p',projectName:'P',projectStatus:'active'},capabilities:{
  'project.progress.v2':payload=>{calls.push(payload);return payload.action==='create'?{apiVersion:2,progress:{id:'output'},edges:[]}:{apiVersion:2,progress:[{id:'original',nodeRole:'original'}],edges:[]};}
}});
(async()=>{try{const listed=await simulator.request('team.progress.list.v1');assert.equal(listed.progressFolders[0].id,'original');const created=await simulator.request('team.progress.create.v1',{progress:{mediaKind:'image',displayName:'Output'},workflowInputProgressIds:['source']});assert.equal(created.progressFolder.id,'output');assert.deepEqual(calls.map(call=>call.action),['list','list','create']);console.log('Team-retouch version graph capability boundary passed');}finally{simulator.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
