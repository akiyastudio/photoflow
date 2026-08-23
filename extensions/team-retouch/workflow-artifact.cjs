const createTeamWorkflowArtifactService = ({ crypto, fs, getWorkspaceDataRoot, path, writeLog }) => {
  const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
  const artifactPaths = (workspaceRoot, status, projectName) => {
    const dataRoot = getWorkspaceDataRoot(workspaceRoot);
    return {
      manifest: path.join(dataRoot, 'team-retouch', 'workflows', `${sha256(`${String(status)}\0${String(projectName)}`)}.json`),
      settings: path.join(dataRoot, 'team-retouch', 'workflow-settings', `${sha256(projectName)}.json`),
      similarities: path.join(dataRoot, 'team-retouch', 'identity-similarities', `${sha256(projectName)}.json`),
      reviewSession: path.join(dataRoot, 'team-retouch', 'workflow-return-reviews', sha256(projectName)),
    };
  };

  const updateReviewSessionIdentity = async (reviewDirectory, status, projectName) => {
    const sessionPath = path.join(reviewDirectory, 'session.json');
    if (!fs.existsSync(sessionPath)) return;
    const session = JSON.parse(await fs.promises.readFile(sessionPath, 'utf8'));
    const rewrittenMatches = (session.result?.matches || []).map(match => ({
      ...match,
      path: match.path ? path.join(reviewDirectory, path.basename(match.path)) : match.path,
    }));
    const pendingPath = `${sessionPath}.${crypto.randomUUID()}.tmp`;
    const backupPath = `${sessionPath}.${crypto.randomUUID()}.backup`;
    await fs.promises.writeFile(pendingPath, JSON.stringify({
      ...session,
      projectName,
      status,
      updatedAt: Date.now(),
      result: { ...session.result, matches: rewrittenMatches },
    }, null, 2), 'utf8');
    await fs.promises.rename(sessionPath, backupPath);
    try {
      await fs.promises.rename(pendingPath, sessionPath);
      await fs.promises.rm(backupPath, { force: true });
    } catch (error) {
      await fs.promises.rm(sessionPath, { force: true }).catch(() => undefined);
      await fs.promises.rename(backupPath, sessionPath).catch(() => undefined);
      await fs.promises.rm(pendingPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const updateManifestIdentity = async (manifestPath, status, projectName) => {
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    const pendingPath = `${manifestPath}.${crypto.randomUUID()}.tmp`;
    const backupPath = `${manifestPath}.${crypto.randomUUID()}.backup`;
    await fs.promises.writeFile(pendingPath, JSON.stringify({ ...manifest, projectName, status }, null, 2), 'utf8');
    await fs.promises.rename(manifestPath, backupPath);
    try {
      await fs.promises.rename(pendingPath, manifestPath);
      await fs.promises.rm(backupPath, { force: true });
    } catch (error) {
      await fs.promises.rm(manifestPath, { force: true }).catch(() => undefined);
      await fs.promises.rename(backupPath, manifestPath).catch(() => undefined);
      await fs.promises.rm(pendingPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const migrateFile = async ({ kind, sourcePath, destinationPath, status, projectName }) => {
    if (sourcePath === destinationPath) {
      if (!fs.existsSync(sourcePath)) return { kind, state: 'missing' };
      if (kind === 'reviewSession') {
        await updateReviewSessionIdentity(sourcePath, status, projectName);
        return { kind, state: 'updated' };
      }
      return { kind, state: 'missing' };
    }
    if (!fs.existsSync(sourcePath)) return { kind, state: 'missing' };
    if (fs.existsSync(destinationPath)) {
      writeLog('warn', 'Team workflow artifact migration skipped because destination exists', {
        kind, sourcePath, destinationPath,
      });
      return { kind, state: 'conflict' };
    }
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.rename(sourcePath, destinationPath);
    if (kind === 'manifest') await updateManifestIdentity(destinationPath, status, projectName);
    if (kind === 'reviewSession') await updateReviewSessionIdentity(destinationPath, status, projectName);
    return { kind, state: 'migrated' };
  };

  const migrate = async (workspaceRoot, from, to) => {
    const source = artifactPaths(workspaceRoot, from.status, from.projectName);
    const destination = artifactPaths(workspaceRoot, to.status, to.projectName);
    const results = [];
    for (const kind of Object.keys(source)) {
      try {
        results.push(await migrateFile({
          kind,
          sourcePath: source[kind],
          destinationPath: destination[kind],
          status: to.status,
          projectName: to.projectName,
        }));
      } catch (error) {
        writeLog('warn', 'Unable to migrate team workflow artifact', {
          kind,
          from,
          to,
          error: error.message || String(error),
        });
        results.push({ kind, state: 'failed', error: error.message || String(error) });
      }
    }
    return results;
  };

  return { artifactPaths, migrate };
};

module.exports = { createTeamWorkflowArtifactService };
