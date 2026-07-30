const RESERVED_PROJECT_FOLDER_NAMES = new Set([
  'raw',
  'jpg',
  'mov',
  'mov_预览',
  '图片选片',
  '视频选片',
  '策划',
]);

const PROGRESS_FOLDER_PATTERN = /^(?:图片后期|视频后期)_\d+(?:_\d+)*(?:_.+)?$/iu;

const isProtectedProjectFolderName = name => {
  const normalized = String(name || '').trim().toLocaleLowerCase('zh-CN');
  return RESERVED_PROJECT_FOLDER_NAMES.has(normalized) || PROGRESS_FOLDER_PATTERN.test(String(name || '').trim());
};

const isProtectedProjectFolderPath = ({ fs, path, projectRoot, candidate }) => {
  const root = path.resolve(projectRoot);
  const target = path.resolve(candidate);
  if (path.dirname(target).toLocaleLowerCase() !== root.toLocaleLowerCase()) return false;
  try {
    if (!fs.statSync(target).isDirectory()) return false;
  } catch {
    return false;
  }
  return isProtectedProjectFolderName(path.basename(target));
};

module.exports = {
  RESERVED_PROJECT_FOLDER_NAMES,
  isProtectedProjectFolderName,
  isProtectedProjectFolderPath,
};
