const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { copyServiceRuntime } = require('./package-layout.cjs');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.template.json'), 'utf8'));
const dist = path.join(root, 'dist'); const packageRoot = path.join(dist, 'component');
const outputOption = process.argv.indexOf('--output-dir'); const archiveRoot = outputOption >= 0 ? path.resolve(process.argv[outputOption + 1]) : dist;
const withAdvanced = process.argv.includes('--with-advanced');
const python = process.platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
const models = [
  ['rtmdet-ins_m_640x640.onnx',104857600,'6041dded9177d5bd0bca9e3aa264ceb99ec1ff7b0d53320d2433587704840fca'],
  ['face_detection_yunet_2023mar.onnx',204800,'8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'],
  ['adaface_ir18_webface4m.onnx',83886080,'6b6a35772fb636cdd4fa86520c1a259d0c41472a76f70f802b351837a00d9870'],
  ['osnet_x1_0_msmt17.onnx',7340032,'7f545cff27644dcc7481d53b2f6df0b4ba22ceff71f1a839c83a1be5c0973eae'],
];
const run = (command,args) => { const result=spawnSync(command,args,{cwd:root,stdio:'inherit'}); if(result.error) throw result.error; if((result.status??1)!==0) throw new Error(`${command} failed with code ${result.status}`); };
const viteBin = path.join(path.dirname(require.resolve('vite/package.json', { paths: [root] })), 'bin', 'vite.js');
if (!fs.existsSync(python)) throw new Error('Plugin Python environment missing; run npm run setup:python');
for (const [name,minimum,expectedSha256] of models) { const file=path.join(root,'models',name); if(!fs.existsSync(file)||fs.statSync(file).size<minimum||fs.readFileSync(file).subarray(0,256).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) throw new Error(`Required model is missing or incomplete: models/${name}`); const actual=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); if(actual!==expectedSha256) throw new Error(`Required model checksum mismatch: models/${name}`); }
run(process.execPath,[viteBin,'build','--config',path.join(root,'renderer','vite.config.ts')]);
fs.rmSync(packageRoot,{recursive:true,force:true}); fs.mkdirSync(path.dirname(packageRoot),{recursive:true});
const sep=process.platform==='win32'?';':':';
run(python,['-m','PyInstaller','--onedir','--clean','--noconfirm','--workpath',path.join(dist,'pyinstaller-work'),'--specpath',path.join(dist,'spec'),'--distpath',dist,'--name','component','--collect-binaries','onnxruntime','--paths',root,'--hidden-import','patch_merge','--hidden-import','advanced_bridge','--hidden-import','identity_engine','--exclude-module','scipy','--exclude-module','matplotlib','--exclude-module','torch','--exclude-module','torchvision','--exclude-module','torchaudio',...models.flatMap(([name])=>['--add-data',`${path.join(root,'models',name)}${sep}models`]),...['pairdetr_service.py','sam2_service.py'].flatMap(name=>['--add-data',`${path.join(root,'advanced',name)}${sep}advanced`]),path.join(root,'team_retouch.py')]);
const packagedEntrypoint = manifest.entrypoints[`${process.platform}-${process.arch}`] || manifest.entrypoints[process.platform] || manifest.entrypoints.default;
const generatedExecutable = path.join(packageRoot, process.platform === 'win32' ? 'component.exe' : 'component');
const declaredExecutable = path.join(packageRoot, packagedEntrypoint);
if (!fs.existsSync(generatedExecutable)) throw new Error(`PyInstaller output is missing: ${generatedExecutable}`);
if (path.resolve(generatedExecutable) !== path.resolve(declaredExecutable)) fs.renameSync(generatedExecutable, declaredExecutable);
fs.cpSync(path.join(root,'dist','ui'),path.join(packageRoot,'ui'),{recursive:true}); fs.copyFileSync(path.join(root,'renderer','team-retouch.svg'),path.join(packageRoot,'ui','team-retouch.svg'));
copyServiceRuntime(root,packageRoot);
const lifecycleDirectory=path.join(packageRoot,'advanced-installer'); fs.mkdirSync(lifecycleDirectory,{recursive:true});
for(const name of ['setup-team-retouch-advanced.ps1','uninstall-team-retouch-advanced.ps1']) fs.copyFileSync(path.join(root,'advanced-installer',name),path.join(lifecycleDirectory,name));
const advancedPackageName=`PhotoFlow-team-retouch-advanced-${manifest.version}-win32-x64.zip`;
const advancedPackageSource=path.join(dist,advancedPackageName);
delete manifest.advancedRuntime.offlinePackage;
manifest.requiredFiles = manifest.requiredFiles.filter(file => file !== advancedPackageName);
if(withAdvanced){
  if(!fs.existsSync(advancedPackageSource)||!fs.statSync(advancedPackageSource).isFile()) throw new Error(`Trusted advanced package is missing: run npm run package:advanced first (${advancedPackageName})`);
  fs.copyFileSync(advancedPackageSource,path.join(packageRoot,advancedPackageName));
  manifest.advancedRuntime.offlinePackage={path:advancedPackageName,sha256:crypto.createHash('sha256').update(fs.readFileSync(advancedPackageSource)).digest('hex')};
  manifest.requiredFiles.push(advancedPackageName);
}
const sha256=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); for(const action of Object.values(manifest.componentHost.service.lifecycleActions||{})) action.sha256=sha256(path.join(packageRoot,action.entry));
fs.writeFileSync(path.join(packageRoot,'component.json'),`${JSON.stringify(manifest,null,2)}\n`); for(const file of [packagedEntrypoint,...(manifest.requiredFiles||[])]) if(!fs.existsSync(path.join(packageRoot,file))) throw new Error(`Packaged component is missing required file: ${file}`);
fs.mkdirSync(archiveRoot,{recursive:true}); const archive=path.join(archiveRoot,`PhotoFlow-${manifest.id}-${manifest.version}-${process.platform}-${process.arch}.zip`);
const script=['import pathlib,sys,zipfile','source,target=pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2])','target.unlink(missing_ok=True)','with zipfile.ZipFile(target,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:','    for item in sorted(source.rglob("*")):','        if item.is_file():','            mode=zipfile.ZIP_STORED if item.suffix.lower()==".zip" else zipfile.ZIP_DEFLATED','            z.write(item,pathlib.Path(source.name)/item.relative_to(source),compress_type=mode)'].join('\n'); run(python,['-c',script,packageRoot,archive]); console.log(`Installable component package: ${archive}`);
