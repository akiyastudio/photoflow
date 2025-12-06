import React, { useEffect, useRef } from 'react';
import type { LogEntry } from '../types';

interface TerminalProps {
  logs: LogEntry[];
  title?: string;
  height?: string;
}

export const Terminal: React.FC<TerminalProps> = ({ logs, title = "Output", height = "h-64" }) => {
  const bottomRef = useRef<HTMLDivElement>(null);


useEffect(() => {
  if (bottomRef.current) {
    // 保存原始 body 样式
    const originalOverflow = document.body.style.overflow;
    // 临时禁用 body 滚动（防止联动）
    document.body.style.overflow = 'hidden';

    // 执行内部滚动
    bottomRef.current.scrollTo({
      top: bottomRef.current.scrollHeight,
      behavior: "smooth"
    });

    // 滚动完成后恢复 body 样式（平滑滚动需延迟）
    const timer = setTimeout(() => {
      document.body.style.overflow = originalOverflow;
    }, 500);

    // 清理副作用
    return () => clearTimeout(timer);
  }
}, [logs]);

  return (
    <div className={`flex flex-col bg-slate-900 border border-slate-700 rounded-lg overflow-hidden ${height}`}>
      <div className="flex items-center px-4 py-2 bg-slate-800 border-b border-slate-700">
        <div className="flex space-x-2 mr-4">
          <div className="w-3 h-3 rounded-full bg-red-500"></div>
          <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
          <div className="w-3 h-3 rounded-full bg-green-500"></div>
        </div>
        <span className="text-xs font-mono text-slate-400">{title}</span>
      </div>
      <div className="flex-1 p-4 overflow-y-auto font-mono text-sm terminal-scroll space-y-1">
        {logs.length === 0 && (
          <div className="text-slate-600 italic">Waiting for process to start...</div>
        )}
        {logs.map((log, index) => (
          <div key={index} className="flex gap-3">
            <span className="text-slate-600 shrink-0">[{log.timestamp}]</span>
            <span className={`break-all ${
              log.type === 'error' ? 'text-red-400' :
              log.type === 'success' ? 'text-green-400' :
              log.type === 'warning' ? 'text-yellow-400' :
              'text-slate-300'
            }`}>
              {log.message}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};