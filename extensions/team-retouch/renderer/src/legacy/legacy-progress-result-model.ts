type Json = Record<string, any>;
import type { ProgressFolder } from './legacy-types';
type ProgressResult = Json & { success?: boolean; error?: string; progressFolders: ProgressFolder[]; graphEdges: Json[] };

export const normalizeLegacyProgressResult = (value: Json | undefined): ProgressResult => ({
  ...(value || {}),
  progressFolders: Array.isArray(value?.progressFolders) ? value.progressFolders as ProgressFolder[] : [],
  graphEdges: Array.isArray(value?.graphEdges) ? value.graphEdges : [],
});

export const resolveLegacyTeamWorkflowProgressId = (progressFolders: Json[], preferredId = '') => {
  const preferred = progressFolders.find(folder => String(folder?.id || '') === String(preferredId || '') && folder?.nodeRole === 'workflow');
  if (preferred) return String(preferred.id);
  const owned = progressFolders.find(folder => folder?.nodeRole === 'workflow' && folder?.mediaKind === 'image'
    && folder?.sourceMetadata?.componentId === 'team-retouch');
  return String(owned?.id || '');
};
