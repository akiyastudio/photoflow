const fs = require('fs');
const path = require('path');

const readAsciiString = (image, offset) => {
  if (offset < 0 || offset >= image.length) throw new Error('PE 字符串地址超出文件范围');
  let end = offset;
  while (end < image.length && image[end] !== 0) end += 1;
  if (end >= image.length) throw new Error('PE 字符串缺少终止符');
  return image.toString('ascii', offset, end);
};

const parsePe = image => {
  if (image.length < 0x40 || image.toString('ascii', 0, 2) !== 'MZ') throw new Error('文件不是有效的 PE 映像');
  const peOffset = image.readUInt32LE(0x3c);
  if (peOffset + 24 > image.length || image.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('文件缺少有效的 PE 标头');
  }
  const sectionCount = image.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = image.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + 24;
  const optionalMagic = image.readUInt16LE(optionalHeaderOffset);
  const dataDirectoryOffset = optionalHeaderOffset + (optionalMagic === 0x20b ? 112 : optionalMagic === 0x10b ? 96 : 0);
  if (!dataDirectoryOffset) throw new Error('PE 可选标头格式不受支持');
  const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
  if (sectionTableOffset + sectionCount * 40 > image.length) throw new Error('PE 节表超出文件范围');
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTableOffset + index * 40;
    sections.push({
      virtualSize: image.readUInt32LE(offset + 8),
      virtualAddress: image.readUInt32LE(offset + 12),
      rawSize: image.readUInt32LE(offset + 16),
      rawOffset: image.readUInt32LE(offset + 20),
    });
  }
  const rvaToOffset = rva => {
    for (const section of sections) {
      if (rva >= section.virtualAddress && rva < section.virtualAddress + Math.max(section.virtualSize, section.rawSize)) {
        const offset = section.rawOffset + rva - section.virtualAddress;
        if (offset >= image.length) break;
        return offset;
      }
    }
    throw new Error(`无法定位 PE RVA 0x${rva.toString(16)}`);
  };
  return { dataDirectoryOffset, rvaToOffset };
};

const readDescriptorNames = (image, pe, directoryIndex, descriptorSize, nameOffset) => {
  const directoryOffset = pe.dataDirectoryOffset + directoryIndex * 8;
  if (directoryOffset + 8 > image.length) return [];
  const directoryRva = image.readUInt32LE(directoryOffset);
  const directorySize = image.readUInt32LE(directoryOffset + 4);
  if (!directoryRva || !directorySize) return [];
  const start = pe.rvaToOffset(directoryRva);
  const end = Math.min(image.length, start + directorySize);
  const names = [];
  for (let offset = start; offset + descriptorSize <= end; offset += descriptorSize) {
    let empty = true;
    for (let index = 0; index < descriptorSize; index += 4) {
      if (image.readUInt32LE(offset + index) !== 0) { empty = false; break; }
    }
    if (empty) break;
    const nameRva = image.readUInt32LE(offset + nameOffset);
    if (nameRva) names.push(readAsciiString(image, pe.rvaToOffset(nameRva)));
  }
  return names;
};

function readPeDependencies(filePath) {
  const image = fs.readFileSync(filePath);
  const pe = parsePe(image);
  return [...new Set([
    ...readDescriptorNames(image, pe, 1, 20, 12),
    ...readDescriptorNames(image, pe, 13, 32, 4),
  ].map(name => name.toLowerCase()))].sort();
}

const isApiSet = name => /^(?:api|ext)-ms-win-/i.test(name);

function verifyPeDependencyClosure(root, entryNames) {
  const resolvedRoot = path.resolve(root);
  const localFiles = new Map(fs.readdirSync(resolvedRoot, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => [entry.name.toLowerCase(), path.join(resolvedRoot, entry.name)]));
  const systemRoot = path.join(process.env.WINDIR || 'C:\\Windows', 'System32');
  const queue = [...new Set(entryNames.map(name => name.toLowerCase()))];
  const visited = new Set();
  const missing = [];
  while (queue.length) {
    const name = queue.shift();
    if (visited.has(name)) continue;
    visited.add(name);
    const localPath = localFiles.get(name);
    if (!localPath) {
      if (!isApiSet(name) && !fs.existsSync(path.join(systemRoot, name))) missing.push(name);
      continue;
    }
    for (const dependency of readPeDependencies(localPath)) if (!visited.has(dependency)) queue.push(dependency);
  }
  if (missing.length) {
    throw new Error(`Windows PE 运行时缺少动态依赖：${[...new Set(missing)].sort().join(', ')}`);
  }
  return { dependencies: [...visited].sort(), localFiles: [...visited].filter(name => localFiles.has(name)).sort() };
}

module.exports = { readPeDependencies, verifyPeDependencyClosure };

