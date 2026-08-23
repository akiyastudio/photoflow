import './style.css';
import { rpc, type ComponentContext } from './sdk';
import { scheduleWorkflowWeeks } from './workflow-schedule';

type Json = Record<string, any>;
type Tab = 'detect' | 'people' | 'workflow' | 'returns' | 'merge' | 'settings';
const app = document.querySelector<HTMLDivElement>('#app')!;
let context: ComponentContext;
let activeTab: Tab = 'detect';
let workspace: Json = { photos: [], identities: [], assignments: [] };
let files: Json[] = [];
let settings = { useGpu: true, oversizeCropMode: 'face-centered' };
let busy = false;
let notice = '';
let noticeError = false;
let progress = 0;
let progressMessage = '';

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[match]!);
const setNotice = (message: string, error = false) => { notice = message; noticeError = error; render(); };
const run = async (label: string, action: () => Promise<void>) => {
  if (busy) return;
  busy = true; setNotice(label);
  try { await action(); if (notice === label) notice = `${label}完成`; }
  catch (error) { notice = error instanceof Error ? error.message : String(error); noticeError = true; }
  finally { busy = false; render(); }
};
const assertSuccess = (result: Json, fallback: string) => { if (result?.success === false) throw new Error(result.error || fallback); return result; };
const relativePathOf = (entry: Json) => String(entry.relativePath || entry.path || '');

async function refresh() {
  const filePages: Json[] = [];
  let cursor = '';
  do {
    const page = assertSuccess(await rpc<Json>('project.files.list.v1', cursor ? { cursor } : {}), '无法读取项目图片');
    filePages.push(page);
    cursor = page.hasMore ? String(page.cursor || '') : '';
  } while (cursor && filePages.length < 100);
  const [projectResult, settingResult] = await Promise.all([
    rpc<Json>('team.project.get.v1'), rpc<Json>('component.settings.get.v1'),
  ]);
  workspace = assertSuccess(projectResult, '无法读取团片项目');
  files = filePages.flatMap(page => page.entries || page.files || []).filter((entry: Json) => entry.kind === 'image' || /\.(jpe?g|png|tiff?|heic|webp)$/i.test(entry.name || entry.relativePath || ''));
  if (settingResult.success !== false && settingResult.settings) settings = settingResult.settings;
  render();
}

const tabs: Array<[Tab, string]> = [['detect','检测'],['people','人物身份'],['workflow','工作流'],['returns','返图'],['merge','合并'],['settings','设置']];
const photoRows = () => (workspace.photos || []).map((photo: Json) => `<div class="item"><div><strong>${escapeHtml(photo.displayName || photo.originalName || photo.photoId)}</strong><small>${escapeHtml(photo.tasks?.length || 0)} 个工作图 · ${escapeHtml(photo.baseVersionId || '')}</small></div><span class="spacer"></span><span class="pill">已登记</span></div>`).join('') || '<div class="empty">尚未检测项目图片</div>';
const identityRows = () => (workspace.identities || []).map((identity: Json) => `<div class="item"><div><strong>${escapeHtml(identity.name)}</strong><small>${escapeHtml((workspace.assignments || []).filter((item: Json) => item.identityId === identity.id).length)} 个标记</small></div><span class="spacer"></span><button class="btn danger" data-action="delete-identity" data-id="${escapeHtml(identity.id)}">删除</button></div>`).join('') || '<div class="empty">检测后运行自动人物标记，或手动新建身份</div>';
const workflowGroups = () => {
  const identities = new Map((workspace.identities || []).map((identity: Json) => [identity.id, identity]));
  const entries = (workspace.assignments || []).flatMap((assignment: Json) => {
    const photo = (workspace.photos || []).find((candidate: Json) => candidate.photoId === assignment.photoId && candidate.baseVersionId === assignment.baseVersionId);
    const task = photo?.tasks?.find((candidate: Json) => candidate.personIndex === assignment.personIndex || candidate.members?.some((member: Json) => member.personIndex === assignment.personIndex));
    const identity = identities.get(assignment.identityId) as Json | undefined;
    return task && identity ? [{ key: `${assignment.photoId}:${assignment.baseVersionId}:${assignment.personIndex}`, taskId: task.id, personIndex: assignment.personIndex, identityId: identity.id, identityName: identity.name, photoId: assignment.photoId, baseVersionId: assignment.baseVersionId, photoName: photo.displayName || photo.originalName || photo.photoId }] : [];
  });
  const preferredIdentityOrder = (workspace.identities || []).map((identity: Json) => identity.id);
  const schedule = scheduleWorkflowWeeks(entries, { preferredIdentityOrder });
  const groups = new Map<string, Json>();
  for (const entry of entries) {
    const week = schedule.get(entry.key) || 1;
    const key = `${week}:${entry.identityId}`;
    const group = groups.get(key) || { week, identityId: entry.identityId, identityName: entry.identityName, items: [] };
    group.items.push({ photoId: entry.photoId, baseVersionId: entry.baseVersionId, personIndex: entry.personIndex, taskId: entry.taskId, photoName: entry.photoName });
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.week - right.week || String(left.identityName).localeCompare(String(right.identityName), 'zh-CN'));
};

