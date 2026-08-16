import type { AppConfig, ConfiguredSdDevice, StorageDevice } from '../../types';

type SmartImportConfig = AppConfig['smartImport'];

export interface ResolvedSdDevice {
  configuredPath: string;
  mountPath: string;
  deviceId: string;
  type: 'work' | 'broll';
}

const pathKey = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
const uniquePaths = (paths: string[]) => paths.filter((path, index) => paths.findIndex(candidate => pathKey(candidate) === pathKey(path)) === index);
const legacySelectedPaths = (config: SmartImportConfig) => [...new Set(config.sdPaths?.length ? config.sdPaths : config.sdPath ? [config.sdPath] : [])];

export const isTrustedSdImportDevice = (device: StorageDevice) => device.identityStable === true
  && device.eligibleForSdImport === true;

export const normalizeConfiguredSdDeviceRecords = (records: ConfiguredSdDevice[] | undefined): ConfiguredSdDevice[] => {
  if (!Array.isArray(records)) return [];
  const byId = new Map<string, ConfiguredSdDevice>();
  for (const record of records) {
    const deviceId = String(record?.deviceId || '').trim();
    const lastMountPath = String(record?.lastMountPath || '').trim();
    if (!deviceId || !lastMountPath) continue;
    byId.set(deviceId, {
      deviceId,
      lastMountPath,
      type: record.type === 'broll' ? 'broll' : 'work',
      confirmedAt: Math.max(0, Number(record.confirmedAt) || 0),
      enabled: record.enabled !== false,
    });
  }
  return [...byId.values()];
};

export const migrateLegacySdDeviceRecords = (config: Pick<SmartImportConfig, 'sdPath' | 'sdPaths' | 'sdDriveTypes' | 'sdDeviceIds'>): ConfiguredSdDevice[] => {
  const ids = config.sdDeviceIds || {};
  return legacySelectedPaths(config as SmartImportConfig).flatMap(lastMountPath => {
    const deviceId = String(ids[lastMountPath] || '').trim();
    if (!deviceId) return [];
    return [{
      deviceId,
      lastMountPath,
      type: config.sdDriveTypes?.[lastMountPath] === 'broll' ? 'broll' as const : 'work' as const,
      confirmedAt: 0,
      enabled: true,
    }];
  });
};

export const normalizeSavedSdDeviceRecords = (
  records: ConfiguredSdDevice[] | undefined,
  paths: string[],
  ids: Record<string, string> | undefined,
  types: Record<string, 'work' | 'broll'> | undefined,
) => {
  const normalized = normalizeConfiguredSdDeviceRecords(records);
  if (normalized.length) return normalized;
  const byId = new Map<string, ConfiguredSdDevice>();
  for (const lastMountPath of paths) {
    const deviceId = String(ids?.[lastMountPath] || '').trim();
    if (!deviceId) continue;
    byId.set(deviceId, { deviceId, lastMountPath, type: types?.[lastMountPath] === 'broll' ? 'broll' : 'work', confirmedAt: 0, enabled: true });
  }
  return [...byId.values()];
};

const legacyUnboundPaths = (config: SmartImportConfig, records: ConfiguredSdDevice[]) => {
  const recordIds = new Set(records.map(record => record.deviceId));
  return legacySelectedPaths(config).filter(path => {
    const legacyId = config.sdDeviceIds?.[path];
    return !legacyId || !recordIds.has(legacyId);
  });
};

export const syncLegacySdMirrors = (config: SmartImportConfig, records: ConfiguredSdDevice[]): SmartImportConfig => {
  const normalizedRecords = normalizeConfiguredSdDeviceRecords(records);
  const unboundPaths = legacyUnboundPaths(config, normalizedRecords);
  const enabledRecords = normalizedRecords.filter(record => record.enabled);
  const sdPaths = uniquePaths([...enabledRecords.map(record => record.lastMountPath), ...unboundPaths]);
  const sdDriveTypes: Record<string, 'work' | 'broll'> = {};
  const sdDeviceIds: Record<string, string> = {};
  for (const path of unboundPaths) {
    sdDriveTypes[path] = config.sdDriveTypes?.[path] || 'work';
    if (config.sdDeviceIds?.[path]) sdDeviceIds[path] = config.sdDeviceIds[path];
  }
  for (const record of enabledRecords) {
    if (sdDeviceIds[record.lastMountPath]) continue;
    sdDriveTypes[record.lastMountPath] = record.type;
    sdDeviceIds[record.lastMountPath] = record.deviceId;
  }
  return {
    ...config,
    sdPath: sdPaths[0] || '',
    sdPaths,
    sdDriveTypes,
    sdDeviceIds,
    sdDevices: normalizedRecords,
  };
};

