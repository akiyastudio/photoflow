# Team Retouch component

This directory is the complete source, migration, test, and release boundary for the optional component. Copying this directory elsewhere is supported; no build or test command reads the PhotoFlow repository.

## Independent workflow

```powershell
npm ci
npm test
npm run package
```

`npm test` creates/updates the local `.venv`, then runs renderer typechecking, ESLint, the production Vite build, every Node protocol/service/UI regression, and the Python algorithm/storage tests. `npm run package` validates all four model assets, builds the UI, produces the PyInstaller runtime, copies the service and verified lifecycle actions, refreshes lifecycle SHA-256 values in the packaged manifest, checks every `requiredFiles` entry, and creates `dist/PhotoFlow-*.zip`.

The root application never imports this source tree. It discovers installed `component.json` manifests and interacts only through Component Host V2 capabilities. `team.*.v1` methods are private UI-to-service RPC owned here; service-to-Host requests use only the declared project media/output/version/progress, tasks, dialogs, component storage/settings/events/lifecycle/media, and notifications capabilities.

## Migration and recovery

The manifest requests the versioned `component.storage.previous.v1` and `project.output.existing.v1` adoption grants. The Host performs bounded copy/verification or project-local ownership adoption and returns generic receipts. `service.cjs` owns all old table/path interpretation, validates the receipt before rewriting paths, fails mutations closed while adoption is pending, checkpoints output migration, uses stable migration IDs, and leaves the previous source intact for rollback. The helpers under `compatibility/python/` exist only for plugin-owned legacy snapshot/restore tests and are not registered by PhotoFlow.

The package's lifecycle scripts locate their own optional advanced-runtime archive and use only the Host-controlled component data root. No Electron adapter or arbitrary Host filesystem privilege is included.