function content() {
  if (activeTab === 'detect') return `<div class="grid"><section class="card third"><h2>项目图片</h2><p class="hint">组件从宿主的版本化项目文件能力读取，不接收工作区路径参数。</p><div class="metric">${files.length}</div></section><section class="card third"><h2>已登记团片</h2><p class="hint">沿用现有团片数据库，不复制或迁走记录。</p><div class="metric">${(workspace.photos || []).length}</div></section><section class="card third"><h2>检测任务</h2><p class="hint">自动优先高级环境，失败时回退基础引擎。</p><div class="row"><button class="btn primary" data-action="detect-all" ${busy || !files.length ? 'disabled':''}>检测全部图片</button><button class="btn" data-action="refresh">刷新</button></div>${progressMessage ? `<div class="progress"><i style="width:${progress}%"></i></div><p class="hint">${escapeHtml(progressMessage)}</p>`:''}</section><section class="card"><h2>检测结果</h2><div class="list">${photoRows()}</div></section></div>`;
  if (activeTab === 'people') return `<div class="grid"><section class="card half"><h2>人物身份</h2><p class="hint">自动聚类只调用明确的身份能力；确认和删除均写回原数据库。</p><div class="row"><button class="btn primary" data-action="suggest" ${busy || !(workspace.photos || []).length ? 'disabled':''}>重新自动标记人物</button><input id="identity-name" placeholder="人物名称"/><button class="btn" data-action="new-identity">新建身份</button></div></section><section class="card half"><h2>统计</h2><p class="hint">人物与指派</p><div class="metric">${(workspace.identities || []).length} / ${(workspace.assignments || []).length}</div></section><section class="card"><div class="list">${identityRows()}</div></section></div>`;
  if (activeTab === 'workflow') return `<div class="grid"><section class="card half"><h2>协作工作流</h2><p class="hint">按当前人物顺序生成应用级独立任务目录。</p><div class="row"><button class="btn primary" data-action="generate" ${busy || !(workspace.identities || []).length ? 'disabled':''}>生成工作流</button><button class="btn" data-action="workflow-status">读取状态</button></div></section><section class="card half"><h2>状态</h2><p class="hint">${workspace.workflowNeedsRegeneration ? '人物顺序已变化，需要重新生成' : '工作流与当前设置一致'}</p><div class="metric">${workspace.workflowGenerated ? '已生成' : '未生成'}</div></section><section class="card"><h2>当前编排</h2><div class="list">${(workspace.identities || []).map((item: Json, index: number) => `<div class="item"><span class="pill">第 ${index + 1} 周</span><strong>${escapeHtml(item.name)}</strong></div>`).join('') || '<div class="empty">请先确认人物身份</div>'}</div></section></div>`;
  if (activeTab === 'returns') return `<div class="grid"><section class="card half"><h2>批量返图</h2><p class="hint">文件只能通过宿主选择器授权，组件不能提交任意本地路径。</p><button class="btn primary" data-action="return-batch" ${busy || !(workspace.photos || []).length ? 'disabled':''}>选择并匹配返图</button></section><section class="card half"><h2>待审核返图</h2><p class="hint">恢复未完成的返图审核会话。</p><button class="btn" data-action="review">读取待审核批次</button></section><section class="card"><h2>处理进度</h2>${progressMessage ? `<div class="progress"><i style="width:${progress}%"></i></div><p>${escapeHtml(progressMessage)}</p>`:'<div class="empty">尚无返图任务</div>'}</section></div>`;
  if (activeTab === 'merge') return `<div class="grid"><section class="card"><h2>合并结果</h2><p class="hint">合并以每张已检测照片为单位，目标进度由版本化通用能力读取。组件不拥有任意文件系统访问。</p><div class="list">${(workspace.photos || []).map((photo: Json) => `<div class="item"><div><strong>${escapeHtml(photo.displayName || photo.photoId)}</strong><small>${escapeHtml(photo.tasks?.length || 0)} 个工作图</small></div><span class="spacer"></span><button class="btn" data-action="merge" data-photo="${escapeHtml(photo.photoId)}" data-version="${escapeHtml(photo.baseVersionId)}">合并</button></div>`).join('') || '<div class="empty">尚无可合并照片</div>'}</div></section></div>`;
  return `<div class="grid"><section class="card half"><h2>检测设置</h2><p class="hint">配置只写入 componentSettings/team-retouch；首次读取兼容旧 personDetection。</p><label class="row"><input id="use-gpu" type="checkbox" ${settings.useGpu ? 'checked':''}/>优先使用 GPU</label><label class="field"><span>超大人物裁剪</span><select id="crop-mode"><option value="face-centered" ${settings.oversizeCropMode === 'face-centered'?'selected':''}>保持 4000 像素</option><option value="expand" ${settings.oversizeCropMode === 'expand'?'selected':''}>扩大裁剪保留完整人物</option></select></label><div class="row"><button class="btn primary" data-action="save-settings">保存组件设置</button></div></section><section class="card half"><h2>高级环境</h2><p class="hint">安装脚本、算法和模型随团片组件包提供。</p><div class="row"><button class="btn" data-action="preflight">检查环境</button><button class="btn primary" data-action="install-advanced">安装/修复</button><button class="btn danger" data-action="uninstall-advanced">卸载高级环境</button></div></section></div>`;
}

