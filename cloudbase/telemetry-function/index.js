import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cloudbase from '@cloudbase/js-sdk';

// CloudBase HTTP cloud functions must listen on port 9000.
const PORT = Number(process.env.PORT || 9000);
const ENV_ID = process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV_ID || '';
const INGEST_KEY = process.env.PHOTOFLOW_INGEST_KEY || 'photoflow-desktop-v1';
const ADMIN_TOKEN = process.env.PHOTOFLOW_ADMIN_TOKEN || '';
const ADMIN_ASSETS_DIR = fileURLToPath(new URL('./admin', import.meta.url));
const EVENT_NAMES = new Set([
  'session_start',
  'feature_opened',
  'feature_used',
  'project_created',
  'photos_imported',
  'update_checked',
  'media_preview_failed',
]);
const COUNT_BUCKETS = new Set(['1-20', '21-100', '101-500', '501-2000', '2001+']);
const PLATFORMS = new Set(['win32', 'darwin', 'linux']);
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

if (!ENV_ID) {
  console.error('CLOUDBASE_ENV_ID or TCB_ENV_ID must be configured');
  process.exit(1);
}

const tcb = cloudbase.init({ env: ENV_ID, timeout: 10000 });
const db = tcb.database();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '128kb', strict: true }));

app.use('/admin', (_request, response, next) => {
  response.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
});
app.use('/admin', express.static(ADMIN_ASSETS_DIR, {
  etag: false,
  index: 'index.html',
  maxAge: 0,
}));

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
const validIsoTime = value => {
  const date = new Date(value);
  const time = date.getTime();
  return Number.isFinite(time)
    && time >= Date.now() - 30 * 24 * 60 * 60 * 1000
    && time <= Date.now() + 24 * 60 * 60 * 1000;
};
const validLocalDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const safeText = (value, max) => String(value ?? '').slice(0, max);
const validSha256 = value => /^[a-f0-9]{64}$/i.test(String(value || ''));
const validHttpsUrl = value => {
  try { return new URL(String(value || '')).protocol === 'https:'; }
  catch { return false; }
};
const validReleaseArtifact = release => validHttpsUrl(release.downloadUrl)
  && validSha256(release.sha256);
const redactText = (value, max) => safeText(value, max)
  .replace(/\b[A-Z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/gi, '<local-path>')
  .replace(/\/(?:Users|home)\/[^/\s]+\/[^\s]*/gi, '<local-path>')
  .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '<email>')
  .replace(/"(projectName|fileName|folderName|path|source|destination)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"');
const safeProperties = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 24).flatMap(([rawKey, rawValue]) => {
    const key = String(rawKey).replace(/[^a-z0-9_]/gi, '_').slice(0, 40);
    if (!ALLOWED_PROPERTY_NAMES.has(key)) return [];
    if (typeof rawValue === 'boolean') return [[key, rawValue]];
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return [[key, rawValue]];
    if (typeof rawValue === 'string') return [[key, rawValue.slice(0, 160)]];
    return [];
  }));
};
const compareVersions = (left, right) => {
  const a = String(left || '').split('.').map(Number);
  const b = String(right || '').split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length, 3); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
};
const databaseRows = (result, operation) => {
  const candidates = [result?.data, result?.data?.data, result?.data?.records, result?.records];
  const rows = candidates.find(Array.isArray);
  if (rows) return rows;
  console.error(`Unexpected database response for ${operation}`, JSON.stringify(result).slice(0, 2000));
  throw new TypeError('unexpected_database_response');
};
const assertDatabaseWrite = (result, operation) => {
  const code = result?.code || result?.data?.code;
  if (!code) return result;
  console.error(`Database write failed for ${operation}`, JSON.stringify(result).slice(0, 2000));
  throw new Error(`database_write_failed:${code}`);
};

const rateBuckets = new Map();
const rateLimit = (limit, windowMs) => (request, response, next) => {
  const now = Date.now();
  const key = sha256(`${request.ip}|${request.get('x-photoflow-app') || ''}`);
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return next();
  }
  current.count += 1;
  if (current.count > limit) return response.status(429).json({ error: 'rate_limited' });
  next();
};

const requireApp = (request, response, next) => {
  if (request.get('x-photoflow-app') !== INGEST_KEY) return response.status(403).json({ error: 'invalid_app' });
  next();
};
const requireAdmin = (request, response, next) => {
  const token = request.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!ADMIN_TOKEN || token.length !== ADMIN_TOKEN.length
    || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN))) {
    return response.status(401).json({ error: 'unauthorized' });
  }
  next();
};

