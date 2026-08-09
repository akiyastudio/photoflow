# Runtime licensing notice

The PhotoFlow bridge source in this directory is proprietary PhotoFlow code. The libmpv,
FFmpeg, codec, subtitle, and GPU runtime binaries placed into a release archive
remain under their respective upstream licenses.

The libmpv client API header is ISC licensed. This component only accepts an mpv
build configured with `-Dgpl=false`, licensed as LGPL-2.1-or-later. Its linked
FFmpeg and every transitive library must also be LGPL-compatible. The component
archive contains the exact upstream license files, build configuration,
corresponding source, and SHA-256 manifest for the selected binary build.

Do not publish an archive produced from an unknown binary bundle.
