# Team Retouch component

This directory is the complete source, test, and release boundary for the optional component. It is prepared for its first public release and accepts only the current component contract and current storage shapes.

## Independent workflow

```powershell
npm ci
npm test
npm run package
```

`npm test` runs renderer typechecking, ESLint, the production Vite build, Node service/UI contracts, and Python algorithm tests. `npm run package` validates the four required ONNX assets, builds the renderer and PyInstaller runtime, copies only the service modules and two advanced-runtime lifecycle scripts, refreshes lifecycle SHA-256 values, verifies `requiredFiles`, and creates `dist/PhotoFlow-*.zip`.

The manifest keeps its package `apiVersion`, Component Host manifest `contractVersion`, and the advanced runtime's private `apiVersion`. Public Host capabilities themselves are unversioned; `team.*.v1` names are private renderer-to-service RPC names owned by this component.

## Current storage and recovery

New databases are created directly as `schema_version=10`. Existing schema-10 development data is validated and opened; any other database version is rejected rather than migrated. Current `component-storage-v1` workspace/project backup and restore remains supported, including digests, receipts, quiescing, rollback, and project-ID hash path rewriting. The project revision lease/fence tables and triggers remain part of the current schema.

No previous-component storage adoption, project-output adoption, name/status workflow lookup, or old Host-field fallback is shipped. `migration-backups/` contains user/developer archives only and is never listed in the manifest or copied into a package.

The advanced backend uses only the `PhotoFlowNative` WSL distribution. Its failure still falls back to the basic RTMDet path. End-user lifecycle scripts consume only the signed offline archive inside the component and never perform a network build.
