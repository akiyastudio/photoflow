const { DatabaseSync }=require('node:sqlite');
const fs=require('node:fs');
const path=require('node:path');
const Ajv=require('ajv');
const {documentSchema,createDocument,applyOperations}=require('../packages/model.cjs');
const validate=new Ajv({strict:false,allErrors:true}).compile(documentSchema);
function assertDocument(doc) {
  if(!validate(doc))throw new Error(`文档格式错误：${JSON.stringify(validate.errors).slice(0,300)}`);
  if(new Set(doc.objects.map(o=>o.id)).size!==doc.objects.length)throw new Error('对象 ID 重复');
  if(doc.surface.extent.kind==='vertical-strip'&&!doc.surface.extent.width)throw new Error('长文档缺少宽度');
  for(const o of doc.objects) {
    if(!['image','richText','ink','connector','frame','shape'].includes(o.type))continue;
    const p=o.payload,st=p.style||{};
    for(const [key,value,min,max] of [['size',p.size,.1,300],['fontSize',st.fontSize,8,240],['lineHeight',st.lineHeight,1,3]])if(value!==undefined&&(!Number.isFinite(value)||value<min||value>max))throw new Error(`无效的样式数值：${key}`);
    for(const color of [p.color,st.color])if(color!==undefined&&!/^#[0-9a-f]{6}$/i.test(color))throw new Error('颜色必须是六位十六进制值');
    if(o.type==='richText'&&st.fontFamily!==undefined&&!['Microsoft YaHei','SimSun','Arial'].includes(st.fontFamily))throw new Error('此原型尚未支持该字体');
    if(o.type==='image'&&p.crop){for(const key of ['x','y','width','height'])if(!Number.isFinite(p.crop[key])||p.crop[key]<0||p.crop[key]>1)throw new Error('裁切坐标无效');if(!p.crop.width||!p.crop.height||p.crop.x+p.crop.width>1.00001||p.crop.y+p.crop.height>1.00001)throw new Error('裁切范围无效');}
    if(o.type==='connector')for(const endpoint of [p.start,p.end])if(endpoint!==undefined&&(!Array.isArray(endpoint)||endpoint.length!==2||endpoint.some(n=>!Number.isFinite(n)||n<0||n>1)))throw new Error('连线端点无效');
    if(o.type==='ink' && (!Array.isArray(o.payload.points)||o.payload.points.length>20000||o.payload.points.some(p=>!Array.isArray(p)||p.length!==3||p.some(n=>!Number.isFinite(n)))))throw new Error('笔迹数据无效或过长');
    if(o.type==='richText'&&JSON.stringify(o.payload).length>200000)throw new Error('单个文字对象过大');
    if(o.type==='image'&&!/^sha256:[a-f0-9]{64}$/.test(o.payload.assetId||''))throw new Error('图片资源标识无效');
  }
}
class Repository {
  constructor(root) {
    fs.mkdirSync(root,{recursive:true});this.root=root;this.db=new DatabaseSync(path.join(root,'documents.sqlite3'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, project TEXT NOT NULL, meta TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, cursor INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS objects(doc TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(doc,id));
      CREATE TABLE IF NOT EXISTS log(doc TEXT NOT NULL,revision INTEGER NOT NULL,tx TEXT NOT NULL,result TEXT NOT NULL,operations TEXT NOT NULL,PRIMARY KEY(doc,revision),UNIQUE(doc,tx));
      CREATE TABLE IF NOT EXISTS history(doc TEXT NOT NULL,seq INTEGER NOT NULL,forward TEXT NOT NULL,inverse TEXT NOT NULL,PRIMARY KEY(doc,seq));
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints(doc TEXT PRIMARY KEY,revision INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,project TEXT NOT NULL,json TEXT NOT NULL);`);
  }
  list(project){return this.db.prepare('SELECT id,meta,revision,updated FROM documents WHERE project=? ORDER BY updated DESC').all(project).map(r=>({id:r.id,title:JSON.parse(r.meta).title,revision:r.revision,updated:r.updated}));}
  create(project,doc=createDocument()) {
    assertDocument(doc);const {objects,...meta}=doc;
    this.db.exec('BEGIN IMMEDIATE');try {
      this.db.prepare('INSERT INTO documents(id,project,meta,updated) VALUES(?,?,?,?)').run(doc.id,project,JSON.stringify(meta),Date.now());
      for(const o of objects)this.db.prepare('INSERT INTO objects VALUES(?,?,?)').run(doc.id,o.id,JSON.stringify(o));
      this.db.exec('COMMIT');return doc.id;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  row(project,id){const row=this.db.prepare('SELECT * FROM documents WHERE id=? AND project=?').get(id,project);if(!row)throw new Error('文档不存在于当前项目');return row;}
  load(project,id){const row=this.row(project,id);return {...JSON.parse(row.meta),objects:this.db.prepare('SELECT json FROM objects WHERE doc=? ORDER BY id').all(id).map(r=>JSON.parse(r.json))};}
  status(project,id){const row=this.row(project,id);return {document:JSON.parse(row.meta),revision:row.revision,canUndo:row.cursor>0,canRedo:!!this.db.prepare('SELECT 1 FROM history WHERE doc=? AND seq=?').get(id,row.cursor+1)};}
  commit(project,id,baseRevision,tx,operations,mode='edit') {
    if(typeof tx!=='string'||tx.length>100)throw new Error('Invalid transaction ID');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row=this.row(project,id), prior=this.db.prepare('SELECT result FROM log WHERE doc=? AND tx=?').get(id,tx);
      if(prior){this.db.exec('COMMIT');return JSON.parse(prior.result);}
      if(row.revision!==baseRevision)throw Object.assign(new Error('文档已在另一页面更新，请重新载入后编辑'),{code:'COMPONENT_SERVICE_QS_CONFLICT'});
      let cursor=row.cursor;
      if(mode==='undo'||mode==='redo') {
        const h=this.db.prepare('SELECT * FROM history WHERE doc=? AND seq=?').get(id,mode==='undo'?cursor:cursor+1);
        if(!h)throw new Error('没有可撤销/重做的操作');
        operations=JSON.parse(mode==='undo'?h.inverse:h.forward);cursor+=mode==='undo'?-1:1;
      }
      if(!Array.isArray(operations)||!operations.length||operations.length>5000||JSON.stringify(operations).length>1200000)throw new Error('事务为空或超出原型上限');
      const {document:doc,inverse}=applyOperations(this.load(project,id),operations);assertDocument(doc);
      for(const o of doc.objects)if(o.type==='image'&&!this.asset(o.payload.assetId))throw new Error('图片资源缺失');
      const {objects,...meta}=doc;
      for(const op of operations) {
        if(op.type==='put')this.db.prepare('INSERT OR REPLACE INTO objects VALUES(?,?,?)').run(id,op.object.id,JSON.stringify(op.object));
        if(op.type==='delete')this.db.prepare('DELETE FROM objects WHERE doc=? AND id=?').run(id,op.id);
      }
      if(mode==='edit') {
        this.db.prepare('DELETE FROM history WHERE doc=? AND seq>?').run(id,cursor);cursor++;
        this.db.prepare('INSERT INTO history VALUES(?,?,?,?)').run(id,cursor,JSON.stringify(operations),JSON.stringify(inverse));
      }
      const revision=row.revision+1;
      this.db.prepare('UPDATE documents SET meta=?,revision=?,cursor=?,updated=? WHERE id=?').run(JSON.stringify(meta),revision,cursor,Date.now(),id);
      const result={revision,operations,canUndo:cursor>0,canRedo:!!this.db.prepare('SELECT 1 FROM history WHERE doc=? AND seq=?').get(id,cursor+1)};
      this.db.prepare('INSERT INTO log VALUES(?,?,?,?,?)').run(id,revision,tx,JSON.stringify(result),JSON.stringify(operations));
      if(revision%50===0)this.db.prepare('INSERT OR REPLACE INTO checkpoints VALUES(?,?,?)').run(id,revision,JSON.stringify(doc));
      this.db.exec('COMMIT');return result;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  asset(id){const r=this.db.prepare('SELECT json FROM assets WHERE id=?').get(id);return r?JSON.parse(r.json):null;}
  putAsset(asset){this.db.prepare('INSERT OR REPLACE INTO assets VALUES(?,?)').run(asset.id,JSON.stringify(asset));}
  saveJob(project,job){this.db.prepare('INSERT OR REPLACE INTO jobs VALUES(?,?,?)').run(job.id,project,JSON.stringify(job));}
  job(project,id){const r=this.db.prepare('SELECT json FROM jobs WHERE id=? AND project=?').get(id,project);if(!r)throw new Error('导出任务不存在');return JSON.parse(r.json);}
  close(){this.db.close();}
}
module.exports={Repository,assertDocument};
