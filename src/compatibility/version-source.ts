import type { ProgressFolder, VersionSourceMetadata } from '../types';

const LEGACY_COMPONENT_WORKSPACE_KIND = 'team_workspace';

/** Converts persisted pre-metadata component workflow nodes at the renderer boundary. */
export const legacyVersionSourceMetadata = (
  folder: Pick<ProgressFolder, 'nodeRole' | 'artifactKind'>,
): VersionSourceMetadata | undefined => folder.nodeRole === 'workflow'
  && folder.artifactKind === LEGACY_COMPONENT_WORKSPACE_KIND
  ? {
      category: 'workflow',
      role: 'component-workspace',
      displayName: '协作',
      componentId: 'team-retouch',
      parentCapability: 'workflow-input',
    }
  : undefined;
