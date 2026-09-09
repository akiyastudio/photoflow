const fs=require('node:fs');
const path=require('node:path');
const FONT_FILES={'Microsoft YaHei':['msyh.ttc','msyhbd.ttc'],'SimSun':['simsun.ttc'],'Arial':['arial.ttf','arialbd.ttf','ariali.ttf','arialbi.ttf']};
function fontConfig(doc){
  const names=new Set(doc.objects.filter(o=>o.type==='richText'&&!o.hidden).map(o=>o.payload.style?.fontFamily||'Microsoft YaHei'));
  // Chinese fallback and labels use YaHei. Never silently substitute a missing
  // requested family at export; font bytes remain installed OS resources.
  if(names.size)names.add('Microsoft YaHei');
  const root=path.join(process.env.SystemRoot||'C:\\Windows','Fonts'),files=[];
  for(const name of names){const choices=FONT_FILES[name];if(!choices||!fs.existsSync(path.join(root,choices[0])))throw new Error(`缺少导出字体 ${name}，请安装字体或在文字属性中选择已有字体`);for(const file of choices){const full=path.join(root,file);if(fs.existsSync(full))files.push(full);}}
  return {loadSystemFonts:false,fontFiles:files,defaultFontFamily:'Microsoft YaHei'};
}
module.exports={fontConfig};
