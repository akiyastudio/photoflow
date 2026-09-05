const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
if (process.platform !== 'win32') { console.log('Skipping Windows component Job host build'); process.exit(0); }
const root = path.resolve(__dirname, '..');
const framework = ['Framework64', 'Framework'].map(name => path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', name, 'v4.0.30319')).find(value => fs.existsSync(path.join(value, 'csc.exe')));
if (!framework) throw new Error('找不到 Windows C# 编译器，无法构建组件 Job 宿主');
const output = path.join(root, 'electron', 'bin', 'component-job-host.exe'); fs.mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync(path.join(framework, 'csc.exe'), ['/nologo', '/optimize+', '/target:exe', '/platform:x64', `/out:${output}`, `/reference:${path.join(framework, 'System.Web.Extensions.dll')}`, path.join(root, 'electron', 'native', 'ComponentJobHost.cs')], { cwd: root, encoding: 'utf8', windowsHide: true });
if (result.status !== 0) throw new Error(result.stderr || result.stdout || '组件 Job 宿主构建失败');
fs.writeFileSync(`${output}.sha256`, `${crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex')}\n`, 'ascii');
console.log(`Built ${output}`);
