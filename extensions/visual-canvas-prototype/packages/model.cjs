const clone = value => JSON.parse(JSON.stringify(value));
const id = () => globalThis.crypto.randomUUID();
const documentSchema = {
  type: 'object', required: ['format', 'formatMajor', 'formatMinor', 'id', 'title', 'surface', 'objects'],
  properties: {
    format: { const: 'com.photoflow.qs' }, formatMajor: { const: 0 }, formatMinor: { type: 'integer', minimum: 1 },
    id: { type: 'string', minLength: 1, maxLength: 100 }, title: { type: 'string', maxLength: 200 },
    surface: { type: 'object', required: ['extent'], properties: { extent: { type: 'object', required: ['kind'], properties: { kind: { enum: ['infinite', 'vertical-strip'] }, width: { type: 'number', minimum: 100, maximum: 20000 }, minHeight: { type: 'number', minimum: 100, maximum: 1000000 } } } } },
    objects: { type: 'array', maxItems: 20000, items: { type: 'object', required: ['id', 'type', 'frame', 'payload'], properties: {
      id: { type: 'string', minLength: 1, maxLength: 100 }, type: { type: 'string', minLength: 1, maxLength: 100 },
      frame: { type: 'object', required: ['x', 'y', 'width', 'height', 'rotation'], properties: {
        x: { type: 'number', minimum: -1000000, maximum: 1000000 }, y: { type: 'number', minimum: -1000000, maximum: 1000000 },
        width: { type: 'number', minimum: 0.1, maximum: 100000 }, height: { type: 'number', minimum: 0.1, maximum: 100000 }, rotation: { type: 'number', minimum: -36000, maximum: 36000 }
      } }, payload: { type: 'object' }, opacity: { type: 'number', minimum: 0, maximum: 1 }, orderKey: { type: 'string' }
    } } }
  }
};
function createDocument(title = '未命名视觉文档') {
  return { format: 'com.photoflow.qs', formatMajor: 0, formatMinor: 1, experimental: true, id: id(), title,
    surface: { id: id(), coordinateSystem: { unit: 'dip', unitsPerInch: 96 }, extent: { kind: 'infinite', width: 1200, minHeight: 1697 } }, objects: [] };
}
function object(type, x, y, width, height, payload = {}) {
  return { id: id(), type, typeVersion: 1, orderKey: String(Date.now()), frame: { x, y, width, height, rotation: 0, flipX: false, flipY: false }, opacity: 1, hidden: false, locked: false, payload };
}
function bounds(objects) {
  if (!objects.length) return { x: 0, y: 0, width: 1200, height: 800 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of objects) {
    const f = o.frame, r = f.rotation * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    for (const [x,y] of [[0,0],[f.width,0],[0,f.height],[f.width,f.height]]) {
      const px = f.x + x*c-y*s, py = f.y+x*s+y*c;
      minX=Math.min(minX,px);minY=Math.min(minY,py);maxX=Math.max(maxX,px);maxY=Math.max(maxY,py);
    }
  }
  return {x:minX,y:minY,width:Math.max(1,maxX-minX),height:Math.max(1,maxY-minY)};
}
function sorted(objects) { return [...objects].sort((a,b) => Number(a.orderKey)-Number(b.orderKey) || a.id.localeCompare(b.id)); }
function applyOperations(doc, operations) {
  const next = { ...doc, objects: [...doc.objects] }, inverse = [];
  for (const op of operations) {
    if (op.type === 'put') {
      const index = next.objects.findIndex(o => o.id === op.object.id);
      inverse.unshift(index < 0 ? { type:'delete', id:op.object.id } : { type:'put', object:clone(next.objects[index]) });
      if (index < 0) next.objects.push(clone(op.object)); else next.objects[index]=clone(op.object);
    } else if (op.type === 'delete') {
      const index=next.objects.findIndex(o => o.id===op.id);
      if(index>=0) { inverse.unshift({type:'put',object:clone(next.objects[index])});next.objects.splice(index,1); }
    } else if (op.type === 'meta') {
      for (const key of Object.keys(op.changes)) if (!['title','surface'].includes(key)) throw new Error('Unsupported metadata field');
      const prior={}; for(const key of Object.keys(op.changes)) prior[key]=clone(next[key]);
      inverse.unshift({type:'meta',changes:prior});Object.assign(next,clone(op.changes));
    } else throw new Error('Unsupported operation');
  }
  return {document:next,inverse};
}
function layout(images, kind, target, gap = 16) {
  if(!images.length) return [];
  const { x, y, width: w, height: h }=target, n=images.length;
  const rows=Math.max(1, Math.min(n,Math.round(Math.sqrt(n*h/w))));
  const columns=Math.ceil(n/rows), result=[];
  if (gap < 0 || w <= gap*(columns-1)+columns || h <= gap*(rows-1)+rows) throw new Error('目标区域太小，请减小间距或增大尺寸');
  let offsetY=y;
  for(let row=0;row<rows;row++) {
    const slice=images.slice(row*columns,(row+1)*columns); if(!slice.length)break;
    const aspects=slice.map(o => Math.max(.05,Math.min(20,(o.payload.naturalWidth||o.frame.width)/(o.payload.naturalHeight||o.frame.height))));
    const rowH=kind==='rows'?(w-gap*(slice.length-1))/aspects.reduce((a,b)=>a+b,0):(h-gap*(rows-1))/rows;
    let offsetX=x;
    slice.forEach((o,j)=>{
      const width=kind==='rows'?aspects[j]*rowH:kind==='rectangle'?(w-gap*(slice.length-1))*aspects[j]/aspects.reduce((a,b)=>a+b,0):(w-gap*(columns-1))/columns;
      result.push({type:'put',object:{...clone(o),frame:{...o.frame,x:offsetX,y:offsetY,width,height:rowH,rotation:0},payload:{...o.payload,fit:kind==='rectangle'?'cover':'contain'}}});
      offsetX+=width+gap;
    });offsetY+=rowH+gap;
  }return result;
}
const PAGE_RATIO=297/210;
function exportRegions(doc, scope, ids=[]) {
  if(scope==='frame') {const frames=doc.objects.filter(o=>o.type==='frame'&&ids.includes(o.id));if(frames.length!==1)throw new Error('请只选中一个画板后导出');if(frames[0].frame.rotation!==0)throw new Error('画板导出暂不支持旋转画板');return [{...frames[0].frame}];}
  const objects=doc.objects.filter(o=>!o.hidden && (scope!=='selection'||ids.includes(o.id)));
  if(!objects.length) throw new Error('没有可导出的对象');
  const b=bounds(objects), e=doc.surface.extent;
  if(e.kind==='vertical-strip' && scope!=='selection') {
    const height=e.width*PAGE_RATIO, pages=Math.max(1,Math.ceil(Math.max(e.minHeight||height,b.y+b.height)/height));
    if(pages>200)throw new Error('原型最多导出 200 页，请缩小范围');
    return Array.from({length:pages},(_,i)=>({x:0,y:i*height,width:e.width,height}));
  }
  return [{x:b.x-24,y:b.y-24,width:b.width+48,height:b.height+48}];
}
module.exports={clone,id,documentSchema,createDocument,object,bounds,sorted,applyOperations,layout,exportRegions,PAGE_RATIO};
