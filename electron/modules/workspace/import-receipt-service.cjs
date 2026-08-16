const IMPORT_STAGING_ROOT_NAME = '_PhotoFlow_Safety_Temp';
const IMPORT_GRAPH_RECEIPT_NAME = '.photoflow-import-graph-receipt.json';
const validImportSessionId = value => /^[a-zA-Z0-9_-]{1,128}$/.test(String(value || ''));

const createImportReceiptService = ({ crypto, fs, path, pathExists, versionService }) => {
  const importStagingRoots = (root, catalog) => {
    const normalizedRoot = path.resolve(root);
    return [...new Set([normalizedRoot, ...(catalog?.projects || []).map(project => path.resolve(normalizedRoot, project.relative_path))]
      .filter(candidate => candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}${path.sep}`))
      .map(candidate => path.join(candidate, IMPORT_STAGING_ROOT_NAME)))];
  };

  const readImportReceipt = async receiptPath => {
    try {
      const payload = JSON.parse(await fs.promises.readFile(receiptPath, 'utf8'));
      if (payload?.receiptVersion !== 1 || !validImportSessionId(payload?.importSessionId) || !Array.isArray(payload?.manifests)) return null;
      return payload;
    } catch { return null; }
  };

  const receiptLocationsForSession = async (root, catalog, sessionId) => {
    if (!validImportSessionId(sessionId)) return [];
    const results = [];
    for (const stagingRoot of importStagingRoots(root, catalog)) {
      const location = { sessionDir: path.join(stagingRoot, sessionId), receiptPath: path.join(stagingRoot, sessionId, IMPORT_GRAPH_RECEIPT_NAME) };
      if (await pathExists(location.receiptPath)) results.push(location);
    }
    return results;
  };

  const acknowledgeImportReceipt = async (location, projectName) => {
    const receipt = await readImportReceipt(location.receiptPath);
    if (!receipt) return false;
    const expected = [...new Set(receipt.manifests.map(item => String(item?.projectName || '').toLocaleLowerCase()).filter(Boolean))];
    const acknowledgedProjects = [...new Set([...(Array.isArray(receipt.acknowledgedProjects) ? receipt.acknowledgedProjects : []), projectName]
      .map(value => String(value).toLocaleLowerCase()).filter(value => expected.includes(value)))];
    if (expected.length && expected.every(value => acknowledgedProjects.includes(value))) {
      await fs.promises.rm(location.sessionDir, { recursive: true, force: true });
      return true;
    }
    const temporaryPath = `${location.receiptPath}.tmp-${crypto.randomUUID()}`;
    await fs.promises.writeFile(temporaryPath, JSON.stringify({ ...receipt, acknowledgedProjects }, null, 2), 'utf8');
    await fs.promises.rename(temporaryPath, location.receiptPath);
    return false;
  };

  const commitImportManifest = (workspaceRoot, manifest) => versionService.commitImportGraph(workspaceRoot, {
    schemaVersion: manifest?.schemaVersion,
    projectName: manifest?.projectName,
    importSessionId: manifest?.importSessionId,
    artifacts: Array.isArray(manifest?.artifacts) ? manifest.artifacts.map(item => ({
      relativePath: item?.relativePath,
      mediaKind: item?.mediaKind,
      importSlot: item?.importSlot,
      displayName: item?.displayName,
    })) : [],
  });

  return { acknowledgeImportReceipt, commitImportManifest, importStagingRoots, readImportReceipt, receiptLocationsForSession };
};

module.exports = { IMPORT_GRAPH_RECEIPT_NAME, IMPORT_STAGING_ROOT_NAME, createImportReceiptService, validImportSessionId };
