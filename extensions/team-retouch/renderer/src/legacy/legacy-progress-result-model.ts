type Json = Record<string, any>;

export const normalizeLegacyProgressResult = (value: Json | undefined) => ({
  ...(value || {}),
  progressFolders: Array.isArray(value?.progressFolders) ? value.progressFolders : [],
  graphEdges: Array.isArray(value?.graphEdges) ? value.graphEdges : Array.isArray(value?.edges) ? value.edges : [],
});
