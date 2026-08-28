# Media playback backend v1

`media.playbackBackend@v1` is a runtime-only contribution with no UI. Its immutable descriptor declares `backendId`, `displayName`, semantic `backendVersion`, protocol version, container/codec/extension hints, and bounded transforms, HDR, statistics, subtitle, hardware-decoding and capture features. Registry parsing and both manifest schemas reject unknown fields, duplicate IDs, malformed versions and unsupported values.

The process transport is `media-playback-backend-v1`. Every command and event is a JSON envelope containing `protocol`, `protocolVersion`, `sessionId`, strictly increasing `sequence`, `timestamp`, `event` and object `payload`. Frames are limited to 256 KiB and may never contain image, pixel, audio-frame or video-frame bytes. High-frequency state and statistics are bounded/coalesced; terminal and track-change events are lossless. Historical command names exist only inside the Electron process adapter.

Media access is a short-lived authorization bound to component, backend, process and playback session. It grants random-read access to exactly one authorized project media file, rejects changed file identity, supports renewal, and is revoked by close, crash, process cleanup or component uninstall.

The component registers only its own native HWND. PhotoFlow verifies process ownership and a core native helper exclusively owns parent attachment, window styles, per-monitor DPI, bounds, visibility and clip regions. The component never receives the Electron main-window HWND.

Capture uses a host-created stage with owner checks, expiry, complete-image validation and atomic same-directory commit. The backend receives only the stage identity/path and never selects the public filename. Structured diagnostics use a strict field allowlist and cannot access host logs, environment variables, secrets or other components.

Application failures use the stable public enum `BACKEND_UNAVAILABLE`, `UNSUPPORTED_CONTAINER`, `UNSUPPORTED_CODEC`, `DECODE_INITIALIZATION_FAILED`, `HARDWARE_DECODING_FAILED`, `RENDER_INITIALIZATION_FAILED`, `SURFACE_LOST`, `GPU_DEVICE_LOST`, `CORRUPT_MEDIA`, `MEDIA_IO_FAILED`, `PERMISSION_DENIED`, `STARTUP_TIMEOUT`, `CANCELLED`, and `BACKEND_CRASHED`, with `recoverable`, `suggestedFallback`, and an ordered attempt ledger. Automatic fallback remains finite: each descriptor is attempted at most once per media generation. The native backend has its own bounded recovery ladder—hardware to software decode, GPU safe mode, timestamp/cache repair, then silent-audio continuation. Exhausting that ladder emits a normalized error; no arbitrary decoder option crosses the host protocol.

The backend never enumerates the media directory. Host code discovers same-name sidecars inside the authorized project scope and passes each approved subtitle through `subtitles.add`; a corrupt subtitle produces a recoverable diagnostic without ending video playback. Audio tracks are stable facts (`stableId`, language, codec, channels, sample rate) selected through `audio.track-select` and remapped across backend switches.

HDR capability separately declares passthrough, tone mapping, supported algorithms (`auto`, `bt2390`, `reinhard`, `mobius`, `hable`) and target-peak control. Statistics declare basic/decode/HDR/timing/cache/GPU groups and never exceed 4 Hz. Capture distinguishes source and displayed frames, and transforms explicitly declare aspect modes, rotation, flip, and crop.

This protocol applies only to project media inside PhotoFlow. It defines no file association, registry, default-app, shell-open, external double-click or single-instance routing behavior.
