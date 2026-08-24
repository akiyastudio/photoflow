/** @deprecated One-time Component Host V1 output ownership migration. */
const digestFile = (fs, crypto, filePath) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256'); const input = fs.createReadStream(filePath);
  input.on('error', reject); input.on('data', chunk => hash.update(chunk)); input.on('end', () => resolve(hash.digest('hex')));
});
const inside = (path, root, candidate) => { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative); };
const stableUuid = (crypto, value) => { const bytes = crypto.createHash('sha256').update(value).digest().subarray(0, 16); bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128; const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; };

const adoptDeprecatedV1OutputReceipt = async ({ fs, path, crypto, componentRoot, componentId, projectId, scopeDigest, projectRoot, migrationId, outputs }) => {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(String(migrationId || '')) || !Array.isArray(outputs) || !outputs.length || outputs.length > 2000) throw new Error('Invalid V1 output adoption request');
  const commitId = stableUuid(crypto, `component-output-v1-adoption\0${componentId}\0${projectId}\0${migrationId}`);
  const receiptPath = path.join(componentRoot, 'receipts', 'commits', `${commitId}.json`);
  if (fs.existsSync(receiptPath)) return JSON.parse(await fs.promises.readFile(receiptPath, 'utf8'));
  const adopted = [];
  for (const item of outputs) {
    const relativePath = String(item.relativePath || '').replace(/\\/g, '/');
    const filePath = path.resolve(projectRoot, relativePath);
    if (!relativePath || !inside(path, projectRoot, filePath)) throw new Error('V1 adopted output escapes project');
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('V1 adopted output is missing or unsafe');
    adopted.push({ artifactId: String(item.artifactId || stableUuid(crypto, `${commitId}\0${relativePath}`)), relativePath, size: stat.size, sha256: await digestFile(fs, crypto, filePath), published: true });
  }
  const receipt = { schemaVersion: 1, kind: 'component-output-commit', state: 'committed', commitId, idempotencyKey: `legacy-${migrationId}`.slice(0, 80), componentId, projectId: String(projectId), scopeDigest, stageId: stableUuid(crypto, `${commitId}\0adopted-stage`), createdAt: Date.now(), committedAt: Date.now(), adoptedFromHostApiVersion: 1, outputs: adopted };
  await fs.promises.mkdir(path.dirname(receiptPath), { recursive: true });
  const pending = `${receiptPath}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(pending, JSON.stringify(receipt, null, 2), { encoding: 'utf8', flag: 'wx' });
  try { await fs.promises.rename(pending, receiptPath); }
  catch (error) { await fs.promises.rm(pending, { force: true }).catch(() => undefined); if (!fs.existsSync(receiptPath)) throw error; return JSON.parse(await fs.promises.readFile(receiptPath, 'utf8')); }
  return receipt;
};

module.exports = { adoptDeprecatedV1OutputReceipt };
