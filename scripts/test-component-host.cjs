const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createComponentHostRegistry,parseComponentHostManifest}=require('../electron/component-host-contract.cjs');
const {normalizeOpenScope,selectComponentPreload}=require('../electron/services/component-view-manager.cjs');
const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'component-host-installed-'));
try{
 const componentRoot=path.join(sandbox,'fixture-component');fs.mkdirSync(path.join(componentRoot,'ui'),{recursive:true});
 for(const file of ['index.html','settings.html'])fs.writeFileSync(path.join(componentRoot,'ui',file),'<!doctype html>');fs.writeFileSync(path.join(componentRoot,'service.cjs'),'');
 const manifest={apiVersion:1,id:'fixture-component',version:'1.0.0',componentHost:{contractVersion:2,compatibility:{minHostApiVersion:4,maxHostApiVersion:4},contributions:[{type:'workspace.toolbarAction',id:'open',label:'Fixture',pageId:'main'},{type:'component.fullPage',id:'main',title:'Fixture',entry:'ui/index.html'},{type:'application.settingsPage',id:'settings',label:'Settings',title:'Settings',entry:'ui/settings.html',rpcMethods:['fixture.settings.v1']}],service:{protocolVersion:1,runtime:'node',entrypoints:{default:'service.cjs'},rpcMethods:['fixture.settings.v1'],capabilities:['component.settings.v2'],permissions:['component.settings'],events:[]}}};
 fs.writeFileSync(path.join(componentRoot,'component.json'),JSON.stringify(manifest));
 const parsed=parseComponentHostManifest(manifest,componentRoot);assert.equal(parsed.contractVersion,2);assert.equal(parsed.fullPage.entry,path.join(componentRoot,'ui','index.html'));assert.equal(parsed.settingsPages[0].rpcMethods[0],'fixture.settings.v1');
 const registry=createComponentHostRegistry({roots:[{source:'installed',path:sandbox}]});assert.deepEqual(registry.list().map(item=>item.componentId),['fixture-component']);
 assert.deepEqual(createComponentHostRegistry({roots:[{source:'installed',path:sandbox}],admitDescriptor:()=>false}).list(),[]);
 assert.deepEqual(normalizeOpenScope({scopeRelativePath:'images',selectedRelativePaths:['images/a.jpg'],sourcePageId:'workspace'}),{scopeRelativePath:'images',selectedRelativePaths:['images/a.jpg'],sourcePageId:'workspace'});
 assert.throws(()=>normalizeOpenScope({scopeRelativePath:'images',selectedRelativePaths:['escape/a.jpg']}),/escapes/);
 assert.equal(selectComponentPreload(parsed,{core:'component-preload.cjs'}),'component-preload.cjs');
 assert.throws(()=>selectComponentPreload({contractVersion:1,hostApiVersion:1},{core:'component-preload.cjs'}),/Unsupported/);
 console.log('Installed Component Host view/registry tests passed');
}finally{fs.rmSync(sandbox,{recursive:true,force:true});}
