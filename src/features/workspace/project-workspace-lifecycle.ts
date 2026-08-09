export interface ProjectWorkspaceLifecycleIdentity {
  pageId: string;
  projectId: string;
  projectPath: string;
  projectName: string;
  projectStatus: string;
}

export type ProjectWorkspaceLifecycleAction = {
  kind: 'initialize' | 'refresh' | 'none';
  relativePath: string;
  resetNavigation: boolean;
};

export const resolveProjectWorkspaceLifecycle = (
  previous: ProjectWorkspaceLifecycleIdentity | undefined,
  next: ProjectWorkspaceLifecycleIdentity,
  currentRelativePath: string,
  initialRelativePath: string,
): ProjectWorkspaceLifecycleAction => {
  if (!previous || previous.pageId !== next.pageId || previous.projectId !== next.projectId) {
    return { kind: 'initialize', relativePath: initialRelativePath, resetNavigation: true };
  }
  const metadataChanged = previous.projectPath !== next.projectPath
    || previous.projectName !== next.projectName
    || previous.projectStatus !== next.projectStatus;
  return metadataChanged
    ? { kind: 'refresh', relativePath: currentRelativePath, resetNavigation: false }
    : { kind: 'none', relativePath: currentRelativePath, resetNavigation: false };
};