function render() {
  app.innerHTML = `<div class="shell"><header class="topbar"><div class="brand"><span class="logo">团</span><div><h1>团片协作</h1><p>${escapeHtml(context?.projectName || '正在载入项目')}</p></div></div><nav class="tabs">${tabs.map(([id,label]) => `<button class="tab ${activeTab===id?'active':''}" data-tab="${id}">${label}</button>`).join('')}</nav><span class="state">${busy?'处理中…':`组件 ${escapeHtml(context?.componentVersion || '')}`}</span></header><main class="main">${notice?`<div class="notice ${noticeError?'error':''}">${escapeHtml(notice)}</div>`:''}${content()}</main></div>`;
}

app.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return;
  if (button.dataset.tab) { activeTab = button.dataset.tab as Tab; notice=''; render(); return; }
  const action = button.dataset.action;
  if (action === 'refresh') void run('刷新项目', refresh);
  if (action === 'detect-all') void run('正在检测项目图片', async () => { const relativePaths=files.map(relativePathOf).filter(Boolean); assertSuccess(await rpc<Json>('team.project.register.v1',{relativePaths}),'登记失败'); assertSuccess(await rpc<Json>('team.patch.detect-batch.v1',{relativePaths}),'检测失败'); await refresh(); });
  if (action === 'suggest') void run('正在自动标记人物', async () => { workspace=assertSuccess(await rpc<Json>('team.identity.suggest.v1'),'自动标记失败'); await refresh(); });
  if (action === 'new-identity') void run('新建人物身份', async () => { const name=(document.querySelector<HTMLInputElement>('#identity-name')?.value||'').trim(); if(!name) throw new Error('请输入人物名称'); assertSuccess(await rpc<Json>('team.identity.save.v1',{projectName:context.projectName,name}),'保存失败'); await refresh(); });
  if (action === 'delete-identity') void run('删除人物身份', async () => { assertSuccess(await rpc<Json>('team.identity.delete.v1',{projectName:context.projectName,identityId:button.dataset.id}),'删除失败'); await refresh(); });
  if (action === 'generate') void run('正在生成工作流', async () => { const preferredIdentityOrder=(workspace.identities||[]).map((item:Json)=>item.id); const groups=workflowGroups(); if(!groups.length) throw new Error('没有已确认且可编排的人物任务'); const result=assertSuccess(await rpc<Json>('team.workflow.generate.v1',{replace:workspace.workflowGenerated,preferredIdentityOrder,groups}),'生成失败'); if(result.requiresConfirmation) throw new Error('工作流目录已存在，请再次生成以替换'); await refresh(); });
  if (action === 'workflow-status') void run('读取工作流状态', async () => { const result=assertSuccess(await rpc<Json>('team.workflow.status.v1'),'读取失败'); notice=result.job?.message||'当前没有运行中的生成任务'; });
  if (action === 'return-batch') void run('正在选择返图', async () => { const selected=assertSuccess(await rpc<Json>('team.patch.select-returns.v1'),'选择失败'); if(selected.cancelled) {notice='已取消选择';return;} const relativePaths=(workspace.photos||[]).map((photo:Json)=>photo.relativePath).filter(Boolean); assertSuccess(await rpc<Json>('team.patch.return-batch.v1',{relativePaths,returnedFiles:selected.files||[]}),'返图处理失败'); await refresh(); });
  if (action === 'review') void run('读取待审核返图', async () => { const result=assertSuccess(await rpc<Json>('team.workflow.return-review.get.v1'),'读取失败'); notice=result.review?`有 ${result.review.reviewCount||0} 张返图待审核`:'没有待审核返图'; });
  if (action === 'merge') void run('正在合并照片', async () => { const progressResult=assertSuccess(await rpc<Json>('project.progress.list.v1'),'无法读取目标进度'); const candidates=(progressResult.progressFolders||[]).filter((item:Json)=>item.mediaKind==='image'&&!item.folderMissing&&item.nodeRole==='progress'); const target=candidates.at(-1); if(!target) throw new Error('请先在项目中建立图片进度'); assertSuccess(await rpc<Json>('team.patch.merge.v1',{photoId:button.dataset.photo,baseVersionId:button.dataset.version,outputProgressId:target.id,versionName:'团片协作合并'}),'合并失败'); await refresh(); });
  if (action === 'save-settings') void run('保存设置', async () => { settings={useGpu:Boolean(document.querySelector<HTMLInputElement>('#use-gpu')?.checked),oversizeCropMode:document.querySelector<HTMLSelectElement>('#crop-mode')?.value==='expand'?'expand':'face-centered'}; assertSuccess(await rpc<Json>('component.settings.update.v1',settings),'保存失败'); });
  if (action === 'preflight') void run('检查高级环境', async () => { const result=await rpc<Json>('component.advanced.preflight.v1'); notice=result.message||result.error||'环境检查完成'; noticeError=result.success===false; });
  if (action === 'install-advanced') void run('安装/修复高级环境', async () => { assertSuccess(await rpc<Json>('component.advanced.install.v1',{repair:true}),'安装失败'); });
  if (action === 'uninstall-advanced') void run('卸载高级环境', async () => { assertSuccess(await rpc<Json>('component.advanced.uninstall.v1'),'卸载失败'); });
});

for (const topic of ['patch.detect-batch.progress','patch.return-batch.progress','workflow.progress','advanced.progress']) window.photoFlowComponent.onEvent(topic, value => { const update=value as Json; progress=Math.max(0,Math.min(100,Number(update.progress)||0)); progressMessage=String(update.message||'处理中'); render(); });

void (async () => { context=await window.photoFlowComponent.getContext(); render(); await run('正在载入团片项目',refresh); })();
