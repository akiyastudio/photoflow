// An isolated implementation of the documented protocol for tests and preview.
// This file is never bundled into the installed component.
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {sha}=require('../service/format.cjs');
const Ajv2020=require('ajv/dist/2020');
const schema=require('../../../electron/contracts/schemas/component-host-api.schema.json');
const validators=new Map();
for(const definition of Object.values(schema.$defs))if(definition.properties?.method?.const&&definition.properties?.payload){const validate=new Ajv2020({strict:false}).compile({$schema:schema.$schema,$defs:schema.$defs,...definition.properties.payload});validators.set(definition.properties.method.const,validate);}
function fixture(root){
  const data=path.join(root,'component-private'),project=path.join(root,'project');fs.mkdirSync(data,{recursive:true});fs.mkdirSync(project,{recursive:true});
  const tokens=new Map(),stages=new Map(),commits=new Map(),tasks=new Map(),calls=[],dialogs=[];
  const resolve=(base,relative)=>{const full=path.resolve(base,relative);if(path.relative(base,full).startsWith('..')||path.isAbsolute(relative))throw new Error('Scope escape');return full;};
  const token=file=>{const key=randomUUID();tokens.set(key,file);return {token:key,expiresAt:Date.now()+600000,name:path.basename(file)};};
  let baseURL='';
  async function callHost(parentId,method,p={}){
    const validate=validators.get(method);if(!validate||!validate(p))throw new Error(`Published Host API request mismatch ${method}: ${JSON.stringify(validate?.errors)}`);
    calls.push({method,payload:p});
    if(method==='component.storage')return {dataPath:data,databasePath:path.join(data,'unused.sqlite'),projectId:'fixture-project',ownership:'component-private'};
    if(method==='project.media.page'){
      const names=fs.readdirSync(project).filter(n=>/\.(png|jpe?g|webp|gif)$/i.test(n));const offset=Number(p.cursor)||0;const chunk=names.slice(offset,offset+(p.pageSize||50));
      return {items:chunk.map(name=>({relativePath:name,mediaRef:{relativePath:name},name,kind:'image',extension:path.extname(name),size:fs.statSync(path.join(project,name)).size,updatedAt:1})),page:{cursor:offset+chunk.length<names.length?String(offset+chunk.length):null,hasMore:offset+chunk.length<names.length,pageSize:p.pageSize||50}};
    }
    if(method==='project.media.variants'){
      const file=resolve(project,p.relativePath);if(!fs.existsSync(file))throw new Error('Media missing');const variants={};for(const type of p.variants)variants[type]={url:`${baseURL}/project-media/${encodeURIComponent(p.relativePath)}`,derived:type!=='original',maxEdge:type==='thumbnail'?320:1600};
      return {mediaRef:{relativePath:p.relativePath},metadata:{displayName:path.basename(file),relativePath:p.relativePath},variants,...(p.variants.includes('original')?{input:token(file)}:{})};
    }
    if(method==='project.input.tokens'){
      const file=tokens.get(p.token);if(!file)throw new Error('Token expired or consumed');tokens.delete(p.token);const target=path.join(data,`input-${randomUUID()}`);fs.copyFileSync(file,target);return {inputId:randomUUID(),privatePath:target,byteLength:fs.statSync(target).size,expiresAt:Date.now()+600000};
    }
    if(method==='component.media'){
      const file=resolve(data,p.relativePath);if(!fs.existsSync(file))throw new Error('Private media missing');return {opaqueRef:randomUUID(),variants:Object.fromEntries(p.variants.map(type=>[type,{url:`${baseURL}/private-media/${encodeURIComponent(p.relativePath)}`,derived:true,maxEdge:type==='thumbnail'?320:1600}]))};
    }
    if(method==='dialogs'){
      if(p.kind==='openFiles')return dialogs.shift()||{cancelled:true,inputs:[]};return {opened:true};
    }
    if(method==='tasks'){
      const prior=tasks.get(p.operationId)||{id:p.operationId,state:'running'};if(p.action==='cancel')prior.state='cancelled';else if(p.action==='complete')prior.state='completed';Object.assign(prior,{progress:p.progress??prior.progress});tasks.set(p.operationId,prior);return {task:prior,cancelled:prior.state==='cancelled'};
    }
    if(method==='project.output'){
      if(p.action==='stage'){const stageId=randomUUID(),privatePath=path.join(data,'stages',stageId);fs.mkdirSync(privatePath,{recursive:true});stages.set(stageId,{privatePath,files:[]});return {stageId,privatePath,expiresAt:Date.now()+86400000};}
      if(p.action==='commit'&&commits.has(p.idempotencyKey))return commits.get(p.idempotencyKey);
      const stage=stages.get(p.stageId);if(!stage)throw new Error('Stage missing');
      if(p.action==='write'){const source=resolve(stage.privatePath,p.sourceName);if(!fs.existsSync(source))throw new Error('Source missing');const existing=stage.files.find(f=>f.name===p.name);if(existing)return {stageId:p.stageId,artifactId:existing.artifactId,byteLength:fs.statSync(source).size};const entry={name:p.name,source,relativePath:p.outputRelativePath,artifactId:randomUUID()};stage.files.push(entry);return {stageId:p.stageId,artifactId:entry.artifactId,byteLength:fs.statSync(source).size};}
      if(p.action==='validate'){if(!stage.files.length)throw new Error('Empty stage');return {stageId:p.stageId,valid:true,fileCount:stage.files.length,totalBytes:stage.files.reduce((n,f)=>n+fs.statSync(f.source).size,0)};}
      if(p.action==='rollback'){stage.rolledBack=true;return {stageId:p.stageId,rolledBack:true};}
      if(p.action==='commit'){
        const outputs=stage.files.map(file=>{const dest=resolve(project,file.relativePath);if(fs.existsSync(dest))throw new Error('Output conflict');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file.source,dest,fs.constants.COPYFILE_EXCL);return {artifactId:file.artifactId,relativePath:file.relativePath,byteLength:fs.statSync(dest).size,sha256:sha(fs.readFileSync(dest))};});
        const receipt={commitId:randomUUID(),idempotencyKey:p.idempotencyKey,outputs};commits.set(p.idempotencyKey,receipt);return receipt;
      }
    }
    throw new Error(`Unimplemented fixture capability ${method}`);
  }
  return {data,project,tokens,stages,commits,tasks,calls,dialogs,token,callHost,setURL:value=>baseURL=value};
}
module.exports={fixture};
