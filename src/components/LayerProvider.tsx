import { createContext, useCallback, useContext, useEffect, useId, useRef, type ReactNode } from 'react';

type LayerState = {
  enabled: boolean;
  onEscape: () => void;
};

type LayerRegistration = {
  id: string;
  read: () => LayerState;
};

type LayerContextValue = {
  register: (layer: LayerRegistration) => () => void;
};

const LayerContext = createContext<LayerContextValue | null>(null);

const LayerProvider = ({ children }: { children: ReactNode }) => {
  const layersRef = useRef<LayerRegistration[]>([]);

  const register = useCallback((layer: LayerRegistration) => {
    layersRef.current = [...layersRef.current.filter(item => item.id !== layer.id), layer];
    return () => {
      layersRef.current = layersRef.current.filter(item => item.id !== layer.id);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const top = layersRef.current.at(-1);
      if (!top) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const state = top.read();
      if (state.enabled) state.onEscape();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  return <LayerContext.Provider value={{ register }}>{children}</LayerContext.Provider>;
};

const useEscapeLayer = (open: boolean, onEscape: () => void, enabled = true) => {
  const context = useContext(LayerContext);
  if (!context) throw new Error('useEscapeLayer must be used inside LayerProvider');
  const id = useId();
  const stateRef = useRef<LayerState>({ enabled, onEscape });
  stateRef.current = { enabled, onEscape };

  useEffect(() => {
    if (!open) return;
    return context.register({ id, read: () => stateRef.current });
  }, [context, id, open]);
};

// Provider and hook intentionally share the same private layer registry.
// eslint-disable-next-line react-refresh/only-export-components
export { LayerProvider, useEscapeLayer };
