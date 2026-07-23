import React, { useEffect, useState } from 'react';
import { Loader2, Puzzle } from 'lucide-react';

export const RequirePlugin = ({ scriptName, title, desc, children, embedded = false }: { scriptName: string; title: string; desc: string; children: React.ReactNode; embedded?: boolean }) => {
  const [isInstalled, setIsInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        setIsInstalled(await window.electronAPI.checkScript(scriptName));
      } catch {
        setIsInstalled(false);
      }
    };
    void check();
  }, [scriptName]);

  if (isInstalled === null) return <div className="flex items-center gap-3 p-8 text-slate-500"><Loader2 className="animate-spin" size={18}/>检测插件状态…</div>;
  if (isInstalled) return <>{children}</>;

  return <div className="w-full space-y-6">
    {!embedded && <h2 className="text-2xl font-bold text-slate-800">{title}</h2>}
    <div className="flex flex-col items-center justify-center space-y-4 rounded-xl border border-slate-200 bg-white p-12 text-center shadow-sm">
      <div className="mb-2 flex h-16 w-16 items-center justify-center rounded-2xl border border-slate-100 bg-slate-50 text-slate-400"><Puzzle size={32}/></div>
      <h3 className="text-xl font-bold text-slate-800">未安装此功能插件</h3>
      <p className="max-w-md text-sm text-slate-500">缺少 <strong className="text-blue-600">{scriptName}</strong>。<br/>{desc}</p>
      <button disabled className="mt-4 cursor-not-allowed rounded-lg border border-slate-200 bg-slate-100 px-6 py-2 font-bold text-slate-400">插件缺失</button>
    </div>
  </div>;
};
