# PhotoFlow optional components

PhotoFlow keeps large or independently deployable features outside the base
application. A component is a complete directory containing `component.json`,
its executable, and all of its private runtime files. The normal application
installer does not contain optional components.

## Offline installation

The preferred layout is to place the generated component ZIP archives directly
beside the PhotoFlow installer. The installer's optional-component page detects
files named `PhotoFlow-<component-id>-<version>-win32-<arch>.zip` and extracts
the selected archives automatically. No pre-created `components` directory is
required.

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
- `PhotoFlow-team-retouch-identity-models-*.zip`: installs prepared AdaFace
  IR-18 and OSNet x1.0 ONNX files.
- `PhotoFlow-team-retouch-advanced-*.zip`: verifies and registers the prepared
  PairDETR + SAM 2.1 WSL virtual disk.

WSL registration is the only additional system operation that cannot be
completed by copying files alone. PhotoFlow performs it after explicit user
confirmation because it creates a registered WSL distribution and uses tens
of gigabytes of disk space.

`npm run electron:build` also creates one ZIP package per component in
`release`. Copy each generated ZIP into its component directory and install it
from Settings.

Packaged builds scan these locations in order:

1. `%LOCALAPPDATA%\PhotoFlow\components` (component containers and runtimes)
2. `components` beside `Photoflow.exe` (legacy installer and upgrade compatibility)
3. `resources\components` inside the application (legacy/bundled fallback)

## Manifest contract

`component.json` uses API version 1 and must contain a known component `id`, a
version, supported platforms/architectures, and a relative executable path.
Entrypoints that escape the component directory are rejected.

The current component IDs are:

- `team-retouch`: the complete multi-person patch workflow. It contains ONNX
  GPU/CPU person detection, lossless crop export, high-resolution alignment,
  color matching, overlap blending, and recomposition. When it is missing the
  whole team-retouch workflow is unavailable.
The inspiration library, scene organizer, and Office image extractor are part
of the main application and are not component IDs.

Run `npm run setup:team-retouch` once to create/prepare the development virtual
environment and verify that the DirectML provider is available. Run
`npm run build:team-retouch` to create a self-contained distributable component
under `release/components/team-retouch`; the packaged component includes ONNX
Runtime and does not require Python on the user's machine.

`npm run build:components` builds the optional team-retouch component. Components remain
separate from the base PhotoFlow installer so the core application stays small.
