const crypto = require('crypto');
const fs = require('fs');

const mapRvaToOffset = (image, peOffset, optionalHeaderOffset, rva) => {
  const sectionCount = image.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = image.readUInt16LE(peOffset + 20);
  const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
  for (let index = 0; index < sectionCount; index += 1) {
    const sectionOffset = sectionTableOffset + index * 40;
    const virtualSize = image.readUInt32LE(sectionOffset + 8);
    const virtualAddress = image.readUInt32LE(sectionOffset + 12);
    const rawSize = image.readUInt32LE(sectionOffset + 16);
    const rawOffset = image.readUInt32LE(sectionOffset + 20);
    if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) return rawOffset + rva - virtualAddress;
  }
  throw new Error(`无法定位 .NET RVA：0x${rva.toString(16)}`);
};

const readStreamName = (image, offset) => {
  let end = offset;
  while (end < image.length && image[end] !== 0) end += 1;
  if (end >= image.length) throw new Error('.NET 元数据流名称无效');
  return { name: image.toString('ascii', offset, end), nextOffset: (end + 4) & ~3 };
};

const locateMvid = image => {
  if (image.length < 0x100 || image.toString('ascii', 0, 2) !== 'MZ') throw new Error('输出文件不是有效的 PE 程序集');
  const peOffset = image.readUInt32LE(0x3c);
  if (peOffset + 24 >= image.length || image.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('输出文件缺少 PE 标头');
  const optionalHeaderOffset = peOffset + 24;
  const optionalMagic = image.readUInt16LE(optionalHeaderOffset);
  const dataDirectoryOffset = optionalHeaderOffset + (optionalMagic === 0x20b ? 112 : optionalMagic === 0x10b ? 96 : 0);
  if (!dataDirectoryOffset) throw new Error('输出文件使用了不支持的 PE 格式');
  const cliHeaderRva = image.readUInt32LE(dataDirectoryOffset + 14 * 8);
  if (!cliHeaderRva) throw new Error('输出文件不是 .NET 程序集');
  const cliHeaderOffset = mapRvaToOffset(image, peOffset, optionalHeaderOffset, cliHeaderRva);
  const metadataRva = image.readUInt32LE(cliHeaderOffset + 8);
  const metadataOffset = mapRvaToOffset(image, peOffset, optionalHeaderOffset, metadataRva);
  if (image.readUInt32LE(metadataOffset) !== 0x424a5342) throw new Error('.NET 元数据签名无效');
  const versionLength = image.readUInt32LE(metadataOffset + 12);
  let streamHeaderOffset = (metadataOffset + 16 + versionLength + 3) & ~3;
  const streamCount = image.readUInt16LE(streamHeaderOffset + 2);
  streamHeaderOffset += 4;
  const streams = new Map();
  for (let index = 0; index < streamCount; index += 1) {
    const relativeOffset = image.readUInt32LE(streamHeaderOffset);
    const size = image.readUInt32LE(streamHeaderOffset + 4);
    const parsedName = readStreamName(image, streamHeaderOffset + 8);
    streams.set(parsedName.name, { offset: metadataOffset + relativeOffset, size });
    streamHeaderOffset = parsedName.nextOffset;
  }
  const tables = streams.get('#~') || streams.get('#-');
  const guidHeap = streams.get('#GUID');
  if (!tables || !guidHeap) throw new Error('.NET 程序集缺少元数据表或 GUID 堆');
  const heapSizes = image[tables.offset + 6];
  const validMask = image.readBigUInt64LE(tables.offset + 8);
  if ((validMask & 1n) === 0n) throw new Error('.NET 程序集缺少 Module 元数据表');
  let tableDataOffset = tables.offset + 24;
  for (let table = 0; table < 64; table += 1) if ((validMask & (1n << BigInt(table))) !== 0n) tableDataOffset += 4;
  const stringIndexSize = heapSizes & 0x01 ? 4 : 2;
  const guidIndexSize = heapSizes & 0x02 ? 4 : 2;
  const mvidIndexOffset = tableDataOffset + 2 + stringIndexSize;
  const mvidIndex = guidIndexSize === 4 ? image.readUInt32LE(mvidIndexOffset) : image.readUInt16LE(mvidIndexOffset);
  if (!mvidIndex) throw new Error('.NET 程序集 MVID 无效');
  const mvidOffset = guidHeap.offset + (mvidIndex - 1) * 16;
  if (mvidOffset < guidHeap.offset || mvidOffset + 16 > guidHeap.offset + guidHeap.size) throw new Error('.NET 程序集 MVID 超出 GUID 堆');
  return { timestampOffset: peOffset + 8, mvidOffset };
};

const normalizeDotnetAssembly = filePath => {
  const image = fs.readFileSync(filePath);
  const { timestampOffset, mvidOffset } = locateMvid(image);
  image.fill(0, timestampOffset, timestampOffset + 4);
  image.fill(0, mvidOffset, mvidOffset + 16);
  const deterministicMvid = crypto.createHash('sha256').update(image).digest().subarray(0, 16);
  deterministicMvid[6] = (deterministicMvid[6] & 0x0f) | 0x40;
  deterministicMvid[8] = (deterministicMvid[8] & 0x3f) | 0x80;
  deterministicMvid.copy(image, mvidOffset);
  fs.writeFileSync(filePath, image);
  return crypto.createHash('sha256').update(image).digest('hex');
};

module.exports = { locateMvid, normalizeDotnetAssembly };

