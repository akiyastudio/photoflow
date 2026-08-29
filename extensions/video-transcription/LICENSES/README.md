# Third-party notices and model policy

The component source itself is covered by the PhotoFlow repository license.
No third-party binary, virtual environment, subtitle database, or Whisper model is committed here.

Release builders are responsible for including the licenses that correspond to the exact bundled versions of:

- faster-whisper (MIT) and CTranslate2 (MIT)
- opencc-python-reimplemented (Apache-2.0)
- FFmpeg libraries pulled in by the selected faster-whisper/PyAV distribution (license depends on that build)
- the selected Whisper model and its upstream model card/license

The default package is always thin and never copies the plugin-local `models` directory. When a release builder explicitly supplies an audited model directory with `--model-root`, the package script copies it and this notice. A production release must add the model card and exact dependency license texts beside this file before distribution.
