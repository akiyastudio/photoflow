# Repository boundary

This directory is an independent release project. It owns the native source, manifest, pinned media-runtime lock, reproducible libmpv/dependency scripts, policy and PE helpers, protocol tests, licensing, build, Authenticode signing and install/repair/upgrade/uninstall CLI. `npm test` needs only Node. `npm run build:release` builds the pinned runtime and packages the component; `npm run build -- --mpv-root <verified LGPL runtime>` only validates and packages an existing runtime. Neither command reads above this directory.

The produced ZIP is installed by PhotoFlow's generic component installer or by this project's lifecycle CLI. It contains no renderer UI. PhotoFlow core discovers it only through the signed `component.json` and `media.playbackBackend@v1` declaration.
