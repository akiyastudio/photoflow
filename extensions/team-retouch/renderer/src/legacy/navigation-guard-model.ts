export const navigationBlockedReason = (operations: Iterable<{ blocking: boolean; label: string }>) => {
  const blocked = [...operations].filter(item => item.blocking);
  return blocked.length ? `${blocked[0].label}正在处理，请完成后再切换步骤` : '';
};
