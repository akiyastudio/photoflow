import { useEffect, useState } from 'react';
import { BACKGROUND_TASK_DRAWER_STORAGE_KEY } from './app-shell-layout-model';

export const useSidebarWidthPersistence = (sidebarWidth: number) => {
  useEffect(() => {
    window.localStorage.setItem('photoflow:sidebar-width', String(Math.round(sidebarWidth)));
  }, [sidebarWidth]);
};

export const useBackgroundTaskDrawerWidthPersistence = (backgroundTaskDrawerWidth: number) => {
  useEffect(() => {
    window.localStorage.setItem(BACKGROUND_TASK_DRAWER_STORAGE_KEY, String(Math.round(backgroundTaskDrawerWidth)));
  }, [backgroundTaskDrawerWidth]);
};

export const useSidebarCollapsedPersistence = (sidebarCollapsed: boolean) => {
  useEffect(() => {
    window.localStorage.setItem('photoflow:sidebar-collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);
};

export const useViewportWidth = () => {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const measureViewport = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', measureViewport);
    return () => window.removeEventListener('resize', measureViewport);
  }, []);
  return viewportWidth;
};
