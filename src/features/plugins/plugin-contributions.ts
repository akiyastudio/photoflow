export type RendererPluginCapability =
  | 'team-retouch.workspace'
  | 'team-retouch.settings';

export type RendererPluginContribution = {
  id: 'team-retouch';
  renderer: {
    settingsSection: 'team-retouch';
    workspaceSurfaces: readonly ('project-toolbar' | 'project-context-menu' | 'media-preview')[];
    capabilities: readonly RendererPluginCapability[];
  };
  main: {
    ipcNamespaces: readonly string[];
    serviceCapabilities: readonly string[];
  };
};

export const RENDERER_PLUGIN_CONTRIBUTIONS: readonly RendererPluginContribution[] = [
  {
    id: 'team-retouch',
    renderer: {
      settingsSection: 'team-retouch',
      workspaceSurfaces: ['project-toolbar', 'project-context-menu'],
      capabilities: ['team-retouch.workspace', 'team-retouch.settings'],
    },
    main: {
      ipcNamespaces: ['workspace-team-'],
      serviceCapabilities: ['team-retouch.detect', 'team-retouch.identify', 'team-retouch.merge'],
    },
  },
];

export const componentIdForSettingsSection = (section: string) =>
  RENDERER_PLUGIN_CONTRIBUTIONS.find(contribution => contribution.renderer.settingsSection === section)?.id;

export const installedPluginHasCapability = (installedIds: ReadonlySet<string>, capability: RendererPluginCapability) => {
  const contribution = RENDERER_PLUGIN_CONTRIBUTIONS.find(candidate => candidate.renderer.capabilities.includes(capability));
  return Boolean(contribution && installedIds.has(contribution.id));
};
