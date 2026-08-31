export interface FormalModelLicense {
  name: string;
  purpose: string;
  bundledFile: string;
  version: string;
  sha256: string;
  license: string;
  sourceUrl: string;
  downloadUrl: string;
  downloadNote: string;
  licenseText: string;
}

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const mitLicense = (copyright: string) => `MIT License

${copyright}

${MIT_BODY}`;

const APACHE_2_0 = `Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

"License" shall mean the terms and conditions for use, reproduction, and
distribution as defined by Sections 1 through 9 of this document.

"Licensor" shall mean the copyright owner or entity authorized by the
copyright owner that is granting the License.

"Legal Entity" shall mean the union of the acting entity and all other
entities that control, are controlled by, or are under common control with
that entity. For the purposes of this definition, "control" means (i) the
power, direct or indirect, to cause the direction or management of such
entity, whether by contract or otherwise, or (ii) ownership of fifty percent
(50%) or more of the outstanding shares, or (iii) beneficial ownership of
such entity.

"You" (or "Your") shall mean an individual or Legal Entity exercising
permissions granted by this License.

"Source" form shall mean the preferred form for making modifications,
including but not limited to software source code, documentation source, and
configuration files.

"Object" form shall mean any form resulting from mechanical transformation or
translation of a Source form, including but not limited to compiled object
code, generated documentation, and conversions to other media types.

"Work" shall mean the work of authorship, whether in Source or Object form,
made available under the License, as indicated by a copyright notice that is
included in or attached to the work (an example is provided in the Appendix
below).

"Derivative Works" shall mean any work, whether in Source or Object form, that
is based on (or derived from) the Work and for which the editorial revisions,
annotations, elaborations, or other modifications represent, as a whole, an
original work of authorship. For the purposes of this License, Derivative
Works shall not include works that remain separable from, or merely link (or
bind by name) to the interfaces of, the Work and Derivative Works thereof.

"Contribution" shall mean any work of authorship, including the original
version of the Work and any modifications or additions to that Work or
Derivative Works thereof, that is intentionally submitted to Licensor for
inclusion in the Work by the copyright owner or by an individual or Legal
Entity authorized to submit on behalf of the copyright owner. For the purposes
of this definition, "submitted" means any form of electronic, verbal, or
written communication sent to the Licensor or its representatives, including
but not limited to communication on electronic mailing lists, source code
control systems, and issue tracking systems that are managed by, or on behalf
of, the Licensor for the purpose of discussing and improving the Work, but
excluding communication that is conspicuously marked or otherwise designated
in writing by the copyright owner as "Not a Contribution."

"Contributor" shall mean Licensor and any individual or Legal Entity on behalf
of whom a Contribution has been received by Licensor and subsequently
incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of this
License, each Contributor hereby grants to You a perpetual, worldwide,
non-exclusive, no-charge, royalty-free, irrevocable copyright license to
reproduce, prepare Derivative Works of, publicly display, publicly perform,
sublicense, and distribute the Work and such Derivative Works in Source or
Object form.

3. Grant of Patent License. Subject to the terms and conditions of this
License, each Contributor hereby grants to You a perpetual, worldwide,
non-exclusive, no-charge, royalty-free, irrevocable (except as stated in this
section) patent license to make, have made, use, offer to sell, sell, import,
and otherwise transfer the Work, where such license applies only to those
patent claims licensable by such Contributor that are necessarily infringed by
their Contribution(s) alone or by combination of their Contribution(s) with
the Work to which such Contribution(s) was submitted. If You institute patent
litigation against any entity (including a cross-claim or counterclaim in a
lawsuit) alleging that the Work or a Contribution incorporated within the Work
constitutes direct or contributory patent infringement, then any patent
licenses granted to You under this License for that Work shall terminate as of
the date such litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the Work or
Derivative Works thereof in any medium, with or without modifications, and in
Source or Object form, provided that You meet the following conditions:

(a) You must give any other recipients of the Work or Derivative Works a copy
of this License; and

(b) You must cause any modified files to carry prominent notices stating that
You changed the files; and

(c) You must retain, in the Source form of any Derivative Works that You
distribute, all copyright, patent, trademark, and attribution notices from the
Source form of the Work, excluding those notices that do not pertain to any
part of the Derivative Works; and

(d) If the Work includes a "NOTICE" text file as part of its distribution,
then any Derivative Works that You distribute must include a readable copy of
the attribution notices contained within such NOTICE file, excluding those
notices that do not pertain to any part of the Derivative Works, in at least
one of the following places: within a NOTICE text file distributed as part of
the Derivative Works; within the Source form or documentation, if provided
along with the Derivative Works; or, within a display generated by the
Derivative Works, if and wherever such third-party notices normally appear.
The contents of the NOTICE file are for informational purposes only and do not
modify the License. You may add Your own attribution notices within Derivative
Works that You distribute, alongside or as an addendum to the NOTICE text from
the Work, provided that such additional attribution notices cannot be
construed as modifying the License.

You may add Your own copyright statement to Your modifications and may provide
additional or different license terms and conditions for use, reproduction,
or distribution of Your modifications, or for any such Derivative Works as a
whole, provided Your use, reproduction, and distribution of the Work otherwise
complies with the conditions stated in this License.

5. Submission of Contributions. Unless You explicitly state otherwise, any
Contribution intentionally submitted for inclusion in the Work by You to the
Licensor shall be under the terms and conditions of this License, without any
additional terms or conditions. Notwithstanding the above, nothing herein
shall supersede or modify the terms of any separate license agreement you may
have executed with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade names,
trademarks, service marks, or product names of the Licensor, except as required
for reasonable and customary use in describing the origin of the Work and
reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or agreed to in
writing, Licensor provides the Work (and each Contributor provides its
Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied, including, without limitation, any warranties
or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
PARTICULAR PURPOSE. You are solely responsible for determining the
appropriateness of using or redistributing the Work and assume any risks
associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory, whether in
tort (including negligence), contract, or otherwise, unless required by
applicable law (such as deliberate and grossly negligent acts) or agreed to in
writing, shall any Contributor be liable to You for damages, including any
direct, indirect, special, incidental, or consequential damages of any
character arising as a result of this License or out of the use or inability to
use the Work (including but not limited to damages for loss of goodwill, work
stoppage, computer failure or malfunction, or any and all other commercial
damages or losses), even if such Contributor has been advised of the
possibility of such damages.

9. Accepting Warranty or Additional Liability. While redistributing the Work
or Derivative Works thereof, You may choose to offer, and charge a fee for,
acceptance of support, warranty, indemnity, or other liability obligations
and/or rights consistent with this License. However, in accepting such
obligations, You may act only on Your own behalf and on Your sole
responsibility, not on behalf of any other Contributor, and only if You agree
to indemnify, defend, and hold each Contributor harmless for any liability
incurred by, or claims asserted against, such Contributor by reason of your
accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS

APPENDIX: How to apply the Apache License to your work.

To apply the Apache License to your work, attach the following boilerplate
notice, with the fields enclosed by brackets "[]" replaced with your own
identifying information. (Don't include the brackets!) The text should be
enclosed in the appropriate comment syntax for the file format. We also
recommend that a file or class name and description of purpose be included on
the same "printed page" as the copyright notice for easier identification
within third-party archives.

Copyright [yyyy] [name of copyright owner]

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`;

