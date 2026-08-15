import { useEffect, useRef, useState } from 'react';

export const useStartupSdAutoImport = ({
  enabledAtLaunch,
  ready,
  onStart,
}: {
  enabledAtLaunch: boolean;
  ready: boolean;
  onStart: () => void;
}) => {
  const handledRef = useRef(false);
  const [request, setRequest] = useState(0);
  useEffect(() => {
    if (!ready || handledRef.current) return;
    handledRef.current = true;
    if (!enabledAtLaunch) return;
    onStart();
    setRequest(value => value + 1);
  }, [enabledAtLaunch, onStart, ready]);
  return request;
};
