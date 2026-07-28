export interface ThirdPartySoftwareLicense {
  group: '主程序' | '本地组件' | '人物检测增强包';
  name: string;
  version: string;
  purpose: string;
  license: string;
  sourceUrl: string;
  licenseUrl: string;
  note?: string;
  attention?: boolean;
}

export const THIRD_PARTY_SOFTWARE_LICENSES: ThirdPartySoftwareLicense[] = [
  { group: '主程序', name: 'PhotoFlow 应用代码', version: '26.7.28', purpose: '本软件界面、工作流与本地服务代码', license: '尚未声明', sourceUrl: 'https://github.com/akiyastudio/photoflow', licenseUrl: 'https://github.com/akiyastudio/photoflow', note: '代码仓库根目录目前没有 LICENSE。公开发布源码前应明确选择并随仓库提供本软件自己的许可证。', attention: true },
  { group: '主程序', name: 'Electron', version: '30.5.1', purpose: '桌面应用运行框架', license: 'MIT', sourceUrl: 'https://github.com/electron/electron', licenseUrl: 'https://github.com/electron/electron/blob/main/LICENSE' },
  { group: '主程序', name: 'Chromium', version: '随 Electron 30.5.1', purpose: '网页渲染与多媒体运行环境', license: 'BSD-3-Clause + 第三方许可', sourceUrl: 'https://chromium.googlesource.com/chromium/src/', licenseUrl: 'https://chromium.googlesource.com/chromium/src/+/main/LICENSE', note: '发布包还必须保留 Electron 随附的 LICENSES.chromium.html。' },
  { group: '主程序', name: 'Node.js', version: '随 Electron 30.5.1', purpose: '主进程与本地文件功能', license: 'MIT + 第三方许可', sourceUrl: 'https://github.com/nodejs/node', licenseUrl: 'https://github.com/nodejs/node/blob/main/LICENSE' },
  { group: '主程序', name: 'React / React DOM', version: '18.3.1', purpose: '界面渲染', license: 'MIT', sourceUrl: 'https://github.com/facebook/react', licenseUrl: 'https://github.com/facebook/react/blob/main/LICENSE' },
  { group: '主程序', name: 'Lucide React', version: '0.344.0', purpose: '界面图标', license: 'ISC', sourceUrl: 'https://github.com/lucide-icons/lucide', licenseUrl: 'https://github.com/lucide-icons/lucide/blob/main/LICENSE' },
  { group: '主程序', name: 'exiftool-vendored', version: '30.5.0', purpose: 'ExifTool 进程管理与元数据读取', license: 'MIT', sourceUrl: 'https://github.com/photostructure/exiftool-vendored.js', licenseUrl: 'https://github.com/photostructure/exiftool-vendored.js/blob/main/LICENSE' },
  { group: '主程序', name: 'ExifTool', version: '13.35', purpose: '照片和视频元数据读取', license: 'Artistic License 1.0 或 GPL', sourceUrl: 'https://exiftool.org/', licenseUrl: 'https://dev.perl.org/licenses/' },

  { group: '本地组件', name: 'Python', version: '3.12.10', purpose: '文件工具与可选组件运行时', license: 'PSF License', sourceUrl: 'https://github.com/python/cpython', licenseUrl: 'https://docs.python.org/3/license.html' },
  { group: '本地组件', name: 'PyInstaller', version: '6.17.0', purpose: '生成自包含组件可执行文件', license: 'GPL-2.0-or-later（Bootloader 例外）', sourceUrl: 'https://github.com/pyinstaller/pyinstaller', licenseUrl: 'https://pyinstaller.org/en/stable/license.html', note: '例外允许分发由 PyInstaller 生成的应用；修改 PyInstaller 本身时仍需遵守 GPL。' },
  { group: '本地组件', name: 'NumPy', version: '2.2.6', purpose: '图像和向量计算', license: 'BSD-3-Clause', sourceUrl: 'https://github.com/numpy/numpy', licenseUrl: 'https://github.com/numpy/numpy/blob/main/LICENSE.txt' },
  { group: '本地组件', name: 'Pillow', version: '12.0.0', purpose: '图片读取、缩略图和颜色处理', license: 'HPND', sourceUrl: 'https://github.com/python-pillow/Pillow', licenseUrl: 'https://github.com/python-pillow/Pillow/blob/main/LICENSE' },
  { group: '本地组件', name: 'OpenCV / opencv-python-headless', version: '4.12.0.88', purpose: '视频、人物检测前后处理与图像合成', license: 'Apache-2.0', sourceUrl: 'https://github.com/opencv/opencv', licenseUrl: 'https://github.com/opencv/opencv/blob/4.x/LICENSE' },
  { group: '本地组件', name: 'ONNX Runtime DirectML', version: '1.24.4', purpose: 'CPU 与 DirectML 模型推理', license: 'MIT', sourceUrl: 'https://github.com/microsoft/onnxruntime', licenseUrl: 'https://github.com/microsoft/onnxruntime/blob/main/LICENSE' },
  { group: '本地组件', name: 'Send2Trash', version: '1.8.3', purpose: '将文件安全移动到系统回收站', license: 'BSD-3-Clause', sourceUrl: 'https://github.com/arsenetar/send2trash', licenseUrl: 'https://github.com/arsenetar/send2trash/blob/main/LICENSE' },
  { group: '本地组件', name: 'FFmpeg', version: '7.1 essentials build', purpose: '视频预览、切分与转码', license: 'GPL-3.0-or-later', sourceUrl: 'https://ffmpeg.org/', licenseUrl: 'https://www.gnu.org/licenses/gpl-3.0.html', note: '当前二进制启用了 --enable-gpl、--enable-version3、libx264 和 libx265。发布时必须同时提供对应源码、完整构建参数及 GPL 声明。', attention: true },

  { group: '人物检测增强包', name: 'Ubuntu 与系统软件包', version: 'PhotoFlowNative 镜像内版本', purpose: 'WSL 2 基础环境', license: '多种自由软件许可证', sourceUrl: 'https://ubuntu.com/', licenseUrl: 'https://ubuntu.com/legal/intellectual-property-policy', note: '完整软件包版权文件保存在镜像的 /usr/share/doc/*/copyright。' },
  { group: '人物检测增强包', name: 'Miniforge / conda', version: 'PhotoFlowNative 镜像内版本', purpose: '隔离 Python 环境', license: 'BSD-3-Clause + 软件包各自许可', sourceUrl: 'https://github.com/conda-forge/miniforge', licenseUrl: 'https://github.com/conda-forge/miniforge/blob/main/LICENSE' },
  { group: '人物检测增强包', name: 'PyTorch / TorchVision', version: '2.10.0 / 0.25.0 · CUDA 12.8', purpose: 'PairDETR 与 SAM 2.1 推理', license: 'BSD-3-Clause', sourceUrl: 'https://github.com/pytorch/pytorch', licenseUrl: 'https://github.com/pytorch/pytorch/blob/main/LICENSE' },
  { group: '人物检测增强包', name: 'Transformers', version: '4.27.3', purpose: 'PairDETR 模型结构与预处理', license: 'Apache-2.0', sourceUrl: 'https://github.com/huggingface/transformers', licenseUrl: 'https://github.com/huggingface/transformers/blob/main/LICENSE' },
  { group: '人物检测增强包', name: 'NVIDIA CUDA 运行库', version: 'PyTorch CUDA 12.8 依赖', purpose: 'NVIDIA GPU 推理', license: 'NVIDIA 专有许可', sourceUrl: 'https://developer.nvidia.com/cuda-toolkit', licenseUrl: 'https://docs.nvidia.com/cuda/eula/', note: '不是开源组件；公开分发预封装镜像前必须确认 CUDA 运行库的再分发范围。', attention: true },
  { group: '人物检测增强包', name: 'PairDETR 代码', version: 'fbcdebdff44bb5e9e6a9d92240ff01f8eec30ebc', purpose: '脸与身体联合检测服务', license: '上游代码授权未明确', sourceUrl: 'https://github.com/mts-ai/pairdetr', licenseUrl: 'https://huggingface.co/MTSAIR/PairDETR', note: '模型权重卡标注 MIT，但代码仓库没有明确独立许可证；公开分发高级包前需要取得授权确认。', attention: true },
  { group: '人物检测增强包', name: 'SAM 2.1 代码', version: '2b90b9f5ceec907a1c18123530e92e794ad901a4', purpose: '精细人物蒙版推理', license: 'Apache-2.0', sourceUrl: 'https://github.com/facebookresearch/sam2', licenseUrl: 'https://github.com/facebookresearch/sam2/blob/main/LICENSE' },
];
