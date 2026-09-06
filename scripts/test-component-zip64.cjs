const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { uint64, zip64Extra, directoryLocation, componentInstallTimeoutMs } = require('../electron/component-zip64.cjs');
const { inspectComponentArchive, extractComponentArchive } = require('../electron/component-package-archive.cjs');
const { writeZip } = require('./test-helpers/zip-fixture.cjs');
const crc32 = value => { let crc = 0xffffffff; for (const byte of value) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
const extra64 = values => { const result = Buffer.alloc(4 + values.length * 8); result.writeUInt16LE(1); result.writeUInt16LE(values.length * 8, 2); values.forEach((value, index) => result.writeBigUInt64LE(BigInt(value), 4 + index * 8)); return result; };
const makeZip64 = (target, entries, descriptorMode) => {
  let offset = 0; const data = []; const directory = [];
  for (const [name, value] of entries) {
    const raw = Buffer.from(value); const encodedName = Buffer.from(name); const crc = crc32(raw); const flags = 0x0800 | (descriptorMode ? 8 : 0);
    const localExtra = extra64(descriptorMode ? [0, 0] : [raw.length, raw.length]);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(45, 4); local.writeUInt16LE(flags, 6); local.writeUInt32LE(descriptorMode ? 0 : crc, 14); local.writeUInt32LE(0xffffffff, 18); local.writeUInt32LE(0xffffffff, 22); local.writeUInt16LE(encodedName.length, 26); local.writeUInt16LE(localExtra.length, 28);
    const descriptor = descriptorMode ? Buffer.alloc(descriptorMode === 'signed' ? 24 : 20) : Buffer.alloc(0);
    if (descriptorMode) { const start = descriptorMode === 'signed' ? 4 : 0; if (start) descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, start); descriptor.writeBigUInt64LE(BigInt(raw.length), start + 4); descriptor.writeBigUInt64LE(BigInt(raw.length), start + 12); }
    const centralExtra = extra64([raw.length, raw.length, offset]);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(45, 4); central.writeUInt16LE(45, 6); central.writeUInt16LE(flags, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(0xffffffff, 20); central.writeUInt32LE(0xffffffff, 24); central.writeUInt16LE(encodedName.length, 28); central.writeUInt16LE(centralExtra.length, 30); central.writeUInt32LE(0xffffffff, 42);
    data.push(local, encodedName, localExtra, raw, descriptor); directory.push(central, encodedName, centralExtra); offset += local.length + encodedName.length + localExtra.length + raw.length + descriptor.length;
  }
  const central = Buffer.concat(directory); const end64 = Buffer.alloc(56); end64.writeUInt32LE(0x06064b50); end64.writeBigUInt64LE(44n, 4); end64.writeUInt16LE(45, 12); end64.writeUInt16LE(45, 14); end64.writeBigUInt64LE(BigInt(entries.length), 24); end64.writeBigUInt64LE(BigInt(entries.length), 32); end64.writeBigUInt64LE(BigInt(central.length), 40); end64.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(offset + central.length), 8); locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10); end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
  fs.writeFileSync(target, Buffer.concat([...data, central, end64, locator, end]));
};
async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'photoflow-zip64-'));
  try {
    const archive = path.join(root, 'wide.zip');
    const manifest = JSON.stringify({ apiVersion: 1, id: 'wide', version: '1', entrypoints: { default: 'worker.cjs' }, requiredFiles: ['worker.cjs'] });
    for (const mode of [false, 'signed', 'unsigned']) {
      makeZip64(archive, [['pkg/component.json', manifest], ['pkg/worker.cjs', 'module.exports=true;']], mode);
      const inspected = inspectComponentArchive(archive);
      const result = await extractComponentArchive(inspected, path.join(root, String(mode)));
      assert.equal(result.manifest.id, 'wide');
      assert.equal(fs.readFileSync(path.join(root, String(mode), 'pkg/worker.cjs'), 'utf8'), 'module.exports=true;');
    }
    const wide = Buffer.alloc(8); wide.writeBigUInt64LE(5n * 1024n ** 3n); assert.equal(uint64(wide, 0), 5 * 1024 ** 3);
    wide.writeBigUInt64LE(2n ** 53n); assert.throws(() => uint64(wide, 0), /安全整数/);
    assert.throws(() => zip64Extra(Buffer.concat([extra64([1]), extra64([1])]), ['size']), /重复/);
    assert.throws(() => zip64Extra(extra64([1]), ['size', 'offset']), /长度/);
    const virtualEnd = 5 * 1024 ** 3; const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(virtualEnd - 76), 8); locator.writeUInt32LE(1, 16);
    const record = Buffer.alloc(56); record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 14); record.writeBigUInt64LE(1n, 24); record.writeBigUInt64LE(1n, 32); record.writeBigUInt64LE(100n, 40); record.writeBigUInt64LE(BigInt(virtualEnd - 176), 48);
    const tail = Buffer.alloc(22); tail.writeUInt16LE(0xffff, 8); tail.writeUInt16LE(0xffff, 10); tail.writeUInt32LE(0xffffffff, 12); tail.writeUInt32LE(0xffffffff, 16);
    const read = (_fd, length, position) => { assert([virtualEnd - 20, virtualEnd - 76].includes(position)); return length === 20 ? locator : record; };
    assert.equal(directoryLocation(0, read, tail, 0, virtualEnd, { maxEntries: 10000, maxDirectoryBytes: 32 * 1024 ** 2 }).offset, virtualEnd - 176);
    locator.writeUInt32LE(2, 16); assert.throws(() => directoryLocation(0, read, tail, 0, virtualEnd, { maxEntries: 10000, maxDirectoryBytes: 32 * 1024 ** 2 }), /多卷/);
    writeZip(archive, [['component.json', manifest], ['bomb.bin', Buffer.alloc(1024 * 1024), { method: 8 }]]);
    assert.throws(() => inspectComponentArchive(archive), /压缩倍率/);
    assert.equal(componentInstallTimeoutMs(300 * 1024 ** 2), 5 * 60 * 1000);
    assert(componentInstallTimeoutMs(8 * 1024 ** 3, 9 * 1024 ** 3) > 5 * 60 * 1000);
    console.log('Component ZIP64 metadata, descriptors, extraction, overflow, bomb and timeout tests passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = run;
