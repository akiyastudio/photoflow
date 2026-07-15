import React, { useEffect, useState } from 'react';
import { Folder, FolderOpen, FolderPlus, X } from 'lucide-react';
import type { ProjectStatus, WorkspaceProject, WorkspaceStatusGroup } from '../types';

const STATUSES: ProjectStatus[] = ['未策划', '已策划', '进行中', '已归档'];
type Action = 'import' | 'broll' | 'match';

export const ProjectNavigator = ({ workspacePath, selectedProject, onSelectProject, onProjectAction, onWorkspaceResolved }: {
  workspacePath: string;
  selectedProject: WorkspaceProject | null;
  onSelectProject: (project: WorkspaceProject) => void;
  onProjectAction: (action: Action, project: WorkspaceProject) => void;
  onWorkspaceResolved: (workspacePath: string) => void;
}) => {
  const [groups, setGroups] = useState<WorkspaceStatusGroup[]>([]);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState<{ project: WorkspaceProject; x: number; y: number } | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');

  const refresh = async () => {
    const result = await window.electronAPI.getWorkspaceProjects(workspacePath);
    if (result.success) {
      setGroups(result.statuses);
      if (result.root && result.root !== workspacePath) onWorkspaceResolved(result.root);
      setError('');
    } else setError(result.error || '无法读取工作目录');
  };

  useEffect(() => { refresh(); }, [workspacePath]);
  useEffect(() => { const close = () => setMenu(null); window.addEventListener('click', close); return () => window.removeEventListener('click', close); }, []);

  const createProject = async () => {
    const result = await window.electronAPI.createWorkspaceProject(workspacePath, date, name);
    if (!result.success || !result.project) { setError(result.error || '新建项目失败'); return; }
    setShowNew(false); setName(''); onSelectProject(result.project); refresh();
  };
  const rename = async (project: WorkspaceProject) => {
    const nextName = window.prompt('项目名称', project.name);
    if (!nextName || nextName === project.name) return;
    const result = await window.electronAPI.renameWorkspaceProject(workspacePath, project.status, project.name, nextName);
    if (!result.success) setError(result.error || '重命名失败'); refresh();
  };
  const move = async (project: WorkspaceProject, status: ProjectStatus) => {
    if (status === project.status) return;
    const result = await window.electronAPI.moveWorkspaceProject(workspacePath, project.status, project.name, status);
    if (!result.success) setError(result.error || '更改状态失败'); refresh();
  };
  const trash = async (project: WorkspaceProject) => {
    if (!window.confirm(`确定将“${project.name}”移入系统回收站吗？`)) return;
    const result = await window.electronAPI.trashWorkspaceProject(workspacePath, project.status, project.name);
    if (!result.success) setError(result.error || '移入回收站失败'); refresh();
  };

  return <>
    <div className="px-4 pt-4">
      <button onClick={() => setShowNew(true)} className="w-full rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-bold text-white shadow-md shadow-blue-500/20 hover:bg-blue-500"><span className="flex items-center justify-center gap-2"><FolderPlus size={17}/>新建项目</span></button>
    </div>
    <nav className="flex-1 overflow-y-auto p-4 pt-2">
      {STATUSES.map(status => { const projects = groups.find(group => group.status === status)?.projects || []; return <section key={status} className="border-t border-slate-200 py-3 first:border-t-0"><p className="mb-2 px-2 text-xs font-bold tracking-wide text-slate-500">{status}</p><div className="space-y-1">{projects.map(project => <div key={project.path} className={`flex items-center gap-1 rounded-lg text-sm transition ${selectedProject?.path === project.path ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}><button title={project.name} onClick={() => onSelectProject(project)} onContextMenu={event => { event.preventDefault(); setMenu({ project, x: event.clientX, y: event.clientY }); }} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"><Folder size={15} className="shrink-0"/><span className="min-w-0 flex-1 truncate">{project.name}</span></button><button type="button" aria-label="打开项目文件夹" title="打开项目文件夹" onClick={() => window.electronAPI.openWorkspaceProject(workspacePath, project.status, project.name).then(result => { if (!result.success) setError(result.error || '无法打开文件夹'); })} className="mr-1 rounded p-1.5 hover:bg-white/20"><FolderOpen size={15}/></button></div>)}{!projects.length && <p className="px-2 text-xs text-slate-400">暂无项目</p>}</div></section>; })}
      {error && <p className="mt-2 px-2 text-xs text-red-500">{error}</p>}
    </nav>
    {menu && <div className="fixed z-[300] w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-xl" style={{ left: menu.x, top: menu.y }} onClick={event => event.stopPropagation()}><button className="project-menu-item" onClick={() => { rename(menu.project); setMenu(null); }}>重命名</button><div className="my-1 border-t border-slate-100"/><p className="px-2 py-1 text-[11px] font-bold text-slate-400">更改状态</p>{STATUSES.map(status => <button key={status} className="project-menu-item" onClick={() => { move(menu.project, status); setMenu(null); }}>{status}{status === menu.project.status ? '（当前）' : ''}</button>)}<div className="my-1 border-t border-slate-100"/><button className="project-menu-item" onClick={() => { onProjectAction('import', menu.project); setMenu(null); }}>从 SD 卡导入</button><button className="project-menu-item" onClick={() => { onProjectAction('broll', menu.project); setMenu(null); }}>导入花絮</button><button className="project-menu-item" onClick={() => { onProjectAction('match', menu.project); setMenu(null); }}>选片</button><div className="my-1 border-t border-slate-100"/><button className="project-menu-item text-red-500 hover:bg-red-50" onClick={() => { trash(menu.project); setMenu(null); }}>移入回收站</button></div>}
    {showNew && <ProjectDialog title="新建项目" onClose={() => setShowNew(false)}><p className="text-xs text-slate-500">日期和名称至少填写一项；新项目会创建在“未策划”。</p><label className="form-label">项目日期</label><input value={date} onChange={event => setDate(event.target.value)} placeholder="例如：8-10 或 2026-08-10" className="form-input"/><label className="form-label">项目名称</label><input value={name} onChange={event => setName(event.target.value)} className="form-input"/><div className="mt-5 flex justify-end gap-2"><button onClick={() => setShowNew(false)} className="dialog-secondary">取消</button><button onClick={createProject} disabled={!date && !name} className="dialog-primary">创建</button></div></ProjectDialog>}
  </>;
};

const ProjectDialog = ({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) => <div className="fixed inset-0 z-[250] flex items-center justify-center bg-slate-950/30 p-4"><div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"><div className="mb-3 flex items-center justify-between"><h3 className="font-bold text-slate-800">{title}</h3><button onClick={onClose}><X size={18}/></button></div>{children}</div></div>;