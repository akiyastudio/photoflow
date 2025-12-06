import React, { useState, useEffect } from 'react';
import { Trash2, Plus, Save, User, Calendar } from 'lucide-react';

const BirthdayManager = () => {
  const [birthdays, setBirthdays] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  
  // 表单状态
  const [newName, setNewName] = useState('');
  const [newMonth, setNewMonth] = useState('');
  const [newDay, setNewDay] = useState('');
  const [msg, setMsg] = useState<{text: string, type: 'success' | 'error'} | null>(null);

  // 加载数据
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    if (window.electronAPI) {
      const data = await window.electronAPI.getBirthdays();
      setBirthdays(data || {});
      setLoading(false);
    }
  };

  // 显示临时消息
  const showMsg = (text: string, type: 'success' | 'error') => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 3000);
  };

  // 添加生日
  const handleAdd = async () => {
    if (!newName.trim() || !newMonth || !newDay) {
      showMsg("请填写完整信息", 'error');
      return;
    }

    // 格式化日期以匹配 main.py 的要求: "X月.Y日"
    // 去除前导零，例如 05 -> 5
    const m = parseInt(newMonth).toString(); 
    const d = parseInt(newDay).toString();
    const dateStr = `${m}月.${d}日`;

    if (birthdays[newName]) {
      if (!confirm(`角色 "${newName}" 已存在，要覆盖吗？`)) return;
    }

    const updated = { ...birthdays, [newName]: dateStr };
    await saveToDisk(updated);
    
    // 重置表单
    setNewName('');
    setNewMonth('');
    setNewDay('');
  };

  // 删除生日
  const handleDelete = async (name: string) => {
    if (!confirm(`确定要删除 "${name}" 吗？`)) return;
    
    const updated = { ...birthdays };
    delete updated[name];
    
    await saveToDisk(updated);
  };

  // 保存到硬盘的核心逻辑
  const saveToDisk = async (newData: Record<string, string>) => {
    setLoading(true);
    const res = await window.electronAPI.saveBirthdays(newData);
    
    if (res.success) {
      setBirthdays(newData);
      showMsg("保存成功", 'success');
    } else {
      showMsg("保存失败: " + res.error, 'error');
    }
    setLoading(false);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-white">生日数据管理</h2>
        <span className="text-xs text-slate-500 bg-slate-900 px-3 py-1 rounded-full border border-slate-800">
          Source: birthdays.json
        </span>
      </div>

      {/* 消息提示 */}
      {msg && (
        <div className={`p-3 rounded-lg text-sm font-medium animate-in fade-in slide-in-from-top-2 ${
          msg.type === 'success' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'
        }`}>
          {msg.text}
        </div>
      )}

      {/* 添加区域 */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
        <h3 className="text-sm font-semibold text-slate-400 uppercase mb-4 flex items-center gap-2">
          <Plus size={16} /> 添加新角色
        </h3>
        <div className="flex flex-col md:flex-row gap-4 items-end">
          <div className="flex-1 w-full space-y-2">
             <label className="text-xs text-slate-500">角色名称</label>
             <div className="relative">
                <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input 
                  type="text" 
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="例如: 刻晴"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-slate-200 focus:border-blue-500 outline-none"
                />
             </div>
          </div>
          
          <div className="w-full md:w-32 space-y-2">
             <label className="text-xs text-slate-500">月份</label>
             <input 
                type="number" min="1" max="12"
                value={newMonth}
                onChange={e => setNewMonth(e.target.value)}
                placeholder="1-12"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 focus:border-blue-500 outline-none text-center"
             />
          </div>

          <div className="w-full md:w-32 space-y-2">
             <label className="text-xs text-slate-500">日期</label>
             <input 
                type="number" min="1" max="31"
                value={newDay}
                onChange={e => setNewDay(e.target.value)}
                placeholder="1-31"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 focus:border-blue-500 outline-none text-center"
             />
          </div>

          <button 
            onClick={handleAdd}
            disabled={loading}
            className="w-full md:w-auto px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
          >
            <Save size={18} /> 保存
          </button>
        </div>
      </div>

      {/* 列表区域 */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-900/50 flex justify-between items-center">
          <h3 className="font-semibold text-slate-200">现有列表 ({Object.keys(birthdays).length})</h3>
        </div>
        
        <div className="max-h-[400px] overflow-y-auto">
          {Object.entries(birthdays).length === 0 ? (
            <div className="p-8 text-center text-slate-500">暂无数据</div>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-950 text-slate-500 sticky top-0">
                <tr>
                  <th className="px-6 py-3 font-medium">角色名</th>
                  <th className="px-6 py-3 font-medium">生日日期</th>
                  <th className="px-6 py-3 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {Object.entries(birthdays).map(([name, dateStr]) => (
                  <tr key={name} className="hover:bg-slate-800/50 transition-colors group">
                    <td className="px-6 py-3 text-slate-300 font-medium">{name}</td>
                    <td className="px-6 py-3 text-blue-400 font-mono">{dateStr}</td>
                    <td className="px-6 py-3 text-right">
                      <button 
                        onClick={() => handleDelete(name)}
                        className="text-slate-600 hover:text-red-400 p-1 rounded hover:bg-red-400/10 transition-colors"
                        title="删除"
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};