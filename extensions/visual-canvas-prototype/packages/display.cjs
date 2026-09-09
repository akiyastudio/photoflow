const {sorted,bounds}=require('./model.cjs');
const {getStroke}=require('perfect-freehand');
const xml=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function textRuns(payload) {
  const style={fontSize:24,lineHeight:1.5,fontFamily:'Microsoft YaHei',color:'#24342d',align:'left',...payload.style};
  const paragraphs=payload.content?.content||[];
  return {style,paragraphs:paragraphs.map(p=>(p.content||[]).flatMap(n=>n.type==='hard_break'?[{text:'\n'}]:[{text:n.text||'',bold:n.marks?.some(m=>m.type==='strong'),italic:n.marks?.some(m=>m.type==='em')}]))};
}
// Shared line breaking for the preview and export. Font metrics are deliberately
// conservative in this experimental format; the DOM editor uses the same width.
function textLayout(payload,width) {
  const {style,paragraphs}=textRuns(payload),lines=[];let y=0;
  for(const runs of paragraphs){let line=[],x=0;
    const flush=()=>{lines.push({runs:line,width:x,y});line=[];x=0;y+=style.fontSize*style.lineHeight;};
    for(const run of runs)for(const ch of [...run.text]){
      const cw=style.fontSize*(/[\u0000-\u007f]/.test(ch)?(/[ilI.,' ]/.test(ch)?.3:.6):1)*(run.bold?1.025:1);
      if(ch==='\n'){flush();continue;}if(x+cw>width&&line.length)flush();
      line.push({...run,text:ch,x});x+=cw;
    }flush();
  }return {style,lines,height:Math.max(style.fontSize*style.lineHeight,y)};
}
function inkPath(o) {
  const points=getStroke(o.payload.points||[],{size:o.payload.size||5,thinning:.55,smoothing:.5,simulatePressure:o.payload.simulatePressure!==false});
  if(!points.length)return '';
  return `M ${points.map(p=>`${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' L ')} Z`;
}
function displayList(doc,region,ids) {
  return sorted(doc.objects).filter(o=>!o.hidden&&(!ids||ids.includes(o.id))).filter(o=>{
    const b=bounds([o]);return b.x<=region.x+region.width&&b.x+b.width>=region.x&&b.y<=region.y+region.height&&b.y+b.height>=region.y;
  }).map(o=>({...o,layout:o.type==='richText'?textLayout(o.payload,o.frame.width):null,path:o.type==='ink'?inkPath(o):null}));
}
function imagePlacement(o,naturalWidth,naturalHeight) {
  const f=o.frame,c={x:0,y:0,width:1,height:1,...o.payload.crop};
  const sw=Math.max(.001,c.width)*naturalWidth,sh=Math.max(.001,c.height)*naturalHeight;
  const scale=o.payload.fit==='contain'?Math.min(f.width/sw,f.height/sh):Math.max(f.width/sw,f.height/sh);
  return {x:(f.width-sw*scale)/2-c.x*naturalWidth*scale,y:(f.height-sh*scale)/2-c.y*naturalHeight*scale,width:naturalWidth*scale,height:naturalHeight*scale};
}
function svgFor(doc,region,resolveAsset,ids) {
  const items=displayList(doc,region,ids);let index=0;
  const content=items.map(o=>{
    const f=o.frame,p=o.payload;let body='';const key=`clip${index++}`;
    if(o.type==='image'){
      const a=resolveAsset(p.assetId),m=imagePlacement(o,a.width,a.height);
      body=`<defs><clipPath id="${key}"><rect width="${f.width}" height="${f.height}"/></clipPath></defs><g clip-path="url(#${key})"><image x="${m.x}" y="${m.y}" width="${m.width}" height="${m.height}" href="data:${xml(a.mime)};base64,${a.base64}"/></g>`;
    }else if(o.type==='richText'){
      const {style,lines}=o.layout;
      body=lines.map(l=>{const offset=style.align==='center'?(f.width-l.width)/2:style.align==='right'?f.width-l.width:0;
        return l.runs.map(r=>`<text x="${offset+r.x}" y="${l.y+style.fontSize}" font-family="${xml(style.fontFamily)}" font-size="${style.fontSize}" font-weight="${r.bold?'bold':'normal'}" font-style="${r.italic?'italic':'normal'}" fill="${xml(style.color)}">${xml(r.text)}</text>`).join('');}).join('');
    }else if(o.type==='ink')body=`<path d="${o.path}" fill="${xml(p.color||'#315746')}" transform="scale(${f.width/(p.originalWidth||f.width)} ${f.height/(p.originalHeight||f.height)})"/>`;
    else if(o.type==='connector'){
      const a=p.start||[0,0],b=p.end||[1,1],sx=a[0]*f.width,sy=a[1]*f.height,ex=b[0]*f.width,ey=b[1]*f.height,length=Math.max(.01,Math.hypot(ex-sx,ey-sy)),ux=(ex-sx)/length,uy=(ey-sy)/length;
      body=`<path d="M ${sx} ${sy} L ${ex} ${ey} M ${ex-12*ux+5*uy} ${ey-12*uy-5*ux} L ${ex} ${ey} L ${ex-12*ux-5*uy} ${ey-12*uy+5*ux}" stroke="${xml(p.color||'#315746')}" stroke-width="${p.size||3}" fill="none"/>`;
    }
    else body=`<rect width="${f.width}" height="${f.height}" fill="${xml(p.color||'#e7eadf')}" stroke="#89988b"/><text x="12" y="24" font-family="Microsoft YaHei" font-size="16">${xml(p.label|| (o.type==='frame'?'画板':`未知对象：${o.type}`))}</text>`;
    return `<g opacity="${o.opacity??1}" transform="translate(${f.x} ${f.y}) rotate(${f.rotation})">${body}</g>`;
  }).join('');
  const extent=doc.surface.extent;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${region.width}" height="${region.height}" viewBox="${region.x} ${region.y} ${region.width} ${region.height}"><rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" fill="white"/>${extent.kind==='vertical-strip'?`<defs><clipPath id="strip"><rect x="0" y="0" width="${extent.width}" height="1000000"/></clipPath></defs><g clip-path="url(#strip)">${content}</g>`:content}</svg>`;
}
module.exports={xml,textRuns,textLayout,inkPath,displayList,imagePlacement,svgFor};
