const npmInvocation = ({
  platform = process.platform,
  nodeExecutable = process.execPath,
  npmCli = process.env.npm_execpath,
} = {}) => {
  if (platform !== 'win32') return { command: 'npm', argsPrefix: [] };
  if (!npmCli) throw new Error('npm_execpath is required to launch npm safely on Windows. Run packaging through npm run package:base.');
  return { command: nodeExecutable, argsPrefix: [npmCli] };
};

module.exports = { npmInvocation };
