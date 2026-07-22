# PhotoFlow optional components

PhotoFlow keeps large or independently deployable features outside the base
application. A component is a complete directory containing `component.json`,
its executable, and all of its private runtime files.

## Offline installation

Copy the complete component directory into the PhotoFlow installation folder:

```text
<PhotoFlow installation directory>\components\team-retouch
<PhotoFlow installation directory>\components\research-tools
```

Then restart PhotoFlow or use **设置 → 可选功能组件 → 刷新状态**. This folder
is beside `Photoflow.exe`; if PhotoFlow was installed under `Program Files`,
copying or upgrading a component may require administrator permission.

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

Run `npm run setup:team-retouch` once to create/prepare the development virtual
environment and verify that the DirectML provider is available. Run
`npm run build:team-retouch` to create a self-contained distributable component
under `release/components/team-retouch`; the packaged component includes ONNX
Runtime and does not require Python on the user's machine.

`npm run build:components` builds every optional component. Components remain
separate from the base PhotoFlow installer so the core application stays small.
