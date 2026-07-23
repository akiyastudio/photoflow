const RECYCLE_BIN_FAILURE_DIALOG = {
  title: '无法移入回收站',
  message: 'Windows 未能将文件移入回收站，原文件仍然保留。',
  detail: '删除操作被系统拒绝。可能因回收站容量不足、文件过大、磁盘不支持回收站、权限或文件占用等。',
  confirmLabel: '知道了',
  tone: 'danger',
} as const;

const isRecycleBinFailure = (value?: string) => Boolean(value && /回收站|系统取消了删除操作|可恢复删除/.test(value));

export { RECYCLE_BIN_FAILURE_DIALOG, isRecycleBinFailure };
