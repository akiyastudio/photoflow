const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const createDevelopmentPythonResolver = ({ projectRoot }) => {
  let validatedFingerprint = '';
  return () => {
    const venvRoot = path.join(projectRoot, '.venv');
    const venvPython = process.platform === 'win32'
      ? path.join(venvRoot, 'Scripts', 'python.exe')
      : path.join(venvRoot, 'bin', 'python');
    const venvConfig = path.join(venvRoot, 'pyvenv.cfg');
    const venvLibrary = path.join(venvRoot, process.platform === 'win32' ? 'Lib' : 'lib');
    if (!fs.existsSync(venvPython) || !fs.existsSync(venvConfig) || !fs.existsSync(venvLibrary)) {
      validatedFingerprint = '';
      throw new Error('Python 虚拟环境不完整；请运行 npm run setup:python 后重试');
    }
    const fingerprint = [venvPython, venvConfig, venvLibrary].map(candidate => {
      const stat = fs.statSync(candidate);
      return `${stat.size}:${stat.mtimeMs}`;
    }).join('|');
    if (validatedFingerprint !== fingerprint) {
      const verifier = path.join(projectRoot, 'scripts', 'verify-python-environment.py');
      const result = spawnSync(venvPython, [verifier, '--quick'], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: { ...process.env, PYTHONUTF8: '1' },
      });
      if ((result.status ?? 1) !== 0) {
        const detail = (result.stderr || result.stdout || '').trim();
        validatedFingerprint = '';
        throw new Error(`Python 环境不完整；请运行 npm run setup:python${detail ? `\n${detail}` : ''}`);
      }
      validatedFingerprint = fingerprint;
    }
    return venvPython;
  };
};

module.exports = { createDevelopmentPythonResolver };
