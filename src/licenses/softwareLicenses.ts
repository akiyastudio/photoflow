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
  { group: '主程序', name: '照片流应用代码', version: __APP_VERSION__, purpose: '本软件界面、工作流与本地服务代码', license: '专有软件 · 保留所有权利', sourceUrl: 'https://github.com/akiyastudio/photoflow', licenseUrl: 'https://github.com/akiyastudio/photoflow/blob/main/LICENSE', note: '照片流自主代码不属于开源软件，未经版权所有者书面授权不得复制、修改、分发或再许可；第三方组件仍适用各自许可证。' },
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
  { group: '本地组件', name: 'pi-heif', version: '1.4.0', purpose: 'HEIC、HEIF 与 HIF 图片解码及 Pillow 集成', license: 'BSD-3-Clause', sourceUrl: 'https://github.com/bigcat88/pillow_heif', licenseUrl: 'https://github.com/bigcat88/pillow_heif/blob/master/LICENSE.txt', note: '安装包使用仅解码版本，不包含 x265 或 HEIF 编码功能。Windows 二进制包同时包含 LGPL-3.0 的 libheif 与 libde265。' },
  { group: '本地组件', name: 'libheif / libde265', version: '1.23.0 / 1.1.1', purpose: 'HEIF 容器解析与 HEVC 图片解码', license: 'LGPL-3.0', sourceUrl: 'https://github.com/strukturag/libheif', licenseUrl: 'https://github.com/strukturag/libheif/blob/master/COPYING', note: '由 pi-heif 的 Windows 二进制包携带，仅启用解码能力。' },
  { group: '本地组件', name: 'OpenCV / opencv-python-headless', version: '4.12.0.88', purpose: '视频、人物检测前后处理与图像合成', license: 'Apache-2.0', sourceUrl: 'https://github.com/opencv/opencv', licenseUrl: 'https://github.com/opencv/opencv/blob/4.x/LICENSE' },
  { group: '本地组件', name: 'ONNX Runtime DirectML', version: '1.24.4', purpose: 'CPU 与 DirectML 模型推理', license: 'MIT', sourceUrl: 'https://github.com/microsoft/onnxruntime', licenseUrl: 'https://github.com/microsoft/onnxruntime/blob/main/LICENSE' },
  { group: '本地组件', name: 'Send2Trash', version: '1.8.3', purpose: '将文件安全移动到系统回收站', license: 'BSD-3-Clause', sourceUrl: 'https://github.com/arsenetar/send2trash', licenseUrl: 'https://github.com/arsenetar/send2trash/blob/main/LICENSE' },
  { group: '本地组件', name: 'FFmpeg + x264 + zlib', version: 'FFmpeg 7.1.1 · x264/zlib 固定提交', purpose: '视频预览、PNG 抽帧、切分与 H.264 转码', license: 'GPL-2.0-or-later', sourceUrl: 'https://ffmpeg.org/', licenseUrl: 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html', note: '照片流使用固定源码提交的精简自建版本，只启用实际需要的 libx264 与 zlib 外部组件，其中 zlib 保留其宽松许可；禁用 x265、xvid、Avisynth、rubberband、nonfree 和网络功能。精确对应源码、构建材料和许可证按发行版本单独留存，不写入更新数据库。' },
  { group: '本地组件', name: 'mpv / libmpv', version: '0.41.0（高级视频解码组件）', purpose: '相机视频播放、硬件解码、缓存与音视频同步', license: 'LGPL-2.1-or-later', sourceUrl: 'https://github.com/mpv-player/mpv', licenseUrl: 'https://github.com/mpv-player/mpv/blob/master/Copyright', note: '组件仅接受 -Dgpl=false 的 libmpv，并强制校验所链接 FFmpeg 为 LGPL 构建且不含 GPL/nonfree 组件；对应源码、许可证、配置和文件哈希随组件归档提供。' },

  { group: '人物检测增强包', name: 'Ubuntu 与系统软件包', version: '照片流本地增强环境镜像内版本', purpose: 'WSL 2 基础环境', license: '多种自由软件许可证', sourceUrl: 'https://ubuntu.com/', licenseUrl: 'https://ubuntu.com/legal/intellectual-property-policy', note: '完整软件包版权文件保存在镜像的 /usr/share/doc/*/copyright。' },
  { group: '人物检测增强包', name: 'Miniforge / conda', version: '照片流本地增强环境镜像内版本', purpose: '隔离 Python 环境', license: 'BSD-3-Clause + 软件包各自许可', sourceUrl: 'https://github.com/conda-forge/miniforge', licenseUrl: 'https://github.com/conda-forge/miniforge/blob/main/LICENSE' },
  { group: '人物检测增强包', name: 'PyTorch / TorchVision', version: '2.10.0 / 0.25.0 · CUDA 12.8', purpose: 'PairDETR 与 SAM 2.1 推理', license: 'BSD-3-Clause', sourceUrl: 'https://github.com/pytorch/pytorch', licenseUrl: 'https://github.com/pytorch/pytorch/blob/main/LICENSE' },
  { group: '人物检测增强包', name: 'Transformers', version: '4.27.3', purpose: 'PairDETR 模型结构与预处理', license: 'Apache-2.0', sourceUrl: 'https://github.com/huggingface/transformers', licenseUrl: 'https://github.com/huggingface/transformers/blob/main/LICENSE' },
  { group: '人物检测增强包', name: 'NVIDIA CUDA 运行库', version: 'PyTorch CUDA 12.8 依赖', purpose: 'NVIDIA GPU 推理', license: 'NVIDIA 专有许可', sourceUrl: 'https://developer.nvidia.com/cuda-toolkit', licenseUrl: 'https://docs.nvidia.com/cuda/eula/', note: '不是开源组件；公开分发预封装镜像前必须确认 CUDA 运行库的再分发范围。', attention: true },
  { group: '人物检测增强包', name: 'PairDETR 代码', version: 'fbcdebdff44bb5e9e6a9d92240ff01f8eec30ebc', purpose: '脸与身体联合检测服务', license: '上游代码授权未明确', sourceUrl: 'https://github.com/mts-ai/pairdetr', licenseUrl: 'https://huggingface.co/MTSAIR/PairDETR', note: '模型权重卡标注 MIT，但代码仓库没有明确独立许可证；公开分发高级包前需要取得授权确认。', attention: true },
  { group: '人物检测增强包', name: 'SAM 2.1 代码', version: '2b90b9f5ceec907a1c18123530e92e794ad901a4', purpose: '精细人物蒙版推理', license: 'Apache-2.0', sourceUrl: 'https://github.com/facebookresearch/sam2', licenseUrl: 'https://github.com/facebookresearch/sam2/blob/main/LICENSE' },
];
