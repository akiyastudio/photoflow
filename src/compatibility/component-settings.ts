import type { ComponentSettingsMap } from '../types';

const LEGACY_COMPONENT_ID = 'team-retouch';
const LEGACY_SETTINGS_KEY = 'personDetection';

const isJsonObject = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value);

/** Copies the pre-component settings object into its component namespace without deleting legacy data. */
export const migrateLegacyComponentSettings = (
  config: unknown,
  settings: ComponentSettingsMap,
): ComponentSettingsMap => {
  if (!isJsonObject(config) || settings[LEGACY_COMPONENT_ID] !== undefined) return settings;
  const revisions = isJsonObject(config.componentSettingsRevisions) ? config.componentSettingsRevisions : {};
  const revision = revisions[LEGACY_COMPONENT_ID];
  if (Number.isSafeInteger(revision) && Number(revision) > 0) return settings;
  const legacySettings = config[LEGACY_SETTINGS_KEY];
  return isJsonObject(legacySettings)
    ? { ...settings, [LEGACY_COMPONENT_ID]: { ...legacySettings } }
    : settings;
};
