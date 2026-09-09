const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {unzipSync}=require('fflate');
const {sha}=require('../service/format.cjs');
const {privateOutputPath,installersRootFor}=require('../../../scripts/project-output-paths.cjs');
const repository=path.resolve(__dirname,'../../..');
const archive=path.join(installersRootFor(repository),'advanced','PhotoFlow-visual-canvas-prototype-0.1.0-win32-x64.zip');
const bytes=fs.readFileSync(archive),expected=fs.readFileSync(archive+'.sha256','utf8').split(' ')[0];if(sha(bytes)!==expected)throw new Error('Archive SHA mismatch');
const files=unzipSync(bytes),hashes=JSON.parse(Buffer.from(files['PACKAGE-HASHES.json']).toString('utf8'));
const root=privateOutputPath(repository,'diagnostics','visual-canvas-prototype',`package-${Date.now()}`);fs.mkdirSync(root,{recursive:true});
for(const [name,data]of Object.entries(files)){
  if(name.includes('..')||name.includes('\\')||name.includes(':')||name.startsWith('/'))throw new Error('Unsafe package entry');
  if(name!=='PACKAGE-HASHES.json'&&(hashes[name]?.sha256!==sha(data)||hashes[name]?.size!==data.length))throw new Error('Package file mismatch: '+name);
  const dest=path.join(root,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,data,{flag:'wx'});
}
if(Object.keys(files).some(n=>/preview|test|node_modules\/(konva|pdf-lib)|\.map$/.test(n)))throw new Error('Unexpected development payload');
const child=spawn(process.execPath,[path.join(root,'dist/service.cjs')],{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NODE_PATH:''}});let text='',stderr='',ready=false;
const timer=setTimeout(()=>{child.kill();throw new Error('Isolated service start timed out: '+stderr);},15000);
child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>{text+=b;if(text.includes('\n')){const frame=JSON.parse(text.split('\n')[0]);if(frame.type!=='ready'||frame.protocolVersion!==1)throw new Error('Invalid ready frame');ready=true;clearTimeout(timer);child.stdin.end();}});
child.on('exit',code=>{clearTimeout(timer);if(!ready||code!==0){console.error(stderr);process.exitCode=1;return;}const result={sha256:expected,archiveBytes:bytes.length,files:Object.keys(files).length,isolatedServiceReady:true,packageRoot:root};fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));});
