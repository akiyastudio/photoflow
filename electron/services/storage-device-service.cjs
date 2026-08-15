const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const normalizeMountPath = (value, platform = process.platform) => {
  const source = String(value || '').trim();
  if (!source) return '';
  if (platform === 'win32') {
    const match = source.replace(/\\/g, '/').match(/^([a-z]):(?:\/.*)?$/i);
    return match ? `${match[1].toUpperCase()}:/` : '';
  }
  return path.resolve(source);
};

const parseWindowsLogicalDisks = output => {
  const text = String(output || '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap(row => {
    const mountPath = normalizeMountPath(row?.DeviceID || row?.Name, 'win32');
    if (!mountPath) return [];
    const serial = String(row?.VolumeSerialNumber || '').trim().toUpperCase();
    const driveType = Number(row?.DriveType) || 0;
    return [{
      id: serial ? `win-volume:${serial}` : `win-path:${mountPath.toUpperCase()}`,
      mountPath,
      label: String(row?.VolumeName || row?.VolumeLabel || '').trim(),
      removable: driveType === 2,
      driveType,
    }];
  });
};

const parseWindowsVolOutput = (output, mountPath) => {
  const normalizedPath = normalizeMountPath(mountPath, 'win32');
  if (!normalizedPath) return null;
  const serial = String(output || '').match(/\b([0-9A-F]{4}-[0-9A-F]{4})\b/i)?.[1]?.toUpperCase() || '';
  return {
    id: serial ? `win-volume:${serial}` : `win-path:${normalizedPath.toUpperCase()}`,
    mountPath: normalizedPath,
    label: '',
    removable: false,
    driveType: 0,
  };
};

const collectProcessOutput = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', code => {
    if (code === 0) resolve(stdout);
    else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
  });
});

const listWindowsStorageDevices = async () => {
  const command = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); @([System.IO.DriveInfo]::GetDrives() | Select-Object Name,DriveType,VolumeLabel) | ConvertTo-Json -Compress';
  let devices;
  try {
    const output = await collectProcessOutput('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]);
    devices = parseWindowsLogicalDisks(output).filter(device => fs.existsSync(device.mountPath));
  } catch {
    const mountPaths = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => `${letter}:/`).filter(mountPath => fs.existsSync(mountPath));
    devices = mountPaths.map(mountPath => parseWindowsVolOutput('', mountPath)).filter(Boolean);
  }
  return Promise.all(devices.map(async device => {
    try {
      const output = await collectProcessOutput('cmd.exe', ['/d', '/s', '/c', 'vol', device.mountPath.slice(0, 2)]);
      const identified = parseWindowsVolOutput(output, device.mountPath);
      return { ...device, id: identified.id };
    } catch { return device; }
  }));
};

const listDarwinStorageDevices = async () => {
  const entries = await fs.promises.readdir('/Volumes', { withFileTypes: true });
  const devices = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const mountPath = path.join('/Volumes', entry.name);
    try {
      const stats = await fs.promises.stat(mountPath, { bigint: true });
      devices.push({
        id: `darwin-volume:${stats.dev.toString()}:${entry.name}`,
        mountPath,
        label: entry.name,
        removable: true,
        driveType: 2,
      });
    } catch { /* volume disappeared during enumeration */ }
  }
  return devices;
};

const listStorageDevices = async (platform = process.platform) => {
  if (platform === 'win32') return listWindowsStorageDevices();
  if (platform === 'darwin') return listDarwinStorageDevices();
  return [];
};

module.exports = {
  listStorageDevices,
  normalizeMountPath,
  parseWindowsLogicalDisks,
  parseWindowsVolOutput,
};
