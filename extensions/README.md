# PhotoFlow optional components

PhotoFlow keeps large or independently deployable features outside the base
application. A component is a complete directory containing `component.json`,
its executable, and all of its private runtime files. The normal application
installer does not contain optional components.

## Offline installation

Place generated component ZIPs directly in the shared `components` user-data
directory, then click Install for the matching component. PhotoFlow extracts and
validates the package in a temporary directory before copying the runtime into
its component-specific subdirectory. After installation, the user may choose
whether to delete or retain the source ZIP.

Each component has one application-data directory:

```text
%LOCALAPPDATA%\PhotoFlow\components\sample-component
```

All component ZIPs contain self-contained executables; end users do not install
Python or compile the component.

## Additional model and engine packages

Every optional runtime is distributed as a prepared ZIP. All packages belonging
to one component are placed, without extraction, in that component's single
directory. For multi-person retouch this is:

`%LOCALAPPDATA%\PhotoFlow\components\sample-component`

- `PhotoFlow-<component-id>-*.zip`: installed by the matching component button.
- `PhotoFlow-sample-component-advanced-*.zip`: verifies and registers the prepared
  PairDETR + SAM 2.1 WSL virtual disk.

WSL registration is the only additional system operation that cannot be
completed by copying files alone. PhotoFlow performs it after explicit user
confirmation because it creates a registered WSL distribution and uses tens
of gigabytes of disk space.

Build component ZIPs separately from the application installer. For example,
`npm run build:components` creates the sample-component ZIP in `release`; copy it to
the shared `components` directory and install it from Settings.

Packaged builds scan only this location:

1. `%LOCALAPPDATA%\PhotoFlow\components` (component containers and runtimes)

Components beside `Photoflow.exe` or inside `resources\components` are ignored.

Installed and development components can be disabled from Component Management
without uninstalling them or deleting their data. Disabling closes their pages,
stops their services and worker processes, removes their Host contributions, and
persists across application restarts until the component is enabled again.

## Manifest contract

`component.json` uses API version 1 and must contain a known component `id`, a
version, supported platforms/architectures, and a relative executable path.
Entrypoints that escape the component directory are rejected.

The current component IDs are:

- `sample-component`: the complete multi-person patch workflow. It contains ONNX
  GPU/CPU person detection, lossless crop export, high-resolution alignment,
  color matching, overlap blending, and recomposition. When it is missing the
  whole sample-component workflow is unavailable.
- `video-playback-mpv`: “视频播放器”. The legacy installation ID is retained
  for package compatibility. It runs libmpv in an isolated process and embeds
  the native video surface in PhotoFlow. It declares the UI-less,
  versioned `media.playbackBackend` capability; startup or decoding failures may
  fall back to another untried backend under the application session. It is a runtime-only backend
  capability: the player, controls, trimming, screenshots and settings remain
  in the main application, and the component package must not contain renderer
  JavaScript, HTML or CSS.
- `video-tools`: “视频处理”. It contributes the existing “视频转码” and
  “视频切割” panels at their original positions under the file-page “视频工具”
  menu. Both entries share one component service, settings namespace and a
  component-owned audited FFmpeg encoder runtime. Transcode, split, trim,
  import post-processing and video thumbnail extraction resolve through this
  component; timeline-frame extraction belongs to `video-playback-mpv`.

The inspiration library, scene organizer, and Office image extractor are part
of the main application and are not component IDs.

Run `npm run setup:sample-component` once to create/prepare the development virtual
environment and verify that the DirectML provider is available. Run
`npm run build:sample-component` to create a self-contained distributable component
under `artifacts/installers/components/sample-component`; the packaged component includes ONNX
Runtime, YuNet, AdaFace IR-18, and OSNet x1.0, and does not require Python on
the user's machine.

`npm run build:components` builds the optional sample-component component. Components remain
separate from the base PhotoFlow installer so the core application stays small.

The libmpv backend lives in `extensions/video-playback-mpv`, an independent
release project with its own build, test, signing and lifecycle commands. The
core package has no plugin-specific build command or source dependency, and the
main installer does not depend on or include libmpv.
