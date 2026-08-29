# Video tools runtime licensing

The component package carries the audited PhotoFlow FFmpeg encoder runtime and
its `ffmpeg-runtime-manifest.json`. FFmpeg is distributed under
GPL-2.0-or-later for this build because GPL codecs are enabled. Exact source,
build flags, checksums and corresponding-source archives are identified by this
component's `media-runtime/vendor` directory and `media-runtime.lock.json`.

The base PhotoFlow installer does not carry this encoder archive after the
video-tools component split.
