# Model and third-party notices

The model assets in `models/` are distributed only as part of this optional
component. Their provenance and exact packaged hashes are in `MODEL-SOURCE.md`.

- AdaFace source and the official R18 WebFace4M checkpoint are published by
  Minchul Kim under the MIT License:
  https://github.com/mk-minchul/AdaFace/blob/master/LICENSE
- Torchreid/OSNet source and the `osnet_x1_0_msmt17_combineall` checkpoint are
  published by Kaiyang Zhou under the MIT License:
  https://github.com/KaiyangZhou/deep-person-reid/blob/master/LICENSE
- YuNet model is distributed under the MIT License (the OpenCV Zoo repository has its own Apache-2.0 license):
  https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/LICENSE
- MMDetection and MMDeploy are distributed by OpenMMLab under the Apache
  License 2.0:
  https://github.com/open-mmlab/mmdetection/blob/main/LICENSE and
  https://github.com/open-mmlab/mmdeploy/blob/main/LICENSE

The license texts and upstream notices remain authoritative. Dataset access and
use may be subject to separate dataset terms; this component does not distribute
the training datasets.

Full upstream notices are in `licenses/upstream/`; `sources.json` records retrieval URLs and SHA-256. Formal packaging also collects the installed Python distribution notices, Python runtime license, JavaScript runtime notices and a complete package file/hash inventory. Advanced release authorization is tracked separately; this notice file is not approval.
