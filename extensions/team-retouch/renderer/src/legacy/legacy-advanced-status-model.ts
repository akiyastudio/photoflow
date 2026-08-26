type Status = { advancedAvailable?: boolean; advancedState?: string; advancedErrorCategory?: string; advancedRuntimeSource?: string } | undefined;
export const legacyAdvancedStatusPresentation = (status: Status, loading: boolean, error = '') => {
  if (loading) return { state: 'checking' as const, text: '正在检查高级人物检测…' };
  if (error) return { state: 'error' as const, text: `高级人物检测状态检查失败：${error}` };
  if (status?.advancedAvailable || status?.advancedState === 'ready') return { state: 'ready' as const, text: '当前使用高级人物检测' };
  if (status?.advancedState === 'repair-needed') return { state: 'repair-needed' as const, text: '当前使用基础人物检测；高级检测需要修复。' };
  if (status?.advancedState === 'not-installed') return { state: 'not-installed' as const, text: '当前使用基础人物检测；高级检测未安装。' };
  if (status?.advancedState === 'unavailable' && status.advancedErrorCategory === 'wsl-access-denied') return { state: 'unavailable' as const, text: status.advancedRuntimeSource === 'development' ? '当前使用基础人物检测；开发运行进程无权访问 WSL。' : '当前使用基础人物检测；照片流无权访问 WSL。' };
  return { state: 'unknown' as const, text: '当前使用基础人物检测；高级检测状态尚未确认。' };
};
