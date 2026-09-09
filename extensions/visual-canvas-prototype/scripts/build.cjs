const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {build}=require('esbuild');
const Ajv2020=require('ajv/dist/2020');
const {zipSync}=require('fflate');
const root=path.resolve(__dirname,'..'),repository=path.resolve(root,'../..');
const {installersRootFor}=require(path.join(repository,'scripts/project-output-paths.cjs'));
const {METHODS}=require('../service/application.cjs');
const manifest={apiVersion:1,id:'visual-canvas-prototype',version:'0.1.0',name:'QS 视觉画布（原型）',description:'独立视觉文档插件：图片排版、富文本、手写、.qs 保存和 PNG/PDF 导出',platforms:['win32'],architectures:['x64'],componentHost:{contractVersion:2,
  contributions:[{type:'workspace.toolbarAction',id:'open',label:'视觉画布',pageId:'main'},
    {type:'component.fullPage',id:'main',title:'QS · 视觉画布',entry:'dist/ui/index.html'},
    {type:'media.contextAction',id:'add-selection',label:'添加到视觉画布',pageId:'main',rpcMethods:METHODS},
    {type:'project.exportProvider',id:'export',label:'导出视觉画布',pageId:'main',rpcMethods:METHODS}],
  service:{protocolVersion:1,runtime:'node',entrypoints:{default:'dist/service.cjs'},rpcMethods:METHODS,capabilities:['component.storage','project.media.page','project.media.variants','project.input.tokens','component.media','project.output','dialogs','tasks'],permissions:['component.storage','project.media.read','project.input.read','component.media','project.output.write','dialogs','tasks'],events:[]}}};
async function run(){
  const schema=JSON.parse(fs.readFileSync(path.join(repository,'electron/contracts/schemas/component-manifest-v2.schema.json'),'utf8'));
  const ajv=new Ajv2020({strict:false});if(!ajv.validate(schema,manifest))throw new Error(JSON.stringify(ajv.errors));
  fs.mkdirSync(path.join(root,'dist/ui'),{recursive:true});
  await build({entryPoints:[path.join(root,'ui/main.js')],outfile:path.join(root,'dist/ui/app.js'),bundle:true,minify:true,platform:'browser',target:'chrome130',legalComments:'eof'});
  await build({entryPoints:[path.join(root,'service/service.cjs')],outfile:path.join(root,'dist/service.cjs'),bundle:true,platform:'node',target:'node24',external:['@resvg/resvg-js'],legalComments:'eof'});
  for(const file of ['index.html','style.css'])fs.copyFileSync(path.join(root,'ui',file),path.join(root,'dist/ui',file));
  fs.copyFileSync(path.join(repository,'component-sdk/ui.css'),path.join(root,'dist/ui/host-ui.css'));
  for(const pkg of ['@resvg/resvg-js','@resvg/resvg-js-win32-x64-msvc']){
    const source=path.join(root,'node_modules',pkg),target=path.join(root,'dist/node_modules',pkg);
    if(!fs.existsSync(source))throw new Error(`Windows x64 runtime missing: ${pkg}`);
    fs.cpSync(source,target,{recursive:true});
  }
  fs.writeFileSync(path.join(root,'component.json'),JSON.stringify(manifest,null,2)+'\n');
  fs.writeFileSync(path.join(root,'qs.schema.json'),JSON.stringify(require('../packages/model.cjs').documentSchema,null,2)+'\n');
  const files={};function add(directory,prefix){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){if(entry.isSymbolicLink())throw new Error('Package cannot include links');const name=`${prefix}${entry.name}`,full=path.join(directory,entry.name);if(entry.isDirectory())add(full,name+'/');else files[name]=fs.readFileSync(full);}}
  add(path.join(root,'dist'),'dist/');files['component.json']=fs.readFileSync(path.join(root,'component.json'));
  files['qs.schema.json']=fs.readFileSync(path.join(root,'qs.schema.json'));
  const notices=[];for(const pkg of fs.readdirSync(path.join(root,'node_modules'),{withFileTypes:true})){
    if(pkg.name.startsWith('.'))continue;const folders=pkg.name.startsWith('@')?fs.readdirSync(path.join(root,'node_modules',pkg.name)).map(n=>`${pkg.name}/${n}`):[pkg.name];
    for(const name of folders){if(/playwright|esbuild/.test(name))continue;const dir=path.join(root,'node_modules',name);for(const file of fs.readdirSync(dir).filter(n=>/^licen[cs]e|^copying|^notice/i.test(n))){const full=path.join(dir,file);if(fs.statSync(full).isFile())notices.push(`\n===== ${name} / ${file} =====\n${fs.readFileSync(full,'utf8')}`);}}
  }
  files['THIRD-PARTY-NOTICES.txt']=Buffer.from(notices.join('\n'));
  for(const name of ['README.md','FORMAT.md','API-GAPS.md'])if(fs.existsSync(path.join(root,name)))files[name]=fs.readFileSync(path.join(root,name));
  const hashes=Object.fromEntries(Object.entries(files).map(([name,data])=>[name,{size:data.length,sha256:createHash('sha256').update(data).digest('hex')}]));
  files['PACKAGE-HASHES.json']=Buffer.from(JSON.stringify(hashes,null,2));
  const output=path.join(installersRootFor(repository),'advanced','PhotoFlow-visual-canvas-prototype-0.1.0-win32-x64.zip');fs.mkdirSync(path.dirname(output),{recursive:true});
  const bytes=Buffer.from(zipSync(files,{level:6}));fs.writeFileSync(output,bytes);const digest=createHash('sha256').update(bytes).digest('hex');fs.writeFileSync(`${output}.sha256`,`${digest}  ${path.basename(output)}\n`);
  console.log(JSON.stringify({output,bytes:bytes.length,uncompressedBytes:Object.values(files).reduce((a,b)=>a+b.length,0),sha256:digest,files:Object.keys(files).length},null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1;});