const validateClient = body => {
  if (!isUuid(body.installId) || !isUuid(body.sessionId)) return 'invalid_identity';
  if (!/^\d+(?:\.\d+){1,3}$/.test(String(body.appVersion || ''))) return 'invalid_version';
  if (!PLATFORMS.has(body.platform)) return 'invalid_platform';
  return '';
};

app.get('/health', (_request, response) => response.json({
  ok: true,
  service: 'photoflow-telemetry-api',
  build: '2026-07-30.1',
  databaseInstance: 'default',
}));

app.post('/v1/events', requireApp, rateLimit(120, 60_000), async (request, response, next) => {
  try {
    const body = request.body || {};
    const clientError = validateClient(body);
    if (clientError) return response.status(400).json({ error: clientError });
    if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 50) {
      return response.status(400).json({ error: 'invalid_events' });
    }

    const installHash = sha256(body.installId);
    const records = [];
    for (const event of body.events) {
      if (!isUuid(event.id) || !EVENT_NAMES.has(event.eventName) || !validIsoTime(event.clientTime)) {
        return response.status(400).json({ error: 'invalid_event' });
      }
      if (!validLocalDate(event.localDate)) return response.status(400).json({ error: 'invalid_local_date' });
      const properties = safeProperties(event.properties);
      if (properties.count_bucket && !COUNT_BUCKETS.has(properties.count_bucket)) {
        return response.status(400).json({ error: 'invalid_count_bucket' });
      }
      records.push({
        _id: event.id,
        eventName: event.eventName,
        installHash,
        sessionId: event.sessionId || body.sessionId,
        appVersion: body.appVersion,
        platform: body.platform,
        arch: safeText(body.arch, 24),
        clientTime: event.clientTime,
        localDate: event.localDate,
        timezoneOffsetMin: Math.max(-840, Math.min(840, Number(event.timezoneOffsetMin) || 0)),
        receivedAt: new Date().toISOString(),
        properties,
      });
    }

    await Promise.all(records.map(async record => {
      const { _id: documentId, ...data } = record;
      const result = await db.collection('analytics_events').doc(documentId).set(data);
      return assertDatabaseWrite(result, 'analytics_events.set');
    }));
    response.status(202).json({ accepted: records.length });
  } catch (error) {
    next(error);
  }
});

app.post('/v1/crashes', requireApp, rateLimit(20, 60_000), async (request, response, next) => {
  try {
    const body = request.body || {};
    const clientError = validateClient(body);
    if (clientError || !isUuid(body.id) || !validIsoTime(body.clientTime)) {
      return response.status(400).json({ error: clientError || 'invalid_crash' });
    }
    const result = await db.collection('crash_reports').doc(body.id).set({
      installHash: sha256(body.installId),
      sessionId: body.sessionId,
      appVersion: body.appVersion,
      platform: body.platform,
      arch: safeText(body.arch, 24),
      clientTime: body.clientTime,
      receivedAt: new Date().toISOString(),
      processType: safeText(body.processType, 32),
      errorName: safeText(body.errorName, 80),
      message: redactText(body.message, 2000),
      stack: redactText(body.stack, 16000),
      logTail: redactText(body.logTail, 48 * 1024),
      extra: safeProperties(body.extra),
      fingerprint: validSha256(body.fingerprint) ? body.fingerprint.toLowerCase() : '',
      status: 'new',
    });
    assertDatabaseWrite(result, 'crash_reports.set');
    response.status(202).json({ accepted: true, crashId: body.id });
  } catch (error) {
    next(error);
  }
});

app.post('/v1/feedback', requireApp, rateLimit(10, 60_000), async (request, response, next) => {
  try {
    const body = request.body || {};
    const clientError = validateClient(body);
    const message = safeText(body.message, 4001).trim();
    if (clientError || !isUuid(body.id) || !validIsoTime(body.clientTime)) {
      return response.status(400).json({ error: clientError || 'invalid_feedback' });
    }
    if (message.length < 2 || message.length > 4000) {
      return response.status(400).json({ error: 'invalid_message' });
    }
    const result = await db.collection('user_feedback').doc(body.id).set({
      installHash: sha256(body.installId),
      appVersion: body.appVersion,
      platform: body.platform,
      arch: safeText(body.arch, 24),
      clientTime: body.clientTime,
      receivedAt: new Date().toISOString(),
      message,
      status: 'new',
    });
    assertDatabaseWrite(result, 'user_feedback.set');
    response.status(202).json({ accepted: true });
  } catch (error) {
    next(error);
  }
});

