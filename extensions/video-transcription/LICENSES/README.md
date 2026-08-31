# Third-party notices and model policy

The component source itself is covered by the PhotoFlow repository license.
No third-party binary, virtual environment, or Whisper model is committed here. This component does not create a subtitle database.

Release builders are responsible for including the licenses that correspond to the exact bundled versions of:

- faster-whisper (MIT) and CTranslate2 (MIT)
- opencc-python-reimplemented (Apache-2.0)
- FFmpeg libraries pulled in by the selected faster-whisper/PyAV distribution (license depends on that build)
- the selected Whisper model and its upstream model card/license

The release package includes the self-contained transcription runtime but never copies the plugin-local `models` directory. Models are installed separately under the directory shown in component settings. A production release must retain the exact dependency license texts beside this file before distribution.
