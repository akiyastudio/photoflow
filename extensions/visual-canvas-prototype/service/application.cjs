const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {imageSize}=require('image-size');
const {Resvg}=require('@resvg/resvg-js');
const {PDFDocument}=require('pdf-lib');
const {Repository}=require('./repository.cjs');
const {assetPath,saveBytes,pack,unpack}=require('./format.cjs');
const {createDocument,object,exportRegions}=require('../packages/model.cjs');
const {svgFor}=require('../packages/display.cjs');
const {fontConfig}=require('./fonts.cjs');
const METHODS=['list','open','page','new','transact','history','media','variant','pick','import','openFile','exportStart','exportStep','exportStatus','exportCancel','reveal'].map(n=>`qs.${n.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}.v1`);
const MAX_IMAGE=64*1024*1024;
class Application {
  constructor(callHost){this.callHost=callHost;this.repositories=new Map();}
  async session(request){
    const context=request.context;if(!context.projectId)throw new Error('请先打开 PhotoFlow 项目');
    const storage=await this.callHost(request.id,'component.storage',{});
    if(storage.adoption?.state==='pending'||!storage.dataPath)throw new Error('插件存储正在迁移，请稍后重试');
    const root=path.join(storage.dataPath,'visual-qs');
    let repo=this.repositories.get(root);if(!repo){repo=new Repository(root);this.repositories.set(root,repo);}
    return {repo,project:context.projectId,host:(method,payload)=>this.callHost(request.id,method,payload)};
  }
  async handle(request){
    if(!METHODS.includes(request.method))throw new Error('Unknown RPC');
    const {repo,project,host}=await this.session(request),p=request.payload||{},method=request.method.split('.')[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
    if(method==='list')return {documents:repo.list(project)};
    if(method==='new'){const doc=createDocument();return {id:repo.create(project,doc)};}
    if(method==='open'){
      let id=p.id;if(!id)id=repo.list(project)[0]?.id||repo.create(project);
      return repo.status(project,id);
    }
    if(method==='page'){
      const status=repo.status(project,p.id);if(p.revision!==status.revision)throw Object.assign(new Error('载入期间文档发生变化，请重新载入'),{code:'COMPONENT_SERVICE_QS_CONFLICT'});
      const offset=Math.max(0,Math.floor(Number(p.offset)||0));
      const all=repo.load(project,p.id).objects;const objects=all.slice(offset,offset+50);
      return {objects,next:offset+objects.length<all.length?offset+objects.length:null};
    }
    if(method==='transact')return repo.commit(project,p.id,p.revision,p.tx,p.operations);
    if(method==='history'){
      if(!['undo','redo'].includes(p.action))throw new Error('Unknown history action');
      return repo.commit(project,p.id,p.revision,p.tx,null,p.action);
    }
    if(method==='media')return host('project.media.page',{pageSize:50,kinds:['image'],cursor:p.cursor||null});
    if(method==='pick')return host('dialogs',{kind:'openFiles',title:'导入画布图片',extensions:['png','jpg','jpeg','webp','gif'],multiple:true});
    if(method==='variant'){
      if(p.relativePath)return host('project.media.variants',{relativePath:p.relativePath,variants:['thumbnail']});
      const doc=repo.load(project,p.id),asset=repo.asset(p.assetId);
      if(!asset||!doc.objects.some(o=>o.type==='image'&&o.payload.assetId===p.assetId))throw new Error('文档未引用此资源');
      const level=p.level==='preview'?'preview':'thumbnail';
      return host('component.media',{action:'variants',relativePath:`visual-qs/assets/sha256/${asset.id.slice(7,9)}/${asset.id.slice(7)}.${asset.extension}`,variants:[level]});
    }
    if(method==='import'){
      repo.row(project,p.id);let token=p.token,name=p.name||'图片';
      if(p.relativePath){const v=await host('project.media.variants',{relativePath:p.relativePath,variants:['original']});token=v.input?.token;name=v.metadata.displayName||name;}
      if(typeof token!=='string')throw new Error('缺少授权读取令牌');
      const input=await host('project.input.tokens',{action:'materialize',token});
      if(input.byteLength>MAX_IMAGE)throw new Error('原型单张图片限制为 64 MiB');
      const bytes=fs.readFileSync(input.privatePath);if(bytes.length>MAX_IMAGE)throw new Error('图片过大');
      const size=imageSize(bytes),extension={jpg:'jpg',png:'png',webp:'webp',gif:'gif'}[size.type];
      if(!extension)throw new Error('原型支持 PNG/JPEG/WebP/GIF；RAW、TIFF 和 HEIC 暂不支持');
      if(size.width*size.height>150000000)throw new Error('图片像素过大，原型最多 1.5 亿像素');
      const hash=saveBytes(repo.root,bytes),asset={id:`sha256:${hash}`,width:size.width,height:size.height,extension,mime:`image/${extension==='jpg'?'jpeg':extension}`,byteLength:bytes.length,name:String(name).slice(0,200)};
      this.mediaCopy(repo,asset);repo.putAsset(asset);
      const width=Math.min(360,size.width),height=width*size.height/size.width;
      const o=object('image',Number(p.x)||80,Number(p.y)||80,width,height,{assetId:asset.id,fit:'contain',crop:{x:0,y:0,width:1,height:1},naturalWidth:size.width,naturalHeight:size.height,name:asset.name});
      return repo.commit(project,p.id,p.revision,p.tx,[{type:'put',object:o}]);
    }
    if(method==='openFile'){
      const pick=await host('dialogs',{kind:'openFiles',title:'打开 .qs 视觉文档',extensions:['qs'],multiple:false});
      if(pick.cancelled||!pick.inputs?.length)return {cancelled:true};
      const input=await host('project.input.tokens',{action:'materialize',token:pick.inputs[0].token});
      if(input.byteLength>266*1024*1024)throw new Error('.qs 文件超出原型上限');
      const doc=unpack(fs.readFileSync(input.privatePath),repo);
      for(const o of doc.objects.filter(o=>o.type==='image'))this.mediaCopy(repo,repo.asset(o.payload.assetId));
      if(repo.list(project).some(d=>d.id===doc.id)){doc.id=randomUUID();doc.title=`${doc.title.slice(0,190)}（导入）`;}
      return {id:repo.create(project,doc)};
    }
    if(method==='exportStart'){
      if(!['png','pdf','qs'].includes(p.format))throw new Error('不支持的导出格式');
      const doc=repo.load(project,p.id),status=repo.status(project,p.id);
      if(p.format!=='qs')fontConfig(doc);
      let regions=p.format==='qs'?[]:exportRegions(doc,p.scope,p.ids||[]);
      if(p.format==='png'&&regions.length>1)regions=[{...regions[0],height:regions[0].height*regions.length}];
      if(p.format!=='qs')for(const r of regions)if(r.width*1.5>10000||r.height*1.5>10000||r.width*r.height*2.25>32000000)throw new Error('单张导出超过 3200 万像素或边长 10000，请使用分页 PDF 或选择较小区域');
      const stage=await host('project.output',{action:'stage'}),id=randomUUID();
      const job={id,format:p.format,document:doc,revision:status.revision,regions,page:0,ids:p.scope==='selection'?p.ids:null,stageId:stage.stageId,privatePath:stage.privatePath,state:'rendering',outputName:`qs-${doc.id.slice(0,8)}-r${status.revision}-${id.slice(0,8)}.${p.format}`,idempotencyKey:`qs-export-${id}`,scope:p.scope};
      repo.saveJob(project,job);
      await host('tasks',{action:'start',operationId:id,title:`导出视觉文档 ${p.format.toUpperCase()}`,checkpoint:{jobId:id},progress:0});
      return {id,total:Math.max(1,regions.length)};
    }
    if(method==='exportStatus'){
      const jobs=repo.db.prepare('SELECT json FROM jobs WHERE project=?').all(project).map(r=>JSON.parse(r.json));
      return {jobs:jobs.filter(j=>!['completed','cancelled'].includes(j.state)).map(j=>({id:j.id,format:j.format,state:j.state,page:j.page,total:j.regions.length}))};
    }
    if(method==='exportCancel'){
      const j=repo.job(project,p.jobId);if(['committing','completed'].includes(j.state))throw new Error('发布已开始，请恢复并确认结果后再处理');
      await host('project.output',{action:'rollback',stageId:j.stageId});j.state='cancelled';repo.saveJob(project,j);await host('tasks',{action:'cancel',operationId:j.id});return {cancelled:true};
    }
    if(method==='exportStep')return this.exportStep(repo,project,host,p.jobId);
    if(method==='reveal'){
      const j=repo.job(project,p.jobId);if(j.state!=='completed')throw new Error('导出未完成');
      return host('dialogs',{kind:'revealOutput',commitId:j.receipt.commitId,artifactId:j.receipt.outputs[0].artifactId});
    }
  }
  mediaCopy(repo,asset){
    const source=assetPath(repo.root,asset.id.slice(7)),target=`${source}.${asset.extension}`;
    if(!fs.existsSync(target))fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
  }
  async exportStep(repo,project,host,id){
    const j=repo.job(project,id);
    if(j.state==='completed')return {done:true,receipt:j.receipt,id:j.id};
    if(j.state==='cancelled')throw new Error('导出已取消');
    if(j.state!=='committing'){
      const task=await host('tasks',{action:'status',operationId:id});
      if(task.cancelled){await host('project.output',{action:'rollback',stageId:j.stageId});j.state='cancelled';repo.saveJob(project,j);throw new Error('导出已取消');}
    }
    const cache=path.join(repo.root,'export-cache',j.id);fs.mkdirSync(cache,{recursive:true});
    const target=path.join(j.privatePath,j.outputName);
    if(j.state==='rendering'){
      if(j.format==='qs'){fs.writeFileSync(target,pack(j.document,repo));j.state='registering';}
      else if(j.page<j.regions.length){
        const svg=svgFor(j.document,j.regions[j.page],id=>{const a=repo.asset(id);return {...a,base64:fs.readFileSync(assetPath(repo.root,id.slice(7))).toString('base64')};},j.ids);
        const png=new Resvg(svg,{fitTo:{mode:'zoom',value:1.5},font:fontConfig(j.document)}).render().asPng();
        fs.writeFileSync(j.format==='png'?target:path.join(cache,`${j.page}.png`),png);j.page++;
        if(j.page===j.regions.length)j.state=j.format==='pdf'?'assembling':'registering';
      }
      repo.saveJob(project,j);await host('tasks',{action:'report',operationId:id,progress:Math.round(j.page/Math.max(1,j.regions.length)*80),checkpoint:{jobId:id,page:j.page}});
      return {done:false,page:j.page,total:Math.max(1,j.regions.length),state:j.state};
    }
    if(j.state==='assembling'){
      const pdf=await PDFDocument.create();pdf.setTitle(j.document.title);pdf.setCreator('PhotoFlow QS prototype (raster pages)');
      let total=0;for(let i=0;i<j.regions.length;i++){
        const bytes=fs.readFileSync(path.join(cache,`${i}.png`));total+=bytes.length;if(total>256*1024*1024)throw new Error('PDF 图像总量超过原型 256 MiB 上限');
        const img=await pdf.embedPng(bytes),r=j.regions[i],w=j.document.surface.extent.kind==='vertical-strip'?595.276:r.width*.75,h=w*r.height/r.width;
        pdf.addPage([w,h]).drawImage(img,{x:0,y:0,width:w,height:h});
      }
      fs.writeFileSync(target,await pdf.save());j.state='registering';repo.saveJob(project,j);return {done:false,state:j.state};
    }
    if(j.state==='registering'){
      await host('project.output',{action:'write',stageId:j.stageId,name:j.outputName,sourceName:j.outputName,outputRelativePath:`视觉画布/${j.outputName}`});
      await host('project.output',{action:'validate',stageId:j.stageId});j.state='committing';repo.saveJob(project,j);
    }
    if(j.state==='committing'){
      // Keep this exact key and stage after an uncertain response. Never roll back
      // a potentially committed output or silently retry with another key.
      j.receipt=await host('project.output',{action:'commit',stageId:j.stageId,idempotencyKey:j.idempotencyKey});j.state='completed';repo.saveJob(project,j);
      await host('tasks',{action:'complete',operationId:id,progress:100});return {done:true,receipt:j.receipt,id:j.id};
    }
  }
  close(){for(const repo of this.repositories.values())repo.close();}
}
module.exports={Application,METHODS};
