export type ToastOverlayLayout = { visible: boolean; revision: number; x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number };

type LayoutReporterOptions = {
  measure: (revision: number) => ToastOverlayLayout;
  send: (layout: ToastOverlayLayout) => void;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (timer: number) => void;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frame: number) => void;
};

export const createToastOverlayLayoutReporter = ({ measure, send, setTimer, clearTimer, requestFrame, cancelFrame }: LayoutReporterOptions) => {
  let revision = 0;
  let lastLayout = '';
  let timer = 0;
  let frame = 0;

  const cancelPending = () => {
    if (timer) clearTimer(timer);
    if (frame) cancelFrame(frame);
    timer = 0;
    frame = 0;
  };
  const reportNow = () => {
    frame = 0;
    const layout = measure(revision);
    const fingerprint = JSON.stringify(layout);
    if (fingerprint === lastLayout) return;
    lastLayout = fingerprint;
    send(layout);
  };
  const acceptSnapshot = (nextRevision: number) => {
    revision = nextRevision;
    lastLayout = '';
    cancelPending();
    // A hidden BrowserWindow may suspend animation frames. First measurement
    // and its trailing correction therefore cannot depend on RAF.
    reportNow();
    timer = setTimer(() => { timer = 0; reportNow(); }, 40);
  };
  const schedule = () => {
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = 0;
      if (frame) cancelFrame(frame);
      frame = requestFrame(reportNow);
    }, 40);
  };
  const destroy = () => cancelPending();

  return { acceptSnapshot, destroy, reportNow, schedule };
};
