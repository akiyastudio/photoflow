const ALLOWED_EVENT_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_QUEUE_ITEMS = 1000;
const MAX_PROPERTY_COUNT = 24;
const MAX_STRING_LENGTH = 160;
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

const redactSensitiveText = value => trimText(value, 64 * 1024)
  .replace(/\b[A-Z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/gi, '<local-path>')
  .replace(/\/(?:Users|home)\/[^/\s]+\/[^\s]*/gi, '<local-path>')
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
  let flushing = false;
  let previousAnalyticsEnabled = false;

  const readJson = (filePath, fallback) => {
    try {
      return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : fallback;
    } catch {
      return fallback;
    }
  };
  const writeJson = (filePath, value) => {
    try {
      fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
    } catch (error) {
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
  const readQueue = () => {
    const queue = readJson(queuePath, []);
    return Array.isArray(queue) ? queue.slice(-MAX_QUEUE_ITEMS) : [];
  };
  const saveQueue = queue => writeJson(queuePath, queue.slice(-MAX_QUEUE_ITEMS));
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
    if (!getConsent().analytics || !ALLOWED_EVENT_NAME.test(String(eventName || ''))) return false;
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
    const normalized = error instanceof Error ? error : new Error(String(error || 'Unknown error'));
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
      },
    });
    void flush();
    return true;
  };

  const postJson = async (route, body) => {
    if (!baseUrl) throw new Error('Cloud API URL is not configured');
    const controller = new AbortController();
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
      if (!response.ok) throw new Error(`Telemetry API returned ${response.status}`);
    } finally {
      clearTimeout(timeout);
    }
  };

  async function flush() {
    if (flushing || !baseUrl) return false;
    const consent = getConsent();
    const queue = readQueue().filter(item =>
      (item.kind === 'event' && consent.analytics) || (item.kind === 'crash' && consent.crashes));
    if (!queue.length) {
      saveQueue([]);
      return true;
    }

    flushing = true;
    try {
      const events = queue.filter(item => item.kind === 'event').slice(0, 50);
      if (events.length) {
        await postJson('/v1/events', { ...commonPayload(), events: events.map(item => item.payload) });
      }
      const crash = queue.find(item => item.kind === 'crash');
      if (crash) {
        await postJson('/v1/crashes', { ...commonPayload(), ...crash.payload });
      }
      const sentIds = new Set([...events.map(item => item.payload.id), crash?.payload.id].filter(Boolean));
      saveQueue(readQueue().filter(item => !sentIds.has(item?.payload?.id)));
      return true;
    } catch (error) {
      writeLog('warn', 'Telemetry upload deferred', { error: error.message || String(error) });
      return false;
    } finally {
      flushing = false;
    }
  }

  const syncConsent = telemetry => {
    const analytics = telemetry?.enabled === true;
    const crashes = telemetry?.crashReports === true;
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
    state.installId = crypto.randomUUID();
    state.createdAt = new Date().toISOString();
    writeJson(statePath, state);
    saveQueue([]);
    return true;
  };

  const start = () => {
    previousAnalyticsEnabled = false;
    syncConsent(getConfig()?.telemetry);
    timer = setInterval(() => void flush(), 30 * 1000);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    void flush();
  };

  return { start, stop, flush, track, reportCrash, syncConsent, clearLocalData, countBucket };
};

module.exports = { createTelemetryService, countBucket };
