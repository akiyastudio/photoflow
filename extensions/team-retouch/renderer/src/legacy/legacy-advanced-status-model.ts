type Status = { advancedAvailable?: boolean; advancedState?: string } | undefined;
export const legacyAdvancedStatusPresentation = (status: Status, loading: boolean, error = '') => {
  if (loading) return { state: 'checking' as const, text: '正在检查高级人物检测…' };
  if (error) return { state: 'error' as const, text: `高级人物检测状态检查失败：${error}` };
  if (status?.advancedAvailable || status?.advancedState === 'ready') return { state: 'ready' as const, text: '当前使用高级人物检测' };
  if (status?.advancedState === 'repair-needed') return { state: 'repair-needed' as const, text: '当前使用基础人物检测；高级检测需要修复。' };
  if (status?.advancedState === 'not-installed') return { state: 'not-installed' as const, text: '当前使用基础人物检测；高级检测未安装。' };
  return { state: 'unknown' as const, text: '当前使用基础人物检测；高级检测状态尚未确认。' };
};
