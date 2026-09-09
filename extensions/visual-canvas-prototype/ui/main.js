import Konva from 'konva';
import RBush from 'rbush';
import {Schema} from 'prosemirror-model';
import {EditorState} from 'prosemirror-state';
import {EditorView} from 'prosemirror-view';
import {baseKeymap,toggleMark} from 'prosemirror-commands';
import {keymap} from 'prosemirror-keymap';
import {history,undo as textUndo,redo as textRedo} from 'prosemirror-history';
import {clone,id,object,bounds,sorted,applyOperations,layout,PAGE_RATIO} from '../packages/model.cjs';
import {textLayout,inkPath,imagePlacement} from '../packages/display.cjs';

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)], bridge=window.photoFlowComponent;
let context,doc,revision=0,selection=new Set(),tool='select',resourceTab='project',media=[],mediaCursor=null;
let queue=Promise.resolve(),pending=0,blocked=false,active=true,drawScheduled=false,editor=null,editId=null,textTimer=null,exportJob=null,exportBusy=false;
let stage,layer,decor,transformer,index=new RBush(),gesture=null,space=false,marquee=null,strokes=null,objectNodes=new Map();
let guides=[];
const cache=new Map(),loading=new Set(),imageQueue=[];let loadCount=0;
const unsubs=[];
const schema=new Schema({nodes:{doc:{content:'paragraph+'},paragraph:{content:'inline*',group:'block',toDOM:()=>['p',0],parseDOM:[{tag:'p'}]},text:{group:'inline'},hard_break:{inline:true,group:'inline',selectable:false,toDOM:()=>['br'],parseDOM:[{tag:'br'}]}},marks:{strong:{toDOM:()=>['strong',0],parseDOM:[{tag:'strong'},{tag:'b'}]},em:{toDOM:()=>['em',0],parseDOM:[{tag:'em'},{tag:'i'}]}}});
function notice(message,error=false){const el=$('#toast');el.textContent=message;el.dataset.error=String(error);el.hidden=false;clearTimeout(notice.timer);notice.timer=setTimeout(()=>el.hidden=true,error?12000:4500);}
function fail(e){notice(e.message||String(e),true);}
function rpc(name,payload={}){return bridge.rpc(`qs.${name.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}.v1`,payload);}
function saveState(text,error=false){$('#save-state').textContent=text;$('#save-dot').style.background=error?'#bd7858':'#759b70';}
function refreshIndex(){index.clear();index.load(doc.objects.map(o=>{const b=bounds([o]);return {minX:b.x,minY:b.y,maxX:b.x+b.width,maxY:b.y+b.height,id:o.id};}));}
function ingest(result){if(result.operations)doc=applyOperations(doc,result.operations).document;revision=result.revision;$('#undo').disabled=!result.canUndo;$('#redo').disabled=!result.canRedo;selection=new Set([...selection].filter(id=>doc.objects.some(o=>o.id===id)));refreshIndex();render();renderResources();}
function enqueue(action){
  pending++;saveState('正在保存…');
  const next=queue.then(async()=>{if(blocked)throw new Error('保存状态待确认，请重新载入');return action();});
  queue=next.catch(e=>{blocked=true;$('#reload').hidden=false;saveState('保存未确认 · 编辑已暂停',true);render();fail(e);}).finally(()=>{pending--;if(!pending&&!blocked)saveState('所有更改已自动保存');});
  return next;
}
function commit(operations){if(!operations.length)return Promise.resolve();const tx=id();return enqueue(async()=>{const result=await rpc('transact',{id:doc.id,revision,tx,operations});ingest(result);return result;});}
function put(objects){return commit(objects.map(object=>({type:'put',object})));}
async function openDocument(documentId){
  await finishText();await queue;blocked=false;$('#reload').hidden=true;
  const r=await rpc('open',{id:documentId});const next={...r.document,objects:[]};let offset=0;
  do{const page=await rpc('page',{id:next.id,revision:r.revision,offset});next.objects.push(...page.objects);offset=page.next;}while(offset!==null);
  doc=next;selection.clear();ingest(r);$('#title').value=doc.title;saveState('所有更改已自动保存');fit();
}
function selected(){return doc?.objects.filter(o=>selection.has(o.id))||[];}
function point(){return stage.getAbsoluteTransform().copy().invert().point(stage.getPointerPosition()||{x:0,y:0});}
function snapped(v){return $('#snap').checked?Math.round(v/10)*10:v;}
function alignDrag(node,o){
  guides.forEach(g=>g.destroy());guides=[];node.setAttr('guideX',false);node.setAttr('guideY',false);if(!$('#snap').checked)return;
  const box=bounds([{...o,frame:{...o.frame,x:node.x(),y:node.y()}}]),threshold=6/stage.scaleX();let bestX=threshold,bestY=threshold,dx=0,dy=0,gx,gy;
  for(const other of index.all()){if(selection.has(other.id))continue;for(const a of [box.x,box.x+box.width/2,box.x+box.width])for(const b of [other.minX,(other.minX+other.maxX)/2,other.maxX]){const d=b-a;if(Math.abs(d)<bestX){bestX=Math.abs(d);dx=d;gx=b;}}
    for(const a of [box.y,box.y+box.height/2,box.y+box.height])for(const b of [other.minY,(other.minY+other.maxY)/2,other.maxY]){const d=b-a;if(Math.abs(d)<bestY){bestY=Math.abs(d);dy=d;gy=b;}}
  }
  const s=stage.scaleX(),left=-stage.x()/s,top=-stage.y()/s;
  if(gx!==undefined){node.x(node.x()+dx);node.setAttr('guideX',true);const line=new Konva.Line({points:[gx,top,gx,top+stage.height()/s],stroke:'#5e9d8b',strokeWidth:1/s,dash:[5/s,5/s],listening:false});guides.push(line);layer.add(line);}
  if(gy!==undefined){node.y(node.y()+dy);node.setAttr('guideY',true);const line=new Konva.Line({points:[left,gy,left+stage.width()/s,gy],stroke:'#5e9d8b',strokeWidth:1/s,dash:[5/s,5/s],listening:false});guides.push(line);layer.add(line);}
}
function setTool(value){tool=value;$$('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===value));stage.draggable(value==='hand'||space);stage.container().style.cursor=value==='hand'?'grab':value==='select'?'default':'crosshair';render();}
function scaleTo(value,at={x:stage.width()/2,y:stage.height()/2}){if(editor)return;const old=stage.scaleX(),s=Math.max(.06,Math.min(5,value));stage.scale({x:s,y:s});stage.position({x:at.x-(at.x-stage.x())/old*s,y:at.y-(at.y-stage.y())/old*s});schedule();}
function fit(){if(!doc)return;const b=bounds(doc.objects.filter(o=>!o.hidden));const s=Math.max(.06,Math.min(1,(stage.width()-150)/b.width,(stage.height()-110)/b.height));stage.scale({x:s,y:s});stage.position({x:(stage.width()-b.width*s)/2-b.x*s,y:(stage.height()-b.height*s)/2-b.y*s});schedule();}
function schedule(){if(!active||drawScheduled)return;drawScheduled=true;requestAnimationFrame(()=>{drawScheduled=false;render();});}
function loadAsset(o,level){
  const key=`${o.payload.assetId}:${level}`;if(cache.has(key)){const image=cache.get(key);cache.delete(key);cache.set(key,image);return image;}
  if(!loading.has(key)){loading.add(key);imageQueue.push({key,assetId:o.payload.assetId,level,documentId:doc.id});pumpImages();}return null;
}
function pumpImages(){
  while(loadCount<4&&imageQueue.length&&active){const job=imageQueue.shift();loadCount++;
    rpc('variant',{id:job.documentId,assetId:job.assetId,level:job.level}).then(r=>new Promise((resolve,reject)=>{
      const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('图片预览不可用'));image.src=r.variants[job.level].url;
    })).then(image=>{if(doc.id!==job.documentId)return;cache.set(job.key,image);while(cache.size>100){const oldest=cache.keys().next().value;cache.delete(oldest);}schedule();}).catch(()=>{cache.set(job.key,null);}).finally(()=>{loading.delete(job.key);loadCount--;pumpImages();});
  }
}
function createNode(o,loadPixels){
  const f=o.frame,p=o.payload;const group=new Konva.Group({id:o.id,name:'object',x:f.x,y:f.y,width:f.width,height:f.height,rotation:f.rotation,opacity:o.opacity??1,draggable:tool==='select'&&!space&&!o.locked&&!blocked});
  group.add(new Konva.Rect({width:f.width,height:f.height,fill:o.type==='image'?'#dce2d5':'rgba(0,0,0,0)'}));
  if(o.type==='image'){
    const level=Math.max(f.width,f.height)*stage.scaleX()>340?'preview':'thumbnail';const image=loadPixels?loadAsset(o,level):null;
    if(image){const clipped=new Konva.Group({clip:{x:0,y:0,width:f.width,height:f.height}}),m=imagePlacement(o,image.width,image.height);clipped.add(new Konva.Image({...m,image,listening:false}));group.add(clipped);}
    else group.add(new Konva.Text({text:p.name||'图片',width:f.width,height:f.height,align:'center',verticalAlign:'middle',fontSize:Math.min(16,f.width/6),fill:'#87947d',listening:false}));
  }else if(o.type==='richText'){
    const {style,lines}=textLayout(p,f.width);
    lines.forEach(l=>{const offset=style.align==='center'?(f.width-l.width)/2:style.align==='right'?f.width-l.width:0;
      l.runs.forEach(r=>group.add(new Konva.Text({x:offset+r.x,y:l.y+style.fontSize*.15,text:r.text,fontSize:style.fontSize,fontFamily:style.fontFamily,fontStyle:`${r.bold?'bold ':''}${r.italic?'italic':''}`.trim()||'normal',fill:style.color,listening:false})));});
  }else if(o.type==='ink')group.add(new Konva.Path({data:inkPath(o),fill:p.color||'#315746',scaleX:f.width/(p.originalWidth||f.width),scaleY:f.height/(p.originalHeight||f.height),listening:false}));
  else if(o.type==='connector'){const a=p.start||[0,0],b=p.end||[1,1];group.add(new Konva.Arrow({points:[a[0]*f.width,a[1]*f.height,b[0]*f.width,b[1]*f.height],stroke:p.color||'#315746',fill:p.color||'#315746',strokeWidth:p.size||3,pointerLength:12,pointerWidth:10,listening:false}));}
  else{group.add(new Konva.Rect({width:f.width,height:f.height,fill:p.color||'#e7eadf',stroke:'#97a58f',strokeWidth:1,listening:false}));group.add(new Konva.Text({text:p.label|| (o.type==='frame'?'画板':`未知对象：${o.type}`),x:12,y:12,fontSize:16,fill:'#6e7e66',listening:false}));}
  group.on('pointerdown',e=>{if(tool!=='select'||space)return;e.cancelBubble=true;finishText().catch(fail);if(e.evt.shiftKey){selection.has(o.id)?selection.delete(o.id):selection.add(o.id);}else if(!selection.has(o.id))selection=new Set([o.id]);updateSelection();});
  group.on('dblclick dbltap',e=>{e.cancelBubble=true;if(o.type==='richText')startText(o);});
  let starts;
  group.on('dragstart',e=>{e.cancelBubble=true;starts=new Map(selected().map(v=>[v.id,{...v.frame}]));});
  group.on('dragmove',e=>{e.cancelBubble=true;const start=starts?.get(o.id);if(!start)return;alignDrag(group,o);const dx=group.x()-start.x,dy=group.y()-start.y;for(const [oid,f]of starts){if(oid!==o.id)objectNodes.get(oid)?.position({x:f.x+dx,y:f.y+dy});}});
  group.on('dragend',e=>{e.cancelBubble=true;guides.forEach(g=>g.destroy());guides=[];const moved=[];for(const oid of starts?.keys()||[]){const node=objectNodes.get(oid),prior=doc.objects.find(v=>v.id===oid);if(node&&prior)moved.push({...clone(prior),frame:{...prior.frame,x:group.getAttr('guideX')?node.x():snapped(node.x()),y:group.getAttr('guideY')?node.y():snapped(node.y())}});}put(moved).catch(()=>{});});
  return group;
}
function render(){
  if(!stage||!doc)return;
  if(gesture||stage.isDragging()||[...objectNodes.values()].some(n=>n.isDragging())||transformer?.isTransforming())return;
  transformer?.nodes([]);layer.destroyChildren();decor.destroyChildren();objectNodes=new Map();
  const s=stage.scaleX(),x=-stage.x()/s,y=-stage.y()/s,w=stage.width()/s,h=stage.height()/s,extent=doc.surface.extent;
  if(extent.kind==='vertical-strip'){
    const b=bounds(doc.objects),height=Math.max(extent.minHeight||1697,b.y+b.height+80),pageH=extent.width*PAGE_RATIO;
    decor.add(new Konva.Rect({x:0,y:0,width:extent.width,height,fill:'#fff',shadowColor:'#304326',shadowBlur:20,shadowOpacity:.1,listening:false}));
    for(let i=Math.max(1,Math.floor(y/pageH));i<=Math.min(200,Math.ceil((y+h)/pageH));i++){decor.add(new Konva.Line({points:[0,i*pageH,extent.width,i*pageH],stroke:'#b7c2ae',dash:[6/s,6/s],strokeWidth:1/s,listening:false}));decor.add(new Konva.Text({x:extent.width+12/s,y:i*pageH,text:`A4 · ${i+1}`,fontSize:10/s,fill:'#97a18c',listening:false}));}
  }
  const visible=new Set(index.search({minX:x-100/s,minY:y-100/s,maxX:x+w+100/s,maxY:y+h+100/s}).map(v=>v.id));
  for(const id of selection)visible.add(id);
  let decoded=0;for(const o of sorted(doc.objects)){if(o.hidden||!visible.has(o.id)||o.id===editId)continue;const node=createNode(o,o.type!=='image'||decoded++<90);layer.add(node);objectNodes.set(o.id,node);}
  transformer=new Konva.Transformer({nodes:[],rotateEnabled:true,flipEnabled:false,keepRatio:$('#aspect').checked,borderStroke:'#547c51',anchorStroke:'#547c51',anchorFill:'#fff',anchorSize:7,padding:1,boundBoxFunc:(old,b)=>Math.abs(b.width)<5||Math.abs(b.height)<5?old:b});layer.add(transformer);
  transformer.on('transformend',()=>{
    const changes=selected().filter(o=>objectNodes.has(o.id)).map(o=>{const n=objectNodes.get(o.id);return {...clone(o),frame:{...o.frame,x:snapped(n.x()),y:snapped(n.y()),width:Math.max(1,n.width()*n.scaleX()),height:Math.max(1,n.height()*n.scaleY()),rotation:n.rotation()}};});put(changes).catch(()=>{});
  });
  $('#empty').hidden=doc.objects.length>0;$('#zoom').textContent=`${Math.round(s*100)}%`;$('#object-count').textContent=`${doc.objects.length} 个对象 / ${doc.objects.filter(o=>o.type==='image').length} 张图片`;
  $('#render-stats').textContent=`画面中 ${objectNodes.size} 个对象 · 已加载 ${[...cache.values()].filter(Boolean).length} 张预览`;
  $('#infinite').classList.toggle('active',extent.kind==='infinite');$('#strip').classList.toggle('active',extent.kind==='vertical-strip');$('#strip-width').value=extent.width||1200;
  $('#mode-hint').textContent=extent.kind==='infinite'?'无限延伸的创作空间':'固定宽度 · 内容自动向下延伸 · A4 参考线';
  $('#overflow').hidden=extent.kind!=='vertical-strip'||!doc.objects.some(o=>{const b=bounds([o]);return b.x<0||b.x+b.width>extent.width;});
  updateSelection();stage.batchDraw();
}
function updateSelection(){
  transformer?.nodes(tool==='select'?selected().filter(o=>!o.locked&&objectNodes.has(o.id)).map(o=>objectNodes.get(o.id)):[]);
  const objects=selected(),o=objects.length===1?objects[0]:null;$('#selection-count').textContent=objects.length?`${objects.length} 个对象`:'画布';$('#object-properties').hidden=!objects.length;
  $$('[data-frame]').forEach(el=>{el.disabled=!o;el.value=o?Math.round(o.frame[el.dataset.frame]*100)/100:'';});
  $('#image-properties').hidden=o?.type!=='image';$('#text-properties').hidden=o?.type!=='richText';
  if(o?.type==='image'){$('#image-fit').value=o.payload.fit||'contain';$('#crop').value=(o.payload.crop?.width||1)*100;}
  if(o?.type==='richText'){const st=o.payload.style||{};$('#font-size').value=st.fontSize||24;$('#font-family').value=st.fontFamily||'Microsoft YaHei';$('#text-align').value=st.align||'left';$('#line-height').value=st.lineHeight||1.5;}
  if(o)$('#color').value=o.payload.style?.color||o.payload.color||'#315746';
  if(resourceTab==='layers')renderResources();stage?.batchDraw();
}
async function startText(o){
  if(blocked)return;await finishText();setTool('select');selection=new Set([o.id]);editId=o.id;
  const st=textLayout(o.payload,o.frame.width).style,el=$('#text-editor'),s=stage.scaleX();
  Object.assign(el.style,{display:'block',left:`${stage.x()+o.frame.x*s}px`,top:`${stage.y()+o.frame.y*s}px`,width:`${o.frame.width}px`,transform:`scale(${s}) rotate(${o.frame.rotation}deg)`,fontFamily:st.fontFamily,fontSize:`${st.fontSize}px`,lineHeight:String(st.lineHeight),color:st.color,textAlign:st.align});
  editor=new EditorView(el,{state:EditorState.create({schema,doc:schema.nodeFromJSON(o.payload.content),plugins:[history(),keymap({'Mod-z':textUndo,'Mod-Shift-z':textRedo}),keymap(baseKeymap)]}),dispatchTransaction(tr){editor.updateState(editor.state.apply(tr));if(tr.docChanged){clearTimeout(textTimer);textTimer=setTimeout(()=>{if(editor&&!editor.composing)saveText().catch(fail);},700);}},handleDOMEvents:{compositionend(){clearTimeout(textTimer);textTimer=setTimeout(()=>saveText().catch(fail),700);return false;}}});
  $('#text-controls').hidden=false;render();editor.focus();
}
async function saveText(){
  if(!editor||editor.composing||!editId)return;const original=doc.objects.find(o=>o.id===editId);if(!original)return;
  const content=editor.state.doc.toJSON();if(JSON.stringify(content)===JSON.stringify(original.payload.content))return;
  const next={...clone(original),payload:{...original.payload,content}};next.frame.height=textLayout(next.payload,next.frame.width).height;
  await put([next]);
}
async function finishText(){if(!editor)return;if(editor.composing)return;clearTimeout(textTimer);await saveText();editor.destroy();editor=null;editId=null;$('#text-editor').style.display='none';$('#text-controls').hidden=true;render();}
async function importImages(inputs,at){
  await finishText();let added=0;const start=at||{x:80,y:80};
  for(const input of inputs){try{const tx=id();await enqueue(async()=>{const result=await rpc('import',{...input,id:doc.id,revision,tx,x:start.x+(added%5)*300,y:start.y+Math.floor(added/5)*250});ingest(result);});added++;}catch(e){notice(`已导入 ${added} 张，后续导入停止：${e.message}`,true);break;}}
  if(added){notice(`已导入 ${added} 张图片`);fit();}
}
async function pickImages(){const result=await rpc('pick');if(result.inputs?.length)await importImages(result.inputs.map(i=>({token:i.token,name:i.name})));}
function renderResources(){
  if(!doc)return;const list=$('#resource-list');list.replaceChildren();list.classList.toggle('list-mode',resourceTab!=='project');$('#more-media').hidden=resourceTab!=='project'||!mediaCursor;
  if(resourceTab==='project'){
    if(!media.length){const p=document.createElement('p');p.className='empty-list';p.textContent='当前范围还没有图片。可以从系统导入，或切换项目后重新载入。';list.append(p);}
    for(const item of media){const card=document.createElement('button');card.className='resource-card';card.draggable=true;card.title=`添加 ${item.name}`;const thumb=document.createElement('div');thumb.className='thumb-placeholder';thumb.textContent='▧';const caption=document.createElement('span');caption.textContent=item.name;card.append(thumb,caption);card.onclick=()=>importImages([{relativePath:item.relativePath}]).catch(fail);card.ondragstart=e=>e.dataTransfer.setData('application/x-qs-media',item.relativePath);list.append(card);
      // Lazy thumbnails, independent of the canvas's decoded-image cache.
      const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer.disconnect();rpc('variant',{relativePath:item.relativePath,level:'thumbnail'}).then(r=>{if(!card.isConnected)return;const img=new Image();img.alt=item.name;img.loading='lazy';img.src=r.variants.thumbnail.url;thumb.replaceWith(img);}).catch(()=>{});}},{root:list});observer.observe(card);
    }
  }else if(resourceTab==='layers'){
    for(const o of sorted(doc.objects).reverse()){const row=document.createElement('button');row.className=`layer-row ${selection.has(o.id)?'active':''}`;const icon=document.createElement('b');icon.textContent={image:'▧',richText:'T',ink:'✎',connector:'↗',frame:'▣'}[o.type]||'◇';const label=document.createElement('span');label.textContent=o.payload.name||o.payload.label||{richText:'文字',ink:'手写',connector:'连线',frame:'画板'}[o.type]||o.type;row.append(icon,label);row.onclick=e=>{if(!e.shiftKey)selection.clear();selection.add(o.id);render();};list.append(row);}
  }else{
    const add=document.createElement('button');add.className='layer-row';add.textContent='＋ 新建视觉文档';add.onclick=async()=>{try{await finishText();await queue;const r=await rpc('new');await openDocument(r.id);}catch(e){fail(e);}};list.append(add);
    rpc('list').then(r=>{if(resourceTab!=='documents')return;for(const d of r.documents){const row=document.createElement('button');row.className=`layer-row ${d.id===doc.id?'active':''}`;row.textContent=d.title;row.onclick=()=>openDocument(d.id).catch(fail);list.append(row);}}).catch(fail);
  }
}
async function loadMedia(){const result=await rpc('media',{cursor:mediaCursor});media.push(...result.items);mediaCursor=result.page.cursor;renderResources();}
async function changePayload(change){await finishText();await put(selected().map(o=>{const next={...clone(o),payload:change(clone(o.payload),o)};if(next.type==='richText')next.frame.height=textLayout(next.payload,next.frame.width).height;return next;}));}
function setupEvents(){
  $('#toggle-resources').onclick=()=>{document.body.classList.remove('inspector-open');document.body.classList.toggle('resources-open');};
  $('#toggle-inspector').onclick=()=>{document.body.classList.remove('resources-open');document.body.classList.toggle('inspector-open');};
  $('#import-files').onclick=$('#empty-import').onclick=()=>pickImages().catch(fail);
  $('#import-selection').onclick=()=>{const paths=(context.selectedRelativePaths||[]).filter(p=>/\.(png|jpe?g|webp|gif)$/i.test(p));if(!paths.length)return notice('宿主当前没有选中受支持的图片');importImages(paths.map(relativePath=>({relativePath}))).catch(fail);};
  $('#more-media').onclick=()=>loadMedia().catch(fail);$('#fit').onclick=fit;$('#zoom-in').onclick=()=>scaleTo(stage.scaleX()*1.2);$('#zoom-out').onclick=()=>scaleTo(stage.scaleX()/1.2);
  $$('[data-tab]').forEach(b=>b.onclick=()=>{resourceTab=b.dataset.tab;$$('[data-tab]').forEach(x=>x.classList.toggle('active',x===b));renderResources();});
  $$('[data-tool]').forEach(b=>b.onclick=()=>finishText().then(()=>setTool(b.dataset.tool)).catch(fail));
  $('#reload').onclick=()=>{blocked=false;editor?.destroy();editor=null;editId=null;$('#text-editor').style.display='none';$('#text-controls').hidden=true;openDocument(doc.id).catch(fail);};
  $('#title').onchange=()=>commit([{type:'meta',changes:{title:$('#title').value.trim()||'未命名视觉文档'}}]).catch(()=>{});
  for(const action of ['undo','redo'])$('#'+action).onclick=()=>{finishText().then(()=>{const tx=id();return enqueue(async()=>ingest(await rpc('history',{id:doc.id,revision,tx,action})));}).catch(()=>{});};
  const extent=()=>({type:'meta',changes:{surface:{...doc.surface,extent:{...doc.surface.extent,width:Number($('#strip-width').value)}}}});
  $('#strip-width').onchange=()=>commit([extent()]).catch(()=>{});
  for(const [button,kind]of [['infinite','infinite'],['strip','vertical-strip']])$('#'+button).onclick=()=>{const op=extent();op.changes.surface.extent.kind=kind;commit([op]).catch(()=>{});};
  $$('[data-frame]').forEach(input=>input.onchange=()=>{const o=selected()[0];if(!o)return;const frame={...o.frame},key=input.dataset.frame,value=Number(input.value);if(!Number.isFinite(value))return;frame[key]=value;
    if($('#aspect').checked&&['width','height'].includes(key)){const other=key==='width'?'height':'width';frame[other]=o.frame[other]*value/o.frame[key];}
    put([{...clone(o),frame}]).catch(()=>{});
  });
  $('#aspect').onchange=()=>transformer.keepRatio($('#aspect').checked);
  $('#image-fit').onchange=()=>changePayload(p=>({...p,fit:$('#image-fit').value})).catch(()=>{});
  $('#crop').onchange=()=>{const size=Number($('#crop').value)/100;changePayload(p=>({...p,crop:{x:(1-size)/2,y:(1-size)/2,width:size,height:size}})).catch(()=>{});};
  for(const selector of ['#font-family','#font-size','#text-align','#line-height'])$(selector).onchange=()=>changePayload((p,o)=>{if(o.type!=='richText')return p;const style={...p.style,fontFamily:$('#font-family').value,fontSize:Number($('#font-size').value),align:$('#text-align').value,lineHeight:Number($('#line-height').value)};return {...p,style};}).catch(()=>{});
  $('#color').onchange=()=>{const color=$('#color').value;changePayload((p,o)=>o.type==='richText'?{...p,style:{...p.style,color}}:{...p,color}).catch(()=>{});};
  $('#delete').onclick=()=>commit(selected().filter(o=>!o.locked).map(o=>({type:'delete',id:o.id}))).catch(()=>{});
  for(const [selector,direction]of [['#forward',1],['#backward',-1]])$(selector).onclick=()=>{const ordered=sorted(doc.objects),changes=[];for(const o of selected()){const i=ordered.findIndex(v=>v.id===o.id),other=ordered[i+direction];if(other){changes.push({...clone(o),orderKey:other.orderKey},{...clone(other),orderKey:o.orderKey});}}put(changes).catch(()=>{});};
  $$('[data-layout]').forEach(b=>b.onclick=()=>{const images=selected().filter(o=>o.type==='image');if(!images.length)return notice('先选中要排列的图片，Ctrl+A 可全选');try{const box=bounds(images);commit(layout(images,b.dataset.layout,{x:snapped(box.x),y:snapped(box.y),width:Number($('#layout-width').value),height:Number($('#layout-height').value)},Number($('#layout-gap').value))).catch(()=>{});}catch(e){fail(e);}});
  $('#finish-text').onclick=()=>finishText().catch(fail);$('#bold').onmousedown=e=>e.preventDefault();$('#italic').onmousedown=e=>e.preventDefault();$('#bold').onclick=()=>editor&&toggleMark(schema.marks.strong)(editor.state,editor.dispatch);$('#italic').onclick=()=>editor&&toggleMark(schema.marks.em)(editor.state,editor.dispatch);
  $('#open-file').onclick=async()=>{try{await finishText();await queue;const r=await rpc('openFile');if(r.id)await openDocument(r.id);}catch(e){fail(e);}};
  $('#export').onclick=()=>showExport('png');$('#save-qs').onclick=()=>showExport('qs');$('#close-export').onclick=()=>$('#export-dialog').close();$('#run-export').onclick=()=>runExport(false).catch(fail);$('#resume-export').onclick=()=>runExport(true).catch(fail);$('#reveal-export').onclick=()=>rpc('reveal',{jobId:exportJob}).catch(fail);
  const viewport=$('#viewport');viewport.ondragover=e=>e.preventDefault();viewport.ondrop=async e=>{e.preventDefault();try{const rect=viewport.getBoundingClientRect(),at={x:(e.clientX-rect.left-stage.x())/stage.scaleX(),y:(e.clientY-rect.top-stage.y())/stage.scaleX()};const relativePath=e.dataTransfer.getData('application/x-qs-media');if(relativePath)await importImages([{relativePath}],at);else if(e.dataTransfer.files.length){const r=await bridge.authorizeFiles(e.dataTransfer.files);await importImages(r.inputs.map(i=>({token:i.token,name:i.name})),at);}}catch(error){fail(error);}};
  document.addEventListener('keydown',e=>{
    if(e.target.closest('input,select,textarea,.ProseMirror,dialog'))return;
    if(e.code==='Space'){e.preventDefault();space=true;stage.draggable(true);render();return;}
    if(e.key==='Escape'){finishText().catch(fail);selection.clear();setTool('select');}
    if(e.ctrlKey||e.metaKey){if(e.key.toLowerCase()==='a'){e.preventDefault();selection=new Set(doc.objects.map(o=>o.id));render();}if(e.key.toLowerCase()==='z'){e.preventDefault();$(e.shiftKey?'#redo':'#undo').click();}if(e.key.toLowerCase()==='s'){e.preventDefault();showExport('qs');}return;}
    if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();$('#delete').click();}
    const tools={v:'select',h:'hand',t:'text',b:'ink',l:'connector',f:'frame'};if(tools[e.key.toLowerCase()])setTool(tools[e.key.toLowerCase()]);
  });document.addEventListener('keyup',e=>{if(e.code==='Space'){space=false;stage.draggable(tool==='hand');render();}});
}
async function showExport(format){await finishText();await queue;$('#export-format').value=format;$('#export-dialog').showModal();const r=await rpc('exportStatus');$('#resume-export').hidden=!r.jobs.length;if(r.jobs.length){exportJob=r.jobs[0].id;$('#export-message').textContent='有未完成的导出，可以继续恢复。';}}
async function runExport(resume){
  if(exportBusy)return;exportBusy=true;$('#run-export').disabled=true;$('#resume-export').disabled=true;$('#export-progress').hidden=false;$('#reveal-export').hidden=true;
  try{await finishText();await queue;if(!resume){const r=await rpc('exportStart',{id:doc.id,format:$('#export-format').value,scope:$('#export-scope').value,ids:[...selection]});exportJob=r.id;}
    let result;do{result=await rpc('exportStep',{jobId:exportJob});$('#export-progress').value=result.done?100:Math.min(95,Math.round((result.page||0)/Math.max(1,result.total||1)*80));$('#export-message').textContent=result.done?'导出成功，已写入当前项目。':`正在生成文档${result.page?` · ${result.page} / ${result.total} 页`:''}…`;}while(!result.done);
    $('#reveal-export').hidden=false;$('#resume-export').hidden=true;
  }catch(e){$('#export-message').textContent=`导出未确认：${e.message}。已保留任务记录，可恢复相同任务。`;$('#resume-export').hidden=!exportJob;throw e;}
  finally{exportBusy=false;$('#run-export').disabled=false;$('#resume-export').disabled=false;}
}
function setupCanvas(){
  stage=new Konva.Stage({container:'stage',width:$('#viewport').clientWidth,height:$('#viewport').clientHeight});decor=new Konva.Layer({listening:false});layer=new Konva.Layer();stage.add(decor,layer);
  new ResizeObserver(()=>{stage.size({width:$('#viewport').clientWidth,height:$('#viewport').clientHeight});schedule();}).observe($('#viewport'));
  stage.on('wheel',e=>{e.evt.preventDefault();scaleTo(stage.scaleX()*Math.exp(-e.evt.deltaY*.0015),stage.getPointerPosition());});stage.on('dragend',e=>{if(e.target===stage)schedule();});
  stage.on('pointerdown',e=>{
    if(e.target!==stage||blocked||editor||tool==='hand'||space)return;
    if(e.evt.pointerId!==undefined)e.evt.target.setPointerCapture?.(e.evt.pointerId);
    const start=point();if(tool==='text'){
      const o=object('richText',start.x,start.y,330,90,{content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'在这里写下你的想法'}]}]},style:{fontFamily:'Microsoft YaHei',fontSize:24,lineHeight:1.5,color:'#283a32',align:'left'}});put([o]).then(()=>startText(o)).catch(fail);return;
    }
    gesture={start,points:[[start.x,start.y,e.evt.pressure||.5]],pen:e.evt.pointerType==='pen'};
    if(tool==='select'){if(!e.evt.shiftKey)selection.clear();marquee=new Konva.Rect({x:start.x,y:start.y,width:0,height:0,fill:'#547c5120',stroke:'#547c51',strokeWidth:1/stage.scaleX(),listening:false});layer.add(marquee);updateSelection();}
    if(tool==='ink'){strokes=new Konva.Line({points:[start.x,start.y],stroke:$('#color').value,strokeWidth:5,lineCap:'round',lineJoin:'round',listening:false});layer.add(strokes);}
  });
  stage.on('pointermove',e=>{if(!gesture)return;const p=point(),start=gesture.start;
    if(tool==='select')marquee?.setAttrs({x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),width:Math.abs(p.x-start.x),height:Math.abs(p.y-start.y)});
    if(tool==='ink'&&gesture.points.length<15000){gesture.points.push([p.x,p.y,e.evt.pressure||.5]);strokes.points(gesture.points.flatMap(p=>[p[0],p[1]]));}layer.batchDraw();
  });
  stage.on('pointerup pointercancel',()=>{
    if(!gesture)return;const p=point(),g=gesture;gesture=null;const box={x:Math.min(p.x,g.start.x),y:Math.min(p.y,g.start.y),width:Math.abs(p.x-g.start.x),height:Math.abs(p.y-g.start.y)};
    if(tool==='select'){for(const hit of index.search({minX:box.x,minY:box.y,maxX:box.x+box.width,maxY:box.y+box.height}))selection.add(hit.id);marquee?.destroy();marquee=null;render();}
    else if(tool==='ink'){
      strokes?.destroy();strokes=null;if(g.points.length<2){render();return;}const xs=g.points.map(p=>p[0]),ys=g.points.map(p=>p[1]),x=Math.min(...xs)-5,y=Math.min(...ys)-5,w=Math.max(...xs)-x+5,h=Math.max(...ys)-y+5;
      const o=object('ink',x,y,w,h,{points:g.points.map(p=>[p[0]-x,p[1]-y,p[2]]),originalWidth:w,originalHeight:h,size:5,color:$('#color').value,simulatePressure:!g.pen});put([o]).catch(()=>{});
    }else if(tool==='connector'||tool==='frame'){
      if(Math.max(box.width,box.height)<5){render();return;}const o=object(tool,box.x,box.y,Math.max(1,box.width),Math.max(1,box.height),{color:tool==='frame'?'#ffffff':$('#color').value,label:tool==='frame'?'画板':''});if(tool==='frame')o.orderKey=String(Math.min(0,...doc.objects.map(o=>Number(o.orderKey)||0))-1);else {o.payload.start=[g.start.x>p.x?1:0,g.start.y>p.y?1:0];o.payload.end=[g.start.x>p.x?0:1,g.start.y>p.y?0:1];}put([o]).catch(()=>{});
    }
  });
}
async function initialize(){
  if(!bridge){saveState('请在 PhotoFlow 中打开视觉画布插件',true);notice('此页面需要 PhotoFlow 插件宿主。独立预览请使用插件的 preview 命令。',true);return;}
  context=await bridge.getContext();document.body.dataset.theme=context.resolvedTheme||'light';$('#project-name').textContent=context.projectName||'当前项目';
  setupCanvas();setupEvents();await openDocument();await loadMedia();
  if(bridge.onThemeChange)unsubs.push(bridge.onThemeChange(value=>document.body.dataset.theme=value.resolvedTheme));
  if(bridge.onContextChange)unsubs.push(bridge.onContextChange(next=>{if(next.projectId!==context.projectId){blocked=true;saveState('项目上下文已改变，请重新打开插件',true);}context=next;}));
  if(bridge.onDeactivate)unsubs.push(bridge.onDeactivate(()=>{active=false;finishText().catch(fail);}));
  if(bridge.onActivate)unsubs.push(bridge.onActivate(()=>{active=true;schedule();pumpImages();}));
  window.addEventListener('pagehide',()=>{clearTimeout(textTimer);unsubs.forEach(f=>f());editor?.destroy();stage?.destroy();},{once:true});
}
initialize().catch(e=>{saveState('插件连接失败',true);fail(e);});