export const FORMAL_MODEL_LICENSES: FormalModelLicense[] = [
  {
    name: 'RTMDet-Ins-m',
    purpose: '人物检测与实例分割',
    bundledFile: 'rtmdet-ins_m_640x640.onnx',
    version: 'rtmdet-ins_m_8xb32-300e_coco · 2022-11-23 · 640×640 ONNX 导出',
    sha256: '6041DDED9177D5BD0BCA9E3AA264CEB99EC1FF7B0D53320D2433587704840FCA',
    license: 'Apache License 2.0',
    sourceUrl: 'https://github.com/open-mmlab/mmdetection/tree/main/configs/rtmdet',
    downloadUrl: 'https://download.openmmlab.com/mmdetection/v3.0/rtmdet/rtmdet-ins_m_8xb32-300e_coco/rtmdet-ins_m_8xb32-300e_coco_20221123_001039-6eba602e.pth',
    downloadNote: '上游原始 PTH；软件随附文件是由该权重导出的 ONNX。',
    licenseText: APACHE_2_0,
  },
  {
    name: 'YuNet',
    purpose: '人脸检测',
    bundledFile: 'face_detection_yunet_2023mar.onnx',
    version: 'face_detection_yunet_2023mar',
    sha256: '8F2383E4DD3CFBB4553EA8718107FC0423210DC964F9F4280604804ED2552FA4',
    license: 'MIT License',
    sourceUrl: 'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet',
    downloadUrl: 'https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx?download=true',
    downloadNote: '上游发布的 ONNX，与软件随附文件对应。',
    licenseText: mitLicense('Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>'),
  },
  {
    name: 'AdaFace IR-18',
    purpose: '跨图片人物身份识别 · 低质量人脸特征提取',
    bundledFile: 'adaface_ir18_webface4m.onnx',
    version: 'IR-18 · WebFace4M · ONNX 导出',
    sha256: '6B6A35772FB636CDD4FA86520C1A259D0C41472A76F70F802B351837A00D9870',
    license: 'MIT License',
    sourceUrl: 'https://github.com/mk-minchul/AdaFace',
    downloadUrl: 'https://drive.google.com/file/d/1J17_QW1Oq00EhSWObISnhWEYr2NNrg2y/view?usp=sharing',
    downloadNote: '上游 R18 WebFace4M checkpoint；组件随附文件是由该权重导出的 ONNX。',
    licenseText: mitLicense('Copyright (c) 2022 Minchul Kim'),
  },
  {
    name: 'OSNet x1.0',
    purpose: '跨图片人物身份识别 · 身体外观特征辅助识别',
    bundledFile: 'osnet_x1_0_msmt17.onnx',
    version: 'osnet_x1_0_msmt17_combineall · 150 epochs · ONNX 导出',
    sha256: '7F545CFF27644DCC7481D53B2F6DF0B4BA22CEFF71F1A839C83A1BE5C0973EAE',
    license: 'MIT License',
    sourceUrl: 'https://github.com/KaiyangZhou/deep-person-reid',
    downloadUrl: 'https://huggingface.co/kaiyangzhou/osnet/resolve/main/osnet_x1_0_msmt17_combineall_256x128_amsgrad_ep150_stp60_lr0.0015_b64_fb10_softmax_labelsmooth_flip_jitter.pth?download=true',
    downloadNote: '上游原始 PTH；组件随附文件是由该权重导出的 ONNX。',
    licenseText: mitLicense('Copyright (c) 2018 Kaiyang Zhou'),
  },
  {
    name: 'PairDETR',
    purpose: '人物检测与裁图增强版 · 脸与身体联合检测和对应',
    bundledFile: 'pytorch_model.bin（高级包内部）',
    version: 'MTSAIR/PairDETR · 代码提交 fbcdebdff44bb5e9e6a9d92240ff01f8eec30ebc',
    sha256: '1B3545455B69164B90B833F38ED64819F3A12F5F2332AB4BA9621B0B04A08D3C',
    license: 'MIT License（模型权重）',
    sourceUrl: 'https://github.com/mts-ai/pairdetr',
    downloadUrl: 'https://huggingface.co/MTSAIR/PairDETR/resolve/main/pytorch_model.bin?download=true',
    downloadNote: 'Hugging Face 模型卡将权重标注为 MIT；上游代码仓库的许可情况应独立核对。',
    licenseText: mitLicense('PairDETR model weights · MTSAIR'),
  },
  {
    name: 'SAM 2.1 Hiera Large',
    purpose: '人物检测与裁图增强版 · 精细人物蒙版',
    bundledFile: 'sam2.1_hiera_large.pt（高级包内部）',
    version: 'SAM 2.1 · 代码提交 2b90b9f5ceec907a1c18123530e92e794ad901a4',
    sha256: '2647878D5DFA5098F2F8649825738A9345572BAE2D4350A2468587ECE47DD318',
    license: 'Apache License 2.0',
    sourceUrl: 'https://github.com/facebookresearch/sam2',
    downloadUrl: 'https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt',
    downloadNote: 'Meta 官方 SAM 2.1 Hiera Large checkpoint，与高级包内部文件对应。',
    licenseText: APACHE_2_0,
  },
];
