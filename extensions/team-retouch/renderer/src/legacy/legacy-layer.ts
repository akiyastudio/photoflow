import { useEffect } from 'react';
export const useEscapeLayer = (active: boolean, close: () => void) => useEffect(() => {
  if (!active) return;
  const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
  window.addEventListener('keydown', listener);
  return () => window.removeEventListener('keydown', listener);
}, [active, close]);
