# Video tools runtime licensing

The component package carries the audited PhotoFlow FFmpeg encoder runtime and
its `ffmpeg-runtime-manifest.json`. FFmpeg is distributed under
GPL-2.0-or-later for this build because GPL codecs are enabled. Exact source,
build flags, checksums and corresponding-source archives are identified by this
component's `media-runtime/vendor` directory and `media-runtime.lock.json`.
GPU HDR-to-SDR processing uses LGPL-2.1-or-later libplacebo with the Apache-2.0
shaderc runtime; their notices and build materials are included in the same
audited runtime bundles.

The base PhotoFlow installer does not carry this encoder archive after the
video-tools component split.
