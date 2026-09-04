# Team Retouch component

This directory is the complete source, test, and release boundary for the optional component. It is prepared for its first public release and accepts only the current component contract and current storage shapes.

## Independent workflow

```powershell
npm ci
npm test
npm run package:base
```

`npm test` explicitly uses the development Python setup, whose direct requirements are exactly versioned. `npm run package` and `npm run package:base` intentionally create a basic-only developer package: its generated manifest has no advanced lifecycle, no `offlinePackage`, and no install/repair capability. Formal packaging never falls back to those development requirements; it requires `requirements-build.lock` with `--require-hashes --no-deps`.

`npm run package:advanced` creates only an advanced candidate under `dist/candidates/` after validating `advanced/build-input-lock.json`. It never makes that candidate publishable. After external review records the candidate ZIP digest in the exact-schema `advanced/release-lock.json`, `npm run package:host -- --output-dir <directory>` consumes that already reviewed ZIP from `dist/`, validates every allowlisted build input and the mandatory ZIP digest, packages with `--with-advanced`, and verifies the final manifest, digest, `requiredFiles`, and embedded ZIP. The formal command rejects `--skip-checks`; only the explicit developer base path can skip checks.

The manifest keeps its package `apiVersion`, Component Host manifest `contractVersion`, and the advanced runtime's private `apiVersion`. Public Host capabilities themselves are unversioned; `team.*.v1` names are private renderer-to-service RPC names owned by this component.

## Current storage and recovery

New databases are created directly as `schema_version=10`. Existing schema-10 development data is validated and opened; any other database version is rejected rather than migrated. Current `component-storage-v1` workspace/project backup and restore remains supported, including digests, receipts, quiescing, rollback, and project-ID hash path rewriting. The project revision lease/fence tables and triggers remain part of the current schema.

No previous-component storage adoption, project-output adoption, name/status workflow lookup, or old Host-field fallback is shipped. `migration-backups/` contains user/developer archives only and is never listed in the manifest or copied into a package.

The advanced backend uses only the `PhotoFlowNative` WSL distribution. Its failure still falls back to the basic RTMDet path. End-user lifecycle scripts consume only the signed offline archive inside the component and never perform a network build.

Advanced release preparation is deliberately fail-closed until the reviewed `advanced/build-input-lock.json`, `advanced/release-lock.json`, `advanced/source-metadata.json`, and hash-complete `advanced/locks/{pairdetr-requirements.lock,sam2-requirements.lock,checkpoints.sha256}` are present. Freeze output is retained only as evidence; it is never accepted as an installation input. These reviewed locks are not generated from the network during packaging. PairDETR and SAM each run real 64×64 model self-tests after environment construction, again immediately before VHD export, and again on candidate/final import.
