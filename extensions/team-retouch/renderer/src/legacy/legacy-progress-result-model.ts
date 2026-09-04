type Json = Record<string, any>;

export const normalizeLegacyProgressResult = (value: Json | undefined) => ({
  ...(value || {}),
  progressFolders: Array.isArray(value?.progressFolders) ? value.progressFolders : [],
  graphEdges: Array.isArray(value?.graphEdges) ? value.graphEdges : [],
});

export const resolveLegacyTeamWorkflowProgressId = (progressFolders: Json[], preferredId = '') => {
  const preferred = progressFolders.find(folder => String(folder?.id || '') === String(preferredId || '') && folder?.nodeRole === 'workflow');
  if (preferred) return String(preferred.id);
  const owned = progressFolders.find(folder => folder?.nodeRole === 'workflow' && folder?.mediaKind === 'image'
    && folder?.sourceMetadata?.componentId === 'team-retouch');
  return String(owned?.id || '');
};
