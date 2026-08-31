const EVENT_NAMES = Object.freeze([
  'session_start',
  'feature_opened',
  'feature_used',
  'project_created',
  'photos_imported',
  'update_checked',
  'media_preview_failed',
]);
const EVENT_NAME_SET = new Set(EVENT_NAMES);
const MAX_QUEUE_ITEMS = 1000;
const MAX_PROPERTY_COUNT = 24;
const MAX_STRING_LENGTH = 160;
const CRASH_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const NON_CRASH_MESSAGE = /(?:\[hmr\]|validateDOMNesting|Original image (?:preview|decode)|decoder failed; falling back|Failed to reload)/i;
const ALLOWED_PROPERTY_NAMES = new Set([
  'first_launch',
  'feature',
  'planning_folder',
  'count_bucket',
  'source',
  'preserve_original',
  'media_kind',
  'update_available',
  'reason',
  'exit_code',
]);

const trimText = (value, maximum = MAX_STRING_LENGTH) => String(value ?? '').slice(0, maximum);

const redactSensitiveText = (value, maximum = 64 * 1024) => String(value ?? '').slice(0, maximum)
  .replace(/\bhttps?:\/\/[^\s<>"']+/gi, match => {
    try {
      const url = new URL(match);
      const pathname = url.pathname && url.pathname !== '/' ? '/<redacted>' : url.pathname;
      return `${url.protocol}//${url.host}${pathname}${url.search || url.hash ? '?<redacted>' : ''}`;
    } catch {
      return '<url>';
    }
  })
  .replace(/\\\\[^\\\s]+\\[^\r\n"']+/g, '<local-path>')
  .replace(/\b[A-Z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/gi, '<local-path>')
  .replace(/(^|[\s("'=:\[])\/(?:[^/\r\n"'<>]+\/)*[^/\r\n"'<>]+\.[A-Za-z0-9]{1,10}(?=:\d|\s|[)\],;]|$)/gm, '$1<local-path>')
  .replace(/(^|[\s("'=:\[])\/(?!\/)(?:[^/\s"'<>]+\/)*[^/\s"'<>]+/gm, '$1<local-path>')
  .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '<email>')
  .replace(/"(projectName|fileName|folderName|path|source|destination)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"');

const sanitizeProperties = properties => {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {};
  const clean = {};
  for (const [rawKey, rawValue] of Object.entries(properties).slice(0, MAX_PROPERTY_COUNT)) {
    const key = String(rawKey).replace(/[^a-z0-9_]/gi, '_').slice(0, 40);
    if (!ALLOWED_PROPERTY_NAMES.has(key)) continue;
    if (typeof rawValue === 'boolean') clean[key] = rawValue;
    else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) clean[key] = rawValue;
    else if (typeof rawValue === 'string') clean[key] = trimText(rawValue);
  }
  return clean;
};

const countBucket = count => {
  const value = Math.max(0, Number(count) || 0);
  if (value <= 20) return '1-20';
  if (value <= 100) return '21-100';
  if (value <= 500) return '101-500';
  if (value <= 2000) return '501-2000';
  return '2001+';
};

const createTelemetryService = ({
  app,
  fs,
  path,
  crypto,
  getConfig,
  getLogDir,
  writeLog,
  apiBaseUrl,
  ingestKey,
}) => {
  const baseUrl = String(apiBaseUrl || '').replace(/\/+$/, '');
  const statePath = path.join(app.getPath('userData'), 'telemetry-state.json');
  const queuePath = path.join(app.getPath('userData'), 'telemetry-queue.json');
  const sessionId = crypto.randomUUID();
  let timer = null;
  let flushPromise = null;
  let started = false;
  let previousAnalyticsEnabled = false;
  const uploadControllers = new Map();
  const recentCrashFingerprints = new Map();

  const readJson = (filePath, fallback) => {
    try {
      return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : fallback;
    } catch {
      return fallback;
    }
  };
  const writeJson = (filePath, value) => {
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(value), 'utf8');
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch { /* best effort */ }
      writeLog('warn', 'Unable to persist telemetry state', { error: error.message || String(error) });
    }
  };

  const storedState = readJson(statePath, {});
  const state = {
    installId: typeof storedState.installId === 'string' ? storedState.installId : crypto.randomUUID(),
    createdAt: typeof storedState.createdAt === 'string' ? storedState.createdAt : new Date().toISOString(),
  };
  writeJson(statePath, state);

  const getConsent = () => {
    const telemetry = getConfig()?.telemetry || {};
    return {
      analytics: telemetry.enabled === true,
      crashes: telemetry.crashReports === true,
    };
  };
  let localQueue = (() => {
    const queue = readJson(queuePath, []);
    return Array.isArray(queue) ? queue.slice(-MAX_QUEUE_ITEMS) : [];
  })();
  const readQueue = () => localQueue.slice();
  const saveQueue = queue => {
    localQueue = queue.slice(-MAX_QUEUE_ITEMS);
    writeJson(queuePath, localQueue);
  };
  const enqueue = item => {
    const queue = readQueue();
    queue.push(item);
    saveQueue(queue);
  };

  const commonPayload = () => ({
    installId: state.installId,
    sessionId,
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  });

  const track = (eventName, properties = {}) => {
    if (!getConsent().analytics || !EVENT_NAME_SET.has(eventName)) return false;
    const now = new Date();
    enqueue({
      kind: 'event',
      payload: {
        id: crypto.randomUUID(),
        eventName,
        clientTime: now.toISOString(),
        localDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
        timezoneOffsetMin: now.getTimezoneOffset(),
        properties: sanitizeProperties(properties),
      },
    });
    if (readQueue().length >= 20) void flush();
    return true;
  };

  const readErrorLogTail = () => {
    try {
      const files = fs.readdirSync(getLogDir())
        .filter(name => /^photoflow-\d{4}-\d{2}-\d{2}\.log$/.test(name))
        .sort()
        .slice(-2);
      const text = files.map(name => fs.readFileSync(path.join(getLogDir(), name), 'utf8')).join('\n');
      const errorLines = text.split(/\r?\n/).filter(line => /\[(?:ERROR|WARN)\]/.test(line)).slice(-120).join('\n');
      return redactSensitiveText(errorLines.slice(-48 * 1024));
    } catch {
      return '';
    }
  };

  const reportCrash = (processType, error, extra = {}) => {
    if (!getConsent().crashes) return false;
    // Development errors (notably Vite HMR and React warnings) are useful in
    // the local log, but they are not release crashes and distort incidence.
    if (!app.isPackaged) return false;
    const normalized = error instanceof Error ? error : new Error(String(error || 'Unknown error'));
    if (NON_CRASH_MESSAGE.test(`${normalized.message}\n${normalized.stack || ''}`)) return false;
    const stackHead = String(normalized.stack || '').split(/\r?\n/).slice(0, 4).join('\n');
    const fingerprint = crypto.createHash('sha256')
      .update(`${processType}\0${normalized.name}\0${normalized.message}\0${stackHead}`)
      .digest('hex');
    const now = Date.now();
    for (const [key, seenAt] of recentCrashFingerprints) {
      if (now - seenAt >= CRASH_DEDUPE_WINDOW_MS) recentCrashFingerprints.delete(key);
    }
    if (recentCrashFingerprints.has(fingerprint)) return false;
    recentCrashFingerprints.set(fingerprint, now);
    enqueue({
      kind: 'crash',
      payload: {
        id: crypto.randomUUID(),
        clientTime: new Date().toISOString(),
        processType: trimText(processType, 32),
        errorName: trimText(normalized.name || 'Error', 80),
        message: redactSensitiveText(normalized.message).slice(0, 2000),
        stack: redactSensitiveText(normalized.stack || '').slice(0, 16000),
        logTail: readErrorLogTail(),
        extra: sanitizeProperties(extra),
        fingerprint,
      },
    });
    void flush();
    return true;
  };

  const submitFeedback = async message => {
    const text = String(message || '').trim();
    if (text.length < 2 || text.length > 4000) {
      return { success: false, error: '问题和建议需填写 2—4000 个字符' };
    }
    try {
      await postJson('/v1/feedback', {
        ...commonPayload(),
        id: crypto.randomUUID(),
        clientTime: new Date().toISOString(),
        message: text,
      });
      return { success: true };
    } catch (error) {
      writeLog('warn', 'Feedback submission failed', { error: error.message || String(error) });
      return { success: false, error: '发送失败，请检查网络后重试' };
    }
  };

  const postJson = async (route, body, uploadKind) => {
    if (!baseUrl) throw new Error('Cloud API URL is not configured');
    const controller = new AbortController();
    if (uploadKind) uploadControllers.set(uploadKind, controller);
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PhotoFlow-App': ingestKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`Telemetry API returned ${response.status}`);
        error.status = response.status;
        throw error;
      }
    } finally {
      clearTimeout(timeout);
      if (uploadKind && uploadControllers.get(uploadKind) === controller) uploadControllers.delete(uploadKind);
    }
  };

  const removeQueuedIds = ids => {
    const removed = new Set(ids);
    saveQueue(readQueue().filter(item => !removed.has(item?.payload?.id)));
  };
  const retryableUploadError = error => !Number.isInteger(error?.status) || error.status >= 500;
  const uploadEvents = async events => {
    if (!events.length) return;
    try {
      await postJson('/v1/events', { ...commonPayload(), events: events.map(item => item.payload) }, 'event');
      removeQueuedIds(events.map(item => item.payload.id));
    } catch (error) {
      if (retryableUploadError(error)) throw error;
      if (events.length > 1) {
        const middle = Math.ceil(events.length / 2);
        await uploadEvents(events.slice(0, middle));
        await uploadEvents(events.slice(middle));
        return;
      }
      removeQueuedIds([events[0]?.payload?.id]);
      writeLog('warn', 'Discarded rejected telemetry event', {
        eventName: events[0]?.payload?.eventName,
        status: error.status,
      });
    }
  };

  async function runFlush() {
    if (!baseUrl) return false;
    const consent = getConsent();
    const queue = readQueue().filter(item =>
      (item.kind === 'event' && consent.analytics) || (item.kind === 'crash' && consent.crashes));
    const validQueue = queue.filter(item => item.kind !== 'event' || EVENT_NAME_SET.has(item?.payload?.eventName));
    if (validQueue.length !== readQueue().length) saveQueue(validQueue);
    if (!validQueue.length) {
      saveQueue([]);
      return true;
    }

    try {
      const events = validQueue.filter(item => item.kind === 'event').slice(0, 50);
      await uploadEvents(events);
      const crash = readQueue().find(item => item.kind === 'crash' && getConsent().crashes);
      if (crash) {
        try {
          await postJson('/v1/crashes', { ...commonPayload(), ...crash.payload }, 'crash');
          removeQueuedIds([crash.payload.id]);
        } catch (error) {
          if (retryableUploadError(error)) throw error;
          removeQueuedIds([crash.payload.id]);
          writeLog('warn', 'Discarded rejected crash report', { status: error.status });
        }
      }
      return true;
    } catch (error) {
      writeLog('warn', 'Telemetry upload deferred', { error: error.message || String(error) });
      return false;
    }
  }

  function flush() {
    if (flushPromise) return flushPromise;
    flushPromise = runFlush().finally(() => { flushPromise = null; });
    return flushPromise;
  }

  const syncConsent = telemetry => {
    const analytics = telemetry?.enabled === true;
    const crashes = telemetry?.crashReports === true;
    if (!analytics) uploadControllers.get('event')?.abort();
    if (!crashes) uploadControllers.get('crash')?.abort();
    if (!analytics || !crashes) {
      saveQueue(readQueue().filter(item =>
        (item.kind === 'event' && analytics) || (item.kind === 'crash' && crashes)));
    }
    if (analytics && !previousAnalyticsEnabled) {
      track('session_start', {
        first_launch: state.createdAt === storedState.createdAt ? false : true,
      });
    }
    previousAnalyticsEnabled = analytics;
    if (analytics || crashes) void flush();
  };

  const clearLocalData = () => {
    for (const controller of uploadControllers.values()) controller.abort();
    state.installId = crypto.randomUUID();
    state.createdAt = new Date().toISOString();
    writeJson(statePath, state);
    saveQueue([]);
    return true;
  };

  const start = () => {
    if (started) return false;
    started = true;
    syncConsent(getConfig()?.telemetry);
    timer = setInterval(() => void flush(), 30 * 1000);
    return true;
  };
  const stop = () => {
    if (!started) return flush();
    started = false;
    if (timer) clearInterval(timer);
    timer = null;
    return flush();
  };

  return { start, stop, flush, track, reportCrash, submitFeedback, syncConsent, clearLocalData, countBucket };
};

module.exports = { EVENT_NAMES, createTelemetryService, countBucket, redactSensitiveText };
