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

The legacy expanded-directory layout remains supported:

Copy the complete component directory into the PhotoFlow installation folder:

```text
<PhotoFlow installation directory>\components\team-retouch
<PhotoFlow installation directory>\components\research-tools
<PhotoFlow installation directory>\components\office-media-extractor
```

Then restart PhotoFlow or use **设置 → 可选功能组件 → 刷新状态**. This folder
is beside `Photoflow.exe`; if PhotoFlow was installed under `Program Files`,
copying or upgrading a component may require administrator permission.

`npm run electron:build` also creates one ZIP package per component in
`release`. Each ZIP contains the correctly named top-level component directory;
extract that directory into `<PhotoFlow installation directory>\components`.

Packaged builds also scan these locations in order:

1. `components` beside `Photoflow.exe` (offline install, upgrade, or installer choice)
2. `resources\components` inside the application (legacy/bundled fallback)

## Manifest contract

`component.json` uses API version 1 and must contain a known component `id`, a
version, supported platforms/architectures, and a relative executable path.
Entrypoints that escape the component directory are rejected.

The current component IDs are:

- `team-retouch`: the complete multi-person patch workflow. It contains ONNX
  GPU/CPU person detection, lossless crop export, high-resolution alignment,
  color matching, overlap blending, and recomposition. When it is missing the
  whole team-retouch workflow is unavailable.
- `research-tools`: research image/video organization and scene extraction.
- `office-media-extractor`: extracts embedded images from Office Open XML Word,
  PowerPoint, and Excel documents into a sibling `<document>_media` directory.

Run `npm run setup:team-retouch` once to create/prepare the development virtual
environment and verify that the DirectML provider is available. Run
`npm run build:team-retouch` to create a self-contained distributable component
under `release/components/team-retouch`; the packaged component includes ONNX
Runtime and does not require Python on the user's machine.

`npm run build:components` builds every optional component. Components remain
separate from the base PhotoFlow installer so the core application stays small.
