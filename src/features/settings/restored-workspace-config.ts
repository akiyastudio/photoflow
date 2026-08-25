import type { AppConfig } from '../../types';

const restoredWorkspacePaths = (workspacePath: string, values: string[]) => [workspacePath, ...values]
  .map(value => String(value || '').trim()).filter(Boolean)
  .filter((value, index, entries) => entries.findIndex(candidate => candidate.replace(/\\/g, '/').toLocaleLowerCase() === value.replace(/\\/g, '/').toLocaleLowerCase()) === index);

export const restoredWorkspaceConfig = (savedConfig: AppConfig, workspacePath: string): AppConfig => ({
  ...savedConfig,
  workspacePath,
  workspacePaths: restoredWorkspacePaths(workspacePath, [...(savedConfig.workspacePaths || []), workspacePath]),
});