export const configuredSdSelectionPaths = (config: SmartImportConfig, devices: StorageDevice[]) => {
  const records = normalizeConfiguredSdDeviceRecords(config.sdDevices);
  const recordPaths = records.filter(record => record.enabled).map(record => (
    devices.find(device => device.id === record.deviceId)?.mountPath || record.lastMountPath
  ));
  return uniquePaths([...recordPaths, ...legacyUnboundPaths(config, records)]);
};

export const configuredSdDriveTypes = (config: SmartImportConfig, devices: StorageDevice[]) => {
  const result = { ...(config.sdDriveTypes || {}) };
  for (const record of normalizeConfiguredSdDeviceRecords(config.sdDevices)) {
    const mountPath = devices.find(device => device.id === record.deviceId)?.mountPath || record.lastMountPath;
    result[mountPath] = record.type;
  }
  return result;
};

export const upsertConfiguredSdDevice = (
  config: SmartImportConfig,
  device: StorageDevice,
  type: 'work' | 'broll',
  confirmedAt: number,
) => {
  const records = normalizeConfiguredSdDeviceRecords(config.sdDevices).map(record => {
    if (record.deviceId === device.id) return { ...record, lastMountPath: device.mountPath, type, confirmedAt, enabled: true };
    if (record.enabled && pathKey(record.lastMountPath) === pathKey(device.mountPath)) return { ...record, enabled: false };
    return record;
  });
  if (!records.some(record => record.deviceId === device.id)) {
    records.push({ deviceId: device.id, lastMountPath: device.mountPath, type, confirmedAt, enabled: true });
  }
  return syncLegacySdMirrors(config, records);
};

export const removeConfiguredSdDevice = (config: SmartImportConfig, deviceId: string) => {
  const removedPaths = Object.entries(config.sdDeviceIds || {}).filter(([, id]) => id === deviceId).map(([path]) => path);
  const sdPaths = legacySelectedPaths(config).filter(path => !removedPaths.includes(path));
  const sdDriveTypes = { ...(config.sdDriveTypes || {}) };
  const sdDeviceIds = { ...(config.sdDeviceIds || {}) };
  for (const path of removedPaths) {
    delete sdDriveTypes[path];
    delete sdDeviceIds[path];
  }
  const baseConfig = { ...config, sdPath: sdPaths[0] || '', sdPaths, sdDriveTypes, sdDeviceIds };
  return syncLegacySdMirrors(baseConfig, normalizeConfiguredSdDeviceRecords(config.sdDevices).filter(record => record.deviceId !== deviceId));
};

export const resolveConfiguredSdDevices = (
  config: SmartImportConfig,
  devices: StorageDevice[],
): ResolvedSdDevice[] => normalizeConfiguredSdDeviceRecords(config.sdDevices).flatMap(record => {
  if (!record.enabled || record.confirmedAt <= 0) return [];
  const device = devices.find(candidate => candidate.id === record.deviceId && isTrustedSdImportDevice(candidate));
  if (!device) return [];
  return [{
    configuredPath: record.lastMountPath,
    mountPath: device.mountPath,
    deviceId: device.id,
    type: record.type,
  }];
});

export const reconcileConfiguredSdDevices = (
  config: SmartImportConfig,
  devices: StorageDevice[],
): SmartImportConfig => {
  const records = normalizeConfiguredSdDeviceRecords(config.sdDevices);
  if (!records.length) return config;
  const nextRecords = records.map(record => {
    const match = devices.find(device => device.id === record.deviceId && isTrustedSdImportDevice(device));
    return match && pathKey(match.mountPath) !== pathKey(record.lastMountPath)
      ? { ...record, lastMountPath: match.mountPath }
      : record;
  });
  const nextConfig = syncLegacySdMirrors(config, nextRecords);
  return JSON.stringify(nextConfig) === JSON.stringify(config) ? config : nextConfig;
};
