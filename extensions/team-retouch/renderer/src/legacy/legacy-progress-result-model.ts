type Json = Record<string, any>;

export const normalizeLegacyProgressResult = (value: Json | undefined) => ({
  ...(value || {}),
  progressFolders: Array.isArray(value?.progressFolders) ? value.progressFolders : [],
  graphEdges: Array.isArray(value?.graphEdges) ? value.graphEdges : Array.isArray(value?.edges) ? value.edges : [],
});

export const resolveLegacyTeamWorkflowProgressId = (progressFolders: Json[], preferredId = '') => {
  const preferred = progressFolders.find(folder => String(folder?.id || '') === String(preferredId || '') && folder?.nodeRole === 'workflow');
  if (preferred) return String(preferred.id);
  const owned = progressFolders.find(folder => folder?.nodeRole === 'workflow' && folder?.mediaKind === 'image'
    && (folder?.sourceMetadata?.componentId === 'team-retouch'
      || folder?.artifactKind === 'team_workspace'
      || folder?.versionKey === 'team-workspace' && folder?.displayName === '团片协作'));
  return String(owned?.id || '');
};
