const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const CONTENT_TYPES = new Map([
  ['.avi', 'video/x-msvideo'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.m4v', 'video/mp4'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.mp4', 'video/mp4'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
]);

const parseByteRange = (rangeHeader, fileSize) => {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2]) || fileSize <= 0) return undefined;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined;
    return { start: Math.max(0, fileSize - suffixLength), end: fileSize - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : fileSize - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= fileSize || requestedEnd < start) return undefined;
  return { start, end: Math.min(requestedEnd, fileSize - 1) };
};

const createMediaFileResponse = async (filePath, request) => {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return new Response('Not found', { status: 404 });

  const method = String(request.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });

  const rangeHeader = request.headers.get('range');
  const range = parseByteRange(rangeHeader, stat.size);
  const commonHeaders = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Content-Type': CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
  };

  if (rangeHeader && !range) {
    return new Response(null, { status: 416, headers: { ...commonHeaders, 'Content-Range': `bytes */${stat.size}` } });
  }

  if (range) {
    const contentLength = range.end - range.start + 1;
    const body = method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(filePath, range));
    return new Response(body, {
      status: 206,
      headers: {
        ...commonHeaders,
        'Content-Length': String(contentLength),
        'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
      },
    });
  }

  const body = method === 'HEAD' || stat.size === 0 ? null : Readable.toWeb(fs.createReadStream(filePath));
  return new Response(body, { status: 200, headers: { ...commonHeaders, 'Content-Length': String(stat.size) } });
};

module.exports = { createMediaFileResponse, parseByteRange };
