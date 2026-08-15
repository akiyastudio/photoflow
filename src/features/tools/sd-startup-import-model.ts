import type { AppConfig, StorageDevice } from '../../types';

type SmartImportConfig = AppConfig['smartImport'];

export interface ResolvedSdDevice {
  configuredPath: string;
  mountPath: string;
  deviceId: string;
  type: 'work' | 'broll';
}

const pathKey = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();

export const resolveConfiguredSdDevices = (
  config: SmartImportConfig,
  devices: StorageDevice[],
): ResolvedSdDevice[] => {
  const configuredPaths = [...new Set(config.sdPaths?.length ? config.sdPaths : config.sdPath ? [config.sdPath] : [])];
  const deviceIds = config.sdDeviceIds || {};
  const usedDeviceIds = new Set<string>();
  return configuredPaths.flatMap(configuredPath => {
    const configuredId = deviceIds[configuredPath];
    const device = configuredId
      ? devices.find(candidate => candidate.id === configuredId)
      : devices.find(candidate => pathKey(candidate.mountPath) === pathKey(configuredPath));
    if (!device || usedDeviceIds.has(device.id)) return [];
    usedDeviceIds.add(device.id);
    return [{
      configuredPath,
      mountPath: device.mountPath,
      deviceId: device.id,
      type: config.sdDriveTypes?.[configuredPath] || config.sdDriveTypes?.[device.mountPath] || 'work',
    }];
  });
};

export const reconcileConfiguredSdDevices = (
  config: SmartImportConfig,
  devices: StorageDevice[],
): SmartImportConfig => {
  const configuredPaths = [...new Set(config.sdPaths?.length ? config.sdPaths : config.sdPath ? [config.sdPath] : [])];
  if (!configuredPaths.length || !devices.length) return config;
  const resolved = resolveConfiguredSdDevices(config, devices);
  const byConfiguredPath = new Map(resolved.map(item => [item.configuredPath, item]));
  const sdPaths: string[] = [];
  const sdDriveTypes = { ...(config.sdDriveTypes || {}) };
  const sdDeviceIds = { ...(config.sdDeviceIds || {}) };

  for (const configuredPath of configuredPaths) {
    const match = byConfiguredPath.get(configuredPath);
    const nextPath = match?.mountPath || configuredPath;
    if (!sdPaths.some(item => pathKey(item) === pathKey(nextPath))) sdPaths.push(nextPath);
    if (!match) continue;
    sdDriveTypes[nextPath] = match.type;
    sdDeviceIds[nextPath] = match.deviceId;
    if (pathKey(nextPath) !== pathKey(configuredPath)) {
      delete sdDriveTypes[configuredPath];
      delete sdDeviceIds[configuredPath];
    }
  }

  const unchanged = config.sdPath === (sdPaths[0] || '')
    && JSON.stringify(config.sdPaths || []) === JSON.stringify(sdPaths)
    && JSON.stringify(config.sdDriveTypes || {}) === JSON.stringify(sdDriveTypes)
    && JSON.stringify(config.sdDeviceIds || {}) === JSON.stringify(sdDeviceIds);
  return unchanged ? config : { ...config, sdPath: sdPaths[0] || '', sdPaths, sdDriveTypes, sdDeviceIds };
};
