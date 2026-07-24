import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, X } from 'lucide-react';
import { PROJECT_STATUS_LABELS } from '../types';
import type { ProjectDate, ProjectStatus, WorkspaceProject, WorkspaceStatusGroup } from '../types';
import { useAppDialog } from './AppDialogProvider';
import { RECYCLE_BIN_FAILURE_DIALOG, isRecycleBinFailure } from '../utils/recycleBinFailure';

const STATUSES: ProjectStatus[] = ['未分类', '策划中', '待拍摄', '后期中', '已归档'];
type Action = 'import' | 'broll' | 'match';
const cleanupCheckedWorkspaces = new Set<string>();
const localDateKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const initialProjectDate = () => {
  const now = new Date();
  return { year: String(now.getFullYear()).slice(-2), month: String(now.getMonth() + 1), day: String(now.getDate()) };
};
const parseProjectDateText = (value: string) => {
  const matched = value.trim().match(/^(\d{2}|\d{4})\s*[-/.年]\s*(\d{1,2})(?:\s*[-/.月]\s*(\d{1,2})\s*日?)?$/);
  if (!matched) return null;
  const year = Number(matched[1]) < 100 ? Number(matched[1]) + 2000 : Number(matched[1]);
  const month = Number(matched[2]);
  const day = matched[3] ? Number(matched[3]) : undefined;
  if (year < 2000 || year > 2099 || month < 1 || month > 12) return null;
  if (day !== undefined) {
    const checked = new Date(year, month - 1, day);
    if (day < 1 || checked.getFullYear() !== year || checked.getMonth() !== month - 1 || checked.getDate() !== day) return null;
  }
  return { year: String(year).slice(-2), month: String(month), day: day === undefined ? '' : String(day) };
};

