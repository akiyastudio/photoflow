const transfer = require('./file-transfer-service.cjs');
const identity = require('./file-identity-service.cjs');

const createFileSystemService = ({ recycleBinService }) => ({
  ...transfer,
  ...identity,
  trash: targetPath => recycleBinService.trash(targetPath),
  restore: item => recycleBinService.restore(item),
  probeRecycleItem: item => recycleBinService.probe(item),
});

module.exports = { createFileSystemService };
