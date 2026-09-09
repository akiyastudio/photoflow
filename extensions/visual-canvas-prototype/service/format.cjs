const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {zipSync,unzipSync,strToU8,strFromU8}=require('fflate');
const {assertDocument}=require('./repository.cjs');
const {imageSize}=require('image-size');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const MAX_ARCHIVE=256*1024*1024;
const assetPath=(root,hash)=>{
  if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid hash');
  return path.join(root,'assets','sha256',hash.slice(0,2),hash);
};
function saveBytes(root,bytes){
  const hash=sha(bytes),target=assetPath(root,hash);fs.mkdirSync(path.dirname(target),{recursive:true});
  if(!fs.existsSync(target)){const temp=`${target}.${randomUUID()}.tmp`;fs.writeFileSync(temp,bytes,{flag:'wx'});fs.renameSync(temp,target);}
  else if(sha(fs.readFileSync(target))!==hash)throw new Error('已有私有资源损坏，请保留现场并重新导入');
  return hash;
}
function pack(doc,repo){
  assertDocument(doc);const files={mimetype:strToU8('application/vnd.photoflow.qs+zip'),'document.json':strToU8(JSON.stringify(doc))};
  const catalog={};let total=0;
  const ids=new Set(doc.objects.filter(o=>o.type==='image').map(o=>o.payload.assetId));
  for(const id of ids){const asset=repo.asset(id);if(!asset)throw new Error('缺少图片资源');const data=fs.readFileSync(assetPath(repo.root,id.slice(7)));total+=data.length;if(total>MAX_ARCHIVE)throw new Error('原型便携包上限为 256 MiB');if(sha(data)!==id.slice(7))throw new Error('资源摘要校验失败');catalog[id]=asset;files[`assets/sha256/${id.slice(7)}`]=data;}
  files['resources/assets.json']=strToU8(JSON.stringify(catalog));
  const integrity=Object.fromEntries(Object.entries(files).map(([name,data])=>[name,{size:data.length,sha256:sha(data)}]));
  files['integrity.json']=strToU8(JSON.stringify(integrity));
  files['manifest.json']=strToU8(JSON.stringify({format:'com.photoflow.qs',formatMajor:0,formatMinor:1,experimental:true,entry:'document.json'}));
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name,data])=>[name,[data,{level:name.startsWith('assets/')?0:6}]]))));
}
function unpack(bytes,repo){
  if(bytes.length>MAX_ARCHIVE+10*1024*1024)throw new Error('原型文件超过 256 MiB');let total=0,count=0;
  const files=unzipSync(bytes,{filter:file=>{
    total+=file.originalSize;count++;
    if(count>2100||total>MAX_ARCHIVE+10*1024*1024||file.name.includes('..')||file.name.includes('\\')||file.name.startsWith('/')||file.name.includes(':'))throw new Error('不安全或超限的 .qs 容器');
    return true;
  }});
  const read=name=>{if(!files[name])throw new Error(`容器缺少 ${name}`);return JSON.parse(strFromU8(files[name]));};
  const manifest=read('manifest.json');if(manifest.format!=='com.photoflow.qs'||manifest.formatMajor!==0)throw new Error('不支持此 .qs 格式主版本，未修改文件');
  if(strFromU8(files.mimetype||new Uint8Array())!=='application/vnd.photoflow.qs+zip')throw new Error('Invalid mimetype');
  const integrity=read('integrity.json');for(const [name,data] of Object.entries(files)){
    if(['integrity.json','manifest.json'].includes(name))continue;
    if(integrity[name]?.size!==data.length||integrity[name]?.sha256!==sha(data))throw new Error(`文件完整性校验失败：${name}`);
  }
  const doc=read('document.json');assertDocument(doc);const catalog=read('resources/assets.json');
  for(const o of doc.objects.filter(o=>o.type==='image')) {
    const id=o.payload.assetId,hash=id.slice(7),a=catalog[id],data=files[`assets/sha256/${hash}`];
    if(!a||!data||sha(data)!==hash||a.id!==id||!['image/png','image/jpeg','image/webp','image/gif'].includes(a.mime)||!['png','jpg','webp','gif'].includes(a.extension)||!Number.isFinite(a.width)||!Number.isFinite(a.height))throw new Error('容器资源校验失败');
    const actual=imageSize(data);if(actual.width!==a.width||actual.height!==a.height||actual.width*actual.height>150000000||data.length>64*1024*1024||actual.type!==a.extension)throw new Error('资源类型或尺寸不一致');
  }
  for(const id of new Set(doc.objects.filter(o=>o.type==='image').map(o=>o.payload.assetId))){saveBytes(repo.root,files[`assets/sha256/${id.slice(7)}`]);repo.putAsset(catalog[id]);}
  return doc;
}
module.exports={sha,assetPath,saveBytes,pack,unpack};
