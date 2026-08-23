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
    scheduleMediaTrackingScan(
      root,
      project.name,
      importedPaths.map(importedPath => ({ path: importedPath, eventType: 'rename', kind: 'file' })),
      importedPaths.length === 0,
    );
  }
};

module.exports = { scheduleSdImportedMedia };
