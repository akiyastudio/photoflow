import { useRef, useState } from 'react';
import type { BrowserPageInstance } from './workspace-tab-model';

type InspirationPageDraft = Omit<BrowserPageInstance, 'id'>;

export const useFolderTabNavigation = ({
  rootPath,
  pages,
  activePageId,
  createPage,
  requestInspirationPath,
  activateInspiration,
}: {
  rootPath: string;
  pages: BrowserPageInstance[];
  activePageId: string | null;
  createPage: (page: InspirationPageDraft) => string;
  requestInspirationPath: (rootPath: string, relativePath: string) => void;
  activateInspiration: () => void;
}) => {
  const [navigationRequests, setNavigationRequests] = useState<Record<string, { path: string; id: number }>>({});
  const navigationRequestIdRef = useRef(0);

  const openInNewTab = (relativePath: string) => {
    createPage({ kind: 'inspiration', projectId: `inspiration:${rootPath}`, project: null, inspirationRootPath: rootPath, currentRelativePath: relativePath, initialRelativePath: relativePath, operation: null });
    activateInspiration();
  };
  const navigateCurrent = (relativePath: string) => {
    const activePage = pages.find(page => page.id === activePageId && page.kind === 'inspiration');
    if (activePage) {
      const id = ++navigationRequestIdRef.current;
      setNavigationRequests(current => ({ ...current, [activePage.id]: { path: relativePath, id } }));
    } else requestInspirationPath(rootPath, relativePath);
    activateInspiration();
  };
  return { navigationRequests, openInNewTab, navigateCurrent };
};
