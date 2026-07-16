const { execFileSync } = require('child_process');
const { existsSync, mkdirSync } = require('fs');
const { join } = require('path');

const python = process.env.PYTHON
  || (process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python');
const outputName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const source = execFileSync(
  python,
  ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],
  { encoding: 'utf8' },
).trim();
const destination = join('python', 'dist', 'ffmpeg.zip');

if (!existsSync(source)) {
  throw new Error(`找不到 imageio-ffmpeg 提供的 FFmpeg：${source}`);
}

mkdirSync(join('python', 'dist'), { recursive: true });
execFileSync(
  python,
  [
    '-c',
    [
      'import sys, zipfile',
      'source, destination, entry = sys.argv[1:]',
      'with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:',
      '    archive.write(source, entry)',
    ].join('\n'),
    source,
    destination,
    outputName,
  ],
  { stdio: 'inherit' },
);
console.log(`已准备共享且压缩的 FFmpeg：${destination}`);
