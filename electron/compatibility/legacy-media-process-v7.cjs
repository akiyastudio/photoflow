// Delete after Host API v7 components have migrated to component.runtime.execute.
// This adapter only maps legacy envelope fields to the generic runtime descriptor;
// it never interprets settings, builds tool arguments, runs a process, or translates
// runtime progress. Missing opaque arguments are rejected instead of guessed.
const ACTIONS = Object.freeze({ preview:'video.sources.preview', inspect:'video.transcode.inspect', transcode:'video.transcode', split:'video.split' });
const VIDEO_EXTENSIONS = Object.freeze(['.mp4','.mov','.m4v','.mkv','.avi','.webm','.crm','.mts','.m2ts','.ts','.mpeg','.mpg']);
const isLegacyAction = (action, processAction = '') => Object.values(ACTIONS).includes(String(action || '')) || ['status','cancel','pause','resume'].includes(String(action||'')) && [ACTIONS.transcode,ACTIONS.split].includes(String(processAction||''));
const opaqueArgs = (payload, { optional = false } = {}) => {
  if (payload.runtimeArgs === undefined && optional) return [];
  if (!Array.isArray(payload.runtimeArgs)) { const error = new Error('Legacy video component must be upgraded before this request can run'); error.code = 'COMPONENT_UPGRADE_REQUIRED'; throw error; }
  return payload.runtimeArgs;
};
const translateLegacyMediaProcessV7 = (payload, descriptor) => {
  const action=String(payload?.action||'');if(!isLegacyAction(action,payload?.processAction))return null;
  if(['status','cancel','pause','resume'].includes(action)){const operationKey=payload.processAction===ACTIONS.transcode?'transcode':'split';return{action,runtimeCapability:'media.video.processing.cli',operationKey,idempotencyKey:String(payload.idempotencyKey||'')};}
  const base={relativePaths:Array.isArray(payload.relativePaths)?payload.relativePaths:[],inputTokens:Array.isArray(payload.inputTokens)?payload.inputTokens:[],input:{extensions:VIDEO_EXTENSIONS,prefixArgumentCount:1,directoryArgument:'--source-folder'}};
  if(action===ACTIONS.preview)return{action:'inputs.preview',...base};
  const inspect=action===ACTIONS.inspect;const operationKey=inspect?'inspect':action===ACTIONS.transcode?'transcode':'split';
  return{action:'execute',runtimeCapability:'media.video.processing.cli',arguments:[action===ACTIONS.split?'cut_video':'ffmpeg_transcode',...opaqueArgs(payload,{optional:action===ACTIONS.split})],...base,...(!inspect?{operationKey,idempotencyKey:String(payload.idempotencyKey||''),task:{background:true,title:'Component runtime operation',runningMessage:'Component runtime is running',completeMessage:'Component runtime complete',concurrencyGroup:'heavy-media',concurrencyLimit:1,concurrencyWriteLimit:1},control:{cancelArgument:'--cancel_file',...(action===ACTIONS.transcode?{pauseArgument:'--pause_file'}:{})},eventName:(descriptor?.service?.events||[])[0]||''}:{timeoutMs:20*60*1000})};
};
module.exports={isLegacyAction,translateLegacyMediaProcessV7};
