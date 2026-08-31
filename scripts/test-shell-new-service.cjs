const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createShellNewService } = require('../electron/services/shell-new-service.cjs');

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-shell-new-'));
  try {
    const userData = path.join(root, 'user-data');
    const destinationDirectory = path.join(root, 'destination');
    const template = path.join(root, 'template.bin');
    fs.mkdirSync(userData);
    fs.mkdirSync(destinationDirectory);
    fs.writeFileSync(template, 'template-content');
    fs.writeFileSync(path.join(userData, 'shell-new-types-cache.json'), JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      types: [
        { id: '.dat', extension: '.dat', label: 'Data', method: 'data', dataBase64: Buffer.from('data-content').toString('base64') },
        { id: '.tpl', extension: '.tpl', label: 'Template', method: 'template', templatePath: template },
      ],
    }));
    const service = createShellNewService({ app: { getPath: name => name === 'userData' ? userData : root } });
    const fixedDestination = path.join(destinationDirectory, 'fixed.dat');
    const originalLink = fs.promises.link;
    fs.promises.link = async (source, destination) => {
      if (path.resolve(destination) === path.resolve(fixedDestination)) fs.writeFileSync(destination, 'concurrent placeholder');
      return originalLink(source, destination);
    };
    try {
      await assert.rejects(service.create('.dat', destinationDirectory, () => fixedDestination), error => error?.code === 'EEXIST');
    } finally { fs.promises.link = originalLink; }
    assert.equal(fs.readFileSync(fixedDestination, 'utf8'), 'concurrent placeholder', 'data publication must not clobber a concurrent destination');
    assert.equal(fs.readdirSync(destinationDirectory).some(name => name.endsWith('.photoflow-new')), false, 'failed data publication must clean its private temporary');
    const fallbackDestination = path.join(destinationDirectory, 'fallback.dat');
    const fallbackLink = fs.promises.link;
    fs.promises.link = async () => { throw Object.assign(new Error('hard links unsupported'), { code: 'EPERM' }); };
    try { await service.create('.dat', destinationDirectory, () => fallbackDestination); }
    finally { fs.promises.link = fallbackLink; }
    assert.equal(fs.readFileSync(fallbackDestination, 'utf8'), 'data-content', 'shell-new must use verified COPYFILE_EXCL fallback when hard links are unsupported');
    assert.equal(fs.readdirSync(destinationDirectory).some(name => name.endsWith('.photoflow-new')), false);
    const templateDestination = path.join(destinationDirectory, 'created.tpl');
    const created = await service.create('.tpl', destinationDirectory, () => templateDestination);
    assert.equal(created.path, templateDestination);
    assert.equal(fs.readFileSync(templateDestination, 'utf8'), 'template-content');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write('shell-new safety tests passed\n');
};

run().catch(error => { console.error(error); process.exitCode = 1; });
