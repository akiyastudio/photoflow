const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { copyServiceRuntime } = require('./package-layout.cjs');
const { npmInvocation } = require('./npm-invocation.cjs');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.template.json'), 'utf8'));
const dist = path.join(root, 'dist'); const packageRoot = path.join(dist, 'component');
const outputOption = process.argv.indexOf('--output-dir'); const archiveRoot = outputOption >= 0 ? path.resolve(process.argv[outputOption + 1]) : dist;
const withAdvanced = process.argv.includes('--with-advanced');
const skipChecks = process.argv.includes('--skip-checks');
const developmentPackage = process.argv.includes('--dev');
if (withAdvanced && (skipChecks || developmentPackage)) throw new Error('Formal advanced packaging cannot skip checks or use development dependencies.');
if (!developmentPackage && !fs.existsSync(path.join(root, 'requirements-build.lock'))) throw new Error('Formal packaging requires requirements-build.lock with hashes.');
const python = process.platform === 'win32' ? path.join(root, developmentPackage ? '.venv' : '.venv-release', 'Scripts', 'python.exe') : path.join(root, developmentPackage ? '.venv' : '.venv-release', 'bin', 'python');
const models = [
  ['rtmdet-ins_m_640x640.onnx',104857600,'6041dded9177d5bd0bca9e3aa264ceb99ec1ff7b0d53320d2433587704840fca'],
  ['face_detection_yunet_2023mar.onnx',204800,'8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'],
  ['adaface_ir18_webface4m.onnx',83886080,'6b6a35772fb636cdd4fa86520c1a259d0c41472a76f70f802b351837a00d9870'],
  ['osnet_x1_0_msmt17.onnx',7340032,'7f545cff27644dcc7481d53b2f6df0b4ba22ceff71f1a839c83a1be5c0973eae'],
];
const run = (command,args) => { const result=spawnSync(command,args,{cwd:root,stdio:'inherit',windowsHide:true}); if(result.error) throw result.error; if((result.status??1)!==0) throw new Error(`${command} failed with code ${result.status}`); };
const runNpmScript = script => { const npm = npmInvocation(); run(npm.command, [...npm.argsPrefix, 'run', script]); };
const sha256File = file => {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try { for (;;) { const count = fs.readSync(handle, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); } }
  finally { fs.closeSync(handle); }
  return hash.digest('hex');
};
const viteBin = path.join(path.dirname(require.resolve('vite/package.json', { paths: [root] })), 'bin', 'vite.js');
if (!fs.existsSync(python)) throw new Error('Plugin Python environment missing; run npm run setup:python');
if (!developmentPackage) require('./setup-python.cjs').verifyLockedEnvironment(python, fs.readFileSync(path.join(root, 'requirements-build.lock'), 'utf8'));
for (const [name,minimum,expectedSha256] of models) { const file=path.join(root,'models',name); if(!fs.existsSync(file)||fs.statSync(file).size<minimum) throw new Error(`Required model is missing or incomplete: models/${name}`); const handle=fs.openSync(file,'r'); const prefix=Buffer.alloc(256); const count=fs.readSync(handle,prefix,0,prefix.length,0); fs.closeSync(handle); if(prefix.subarray(0,count).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) throw new Error(`Required model is missing or incomplete: models/${name}`); const actual=sha256File(file); if(actual!==expectedSha256) throw new Error(`Required model checksum mismatch: models/${name}`); }
if (!skipChecks) {
  for (const script of ['typecheck','lint','test:node']) runNpmScript(script);
  if (developmentPackage) runNpmScript('test:python');
  else { run(python,[path.join(root,'tests','test-team-retouch.py')]); run(python,[path.join(root,'tests','test-team-retouch-progress-folder-policy.py')]); }
}
run(process.execPath,[viteBin,'build','--config',path.join(root,'renderer','vite.config.ts')]);
fs.rmSync(packageRoot,{recursive:true,force:true}); fs.mkdirSync(path.dirname(packageRoot),{recursive:true});
const sep=process.platform==='win32'?';':':';
run(python,['-m','PyInstaller','--onedir','--clean','--noconfirm','--workpath',path.join(dist,'pyinstaller-work'),'--specpath',path.join(dist,'spec'),'--distpath',dist,'--name','component','--collect-binaries','onnxruntime','--paths',root,'--hidden-import','patch_merge','--hidden-import','advanced_bridge','--hidden-import','identity_engine','--hidden-import','image_safety','--hidden-import','advanced_geometry','--hidden-import','checkpoint_lock','--exclude-module','scipy','--exclude-module','matplotlib','--exclude-module','torch','--exclude-module','torchvision','--exclude-module','torchaudio',...models.flatMap(([name])=>['--add-data',`${path.join(root,'models',name)}${sep}models`]),...['pairdetr_service.py','sam2_service.py','image_safety.py','advanced_geometry.py','checkpoint_lock.py'].flatMap(name=>['--add-data',`${path.join(root,['image_safety.py','advanced_geometry.py','checkpoint_lock.py'].includes(name) ? name : path.join('advanced',name))}${sep}${['image_safety.py','advanced_geometry.py','checkpoint_lock.py'].includes(name) ? '.' : 'advanced'}`]),path.join(root,'team_retouch.py')]);
const packagedEntrypoint = manifest.entrypoints[`${process.platform}-${process.arch}`] || manifest.entrypoints[process.platform] || manifest.entrypoints.default;
const generatedExecutable = path.join(packageRoot, process.platform === 'win32' ? 'component.exe' : 'component');
const declaredExecutable = path.join(packageRoot, packagedEntrypoint);
if (!fs.existsSync(generatedExecutable)) throw new Error(`PyInstaller output is missing: ${generatedExecutable}`);
if (path.resolve(generatedExecutable) !== path.resolve(declaredExecutable)) fs.renameSync(generatedExecutable, declaredExecutable);
fs.cpSync(path.join(root,'dist','ui'),path.join(packageRoot,'ui'),{recursive:true}); fs.copyFileSync(path.join(root,'renderer','team-retouch.svg'),path.join(packageRoot,'ui','team-retouch.svg'));
copyServiceRuntime(root,packageRoot);
const advancedPackageName=`PhotoFlow-team-retouch-advanced-${manifest.version}-win32-x64.zip`;
const advancedPackageSource=path.join(dist,advancedPackageName);
delete manifest.advancedRuntime.offlinePackage;
manifest.requiredFiles = manifest.requiredFiles.filter(file => file !== advancedPackageName);
if(withAdvanced){
  if(!fs.existsSync(advancedPackageSource)||!fs.statSync(advancedPackageSource).isFile()) throw new Error(`Trusted advanced package is missing: run npm run package:advanced first (${advancedPackageName})`);
  const lifecycleDirectory=path.join(packageRoot,'advanced-installer'); fs.mkdirSync(lifecycleDirectory,{recursive:true});
  for(const name of ['setup-team-retouch-advanced.ps1','uninstall-team-retouch-advanced.ps1']) fs.copyFileSync(path.join(root,'advanced-installer',name),path.join(lifecycleDirectory,name));
  const advancedScriptsDirectory=path.join(packageRoot,'advanced'); fs.mkdirSync(advancedScriptsDirectory,{recursive:true});
  for(const name of ['pairdetr_service.py','sam2_service.py']) fs.copyFileSync(path.join(root,'advanced',name),path.join(advancedScriptsDirectory,name));
  fs.copyFileSync(path.join(root,'image_safety.py'),path.join(packageRoot,'image_safety.py'));
  fs.copyFileSync(path.join(root,'advanced_geometry.py'),path.join(packageRoot,'advanced_geometry.py'));
  fs.copyFileSync(path.join(root,'checkpoint_lock.py'),path.join(packageRoot,'checkpoint_lock.py'));
  fs.copyFileSync(advancedPackageSource,path.join(packageRoot,advancedPackageName));
  manifest.advancedRuntime.offlinePackage={path:advancedPackageName,sha256:sha256File(advancedPackageSource)};
  manifest.requiredFiles.push(advancedPackageName);
  manifest.requiredFiles.push('advanced/pairdetr_service.py','advanced/sam2_service.py','image_safety.py','advanced_geometry.py','checkpoint_lock.py');
} else {
  delete manifest.componentHost.service.lifecycleActions;
  manifest.componentHost.service.capabilities = manifest.componentHost.service.capabilities.filter(value => value !== 'component.lifecycle');
  manifest.componentHost.service.permissions = manifest.componentHost.service.permissions.filter(value => !value.startsWith('component.lifecycle.'));
  const managementMethods = new Set(['team.advanced.preflight.v1','team.advanced.install.v1','team.advanced.uninstall.v1']);
  manifest.componentHost.service.rpcMethods = manifest.componentHost.service.rpcMethods.filter(value => !managementMethods.has(value));
  for (const contribution of manifest.componentHost.contributions) {
    if (Array.isArray(contribution.rpcMethods)) contribution.rpcMethods = contribution.rpcMethods.filter(value => !managementMethods.has(value));
  }
}
for(const action of Object.values(manifest.componentHost.service.lifecycleActions||{})) action.sha256=sha256File(path.join(packageRoot,action.entry));
fs.writeFileSync(path.join(packageRoot,'component.json'),`${JSON.stringify(manifest,null,2)}\n`); for(const file of [packagedEntrypoint,...(manifest.requiredFiles||[])]) if(!fs.existsSync(path.join(packageRoot,file))) throw new Error(`Packaged component is missing required file: ${file}`);
fs.mkdirSync(archiveRoot,{recursive:true}); const archive=path.join(archiveRoot,`PhotoFlow-${manifest.id}-${manifest.version}-${process.platform}-${process.arch}.zip`);
const script=['import pathlib,sys,zipfile','source,target=pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2])','target.unlink(missing_ok=True)','with zipfile.ZipFile(target,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:','    for item in sorted(source.rglob("*")):','        if item.is_file():','            mode=zipfile.ZIP_STORED if item.suffix.lower()==".zip" else zipfile.ZIP_DEFLATED','            z.write(item,pathlib.Path(source.name)/item.relative_to(source),compress_type=mode)'].join('\n'); run(python,['-c',script,packageRoot,archive]); console.log(`Installable component package: ${archive}`);
