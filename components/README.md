# PhotoFlow optional components

PhotoFlow keeps large or independently deployable features outside the base
application. A component is a complete directory containing `component.json`,
its executable, and all of its private runtime files. The normal application
installer does not contain optional components.

## Offline installation

Open PhotoFlow's component manager, click Install, and select the generated ZIP
directly. PhotoFlow extracts and validates it in a temporary directory before
copying the runtime into the component-specific user-data directory. The source
ZIP selected by the user is never moved or deleted.

Each component has one application-data directory:

```text
%LOCALAPPDATA%\PhotoFlow\components\team-retouch
```

All component ZIPs contain self-contained executables; end users do not install
Python or compile the component.

## Additional model and engine packages

Every optional runtime is distributed as a prepared ZIP. All packages belonging
to one component are placed, without extraction, in that component's single
directory. For multi-person retouch this is:

`%LOCALAPPDATA%\PhotoFlow\components\team-retouch`

- `PhotoFlow-<component-id>-*.zip`: installed by the matching component button.
- `PhotoFlow-team-retouch-advanced-*.zip`: verifies and registers the prepared
  PairDETR + SAM 2.1 WSL virtual disk.

WSL registration is the only additional system operation that cannot be
completed by copying files alone. PhotoFlow performs it after explicit user
confirmation because it creates a registered WSL distribution and uses tens
of gigabytes of disk space.

Build component ZIPs separately from the application installer. For example,
`npm run build:components` creates the team-retouch ZIP in `release`; select it
from Settings to install it.

Packaged builds scan only this location:

1. `%LOCALAPPDATA%\PhotoFlow\components` (component containers and runtimes)

Components beside `Photoflow.exe` or inside `resources\components` are ignored.

## Manifest contract

`component.json` uses API version 1 and must contain a known component `id`, a
version, supported platforms/architectures, and a relative executable path.
Entrypoints that escape the component directory are rejected.

The current component IDs are:

- `team-retouch`: the complete multi-person patch workflow. It contains ONNX
  GPU/CPU person detection, lossless crop export, high-resolution alignment,
  color matching, overlap blending, and recomposition. When it is missing the
  whole team-retouch workflow is unavailable.
- `video-playback-mpv`: “高级视频解码”. It runs libmpv in an isolated process,
  embeds the native video surface in PhotoFlow, and falls back to Chromium
  playback if startup or decoding fails.
The inspiration library, scene organizer, and Office image extractor are part
of the main application and are not component IDs.

Run `npm run setup:team-retouch` once to create/prepare the development virtual
environment and verify that the DirectML provider is available. Run
`npm run build:team-retouch` to create a self-contained distributable component
under `release/components/team-retouch`; the packaged component includes ONNX
Runtime, YuNet, AdaFace IR-18, and OSNet x1.0, and does not require Python on
the user's machine.

`npm run build:components` builds the optional team-retouch component. Components remain
separate from the base PhotoFlow installer so the core application stays small.

`npm run build:advanced-video-decoder -- --mpv-root <directory>` builds only the
optional advanced video ZIP. It is intentionally not part of `electron:build`,
so the main installer does not depend on or include libmpv.
