# Person detection model

Put `person_detection_mediapipe_2023mar.onnx` in the `models` directory before
building this optional component.

- Upstream: OpenCV Zoo `models/person_detection_mediapipe`
- Model: MediaPipe Person Detector, 224 × 224 ONNX
- License: Apache-2.0 (see the upstream model directory)
- Source URL: `https://github.com/opencv/opencv_zoo/raw/main/models/person_detection_mediapipe/person_detection_mediapipe_2023mar.onnx`
- SHA-256: `47fd5599d6fa17608f03e0eb0ae230baa6e597d7e8a2c8199fe00abea55a701f`

The model is intentionally not part of the base Electron resources. The
component build copies it into the standalone team-retouch component, where it
is shared by the GPU and CPU execution paths.
