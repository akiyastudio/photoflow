# Media playback backend v1

`media.playbackBackend@v1` is a runtime-only contribution with no UI. Its immutable descriptor declares `backendId`, `displayName`, semantic `backendVersion`, protocol version, container/codec/extension hints, and bounded transforms, HDR, statistics, subtitle, hardware-decoding and capture features. Registry parsing and both manifest schemas reject unknown fields, duplicate IDs, malformed versions and unsupported values.

The process transport is `media-playback-backend-v1`. Every command and event is a JSON envelope containing `protocol`, `protocolVersion`, `sessionId`, strictly increasing `sequence`, `timestamp`, `event` and object `payload`. Frames are limited to 256 KiB and may never contain image, pixel, audio-frame or video-frame bytes. High-frequency state and statistics are bounded/coalesced; terminal and track-change events are lossless. Historical command names exist only inside the Electron process adapter.

Media access is a short-lived authorization bound to component, backend, process and playback session. It grants random-read access to exactly one authorized project media file, rejects changed file identity, supports renewal, and is revoked by close, crash, process cleanup or component uninstall.

The component registers only its own native HWND. PhotoFlow verifies process ownership and a core native helper exclusively owns parent attachment, window styles, per-monitor DPI, bounds, visibility and clip regions. The component never receives the Electron main-window HWND.

Capture uses a host-created stage with owner checks, expiry, complete-image validation and atomic same-directory commit. The backend receives only the stage identity/path and never selects the public filename. Structured diagnostics use a strict field allowlist and cannot access host logs, environment variables, secrets or other components.

This protocol applies only to project media inside PhotoFlow. It defines no file association, registry, default-app, shell-open, external double-click or single-instance routing behavior.
