const cleanupImportArtifacts = async ({
  fs,
  virtualPaths,
  targets = [],
  managedLinks = [],
  preserveManagedLinks = false,
  cleanupErrors = [],
  writeLog = () => undefined,
  logLabel = 'import',
}) => {
  const managedPaths = new Set(managedLinks.map(item => item.shortcutPath));
  for (const target of [...new Set(targets.filter(Boolean))]) {
    if (preserveManagedLinks && managedPaths.has(target)) continue;
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
      if (fs.existsSync(target)) throw new Error('清理后目标仍然存在');
    } catch (error) {
      cleanupErrors.push({ path: target, error: error.message || String(error) });
      writeLog('error', `Unable to remove failed ${logLabel} target`, { path: target, error: error.message || String(error) });
    }
  }
  const removedLinkIds = managedLinks.filter(item => !fs.existsSync(item.shortcutPath)).map(item => item.linkId);
  if (removedLinkIds.length) {
    try { virtualPaths.revokeManagedExternalLinkIds(removedLinkIds); }
    catch (error) {
      cleanupErrors.push({ path: 'managed-external-link-registry', error: error.message || String(error) });
      writeLog('error', `Unable to revoke removed ${logLabel} identities`, error);
    }
  }
  const leftoverPaths = [...new Set(targets.filter(target => target && fs.existsSync(target)))];
  return {
    cleanupErrors,
    leftoverPaths,
    preserveManagedLinks: preserveManagedLinks || managedLinks.some(item => fs.existsSync(item.shortcutPath)),
  };
};

module.exports = { cleanupImportArtifacts };
