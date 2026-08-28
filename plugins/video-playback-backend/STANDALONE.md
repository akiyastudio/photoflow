# Repository boundary

This directory is an independent release project. It owns the native source, manifest, protocol tests, licensing, build, Authenticode signing and install/repair/upgrade/uninstall CLI. `npm test` needs only Node. `npm run build -- --mpv-root <verified LGPL runtime>` currently reuses four generic build-policy helpers from the enclosing PhotoFlow checkout; when split into a physical repository, copy those helpers under `scripts/vendor/` without changing the component protocol or application code.

The produced ZIP is installed by PhotoFlow's generic component installer or by this project's lifecycle CLI. It contains no renderer UI. PhotoFlow core discovers it only through the signed `component.json` and `media.playbackBackend@v1` declaration.
