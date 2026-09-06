# Project output and confidentiality rules

These rules apply to work in this repository, including temporary scripts and generated documents.

## Private material

- Store business/database backups, customer/project data, unredacted screenshots, audit/diagnostic reports, internal operating records, private backend source, and history-recovery material outside the source repository.
- On this workstation the private root is `C:/dev/app/app1visual/photoflow-private`. Resolve it with `scripts/project-output-paths.cjs`; local configuration is `.photoflow-paths.local.json`, or `PHOTOFLOW_PRIVATE_ROOT`.
- Use `backups/`, `audits/`, `diagnostics/`, or `operations/` below that root as appropriate. The existing private CloudBase workspace is `C:/dev/app/app1visual/cloudbase-backend`; preserve its existing source location.
- Create sensitive outputs directly in the private root. Do not first write them into the source repository and rely on `.gitignore` or a later move. If access is unavailable, report the problem; do not fall back into this repository.
- Keep raw credentials and populated private evidence out of tracked files. Public policy documents, blank templates, API contracts and required license notices may remain public.

## Packages and deliverables

- All application installers, installable component ZIPs, service deployment ZIPs, offline runtime packages, packaged candidates and delivery manifests belong under `C:/dev/app1/artifacts/installers` for this checkout (`<repositoryRoot>/artifacts/installers` in isolated test checkouts).
- Subdirectories are allowed: `base/`, `advanced/`, `advanced-runtime/`, `cloudbase/`, `metadata/`, and immutable `releases/<commit>/<version>/`.
- A candidate package is still a candidate after being placed here; never bypass review, approval, hash verification or release gates because of its location.
- Output location does not grant public distribution rights. Backend deployment packages remain private; publish only the explicitly approved delivery manifest, never the whole installers directory.
- Business backup archives are private material, not software deliverables, even when they use a `.zip` extension.
- Do not generate final deliverables under component `dist/`, the repository root, `artifacts/cloudbase/`, or the private source tree. Update producers and consumers together when changing paths.
- Existing explicit output arguments are for isolated tests or explicitly requested destinations. Normal build/release commands must resolve inside `artifacts/installers`; do not select a different production output directory without a new user instruction.

## Preserve working state

- Build intermediates, dependency environments and caches may use their established ignored paths (`dist/` assembly trees, `.cache/`, `.venv/`, `node_modules/`, etc.). They are not final deliverables.
- Vendored upstream archives remain build inputs at their established paths. If separately delivered, their delivery copies belong under `artifacts/installers`.
- Keep atomic publication temporary files next to their target when necessary, and retain failure evidence. Never lose a pending publish record or an active lock during a path migration.
- Do not move or overwrite files belonging to another active task. Check dependencies before relocating existing material, verify copied content before removal, and do not rewrite Git history or publish changes merely to enforce this output policy.

See `docs/OUTPUT_LOCATIONS.md` for usage and scope.
