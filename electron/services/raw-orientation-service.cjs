const EXIF_ORIENTATION_MATRICES = {
  1: [1, 0, 0, 1],
  2: [-1, 0, 0, 1],
  3: [-1, 0, 0, -1],
  4: [1, 0, 0, -1],
  5: [0, 1, 1, 0],
  6: [0, 1, -1, 0],
  7: [0, -1, -1, 0],
  8: [0, -1, 1, 0],
};

const createRawOrientationService = ({ exiftool, maxCacheEntries = 64 }) => {
  const cache = new Map();
  const readExifOrientation = async filePath => {
    try {
      const tags = await exiftool.readRaw(filePath, ['-G1', '-Orientation#', '-n', '-api', 'largefilesupport=1']);
      const candidates = Object.entries(tags).filter(([name, value]) => /(^|:)Orientation$/i.test(name) && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 8);
      const priority = name => /(^|:)IFD0:Orientation$/i.test(name) ? 0 : 1;
      candidates.sort(([left], [right]) => priority(left) - priority(right));
      return candidates.length ? Number(candidates[0][1]) : 1;
    } catch {
      return 1;
    }
  };
  const multiply = (left, right) => [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
  ];
  const correction = async (sourcePath, previewPath, stat) => {
    const cacheKey = `${sourcePath}|${stat.size}|${stat.mtimeMs}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const [rawOrientation, embeddedOrientation] = await Promise.all([readExifOrientation(sourcePath), readExifOrientation(previewPath)]);
    const rawMatrix = EXIF_ORIENTATION_MATRICES[rawOrientation] || EXIF_ORIENTATION_MATRICES[1];
    const embeddedMatrix = EXIF_ORIENTATION_MATRICES[embeddedOrientation] || EXIF_ORIENTATION_MATRICES[1];
    const embeddedInverse = [embeddedMatrix[0], embeddedMatrix[2], embeddedMatrix[1], embeddedMatrix[3]];
    const matrix = multiply(rawMatrix, embeddedInverse).map(value => Object.is(value, -0) ? 0 : value);
    const result = { matrix, swapsAxes: Math.abs(matrix[1]) === 1 || Math.abs(matrix[2]) === 1, rawOrientation, embeddedOrientation };
    if (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, result);
    return result;
  };
  return { correction };
};

module.exports = { createRawOrientationService };
