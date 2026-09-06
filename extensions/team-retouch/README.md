# Team Retouch component

This directory is the complete source, test, and release boundary for the optional component. It is prepared for its first public release and accepts only the current component contract and current storage shapes.

## Independent workflow

```powershell
npm ci
npm test
npm run package:base
```

`npm test` and `npm run prepare:dev` explicitly use the development `.venv` through `setup-python.cjs --dev`, whose direct requirements are exactly versioned. `npm run package` and `npm run package:base` create a formal basic-only package under `../../artifacts/installers/base/`: its generated manifest has no advanced lifecycle, no `offlinePackage`, and no install/repair capability. Formal packaging never falls back to or executes through that development environment: it requires `requirements-build.lock`, creates/verifies the isolated `.venv-release` using `--require-hashes --no-deps`, checks the installed distribution/version set, runs Python tests there, and uses that interpreter for PyInstaller.

`npm run package:advanced` creates only an advanced candidate under `../../artifacts/installers/advanced-runtime/candidates/` after validating `advanced/build-input-lock.json`. It never makes that candidate publishable. After external review records the candidate ZIP digest in the exact-schema `advanced/release-lock.json`, `npm run package:host -- --output-dir <directory>` consumes that already reviewed ZIP from `../../artifacts/installers/advanced-runtime/`, validates every allowlisted build input and the mandatory ZIP digest, packages with `--with-advanced`, and verifies the final manifest, digest, `requiredFiles`, and embedded ZIP. All formal commands reject `--skip-checks`; only `npm run package:dev` uses the development environment and may skip checks. Advanced Host bundles default to `../../artifacts/installers/advanced/`. From the application root, `npm run build:components -- --only team-retouch --variant base` builds and verifies the base variant; `--variant advanced` retains the reviewed advanced package gate.

The manifest keeps its package `apiVersion`, Component Host manifest `contractVersion`, and the advanced runtime's private `apiVersion`. Public Host capabilities themselves are unversioned; `team.*.v1` names are private renderer-to-service RPC names owned by this component.

## Current storage and recovery

New databases are created directly as `schema_version=10`. Existing schema-10 development data is validated and opened; any other database version is rejected rather than migrated. Current `component-storage-v1` workspace/project backup and restore remains supported, including digests, receipts, quiescing, rollback, and project-ID hash path rewriting. The project revision lease/fence tables and triggers remain part of the current schema.

Opening an existing schema-10 database adds missing lease/outbox infrastructure. The known pre-lease schema-10 shape produced by the earlier `CREATE TABLE AS SELECT` migration is rebuilt with current constraints, preserving business rows, indexes, triggers, and project revisions. Retired photo calibration values and the locations of old NULL values filled from declared defaults are retained under `schema10_recovery:*` keys in `meta`. Initialization, recovery, and final validation share one transaction: an unknown shape, conflicting key, missing required value without a default, or invalid index/trigger rolls everything back.

No previous-component storage adoption, project-output adoption, name/status workflow lookup, or old Host-field fallback is shipped. `migration-backups/` contains user/developer archives only and is never listed in the manifest or copied into a package.

The advanced backend uses only the `PhotoFlowNative` WSL distribution. Its failure still falls back to the basic RTMDet path. End-user lifecycle scripts consume only the Host-verified offline archive inside the component and never perform a network build.

Formal advanced publication remains fail-closed until the reviewed `advanced/build-input-lock.json`, `advanced/release-lock.json`, `advanced/source-metadata.json`, and hash-complete `advanced/locks/{pairdetr-requirements.lock,sam2-requirements.lock,checkpoints.sha256}` are present. Freeze output is retained only as evidence; it is never accepted as an installation input. These reviewed locks are not generated from the network during packaging. PairDETR and SAM each run real 64×64 model self-tests after environment construction, again immediately before VHD export, and again on candidate/final import.

## Work-image grouping and notices

`Settings > Team Retouch > Work image grouping` keeps automatic grouping as the default. `Per person` produces one task, crop and person mask for each detected target. Both single-image and batch detection use the preference; existing tasks remain unchanged until detection is explicitly run again. Overlapping rectangles can still show bystanders, but each task owns only its target's mask. The existing oversize policy applies to both grouping modes.

Plugin-owned models and advanced runtime attribution live in `licenses/catalog.json` and are displayed by both plugin settings surfaces. The application's About page retains shared dependencies. Formal packages include full upstream, Python and JavaScript notices, build inventories and `package-files.json` with file hashes.

Advanced construction uses Python 3.10 for PairDETR and Python 3.12 for SAM, with direct artifact URLs and SHA-256 locks resolved from the adjacent `.in` files. Authoring examples for an isolated build distribution:

```powershell
npm run package:advanced -- --distro-name <isolated-build-distro> --linux-user <verified-linux-user>
```

Export verifies exact Python profiles and both real model self-tests. It stops only the selected build distribution, never other WSL distributions. Import selects the validated package's Linux user. `advanced/build-input-lock.json` binds the reviewed technical inputs; `advanced/release-lock.json` is a separate final artifact approval and must not be fabricated while distribution authorization is absent.


`npm run package:advanced:integration` assembles a clearly marked internal Host test candidate from the current formal base build and `../../artifacts/installers/advanced-runtime/candidates/` offline runtime. It writes only under `../../artifacts/installers/advanced-runtime/candidates/host-integration`, never creates release approval, and does not promote the offline ZIP to the trusted formal path.

The Host supports ZIP64 and streamed files above 4 GiB. Former fixed 512 MiB archive / 256 MiB entry / 1 GiB expanded limits are removed; safe integer bounds, manifest/directory/path budgets, compression-ratio checks, disk reservations, CRC/SHA verification and cancellable operation deadlines remain. Installation time budgets scale with archive and expanded size.
