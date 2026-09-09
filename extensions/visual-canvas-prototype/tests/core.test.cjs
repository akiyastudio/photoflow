const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {Resvg}=require('@resvg/resvg-js');
const {PDFDocument}=require('pdf-lib');
const {zipSync,unzipSync,strToU8}=require('fflate');
const {privateOutputPath}=require('../../../scripts/project-output-paths.cjs');
const {Repository}=require('../service/repository.cjs');
const {Application}=require('../service/application.cjs');
const {fixture}=require('./host-fixture.cjs');
const {pack,unpack,saveBytes,sha,assetPath}=require('../service/format.cjs');
const {createDocument,object,clone,layout,applyOperations,exportRegions}=require('../packages/model.cjs');
const {svgFor}=require('../packages/display.cjs');
const {fontConfig}=require('../service/fonts.cjs');
const root=privateOutputPath(path.resolve(__dirname,'../../..'),'diagnostics','visual-canvas-prototype',`tests-${new Date().toISOString().replace(/[:.]/g,'-')}`);
fs.mkdirSync(root,{recursive:true});const report={environment:{node:process.version,platform:process.platform,arch:process.arch},benchmarks:[]};
const sub=name=>path.join(root,name);
const ctx={componentId:'visual-canvas-prototype',componentVersion:'0.1.0',projectId:'fixture-project',surface:'project'};
const request=(app,name,payload)=>app.handle({id:randomUUID(),context:ctx,method:`qs.${name.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}.v1`,payload});
const rgb=(i=0)=>Buffer.from(new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="rgb(${i%256},${Math.floor(i/256)%256},130)"/></svg>`,{font:{loadSystemFonts:false}}).render().asPng());
function asset(repo,i=0){const bytes=rgb(i),hash=saveBytes(repo.root,bytes),a={id:`sha256:${hash}`,width:64,height:48,mime:'image/png',extension:'png',byteLength:bytes.length,name:'fixture.png'};repo.putAsset(a);return a;}
test('inverse operations, CAS and atomic failure preserve prior state',()=>{
  const repo=new Repository(sub('transactions')),doc=createDocument();repo.create('p',doc);
  const unknown=object('future-node',20,40,180,100,{opaque:{keep:'中文'}});unknown.future={keep:[1,2]};
  const tx=randomUUID(),ops=[{type:'put',object:unknown}];const first=repo.commit('p',doc.id,0,tx,ops);
  assert.equal(first.revision,1);assert.deepEqual(repo.commit('p',doc.id,0,tx,ops),first);
  assert.throws(()=>repo.commit('p',doc.id,0,randomUUID(),ops),/另一页面/);
  assert.throws(()=>repo.commit('p',doc.id,1,randomUUID(),[{type:'put',object:{...unknown,frame:{...unknown.frame,width:-4}}}]),/格式错误/);
  assert.deepEqual(repo.load('p',doc.id).objects,[unknown]);
  repo.commit('p',doc.id,1,randomUUID(),null,'undo');assert.equal(repo.load('p',doc.id).objects.length,0);
  repo.commit('p',doc.id,2,randomUUID(),null,'redo');assert.deepEqual(repo.load('p',doc.id).objects,[unknown]);
  repo.close();const reopened=new Repository(sub('transactions'));assert.deepEqual(reopened.load('p',doc.id).objects,[unknown]);reopened.close();
});
test('three image layouts are one reversible transaction, fit rectangle bounds',()=>{
  const doc=createDocument();doc.objects=Array.from({length:17},(_,i)=>object('image',i*3,i*5,160+i*2,100,{naturalWidth:160+i*2,naturalHeight:100,fit:'contain'}));
  for(const mode of ['grid','rows','rectangle']){
    const ops=layout(doc.objects,mode,{x:20,y:40,width:900,height:700},12);const changed=applyOperations(doc,ops);assert.equal(ops.length,17);assert.deepEqual(applyOperations(changed.document,changed.inverse).document,doc);
    for(const op of ops){assert.ok(op.object.frame.width>0);assert.ok(op.object.frame.x+op.object.frame.width<=920.001);}
    if(mode!=='rows')for(const op of ops)assert.ok(op.object.frame.y+op.object.frame.height<=740.001);
  }
});
test('artboard export uses its bounds, connector direction survives SVG and missing fonts fail explicitly',()=>{
  const doc=createDocument(),frame=object('frame',10,20,400,300,{});doc.objects=[frame,object('connector',30,40,100,80,{start:[1,0],end:[0,1],color:'#315746'}),object('richText',0,0,200,100,{content:{type:'doc',content:[{type:'paragraph'}]},style:{fontFamily:'Microsoft YaHei'}})];
  const regions=exportRegions(doc,'frame',[frame.id]);assert.equal(regions.length,1);assert.equal(regions[0].x,10);assert.equal(regions[0].width,400);
  const svg=svgFor(doc,regions[0],()=>{throw new Error('Unexpected asset');});assert.match(svg,/M 100 0 L 0 80/);
  const systemRoot=process.env.SystemRoot;try{process.env.SystemRoot=path.join(root,'missing-windows');assert.throws(()=>fontConfig(doc),/缺少导出字体/);}finally{if(systemRoot===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=systemRoot;}
});
test('.qs portable roundtrip in fresh cache preserves unknown objects and asset hashes',()=>{
  const repo=new Repository(sub('roundtrip-source')),a=asset(repo),doc=createDocument('中文 · Latin');
  doc.futureRoot={preserve:true};doc.surface.futureExtent={x:1};
  doc.objects=[object('image',0,0,240,180,{assetId:a.id}),object('unknown-extension',260,0,100,100,{nested:{untouched:'yes'}})];
  doc.objects[1].futureFields={test:123};repo.create('p',doc);
  const bytes=pack(doc,repo);fs.writeFileSync(path.join(sub('roundtrip-source'),'portable.qs'),bytes);
  const fresh=new Repository(sub('roundtrip-fresh'));const restored=unpack(bytes,fresh);assert.deepEqual(restored,doc);
  assert.equal(sha(fs.readFileSync(assetPath(fresh.root,a.id.slice(7)))),a.id.slice(7));fresh.create('q',restored);
  assert.deepEqual(unpack(pack(restored,fresh),new Repository(sub('roundtrip-third'))),doc);
  repo.close();fresh.close();
});
test('.qs rejects corruption, traversal, higher major and decompression bombs',()=>{
  const repo=new Repository(sub('untrusted')),doc=createDocument();doc.objects=[object('frame',0,0,100,100,{})];
  const files=unzipSync(pack(doc,repo));files['document.json']=strToU8(JSON.stringify({...doc,title:'tampered'}));assert.throws(()=>unpack(zipSync(files),repo),/完整性/);
  assert.throws(()=>unpack(zipSync({'../escape':strToU8('bad')}),repo),/不安全/);
  const original=unzipSync(pack(doc,repo));original['manifest.json']=strToU8(JSON.stringify({format:'com.photoflow.qs',formatMajor:4}));assert.throws(()=>unpack(zipSync(original),repo),/主版本/);
  const huge=zipSync({'huge':new Uint8Array(280*1024*1024)});assert.throws(()=>unpack(huge,repo),/超限/);repo.close();
});
test('500 distinct pictures import through documented capabilities; layout undo and reopen',async()=>{
  const host=fixture(sub('500-images'));const app=new Application(host.callHost);const opened=await request(app,'open',{});const docId=opened.document.id;let revision=0;
  const start=performance.now();for(let i=0;i<500;i++){
    const name=`image-${i}.png`;fs.writeFileSync(path.join(host.project,name),rgb(i));
    const result=await request(app,'import',{id:docId,revision,tx:randomUUID(),relativePath:name,x:i%25*150,y:Math.floor(i/25)*120});revision=result.revision;
  }
  const importedMs=performance.now()-start;const session=await app.session({id:'inspect',context:ctx}),doc=session.repo.load(ctx.projectId,docId);assert.equal(doc.objects.length,500);assert.equal(new Set(doc.objects.map(o=>o.payload.assetId)).size,500);
  const before=clone(doc),begin=performance.now(),ops=layout(doc.objects,'rectangle',{x:0,y:0,width:4000,height:3000},8),layoutMs=performance.now()-begin;
  await request(app,'transact',{id:docId,revision,tx:randomUUID(),operations:ops});await request(app,'history',{id:docId,revision:revision+1,tx:randomUUID(),action:'undo'});
  assert.deepEqual(session.repo.load(ctx.projectId,docId),before);app.close();
  const again=new Application(host.callHost),time=performance.now(),state=await request(again,'open',{id:docId});let count=0,offset=0;do{const page=await request(again,'page',{id:docId,revision:state.revision,offset});count+=page.objects.length;offset=page.next;}while(offset!==null);assert.equal(count,500);
  report.benchmarks.push({test:'500 distinct 64x48 PNG via fixture Host API',importMs:importedMs,layoutMs,reopenMs:performance.now()-time,notMeasured:'Full-resolution photographs, real Host, viewport FPS, GPU memory'});
  for(const n of [1000,2000]){const images=Array.from({length:n},(_,i)=>({...doc.objects[i%500],id:randomUUID()})),t=performance.now();layout(images,'rectangle',{x:0,y:0,width:8000,height:6000},8);report.benchmarks.push({test:`${n} model-only image layout`,layoutMs:performance.now()-t});}
  again.close();assert.equal(host.calls.filter(c=>c.method==='project.input.tokens').length,500);
});
test('PDF has 20 pages; PNG and .qs publish only through stage/write/validate/commit',async()=>{
  const host=fixture(sub('exports')),app=new Application(host.callHost),s=await app.session({id:'setup',context:ctx}),doc=createDocument('中文 mixed English');
  doc.surface.extent={kind:'vertical-strip',width:320,minHeight:320*297/210*20};
  doc.objects=[object('richText',15,18,285,100,{content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'中文与 English 排版测试',marks:[{type:'strong'}]}]}]},style:{fontFamily:'Microsoft YaHei',fontSize:20,lineHeight:1.5,color:'#284932'}}),object('ink',30,160,120,50,{points:[[0,20,.4],[30,0,.8],[60,40,.6],[100,10,.5]],originalWidth:120,originalHeight:50,color:'#315746',size:8})];
  s.repo.create(ctx.projectId,doc);assert.equal(exportRegions(doc,'all').length,20);
  for(const format of ['pdf','png','qs']){
    const start=await request(app,'exportStart',{id:doc.id,format,scope:format==='png'?'selection':'all',ids:doc.objects.map(o=>o.id)});let result;do{result=await request(app,'exportStep',{jobId:start.id});}while(!result.done);
    const bytes=fs.readFileSync(path.join(host.project,result.receipt.outputs[0].relativePath));
    if(format==='pdf')assert.equal((await PDFDocument.load(bytes)).getPageCount(),20);
    if(format==='png')assert.equal(bytes.subarray(1,4).toString(),'PNG');
    if(format==='qs')assert.deepEqual(unpack(bytes,new Repository(sub('export-reimport'))),doc);
    assert.deepEqual((await request(app,'exportStep',{jobId:start.id})).receipt,result.receipt);
  }
  assert.equal(host.commits.size,3);const actions=host.calls.filter(c=>c.method==='project.output').map(c=>c.payload.action);assert.equal(actions.filter(a=>a==='commit').length,3);assert.equal(actions.filter(a=>a==='validate').length,3);app.close();
});
test('uncertain commit keeps same idempotency key and resumes after service restart',async()=>{
  const host=fixture(sub('commit-recovery'));let loseResponse=true;
  const call=async(parent,method,p)=>{const r=await host.callHost(parent,method,p);if(method==='project.output'&&p.action==='commit'&&loseResponse){loseResponse=false;throw new Error('Connection lost after publication');}return r;};
  let app=new Application(call),s=await app.session({id:'setup',context:ctx}),doc=createDocument();doc.objects=[object('frame',0,0,100,100,{})];s.repo.create(ctx.projectId,doc);
  const job=await request(app,'exportStart',{id:doc.id,format:'qs'});await request(app,'exportStep',{jobId:job.id});await assert.rejects(()=>request(app,'exportStep',{jobId:job.id}),/Connection lost/);app.close();
  app=new Application(call);const result=await request(app,'exportStep',{jobId:job.id});assert.equal(result.done,true);assert.equal(host.commits.size,1);
  const commits=host.calls.filter(c=>c.method==='project.output'&&c.payload.action==='commit');assert.equal(commits.length,2);assert.equal(commits[0].payload.idempotencyKey,commits[1].payload.idempotencyKey);assert.equal(host.calls.some(c=>c.method==='project.output'&&c.payload.action==='rollback'),false);app.close();
});
test('hard process termination retains latest acknowledged SQLite transaction',async()=>{
  const crashRoot=sub('crash'),repoFile=path.resolve(__dirname,'../service/repository.cjs'),modelFile=path.resolve(__dirname,'../packages/model.cjs');
  const script=`const {Repository}=require(${JSON.stringify(repoFile)});const {createDocument,object}=require(${JSON.stringify(modelFile)});const repo=new Repository(${JSON.stringify(crashRoot)});const doc=createDocument();repo.create('p',doc);repo.commit('p',doc.id,0,'acknowledged',[{type:'put',object:object('frame',0,0,100,100,{label:'已确认事务'})}]);process.send({id:doc.id});setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['-e',script],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});let err='';child.stderr.on('data',d=>err+=d);
  const message=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>code&&reject(new Error(err)));});
  child.kill();await new Promise(resolve=>child.once('exit',resolve));const repo=new Repository(crashRoot);assert.equal(repo.load('p',message.id).objects[0].payload.label,'已确认事务');assert.equal(repo.status('p',message.id).revision,1);repo.close();
});
test('built service uses JSONL public capabilities and gives no private paths to UI',async()=>{
  const host=fixture(sub('protocol'));const child=spawn(process.execPath,[path.resolve(__dirname,'../dist/service.cjs')],{stdio:['pipe','pipe','pipe'],windowsHide:true});let text='',stderr='';child.stderr.on('data',d=>stderr+=d);
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Protocol timeout '+stderr)),20000);
    child.stdout.on('data',bytes=>{text+=bytes;let newline;while((newline=text.indexOf('\n'))>=0){const frame=JSON.parse(text.slice(0,newline));text=text.slice(newline+1);
      if(frame.type==='ready')child.stdin.write(JSON.stringify({type:'request',id:'load',method:'qs.open.v1',payload:{},context:ctx})+'\n');
      if(frame.type==='capability')host.callHost(frame.parentId,frame.method,frame.payload).then(r=>child.stdin.write(JSON.stringify({type:'capability-response',id:frame.id,ok:true,result:r})+'\n')).catch(reject);
      if(frame.type==='response'){clearTimeout(timer);resolve(frame);}
    }});child.once('error',reject);
  });child.stdin.end();assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.result.document.id);assert.equal(JSON.stringify(result).includes(root),false);
});
test.after(()=>{fs.writeFileSync(path.join(root,'test-results.json'),JSON.stringify(report,null,2));console.log('Private evidence: '+root);});
