import React, { useEffect, useRef } from 'react';
import type { LogEntry } from '../types';

interface TerminalProps {
  logs: LogEntry[];
  title?: string;
  height?: string;
}

export const Terminal: React.FC<TerminalProps> = ({ logs, title = "日志", height = "h-64" }) => {
  // 指向列表底部的锚点
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 只要 logs 变化，就滚动到底部锚点
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ 
        behavior: 'smooth', // 平滑滚动
        block: 'nearest'    // 关键参数：只滚动最近的父容器，不影响整个页面
      });
    }
  }, [logs]);
  // --- 修改重点结束 ---

  return (
    <div className={`flex flex-col bg-white border border-slate-200 rounded-lg overflow-hidden ${height}`}>
      {/* 标题栏 */}
      <div className="flex items-center px-4 py-2 bg-slate-200 border-b border-slate-200">
        <div className="flex space-x-2 mr-4">
          <div className="w-3 h-3 rounded-full bg-red-500"></div>
          <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
          <div className="w-3 h-3 rounded-full bg-green-500"></div>
        </div>
        <span className="text-xs font-mono text-slate-500">{title}</span>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 p-4 overflow-y-auto font-mono text-sm terminal-scroll space-y-1 scrollbar-thin scrollbar-thumb-slate-600 scrollbar-track-transparent">
        {logs.length === 0 && (
          <div className="text-slate-600">等待开始...</div>
        )}
        {logs.map((log, index) => (
          <div key={index} className="flex gap-3">
            <span className="text-slate-600 shrink-0">[{log.timestamp}]</span>
            <span className={`break-all ${
              log.type === 'error' ? 'text-red-400' :
              log.type === 'success' ? 'text-green-400' :
              log.type === 'warning' ? 'text-yellow-400' :
              'text-slate-800'
            }`}>
              {log.message}
            </span>
          </div>
        ))}
        {/* 底部锚点 */}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};
interface TaskStatusProps {
  logs: LogEntry[];
}

export const TaskStatus: React.FC<TaskStatusProps> = ({ logs }) => {
  const latest = logs[logs.length - 1];
  if (!latest) return null;
  const color = latest.type === 'error' ? 'text-red-500' : latest.type === 'success' ? 'text-emerald-600' : latest.type === 'warning' ? 'text-amber-600' : 'text-slate-500';
  return <p className={`mt-4 min-h-5 text-sm ${color}`} role="status" aria-live="polite">{latest.message}</p>;
};
