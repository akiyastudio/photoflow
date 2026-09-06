const { randomUUID } = require('node:crypto');

const createApplicationQuitUi = ({ ipcMain, getMainWindow, timeoutMs = 30000, onStateChange = () => undefined }) => {
  let state = { phase: 'idle', revision: 0 };
  let pending = null;
  let rendererReady = false;
  const trusted = event => {
    const window = getMainWindow();
    return window && !window.isDestroyed() && event?.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame;
  };
  const publish = next => {
    state = { ...next, revision: state.revision + 1 };
    onStateChange(state);
    const window = getMainWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('application-quit:state', state);
  };
  ipcMain.handle('application-quit:state', event => {
    if (!trusted(event)) throw new Error('Unauthorized quit state sender');
    rendererReady = true;
    return state;
  });
  ipcMain.handle('application-quit:respond', (event, requestId, confirmed, errorMessage = '') => {
    if (!trusted(event)) throw new Error('Unauthorized quit response sender');
    if (!pending || pending.id !== requestId || typeof confirmed !== 'boolean' || typeof errorMessage !== 'string') return { accepted: false };
    const request = pending; pending = null; clearTimeout(request.timer);
    publish({ phase: confirmed ? 'saving' : 'idle' });
    if (errorMessage) request.reject(Object.assign(new Error(errorMessage.slice(0, 500)), { code: 'APP_QUIT_SAVE_FAILED' }));
    else request.resolve(confirmed);
    return { accepted: true };
  });
  return {
    confirmAndPrepare: tasks => {
      if (!rendererReady && !tasks.length) return Promise.resolve(true);
      if (pending) return pending.promise;
      const id = randomUUID();
      const request = { id };
      request.promise = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
      request.timer = setTimeout(() => {
        if (pending !== request) return;
        pending = null;
        request.reject(Object.assign(new Error('退出确认未收到响应，请重试。'), { code: 'APP_QUIT_UI_TIMEOUT' }));
      }, timeoutMs);
      pending = request;
      publish({ phase: 'confirming', requestId: id, tasks: tasks.map(task => ({ id: task.id, title: task.title, state: task.state, progress: task.progress })) });
      return request.promise;
    },
    setPhase: (phase, extra = {}) => publish({ phase, ...extra }),
    state: () => state,
  };
};

module.exports = { createApplicationQuitUi };
