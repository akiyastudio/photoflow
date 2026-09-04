const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHostSimulator } = require('./host-simulator.cjs');
const root = path.resolve(__dirname, '..');
const renderer = ['legacy-main.tsx','legacy/PersonIdentityManager.tsx','legacy/TeamRetouchOutputProgress.tsx','legacy/useTeamOutputProgress.ts','legacy/legacy-api.ts'].map(file => fs.readFileSync(path.join(root,'renderer','src',file),'utf8')).join('\n');
const model = fs.readFileSync(path.join(root,'renderer','src','interaction-model.ts'),'utf8');
assert(model.includes("folder.mediaKind === 'image'") && model.includes("folder.nodeRole === 'progress'"));
assert(renderer.includes('legacyApi.getProgressFolders') && renderer.includes('legacyApi.registerProgressWithGraph'));
assert(renderer.includes("relativePath: '团片协作合并'") && renderer.includes('项目根目录 / 团片协作合并'), 'projects without an image progress must publish merges into a dedicated project-root folder');
const calls=[];let outputCreated=false;
const simulator=createHostSimulator({service:path.join(root,'service.cjs'),context:{componentId:'team-retouch',componentVersion:'test',surface:'project',projectId:'p',projectName:'P',projectStatus:'active'},capabilities:{
  'project.progress':payload=>{calls.push(payload);if(payload.action==='create'){outputCreated=true;return{progress:{id:'output',nodeRole:'progress',mediaKind:'image',missing:false},edges:[]};}return{progress:[{id:'original',nodeRole:'original',mediaKind:'image'},...(outputCreated?[{id:'output',nodeRole:'progress',mediaKind:'image',missing:false}]:[])],edges:[]};}
}});
(async()=>{try{const listed=await simulator.request('team.progress.list.v1');assert.equal(listed.progressFolders[0].id,'original');const created=await simulator.request('team.progress.create.v1',{progress:{mediaKind:'image',displayName:'Output'},workflowInputProgressIds:['source']});assert.equal(created.progressFolder.id,'output');const reused=await simulator.request('team.progress.create.v1',{progress:{progressId:'output'},workflowInputProgressIds:['workflow']});assert.equal(reused.progressFolder.id,'output','an existing selected output progress is reused instead of recreated under a workflow node');assert.deepEqual(calls.map(call=>call.action),['list','list','create','list']);console.log('Team-retouch version graph capability boundary passed');}finally{simulator.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
