const MAX_MEDIA_ITEMS = 2000;

const registerComponentProjectCapabilities = ({
  broker, ensureWorkspace, getWorkspaceDataRoot, getWorkspaceTeamRetouchDatabasePath,
  resolveProjectEntry, versionService, IMAGE_EXTENSIONS, path,
}) => {
  broker.register('component.storage.v1', (payload, context, descriptor) => {
    if (payload.namespace !== 'domain') throw new Error('Unknown component storage namespace');
    const workspaceRoot = ensureWorkspace(context.workspacePath);
    const componentId = String(descriptor.componentId || '');
    const dataRoot = path.join(getWorkspaceDataRoot(workspaceRoot), componentId);
    const databasePath = componentId === 'team-retouch'
      ? getWorkspaceTeamRetouchDatabasePath(workspaceRoot)
      : path.join(getWorkspaceDataRoot(workspaceRoot), 'databases', `${componentId}.sqlite3`);
    return { databasePath, dataRoot };
  });

  broker.register('project.media.read.v1', async (payload, context) => {
    const workspaceRoot = ensureWorkspace(context.workspacePath);
    const relativePaths = Array.isArray(payload.relativePaths) ? payload.relativePaths : [];
    const photoIds = Array.isArray(payload.photoIds) ? payload.photoIds : [];
    if (relativePaths.length + photoIds.length > MAX_MEDIA_ITEMS) throw new Error('Too many component media inputs');
    const items = [];
    const seen = new Set();
    for (const value of photoIds) {
      const photoId = String(value || '').trim();
      if (!photoId || seen.has(photoId)) continue;
      const bundle = await versionService.getPhoto(workspaceRoot, photoId);
      if (String(bundle.photo?.projectId || '') !== String(context.projectId || '')) continue;
      seen.add(photoId);
      items.push(bundle);
    }
    for (const value of relativePaths) {
      const relativePath = String(value || '');
      const filePath = resolveProjectEntry(context.workspacePath, context.projectStatus, context.projectName, relativePath);
      if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error(`Unsupported component image input: ${path.basename(filePath)}`);
      const bundle = await versionService.getMedia(workspaceRoot, { projectName: context.projectName, filePath });
      if (String(bundle.photo?.projectId || '') !== String(context.projectId || '')) throw new Error('Component media input is outside the bound project');
      if (seen.has(String(bundle.photo.id))) continue;
      seen.add(String(bundle.photo.id));
      items.push({ ...bundle, relativePath });
    }
    return { items };
  });
};

module.exports = { MAX_MEDIA_ITEMS, registerComponentProjectCapabilities };
