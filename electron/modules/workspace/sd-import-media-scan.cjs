const { MAX_CHANGED_PATHS } = require('../../contracts/media-sync-limits.cjs');

const scheduleSdImportedMedia = ({
  root,
  projects,
  importedPathsByProject,
  imageExtensions,
  rawExtensions,
  videoExtensions,
  fs,
  path,
  scheduleMediaTrackingScan,
}) => {
  const pathsByProject = new Map(Object.entries(
    importedPathsByProject && typeof importedPathsByProject === 'object' ? importedPathsByProject : {},
  ).map(([name, paths]) => [String(name).toLocaleLowerCase(), Array.isArray(paths) ? paths : []]));
  const mediaExtensions = new Set([...imageExtensions, ...rawExtensions, ...videoExtensions]
    .map(extension => String(extension).toLocaleLowerCase()));
  for (const project of projects) {
    const importedPaths = [...new Set((pathsByProject.get(project.name.toLocaleLowerCase()) || [])
      .map(value => path.resolve(String(value || '')))
      .filter(candidate => {
        const relative = path.relative(project.path, candidate);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
          && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
          && mediaExtensions.has(path.extname(candidate).toLocaleLowerCase());
      }))];
    const useFullScan = importedPaths.length === 0 || importedPaths.length > MAX_CHANGED_PATHS;
    scheduleMediaTrackingScan(root, project.name, useFullScan ? [] : importedPaths.map(importedPath => ({
      path: importedPath, eventType: 'rename', kind: 'file',
    })), useFullScan);
  }
};

module.exports = { scheduleSdImportedMedia };
