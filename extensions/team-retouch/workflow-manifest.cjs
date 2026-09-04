const workflowManifestKey = (crypto, value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const workflowOutputOwnershipKey = relativePath => `团片协作/${String(relativePath || '').replace(/\\/g, '/')}`;

const findOwnedWorkflowOutput = (group, outputOwnership = {}) => {
  for (const item of Array.isArray(group?.items) ? group.items : []) {
    if (!item?.available || !item.relativePath) continue;
    const relativePath = workflowOutputOwnershipKey(item.relativePath);
    const ownership = outputOwnership?.[relativePath];
    if (ownership?.commitId && ownership?.artifactId) return { item, relativePath: String(ownership.publishedRelativePath || relativePath), ownership };
  }
  return null;
};

const verifiedWorkflowManifest = (value, binding = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Number(value.version) !== 2 || !Array.isArray(value.groups)) return null;
  if (!value.groups.every(group => group && typeof group === 'object' && !Array.isArray(group) && Array.isArray(group.items)
    && group.items.every(item => item && typeof item === 'object' && !Array.isArray(item)))) return null;
  const boundProjectId = String(binding.projectId || '');
  if (!boundProjectId || String(value.projectId || '') !== boundProjectId) return null;
  return value;
};

const createWorkflowManifestResolver = ({ crypto, fs, path, writeJsonAtomic }) => async (storage, context) => {
  const projectId = String(storage.projectId || context?.projectId || '');
  if (!projectId) throw new Error('工作流程缺少项目 ID，无法建立私有存储边界');
  const key = workflowManifestKey(crypto, projectId);
  const scope = {
    key,
    outputDirectory: path.join(storage.dataPath, 'workflow-content', key),
    manifestPath: path.join(storage.dataPath, 'workflows', `${key}.json`),
    reviewDirectory: path.join(storage.dataPath, 'workflow-return-reviews', key),
  };
  if (!fs.existsSync(scope.manifestPath)) return { ...scope, manifest: null, source: 'missing' };
  let raw = null;
  try { raw = JSON.parse(await fs.promises.readFile(scope.manifestPath, 'utf8')); } catch { /* Invalid current data is reported without rewriting it. */ }
  return { ...scope, manifest: verifiedWorkflowManifest(raw, { projectId }), source: raw ? 'current' : 'invalid-current' };
};

module.exports = { createWorkflowManifestResolver, findOwnedWorkflowOutput, verifiedWorkflowManifest, workflowManifestKey, workflowOutputOwnershipKey };
