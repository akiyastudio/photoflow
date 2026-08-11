export type RendererPluginCapability =
  | 'team-retouch.workspace'
  | 'team-retouch.settings'
  | 'video-playback.settings';

export type RendererPluginContribution = {
  id: 'team-retouch' | 'video-playback-mpv';
  renderer: {
    settingsSection: 'team-retouch' | 'video-playback-mpv';
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
  {
    id: 'video-playback-mpv',
    renderer: {
      settingsSection: 'video-playback-mpv',
      workspaceSurfaces: ['media-preview'],
      capabilities: ['video-playback.settings'],
    },
    main: {
      ipcNamespaces: ['advanced-video-'],
      serviceCapabilities: ['video-playback.advanced'],
    },
  },
];

export const componentIdForSettingsSection = (section: string) =>
  RENDERER_PLUGIN_CONTRIBUTIONS.find(contribution => contribution.renderer.settingsSection === section)?.id;

export const installedPluginHasCapability = (installedIds: ReadonlySet<string>, capability: RendererPluginCapability) => {
  const contribution = RENDERER_PLUGIN_CONTRIBUTIONS.find(candidate => candidate.renderer.capabilities.includes(capability));
  return Boolean(contribution && installedIds.has(contribution.id));
};