app.get('/v1/updates', rateLimit(120, 60_000), async (request, response, next) => {
  try {
    const platform = PLATFORMS.has(request.query.platform) ? request.query.platform : 'win32';
    const channel = request.query.channel === 'beta' ? 'beta' : 'stable';
    const currentVersion = safeText(request.query.currentVersion, 32);
    // Release records are few. Filtering here avoids requiring a compound index
    // for platform + channel + published + versionCode on a fresh environment.
    const result = await db.collection('app_releases').limit(100).get();
    const releases = databaseRows(result, 'app_releases.get')
      .filter(item => item.platform === platform && item.channel === channel && item.published === true && validReleaseArtifact(item));
    const release = releases
      .sort((left, right) => Number(right.versionCode || 0) - Number(left.versionCode || 0))[0];
    if (!release) return response.status(404).json({ error: 'release_not_found' });
    response.json({
      currentVersion,
      latestVersion: release.version,
      updateAvailable: compareVersions(release.version, currentVersion) > 0,
      downloadUrl: release.downloadUrl,
      sha256: release.sha256 || '',
      notes: release.notes || '',
      mandatory: release.mandatory === true,
      publishedAt: release.publishedAt || '',
    });
  } catch (error) {
    next(error);
  }
});

const loadEvents = async maximum => {
  const pageSize = 100;
  const records = [];
  for (let offset = 0; offset < maximum; offset += pageSize) {
    const page = await db.collection('analytics_events')
      .orderBy('clientTime', 'desc')
      .skip(offset)
      .limit(pageSize)
      .get();
    const batch = databaseRows(page, 'analytics_events.get');
    records.push(...batch);
    if (batch.length < pageSize) break;
  }
  return records;
};

const loadCrashes = async maximum => {
  const pageSize = 100;
  const records = [];
  for (let offset = 0; offset < maximum; offset += pageSize) {
    const page = await db.collection('crash_reports')
      .orderBy('clientTime', 'desc')
      .skip(offset)
      .limit(pageSize)
      .get();
    const batch = databaseRows(page, 'crash_reports.get');
    records.push(...batch);
    if (batch.length < pageSize) break;
  }
  return records;
};

const loadFeedback = async maximum => {
  const pageSize = 100;
  const records = [];
  for (let offset = 0; offset < maximum; offset += pageSize) {
    const page = await db.collection('user_feedback')
      .orderBy('receivedAt', 'desc')
      .skip(offset)
      .limit(pageSize)
      .get();
    const batch = databaseRows(page, 'user_feedback.get');
    records.push(...batch);
    if (batch.length < pageSize) break;
  }
  return records;
};

