const workflowManifestKey = (crypto, value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const workflowOutputOwnershipKey = relativePath => `团片协作/${String(relativePath || '').replace(/\\/g, '/')}`;

const findOwnedWorkflowOutput = (group, outputOwnership = {}) => {
  for (const item of Array.isArray(group?.items) ? group.items : []) {
    if (!item?.available || !item.relativePath) continue;
    const relativePath = workflowOutputOwnershipKey(item.relativePath);
    const ownership = outputOwnership?.[relativePath];
    if (ownership?.commitId && ownership?.artifactId) return { item, relativePath, ownership };
  }
  return null;
};

const verifiedWorkflowManifest = (value, binding = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Number(value.version) < 2 || !Array.isArray(value.groups)) return null;
  if (!value.groups.every(group => group && typeof group === 'object' && !Array.isArray(group) && Array.isArray(group.items)
    && group.items.every(item => item && typeof item === 'object' && !Array.isArray(item)))) return null;
  const boundProjectId = String(binding.projectId || '');
  if (boundProjectId && value.projectId && String(value.projectId) !== boundProjectId) return null;
  if (binding.legacy === true && (String(value.projectName || '') !== String(binding.projectName || '')
    || String(value.status || '') !== String(binding.projectStatus || ''))) return null;
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
  if (fs.existsSync(scope.manifestPath)) {
    let raw = null;
    try { raw = JSON.parse(await fs.promises.readFile(scope.manifestPath, 'utf8')); } catch { /* An existing canonical file always wins, even when damaged. */ }
    return { ...scope, manifest: verifiedWorkflowManifest(raw, { projectId }), source: raw ? 'canonical' : 'invalid-canonical' };
  }

  const projectName = String(context?.projectName || '');
  const projectStatus = String(context?.projectStatus || '');
  const legacyKey = workflowManifestKey(crypto, `${projectStatus}\0${projectName}`);
  const legacyPath = path.join(storage.dataPath, 'workflows', `${legacyKey}.json`);
  let legacy = null;
  try { legacy = JSON.parse(await fs.promises.readFile(legacyPath, 'utf8')); } catch { /* Missing or damaged legacy data is not adopted. */ }
  legacy = verifiedWorkflowManifest(legacy, { projectId, projectName, projectStatus, legacy: true });
  if (!legacy) return { ...scope, manifest: null, source: 'missing' };

  const restored = {
    ...legacy,
    projectId,
    restoredFrom: legacy.restoredFrom || { kind: 'legacy-status-name', projectName, status: projectStatus, manifestKey: legacyKey },
  };
  try { await writeJsonAtomic(scope.manifestPath, restored); }
  catch (error) {
    let concurrent = null;
    try { concurrent = JSON.parse(await fs.promises.readFile(scope.manifestPath, 'utf8')); } catch { /* Preserve the original atomic-copy failure. */ }
    concurrent = verifiedWorkflowManifest(concurrent, { projectId });
    if (!concurrent) throw error;
    return { ...scope, manifest: concurrent, source: 'canonical', legacyPath };
  }
  return { ...scope, manifest: restored, source: 'legacy-status-name', legacyPath };
};

module.exports = { createWorkflowManifestResolver, findOwnedWorkflowOutput, verifiedWorkflowManifest, workflowManifestKey, workflowOutputOwnershipKey };
