const readline=require('node:readline');
const {createServiceHostClient}=require('../../../component-sdk/service.cjs');
const {Application}=require('./application.cjs');
const writeFrame=frame=>process.stdout.write(`${JSON.stringify(frame)}\n`);
const client=createServiceHostClient({writeFrame});const app=new Application(client.callHost);
let queue=Promise.resolve();
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
  if(Buffer.byteLength(line)>2*1024*1024)return;
  let frame;try{frame=JSON.parse(line);}catch{return;}
  if(client.acceptFrame(frame)||frame.type!=='request')return;
  queue=queue.then(async()=>{
    try{const result=await app.handle(frame);if(Buffer.byteLength(JSON.stringify(result))>1900000)throw new Error('响应过大，请缩小操作范围');writeFrame({type:'response',id:frame.id,ok:true,result});}
    catch(e){writeFrame({type:'response',id:frame.id,ok:false,error:String(e.message).slice(0,1900),errorCode:/^COMPONENT_(?:HOST|SERVICE)_[A-Z_]+$/.test(e.code||'')?e.code:'COMPONENT_SERVICE_QS',retryable:e.retryable===true});}
  });
});
process.stdin.on('end',()=>{client.failAll(new Error('Host disconnected'));queue.finally(()=>{app.close();process.exit(0);});});
writeFrame({type:'ready',protocolVersion:1});
