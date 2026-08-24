type Json = Record<string, any>;
export type LegacyPreviewRequest = { key: string; kind: 'original' | 'working'; photoId: string; baseVersionId: string; taskId?: string };

export const readableLegacyMediaError = (value: unknown, kind: 'original' | 'working' | 'returned' | 'review-return' = 'working') => {
  const raw = value instanceof Error ? value.message : String(value || '未知错误');
  if (/Host capability is unavailable:\s*project\.media\.access\.v1/i.test(raw)) return `主程序暂未提供媒体授权能力，无法读取${kind === 'original' ? '原图' : '工作图'}。请更新或重启主程序后重试。`;
  if (/outside (?:the )?bound project|ownership|不属于当前项目|归属/i.test(raw)) return `媒体归属与当前项目不匹配，宿主需要恢复这条历史记录的项目归属。详情：${raw}`;
  if (/base.?version|version.*(?:missing|not found|不存在)|版本不存在/i.test(raw)) return `历史版本不存在或尚未恢复，无法授权预览。详情：${raw}`;
  if (/task.*(?:missing|not found|不存在)|工作图.*(?:不存在|缺失)/i.test(raw)) return `工作图任务不存在或文件缺失。详情：${raw}`;
  if (/授权.*(?:失效|失败)|media.*access.*(?:expired|denied)/i.test(raw)) return `媒体授权失败或已经失效，请重试。详情：${raw}`;
  return `预览读取失败：${raw}`;
};

export const legacyPreviewRequests = (workspace: Json): LegacyPreviewRequest[] => (workspace.photos || []).flatMap((photo: Json) => {
  const photoId = String(photo.photoId || ''); const baseVersionId = String(photo.baseVersionId || '');
  return [{ key: `original:${photoId}:${baseVersionId}`, kind: 'original' as const, photoId, baseVersionId }, ...(photo.tasks || []).map((task: Json) => ({ key: `working:${photoId}:${String(task.baseVersionId || baseVersionId)}:${String(task.id || '')}`, kind: 'working' as const, photoId, baseVersionId: String(task.baseVersionId || baseVersionId), taskId: String(task.id || '') }))];
});

export const summarizeLegacyPreviewResults = (requests: LegacyPreviewRequest[], results: Array<{ success: boolean; error?: string }>) => ({
  total: requests.length,
  succeeded: results.filter(result => result.success).length,
  failed: results.filter(result => !result.success).length,
  failures: results.flatMap((result, index) => result.success ? [] : [{ request: requests[index], error: result.error || '未知错误' }]),
});
