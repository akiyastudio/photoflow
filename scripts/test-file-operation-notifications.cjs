const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const modelPath = path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'file-operation-notification-model.ts');
  const { pageOwnsFileOperationNotification } = await import(pathToFileURL(modelPath).href);

  assert.strictEqual(pageOwnsFileOperationNotification({ taskNotificationOwned: true }), false,
    'a visible progress/result task owns its terminal notification');
  assert.strictEqual(pageOwnsFileOperationNotification({ taskNotificationOwned: false }), true,
    'a silent or non-visible task does not suppress page feedback');
  assert.strictEqual(pageOwnsFileOperationNotification({ operationId: 'rename-operation' }), true,
    'an operation id alone must not suppress synchronous rename feedback');
  assert.strictEqual(pageOwnsFileOperationNotification({ success: false, operationId: 'import-task', taskNotificationOwned: true, error: 'copy failed' }), false,
    'a failed file import with a visible task must be reported only by its BackgroundTask card');
  assert.strictEqual(pageOwnsFileOperationNotification({ success: false, operationId: 'paste-task', taskNotificationOwned: true, error: 'paste failed' }), false,
    'a failed paste with an operation id must not create a second page toast');
  assert.strictEqual(pageOwnsFileOperationNotification({ success: false, operationId: 'trash-task', taskNotificationOwned: true, error: 'delete failed' }), false,
    'a failed delete with an operation id must not create a second page toast');
  assert.strictEqual(pageOwnsFileOperationNotification({ success: false, error: 'IPC did not start' }), true,
    'a file import failure before an operation id exists must retain page feedback');
  assert.strictEqual(pageOwnsFileOperationNotification(undefined), true,
    'a rejected IPC call has no task result and remains owned by the page');

  const workspaceSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'features', 'workspace', 'ProjectWorkspace.tsx'), 'utf8');
  const runFileOperation = workspaceSource.slice(workspaceSource.indexOf('const runFileOperation'), workspaceSource.indexOf('const handleFileShortcut'));
  assert(runFileOperation.includes("else if (pageOwnsFileOperationNotification(result)) onNotice(`操作失败"),
    'paste/delete result failures must consult BackgroundTask notification ownership');
  assert(runFileOperation.includes("onNotice(`操作失败：${error instanceof Error"),
    'rejected file-operation IPC calls must keep a page error toast');

  const importFiles = workspaceSource.slice(workspaceSource.indexOf('const importFiles'), workspaceSource.indexOf('const openOfficeImageExtractor'));
  assert(importFiles.includes('const pageOwnsNotice = pageOwnsFileOperationNotification(result)')
    && importFiles.includes('if (!result.success) { if (pageOwnsNotice) onNotice(`导入失败')
    && importFiles.includes('catch (error)'),
  'file imports must suppress task-owned result toasts while preserving IPC rejection feedback');

  const directoryDrop = workspaceSource.slice(workspaceSource.indexOf('const performDirectoryDrop'), workspaceSource.indexOf('const handleEntryDragOver'));
  assert(directoryDrop.includes('const pageOwnsNotice = pageOwnsFileOperationNotification(result)')
    && directoryDrop.includes('catch (error)'),
  'external file drops must use the same result ownership rule and retain startup failure feedback');

  const recovery = workspaceSource.slice(workspaceSource.indexOf('const handleProjectImportRecovery'), workspaceSource.indexOf('const importFiles'));
  assert(recovery.includes('if (pageOwnsFileOperationNotification(result)) onNotice'),
    'recovery UI may keep its actionable dialog but must not add a toast beside a task-owned import failure');
  const adoptImport = workspaceSource.slice(workspaceSource.indexOf('onLinkOnlyImport={async paths'), workspaceSource.indexOf('onBusyChange={setNegativeImportBusy}'));
  assert(adoptImport.includes('if (pageOwnsFileOperationNotification(result))'),
    'adopt-as-original imports must not add a completion toast when an operation id owns the result');

  const inspirationSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'features', 'inspiration', 'InspirationLibrary.tsx'), 'utf8');
  const inspirationDelete = inspirationSource.slice(inspirationSource.indexOf('const deleteFolder'), inspirationSource.indexOf('const addFolderToProject'));
  assert(inspirationDelete.includes('const pageOwnsNotice = pageOwnsFileOperationNotification(result)')
    && inspirationDelete.includes('catch (error)'),
  'the inspiration host must suppress task-owned trash result toasts and retain rejected IPC feedback');

  const manualSelection = workspaceSource.slice(workspaceSource.indexOf('const selectMediaFiles'), workspaceSource.indexOf('const focusEntry'));
  assert(manualSelection.includes('pageOwnsFileOperationNotification(result)')
    && manualSelection.includes('catch (error)')
    && manualSelection.includes('选片预检失败'),
  'manual selection keeps preflight/IPC-start feedback while visible task terminal results stay task-owned');

  console.log('file operation notification ownership tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
