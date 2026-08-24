const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const createDevelopmentPythonResolver = ({ projectRoot }) => {
  let validated = false;
  return () => {
    const venvPython = process.platform === 'win32'
      ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
      : path.join(projectRoot, '.venv', 'bin', 'python');
    if (!fs.existsSync(venvPython)) {
      throw new Error('Python 虚拟环境不存在；请先运行 npm run setup:python');
    }
    if (!validated) {
      const verifier = path.join(projectRoot, 'scripts', 'verify-python-environment.py');
      const result = spawnSync(venvPython, [verifier, '--quick'], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: { ...process.env, PYTHONUTF8: '1' },
      });
      if ((result.status ?? 1) !== 0) {
        const detail = (result.stderr || result.stdout || '').trim();
        throw new Error(`Python 环境不完整；请运行 npm run setup:python${detail ? `\n${detail}` : ''}`);
      }
      validated = true;
    }
    return venvPython;
  };
};

module.exports = { createDevelopmentPythonResolver };