export const ProjectNavigator = ({ workspacePath, autoCleanupDeletedProjectData, selectedProject, onSelectProject, onProjectAction, onWorkspaceResolved }: {
  workspacePath: string;
  autoCleanupDeletedProjectData: boolean;
  selectedProject: WorkspaceProject | null;
  onSelectProject: (project: WorkspaceProject, replacePath?: string) => void;
  onProjectAction: (action: Action, project: WorkspaceProject) => void;
  onWorkspaceResolved: (workspacePath: string) => void;
}) => {
  const appDialog = useAppDialog();
  const [groups, setGroups] = useState<WorkspaceStatusGroup[]>([]);
  const [expanded, setExpanded] = useState<Record<ProjectStatus, boolean>>({ 未分类: true, 策划中: true, 待拍摄: true, 后期中: true, 已归档: true });
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('photoflow:sidebar-expanded');
      if (saved) setExpanded(current => ({ ...current, ...JSON.parse(saved) }));
    } catch {
      window.localStorage.removeItem('photoflow:sidebar-expanded');
    }
  }, []);
  useEffect(() => {
    window.localStorage.setItem('photoflow:sidebar-expanded', JSON.stringify(expanded));
  }, [expanded]);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState<{ project: WorkspaceProject; x: number; y: number } | null>(null);
  const [showNew, setShowNew] = useState(false);
  const initialDate = initialProjectDate();
  const [year, setYear] = useState(initialDate.year);
  const [month, setMonth] = useState(initialDate.month);
  const [day, setDay] = useState(initialDate.day);
  const [quickDate, setQuickDate] = useState(`${initialDate.year}-${initialDate.month}-${initialDate.day}`);
  const [name, setName] = useState('');
  const [renameProject, setRenameProject] = useState<WorkspaceProject | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newProjectError, setNewProjectError] = useState('');
  const [createNotice, setCreateNotice] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const resetProjectDate = () => {
    const value = initialProjectDate();
    setYear(value.year);
    setMonth(value.month);
    setDay(value.day);
    setQuickDate(`${value.year}-${value.month}-${value.day}`);
  };
  const openNewProject = () => {
    resetProjectDate();
    setName('');
    setNewProjectError('');
    setShowNew(true);
  };
  const applyQuickDate = (value: string) => {
    setQuickDate(value);
    const parsed = parseProjectDateText(value);
    if (!parsed) return;
    setYear(parsed.year);
    setMonth(parsed.month);
    setDay(parsed.day);
  };
  const projectDate = (): ProjectDate | null => {
    if (!year.trim() && !month.trim() && !day.trim()) return null;
    if (!year.trim() || !month.trim()) throw new Error('项目日期至少需要填写年份和月份');
    const normalizedYear = Number(year) < 100 ? Number(year) + 2000 : Number(year);
    return { year: normalizedYear, month: Number(month), ...(day.trim() ? { day: Number(day) } : {}), precision: day.trim() ? 'day' : 'month' };
  };
  const formattedDate = year && month ? `${String(year).slice(-2)}-${Number(month)}${day ? `-${Number(day)}` : ''}` : '';

  const refresh = async () => {
    if (!workspacePath.trim()) {
      setGroups([]);
      setError('');
      return;
    }
    const result = await window.electronAPI.getWorkspaceProjects(workspacePath);
    if (result.success) {
      setGroups(result.statuses);
      if (result.root && result.root !== workspacePath) onWorkspaceResolved(result.root);
      setError('');
    } else setError(result.error || '无法读取工作目录');
  };

  useEffect(() => { refresh(); }, [workspacePath]);
  useEffect(() => {
    if (!autoCleanupDeletedProjectData || !workspacePath.trim()) return;
    const key = workspacePath.trim().toLocaleLowerCase();
    if (cleanupCheckedWorkspaces.has(key)) return;
    cleanupCheckedWorkspaces.add(key);
    const storageKey = `photoflow:maintenance:deleted-project-cleanup:${key}`;
    const today = localDateKey();
    if (window.localStorage.getItem(storageKey) === today) return;
    let disposed = false;
    void window.electronAPI.cleanupDeletedWorkspaceProjects(workspacePath).then(result => {
      if (!result.success) return;
      window.localStorage.setItem(storageKey, today);
      if (!disposed && result.cleanedCount > 0) void refresh();
    });
    return () => { disposed = true; };
  }, [workspacePath, autoCleanupDeletedProjectData]);
  useEffect(() => {
    const close = () => setMenu(null);
    let refreshTimer = 0;
    const changed = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void refresh(), 250);
    };
    const unsubscribe = window.electronAPI.onWorkspaceProjectsChanged(changed);
    window.addEventListener('click', close);
    window.addEventListener('photoflow-menu-open', close);
    window.addEventListener('workspace-projects-changed', changed);
    return () => { window.clearTimeout(refreshTimer); unsubscribe(); window.removeEventListener('click', close); window.removeEventListener('photoflow-menu-open', close); window.removeEventListener('workspace-projects-changed', changed); };
  }, [workspacePath]);

  const createProject = async () => {
    setNewProjectError('');
    setIsCreating(true);
    try {
      const result = await window.electronAPI.createWorkspaceProject(workspacePath, projectDate(), name);
      if (!result.success || !result.project) {
        setNewProjectError(result.error || '新建项目失败');
        return;
      }
      const createdName = result.project.name;
      setShowNew(false);
      resetProjectDate();
      setName('');
      setExpanded(current => ({ ...current, 策划中: true }));
      onSelectProject(result.project);
      refresh();
      setCreateNotice(`项目“${createdName}”已创建成功`);
      window.setTimeout(() => setCreateNotice(''), 2000);
    } catch (createError) {
      setNewProjectError(createError instanceof Error ? createError.message : '新建项目失败');
    } finally {
      setIsCreating(false);
    }
  };
  const rename = async () => {
    if (!renameProject) return;
    const nextName = renameValue.trim();
    if (!nextName || nextName === renameProject.name) { setRenameProject(null); return; }
    const result = await window.electronAPI.renameWorkspaceProject(workspacePath, renameProject.status, renameProject.name, nextName);
    if (!result.success) setError(result.error || '重命名失败');
    else if (result.project && selectedProject?.path === renameProject.path) onSelectProject(result.project, renameProject.path);
    setRenameProject(null);
    setRenameValue('');
    refresh();
  };
  const move = async (project: WorkspaceProject, status: ProjectStatus) => {
    if (status === project.status) return;
    const result = await window.electronAPI.moveWorkspaceProject(workspacePath, project.status, project.name, status);
    if (!result.success) setError(result.error || '更改状态失败');
    else if (result.project && selectedProject?.path === project.path) onSelectProject(result.project, project.path);
    setExpanded(current => ({ ...current, [status]: true }));
    refresh();
  };
  const trash = async (project: WorkspaceProject) => {
    if (!await appDialog.confirm({
      title: '确定要删除项目吗？',
      message: `删除项目会将项目文件夹“${project.name}”移入回收站。`,
      confirmLabel: '删除项目',
      tone: 'danger',
    })) return;
    const result = await window.electronAPI.trashWorkspaceProject(workspacePath, project.status, project.name);
    if (!result.success) {
      if (isRecycleBinFailure(result.error, result.errorCode)) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
      else setError(result.error || '删除项目失败');
    }
    refresh();
  };
  const openProject = async (project: WorkspaceProject) => {
    const result = await window.electronAPI.openWorkspaceProject(workspacePath, project.status, project.name);
    if (!result.success) setError(result.error || '无法打开文件夹');
  };

  return <>
    {createNotice && <div className="fixed left-1/2 top-10 z-[400] -translate-x-1/2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white shadow-xl animate-in fade-in slide-in-from-top-2">{createNotice}</div>}
    <div className="px-4 pt-4"><button onClick={openNewProject} className="w-full rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-bold text-white shadow-md shadow-blue-500/20 hover:bg-blue-500"><span className="flex items-center justify-center gap-2"><FolderPlus size={17}/>新建项目</span></button></div>
    <nav className="project-navigator-scroll flex-1 overflow-y-auto p-4 pt-2">
      {STATUSES.filter(status => status !== '未分类' || (groups.find(group => group.status === status)?.projects.length || 0) > 0).map(status => {
        const projects = (groups.find(group => group.status === status)?.projects || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
        const isOpen = expanded[status];
        return <section key={status} className="border-t border-slate-200 py-2 first:border-t-0">
          <button type="button" onClick={() => setExpanded(current => ({ ...current, [status]: !current[status] }))} className="flex w-full items-center gap-1.5 rounded-md px-2 py-2 text-left text-xs font-bold tracking-wide text-slate-500 hover:bg-slate-100 hover:text-slate-800">{isOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<span>{PROJECT_STATUS_LABELS[status]}</span><span className="ml-auto font-mono text-[10px] text-slate-400">{projects.length}</span></button>
          {isOpen && <div className="mt-1 space-y-1">{projects.map(project => <div key={project.path} className={`project-row group flex items-center gap-1 rounded-lg text-sm transition ${selectedProject?.path === project.path ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}><button title={project.name} onClick={() => onSelectProject(project)} onContextMenu={event => { event.preventDefault(); window.dispatchEvent(new Event('photoflow-menu-open')); setMenu({ project, x: event.clientX, y: event.clientY }); }} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"><Folder size={15} className="shrink-0"/><span className="min-w-0 flex-1 truncate">{project.name}</span></button><button type="button" aria-label="打开项目文件夹" title="打开项目文件夹" onClick={() => openProject(project)} className="project-open-button mr-1 rounded p-1.5"><FolderOpen size={15}/></button></div>)}{!projects.length && <p className="px-7 py-1 text-xs text-slate-400">暂无项目</p>}</div>}
        </section>;
      })}
      {error && <p className="mt-2 px-2 text-xs text-red-500">{error}</p>}
    </nav>
    {menu && <div className="fixed z-[300] w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-xl" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 360) }} onClick={event => event.stopPropagation()}><button className="project-menu-item" onClick={() => { setRenameProject(menu.project); setRenameValue(menu.project.name); setMenu(null); }}>重命名</button><div className="my-1 border-t border-slate-100"/><p className="px-2 py-1 text-[11px] font-bold text-slate-400">更改状态</p>{STATUSES.filter(status => status !== '未分类').map(status => { const isCurrentStatus = status === menu.project.status; return <button key={status} aria-current={isCurrentStatus ? 'true' : undefined} className={`project-menu-item ${isCurrentStatus ? 'bg-blue-50 font-bold text-blue-700' : ''}`} onClick={() => { move(menu.project, status); setMenu(null); }}>{PROJECT_STATUS_LABELS[status]}{isCurrentStatus ? '（当前）' : ''}</button>; })}<div className="my-1 border-t border-slate-100"/><button className="project-menu-item" onClick={() => { onProjectAction('import', menu.project); setMenu(null); }}>从 SD 卡导入</button><button className="project-menu-item" onClick={() => { onProjectAction('broll', menu.project); setMenu(null); }}>导入花絮</button><button className="project-menu-item" onClick={() => { onProjectAction('match', menu.project); setMenu(null); }}>从文件名选片</button><div className="my-1 border-t border-slate-100"/><button className="project-menu-item text-red-500 hover:bg-red-50" onClick={() => { trash(menu.project); setMenu(null); }}>删除项目</button></div>}
    {renameProject && <ProjectDialog title="重命名项目" onClose={() => { setRenameProject(null); setRenameValue(''); }}><label className="form-label">项目名称</label><input autoFocus value={renameValue} onChange={event => setRenameValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void rename(); }} className="form-input"/><div className="mt-5 flex justify-end gap-2"><button onClick={() => { setRenameProject(null); setRenameValue(''); }} className="dialog-secondary">取消</button><button onClick={() => void rename()} disabled={!renameValue.trim()} className="dialog-primary">确认重命名</button></div></ProjectDialog>}
    {showNew && <ProjectDialog title="新建项目" onClose={() => { setShowNew(false); setNewProjectError(''); }}><p className="text-xs text-slate-500">日期精确到日时可自动匹配 SD 卡；只填年月时，导入前会询问目标项目。</p><label className="form-label">快速输入日期</label><input value={quickDate} onChange={event => applyQuickDate(event.target.value)} placeholder="例如：26-7-17 或 26-7" className="form-input"/><div className="mt-3 grid grid-cols-3 gap-2"><label className="text-xs font-medium text-slate-500">年<input list="project-year-options" value={year} onChange={event => setYear(event.target.value)} placeholder="26" inputMode="numeric" className="form-input mt-1"/></label><label className="text-xs font-medium text-slate-500">月<input list="project-month-options" value={month} onChange={event => setMonth(event.target.value)} placeholder="7" inputMode="numeric" className="form-input mt-1"/></label><label className="text-xs font-medium text-slate-500">日（可不填）<input list="project-day-options" value={day} onChange={event => setDay(event.target.value)} placeholder="17" inputMode="numeric" className="form-input mt-1"/></label></div><datalist id="project-year-options">{Array.from({ length: 8 }, (_, index) => { const value = new Date().getFullYear() - 2 + index; return <option key={value} value={String(value).slice(-2)}/>; })}</datalist><datalist id="project-month-options">{Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}/>)}</datalist><datalist id="project-day-options">{Array.from({ length: 31 }, (_, index) => <option key={index + 1} value={index + 1}/>)}</datalist><label className="form-label">项目名称</label><input value={name} onChange={event => setName(event.target.value)} placeholder="例如：春日写真" className="form-input"/><p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">将创建：<strong className="text-slate-700">{[formattedDate, name.trim()].filter(Boolean).join(' ') || '请填写日期或名称'}</strong></p>{newProjectError && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{newProjectError}</div>}<div className="mt-5 flex justify-end gap-2"><button onClick={() => { setShowNew(false); setNewProjectError(''); }} className="dialog-secondary">取消</button><button onClick={createProject} disabled={isCreating || (!formattedDate && !name.trim())} className="dialog-primary">{isCreating ? '创建中…' : '创建'}</button></div></ProjectDialog>}
  </>;
};

const ProjectDialog = ({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) => <div className="fixed inset-0 z-[250] flex items-center justify-center bg-slate-950/40 p-4"><div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"><div className="mb-3 flex items-center justify-between"><h3 className="font-bold text-slate-800">{title}</h3><button onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-100"><X size={18}/></button></div>{children}</div></div>;
