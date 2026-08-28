const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MEDIA_EXTENSIONS = Object.freeze(['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'mpg', 'mpeg', 'mts', 'm2ts', 'wmv', 'flv', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma']);
const MEDIA_EXTENSION_SET = new Set(MEDIA_EXTENSIONS.map(value => `.${value}`));
const TERMINAL_STATES = new Set(['completed', 'partial_failure', 'failed', 'cancelled']);
const DEFAULT_SETTINGS = Object.freeze({ language: 'zh', model: 'large-v3', device: 'cuda', computeType: 'float16', beamSize: 5, vadFilter: true, simplifyChinese: true, cpuFallback: true });

const cleanName = value => path.basename(String(value || '').replace(/\\/g, '/')).replace(/[\x00-\x1f<>:"|?*]/g, '_').trim().slice(0, 255) || 'media';
const cleanRelativeName = value => {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(part => part && part !== '.' && part !== '..').map(cleanName);
  return parts.join('/').slice(0, 1024) || 'media';
};
const isSupportedMediaName = value => MEDIA_EXTENSION_SET.has(path.posix.extname(String(value || '').replace(/\\/g, '/')).toLowerCase());
const normalizeDialogInputs = inputs => {
  const seen = new Set();
  return (Array.isArray(inputs) ? inputs : []).flatMap(item => {
    const token = String(item?.token || '');
    const relativeName = cleanRelativeName(item?.relativeName || item?.name);
    if (!token.startsWith('component-input:v7:') && !token.startsWith('test-input:')) return [];
    if (!isSupportedMediaName(relativeName)) return [];
    const key = `${token}\0${relativeName.toLowerCase()}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ token, name: cleanName(item?.name || relativeName), relativeName }];
  });
};
const normalizeSettings = value => {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawLanguage = Object.hasOwn(input, 'language') ? input.language : DEFAULT_SETTINGS.language;
  const language = rawLanguage === null ? '' : String(rawLanguage).trim().slice(0, 16);
  const model = String(input.model ?? DEFAULT_SETTINGS.model).trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) || DEFAULT_SETTINGS.model;
  const device = ['auto', 'cpu', 'cuda'].includes(input.device) ? input.device : DEFAULT_SETTINGS.device;
  const allowedCompute = new Set(['default', 'int8', 'int8_float16', 'float16', 'float32']);
  const computeType = allowedCompute.has(input.computeType) ? input.computeType : (device === 'cpu' ? 'int8' : DEFAULT_SETTINGS.computeType);
  const beamSize = Math.min(10, Math.max(1, Number(input.beamSize) || DEFAULT_SETTINGS.beamSize));
  return { language: language === 'auto' ? null : language || null, model, device, computeType, beamSize, vadFilter: input.vadFilter !== false, simplifyChinese: input.simplifyChinese !== false, cpuFallback: input.cpuFallback !== false };
};
const redactError = value => String(value?.message || value || '未知错误')
  .replace(/[A-Za-z]:\\[^\r\n"']+/g, '[私有路径]')
  .replace(/\\\\[^\r\n"']+/g, '[私有路径]')
  .replace(/\/(?:Users|home|tmp|var|private)\/[^\r\n"']+/g, '[私有路径]')
  .split(/\r?\n/)[0].slice(0, 500);
const srtNameFor = value => cleanRelativeName(value).replace(/\.[^.\/]+$/, '') + '.srt';
const LEGACY_UNSCOPED_PROJECT = '__legacy_unscoped__';

const openDatabase = databasePath => {
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS transcript_operations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, state TEXT NOT NULL, source_kind TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0, succeeded INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, settings_json TEXT NOT NULL, error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS transcript_files (
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES transcript_operations(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, display_name TEXT NOT NULL, relative_name TEXT NOT NULL,
      source_kind TEXT NOT NULL, media_ref_json TEXT NOT NULL DEFAULT '{}', private_path TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'pending', progress REAL NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT '', srt_path TEXT NOT NULL DEFAULT '', output_json TEXT NOT NULL DEFAULT '{}',
      segment_count INTEGER NOT NULL DEFAULT 0, UNIQUE(operation_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS transcript_segments (
      id INTEGER PRIMARY KEY, file_id TEXT NOT NULL REFERENCES transcript_files(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, start REAL NOT NULL, end REAL NOT NULL, text TEXT NOT NULL,
      UNIQUE(file_id, seq)
    );
    CREATE INDEX IF NOT EXISTS transcript_segments_file ON transcript_segments(file_id, seq);
    CREATE INDEX IF NOT EXISTS transcript_files_operation ON transcript_files(operation_id, ordinal);`);
  const operationColumns = new Set(db.prepare('PRAGMA table_info(transcript_operations)').all().map(row => row.name));
  if (!operationColumns.has('project_id')) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE transcript_operations ADD COLUMN project_id TEXT NOT NULL DEFAULT '${LEGACY_UNSCOPED_PROJECT}';
      COMMIT;`);
  }
  db.exec(`UPDATE transcript_operations SET project_id='${LEGACY_UNSCOPED_PROJECT}' WHERE project_id='';
    CREATE INDEX IF NOT EXISTS transcript_operations_project_created ON transcript_operations(project_id, created_at DESC);`);
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS transcript_segments_fts USING fts5(text, content='transcript_segments', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS transcript_segments_ai AFTER INSERT ON transcript_segments BEGIN INSERT INTO transcript_segments_fts(rowid,text) VALUES(new.id,new.text); END;
      CREATE TRIGGER IF NOT EXISTS transcript_segments_ad AFTER DELETE ON transcript_segments BEGIN INSERT INTO transcript_segments_fts(transcript_segments_fts,rowid,text) VALUES('delete',old.id,old.text); END;
      CREATE TRIGGER IF NOT EXISTS transcript_segments_au AFTER UPDATE ON transcript_segments BEGIN INSERT INTO transcript_segments_fts(transcript_segments_fts,rowid,text) VALUES('delete',old.id,old.text); INSERT INTO transcript_segments_fts(rowid,text) VALUES(new.id,new.text); END;`);
  } catch { /* FTS5 is optional; LIKE remains available. */ }
  return db;
};
const publicFile = row => ({
  id: row.id, operationId: row.operation_id, ordinal: row.ordinal, displayName: row.display_name,
  relativeName: row.relative_name, sourceKind: row.source_kind, state: row.state,
  progress: Number(row.progress) || 0, error: redactError(row.error), language: row.language,
  segmentCount: Number(row.segment_count) || 0, output: JSON.parse(row.output_json || '{}'),
});
const operationSnapshot = (db, projectId, operationId, includeFiles = true) => {
  const row = db.prepare('SELECT * FROM transcript_operations WHERE id=? AND project_id=?').get(operationId, projectId);
  if (!row) return null;
  return {
    id: row.id, state: row.state, sourceKind: row.source_kind, total: row.total,
    succeeded: row.succeeded, failed: row.failed, createdAt: row.created_at, updatedAt: row.updated_at,
    error: redactError(row.error), terminal: TERMINAL_STATES.has(row.state),
    ...(includeFiles ? { files: db.prepare(`SELECT f.* FROM transcript_files f
      JOIN transcript_operations o ON o.id=f.operation_id
      WHERE f.operation_id=? AND o.project_id=? ORDER BY f.ordinal`).all(operationId, projectId).map(publicFile) } : {}),
  };
};

module.exports = { MEDIA_EXTENSIONS, MEDIA_EXTENSION_SET, TERMINAL_STATES, DEFAULT_SETTINGS, LEGACY_UNSCOPED_PROJECT, cleanName, cleanRelativeName, isSupportedMediaName, normalizeDialogInputs, normalizeSettings, redactError, srtNameFor, openDatabase, publicFile, operationSnapshot };