// Prefer this endpoint over the CloudBase console's line-oriented database
// export. Express serializes the array as strict UTF-8 JSON, including Windows
// paths and non-ASCII log content.
app.get('/v1/admin/crashes-export', rateLimit(10, 60_000), requireAdmin, async (request, response, next) => {
  try {
    const maximum = Math.min(10_000, Math.max(1, Number(request.query.limit) || 10_000));
    const crashes = await loadCrashes(maximum);
    response.set({
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="photoflow-crashes-${new Date().toISOString().slice(0, 10)}.json"`,
    });
    response.send(JSON.stringify(crashes));
  } catch (error) {
    next(error);
  }
});

const countBy = (records, valueFor) => Object.entries(records.reduce((counts, record) => {
  const value = safeText(valueFor(record) || 'unknown', 160) || 'unknown';
  counts[value] = (counts[value] || 0) + 1;
  return counts;
}, {})).sort((left, right) => right[1] - left[1]).map(([value, count]) => ({ value, count }));

app.get('/v1/admin/metrics', (_request, response, next) => {
  response.set('Cache-Control', 'no-store');
  next();
}, rateLimit(30, 60_000), requireAdmin, async (request, response, next) => {
  try {
    const days = Math.min(90, Math.max(7, Number(request.query.days) || 30));
    const [allEvents, allCrashes, allFeedback] = await Promise.all([loadEvents(50_000), loadCrashes(10_000), loadFeedback(10_000)]);
    const cutoff = Date.now() - days * 86_400_000;
    const events = allEvents.filter(event => new Date(event.clientTime).getTime() >= cutoff);
    const crashes = allCrashes.filter(crash => new Date(crash.clientTime).getTime() >= cutoff);
    const feedback = allFeedback.filter(item => new Date(item.clientTime).getTime() >= cutoff);
    const sessions = events.filter(event => event.eventName === 'session_start');
    const activeByDate = new Map();
    const firstSeen = new Map();
    for (const event of allEvents) {
      const date = validLocalDate(event.localDate) ? event.localDate : String(event.clientTime).slice(0, 10);
      const previous = firstSeen.get(event.installHash);
      if (!previous || date < previous) firstSeen.set(event.installHash, date);
      if (event.eventName === 'session_start' && new Date(event.clientTime).getTime() >= cutoff) {
        if (!activeByDate.has(date)) activeByDate.set(date, new Set());
        activeByDate.get(date).add(event.installHash);
      }
    }
    const activeDatesByInstall = new Map();
    for (const event of allEvents.filter(item => item.eventName === 'session_start')) {
      if (!activeDatesByInstall.has(event.installHash)) activeDatesByInstall.set(event.installHash, new Set());
      activeDatesByInstall.get(event.installHash).add(validLocalDate(event.localDate) ? event.localDate : String(event.clientTime).slice(0, 10));
    }
    const retained = offset => {
      let cohort = 0;
      let returned = 0;
      for (const [installHash, date] of firstSeen) {
        const first = new Date(`${date}T00:00:00Z`);
        if (first.getTime() < cutoff || first.getTime() > Date.now() - offset * 86_400_000) continue;
        cohort += 1;
        const target = new Date(first.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
        if (activeDatesByInstall.get(installHash)?.has(target)) returned += 1;
      }
      return { cohort, returned, rate: cohort ? Number((returned / cohort).toFixed(4)) : 0 };
    };
    const featureCounts = {};
    for (const event of events) {
      if (event.eventName !== 'feature_opened' && event.eventName !== 'feature_used') continue;
      const feature = event.properties?.feature || 'unknown';
      featureCounts[feature] = (featureCounts[feature] || 0) + 1;
    }
    const importBuckets = {};
    for (const event of events) {
      if (event.eventName !== 'photos_imported') continue;
      const bucket = event.properties?.count_bucket || 'unknown';
      importBuckets[bucket] = (importBuckets[bucket] || 0) + 1;
    }
    const updateChecks = events.filter(event => event.eventName === 'update_checked');
    response.json({
      windowDays: days,
      generatedAt: new Date().toISOString(),
      truncated: allEvents.length >= 50_000 || allCrashes.length >= 10_000 || allFeedback.length >= 10_000,
      activationCount: [...firstSeen.values()].filter(date => new Date(`${date}T00:00:00Z`).getTime() >= cutoff).length,
      activeInstallations: new Set(sessions.map(event => event.installHash)).size,
      projectCreationCount: events.filter(event => event.eventName === 'project_created').length,
      dailyActive: [...activeByDate.entries()].sort().map(([date, installs]) => ({ date, count: installs.size })),
      retention: { d1: retained(1), d7: retained(7), d30: retained(30) },
      highFrequencyFeatures: Object.entries(featureCounts).sort((a, b) => b[1] - a[1]).map(([feature, count]) => ({ feature, count })),
      importCountBuckets: importBuckets,
      updateChecks: {
        total: updateChecks.length,
        updateAvailable: updateChecks.filter(event => event.properties?.update_available === true).length,
      },
      crashes: {
        total: crashes.length,
        affectedInstallations: new Set(crashes.map(crash => crash.installHash)).size,
        byProcessType: countBy(crashes, crash => crash.processType),
        byErrorName: countBy(crashes, crash => crash.errorName),
        byAppVersion: countBy(crashes, crash => crash.appVersion),
      },
      feedback: {
        total: feedback.length,
        newCount: feedback.filter(item => String(item.status || 'new') === 'new').length,
        byAppVersion: countBy(feedback, item => item.appVersion),
        recent: feedback.slice(0, 30).map(item => ({
          id: safeText(item._id, 80),
          message: safeText(item.message, 4000),
          appVersion: safeText(item.appVersion, 32),
          platform: safeText(item.platform, 24),
          clientTime: safeText(item.clientTime, 40),
          receivedAt: safeText(item.receivedAt, 40),
          status: safeText(item.status || 'new', 24),
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'internal_error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PhotoFlow HTTP cloud function listening on ${PORT}`);
});
