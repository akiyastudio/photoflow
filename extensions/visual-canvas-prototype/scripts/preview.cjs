const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {randomUUID}=require('node:crypto');
const {Resvg}=require('@resvg/resvg-js');
const {Application}=require('../service/application.cjs');
const {fixture}=require('../tests/host-fixture.cjs');
const {object,createDocument}=require('../packages/model.cjs');
const {privateOutputPath}=require('../../../scripts/project-output-paths.cjs');
const root=path.resolve(__dirname,'..'),repository=path.resolve(root,'../..');
const output=privateOutputPath(repository,'diagnostics','visual-canvas-prototype','preview');
const host=fixture(output),app=new Application(host.callHost),context={componentId:'visual-canvas-prototype',componentVersion:'0.1.0',projectId:'fixture-project',projectName:'视觉画布 · 独立测试项目',surface:'project',resolvedTheme:'light',selectedRelativePaths:[],scopeRelativePath:''};
let serial=Promise.resolve();
async function seed(){
  const {repo,project}=await app.session({id:'seed',context});if(repo.list(project).length)return;
  const colors=[['#e8dfc8','#4c684b','#95a783'],['#dad4c2','#988978','#c1aa81'],['#d5dfcb','#728466','#b4c4a4'],['#efdfbe','#b09a6b','#897956'],['#ccd7c7','#496754','#8eaa91'],['#dfd1b9','#b08468','#d2b090']];
  for(let i=0;i<6;i++){
    const c=colors[i],svg=`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${c[0]}"/><circle cx="${100+i*60}" cy="140" r="180" fill="${c[2]}"/><path d="M0 400 Q180 130 320 310 T640 250 V480 H0Z" fill="${c[1]}"/><path d="M0 430 Q250 210 420 390 T640 340 V480 H0Z" fill="${c[2]}"/><circle cx="500" cy="80" r="38" fill="#fff8df" opacity=".8"/></svg>`;
    fs.writeFileSync(path.join(host.project,`习作-${i+1}.png`),new Resvg(svg).render().asPng());
  }
  const doc=createDocument('春日漫游 · 色彩与形态');repo.create(project,doc);let rev=0;
  for(let i=0;i<6;i++){const r=await app.handle({id:randomUUID(),method:'qs.import.v1',context,payload:{id:doc.id,revision:rev,tx:randomUUID(),relativePath:`习作-${i+1}.png`,x:100+(i%3)*280,y:210+Math.floor(i/3)*225}});rev=r.revision;}
  const objects=repo.load(project,doc.id).objects.map(o=>({...o,frame:{...o.frame,width:260,height:195}}));
  const title=object('richText',100,70,800,80,{content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'在自然之间，寻找新的颜色。',marks:[{type:'strong'}]}]}]},style:{fontSize:35,fontFamily:'Microsoft YaHei',lineHeight:1.5,color:'#31513e'}});
  const sub=object('richText',102,145,760,35,{content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'SPRING STUDY   /   06 VISUAL NOTES   /   2026'}]}]},style:{fontSize:13,fontFamily:'Arial',lineHeight:1.5,color:'#879577'}});
  const note=object('richText',100,680,750,70,{content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'柔和的大地色，缓慢流动的形态。\n收集、排列，让想法在这里发生。'}]}]},style:{fontSize:17,fontFamily:'Microsoft YaHei',lineHeight:1.6,color:'#6a7d62'}});
  repo.commit(project,doc.id,rev,randomUUID(),[...objects.map(object=>({type:'put',object})),...[title,sub,note].map(object=>({type:'put',object}))]);
}
function inside(base,relative){const target=path.resolve(base,relative);if(path.relative(base,target).startsWith('..')||path.isAbsolute(relative))throw new Error('Forbidden');return target;}
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='POST'&&url.pathname==='/rpc'){
      if(req.headers.origin&&req.headers.origin!==`http://127.0.0.1:${server.address().port}`)throw new Error('Origin rejected');
      let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>2*1024*1024)throw new Error('Frame too large');chunks.push(chunk);}
      const p=JSON.parse(Buffer.concat(chunks));const result=serial.then(()=>app.handle({id:randomUUID(),context,method:p.method,payload:p.payload}));serial=result.catch(()=>{});
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result:await result}));return;
    }
    if(url.pathname==='/preview-bridge.js'){
      res.setHeader('Content-Type','text/javascript');res.end(`window.photoFlowComponent={getContext:async()=>(${JSON.stringify(context)}),rpc:async(method,payload={})=>{const data=await(await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,payload})})).json();if(!data.ok)throw new Error(data.error);return data.result;},authorizeFiles:async()=>{throw new Error('独立预览仅提供测试项目图片，请在真实宿主中使用系统文件选择器。');}};`);return;
    }
    let file;
    if(url.pathname.startsWith('/private-media/'))file=inside(host.data,decodeURIComponent(url.pathname.slice(15)));
    else if(url.pathname.startsWith('/project-media/'))file=inside(host.project,decodeURIComponent(url.pathname.slice(15)));
    else file=inside(path.join(root,'dist/ui'),url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1)));
    const type={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'}[path.extname(file)]||'application/octet-stream';res.setHeader('Content-Type',type);res.setHeader('Cache-Control','no-store');
    if(file.endsWith('index.html'))res.end(fs.readFileSync(file,'utf8').replace('<script src="./app.js">','<script src="/preview-bridge.js"></script><script src="./app.js">'));else fs.createReadStream(file).on('error',()=>{res.statusCode=404;res.end();}).pipe(res);
  }catch(e){res.statusCode=400;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:false,error:e.message}));}
});
seed().then(()=>server.listen(4179,'127.0.0.1',()=>{host.setURL('http://127.0.0.1:4179');console.log(JSON.stringify({url:'http://127.0.0.1:4179',privateTestRoot:output,mode:'Isolated public-API fixture, not the real PhotoFlow host'}));})).catch(e=>{console.error(e);process.exitCode=1;});
