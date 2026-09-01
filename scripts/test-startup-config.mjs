import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

globalThis.window = { navigator: { userAgent: 'Windows' } };

const compile = spawnSync(process.execPath, [
  'node_modules/typescript/bin/tsc',
  'src/features/settings/startup-config.ts',
  'src/features/app/app-config.ts',
  '--outDir', 'artifacts/startup-config-test',
  '--module', 'commonjs',
  '--target', 'es2022',
  '--esModuleInterop',
  '--skipLibCheck',
  '--lib', 'es2022,dom',
  '--jsx', 'react-jsx',
  '--moduleResolution', 'node',
], { cwd: process.cwd(), encoding: 'utf8' });
assert.equal(compile.status, 0, compile.stdout || compile.stderr || 'startup config test compilation failed');
writeFileSync('artifacts/startup-config-test/package.json', '{"type":"commonjs"}\n');
const require = createRequire(import.meta.url);
const { DEFAULT_CONFIG } = require('../artifacts/startup-config-test/features/app/app-config.js');
const { normalizeStartupConfig } = require('../artifacts/startup-config-test/features/settings/startup-config.js');

const legacy = DEFAULT_CONFIG('C:/Users/fixture');
legacy.workspacePath = ' D:/Photos ';
legacy.workspacePaths = ['d:/photos', 'E:/Archive'];
legacy.componentSettings = {
  fixture: { enabled: true },
  'research-tools': { ssimThreshold: 0.99, minDuration: 0.4 },
  'video-playback-mpv': { arrowKeyAction: 'navigate' },
  'office-media-extractor': { migrated: true },
};
legacy.smartImport.sdPath = 'F:\\DCIM';
legacy.smartImport.sdPaths = [];
legacy.smartImport.sdDriveTypes = {};
legacy.smartImport.sdDeviceIds = {};
legacy.smartImport.sdDevices = [];
legacy.smartImport.sdDriveVideoActions = {};
legacy.videoPlayback = undefined;
legacy.research = undefined;
legacy.inspirationLibrary = { rootPath: 'D:/Ideas', sensitivity: 'low' };
legacy.folderOpenMode = 'double';
legacy.fileImport = { preserveOriginal: true };
legacy.importDefaults.deleteSourceAfterImport = undefined;
legacy.homeOrder = ['inspiration'];

const result = normalizeStartupConfig(legacy);
assert.deepEqual(result.config.workspacePaths, ['D:/Photos', 'E:/Archive'], 'workspace roots retain primary-first ordering and case-insensitive deduplication');
assert.equal(result.config.workspacePath, 'D:/Photos');
assert.equal(result.config.itemOpenMode, 'double', 'legacy folder open mode is retained');
assert.equal(result.config.importDefaults.deleteSourceAfterImport, false, 'legacy preserve-original behavior is retained');
assert.deepEqual(result.config.componentSettings, { fixture: { enabled: true } }, 'adopted component namespaces are removed while unrelated component settings survive');
assert.deepEqual(result.config.research, { sensitivity: 'low', minDuration: 0.4 }, 'legacy inspiration sensitivity keeps precedence over the older threshold fallback');
assert.equal(result.config.videoPlayback.arrowKeyAction, 'navigate', 'legacy playback navigation preference is retained');
assert.deepEqual(result.config.smartImport.sdPaths, ['F:/'], 'legacy DCIM path is normalized to the drive root');
assert.deepEqual(result.config.homeOrder, ['inspiration', 'birthday', 'import'], 'missing home cards are appended in the established default order');
assert.equal(result.persistencePasses.length, 4, 'the legacy persistence sequence remains four independently evaluated compatibility passes');
assert(result.persistencePasses.some(Boolean), 'legacy input requests persistence of its normalized form');

const stable = normalizeStartupConfig(result.config);
assert.deepEqual(stable.config, result.config, 'normalization is idempotent');
assert.deepEqual(stable.persistencePasses, [false, false, false, false], 'normalized config does not trigger redundant compatibility writes');

process.stdout.write('Startup config normalization tests passed.\n');
