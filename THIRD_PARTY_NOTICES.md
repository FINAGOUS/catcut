# 第三方来源与许可

## DogSC 原作

- 项目：[laogou717/dogsc](https://github.com/laogou717/dogsc)
- 作者及原版权声明：Copyright (c) 2026 神烦老狗
- 许可：[MIT](LICENSE)。本仓库保留该版权声明，并将 Windows 改编源码同样以 MIT 发布。
- `Sources/`、原版资源和 macOS 构建文件来自下载的原作源码；`README.upstream.md` 保留原版说明。Windows 实现位于 `Windows/`。
- 本项目是非官方的 Windows 二创／适配版，不代表原作者，也不承诺原版功能完全兼容。

## FFmpeg / ffprobe

Windows 程序通过独立进程调用未修改的 `ffmpeg.exe` 和 `ffprobe.exe`。这些第三方程序保留其自身许可，不属于本项目的 MIT 授权范围。

- 使用的构建：Gyan `9.0.2-essentials_build-www.gyan.dev`，Windows x64 静态构建。
- 该构建的许可：GPL v3；原文见 [FFmpeg-LICENSE.txt](docs/third-party/FFmpeg-LICENSE.txt)。
- 版本、构建配置与包含的外部库版本：[原始构建说明](docs/third-party/FFmpeg-README.txt)。
- 二进制来源：[Gyan 9.0.2 Release](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2) 与 [Gyan 构建站点](https://www.gyan.dev/ffmpeg/builds/)。
- FFmpeg 主项目源码版本：[946fcce07b](https://github.com/FFmpeg/FFmpeg/commit/946fcce07b)。该版本的主项目源码快照另附于本仓库的 Windows Release 下载区；它不是 DOGsc Windows 的应用源码，也不是所有外部库源码的合并包。
- 外部库保留各自的许可；完整版本列表由 Gyan 原始 README 列明。其中包括 [x264](https://code.videolan.org/videolan/x264)、[x265](https://bitbucket.org/multicoreware/x265_git)、[Xvid](https://www.xvid.com/)、[vid.stab](https://github.com/georgmartius/vid.stab) 等。构建来源、许可证和源代码入口随下载页面一并保留。
- FFmpeg 官方许可说明：[ffmpeg.org/legal.html](https://ffmpeg.org/legal.html)。

发行 ZIP 中保留 `Windows/tools/FFmpeg-LICENSE.txt`、`FFmpeg-README.txt` 与 `FFmpeg-SOURCE.txt`。本项目没有更改或重新授权 FFmpeg，不对其第三方组件主张版权。

## 人像分割模型（W5 美颜遮罩）

美颜功能用的人像分割模型是 MediaPipe Selfie Segmentation（256×256，landscape 模型），以 ONNX 格式随包分发于 `Windows/tools/models/selfie_segmentation_256x256.onnx`，配套推理脚本 `Windows/tools/portrait_segment.py` 与 `Windows/tools/beauty_mask.py`。

- 许可：Apache License 2.0（商用可用，需保留署名与许可声明）。
- 来源：[MediaPipe Selfie Segmentation](https://developers.google.com/mediapipe/solutions/vision/image_segmenter) / 模型卡片 [mediapipe](https://github.com/google-ai-edge/mediapipe)。
- 本项目没有更改模型权重；模型只在用户本机运行推理，不上传任何画面。

## 插件宿主（W9 B 级扫描 + W10 A 级原生桥）

- W9：VST3 / OFX 插件只做发现与元数据展示：VST3 读 bundle 里的 `moduleinfo.json`，
  OFX 只认 bundle 结构与 `Win64/*.ofx` 二进制在不在；不加载任何插件代码。
- W10：原生 C++ 桥（`Windows/native/vst3/`，`CatCut.Vst3Bridge.dll` +
  `Vst3BridgeHost.exe` 子进程）真实加载 VST3 模块并离线处理音频；
  AGain 测试插件（SDK 自带示例）随包分发于 `Windows/bin/Plugins/AGain.vst3`。
  完整说明见 [插件评估与路线图](docs/windows/plugins.md)。
- 许可：VST3 SDK 3.8.0 起是 MIT（不再需要签 Steinberg 许可协议）。
  SDK（含 AGain 示例与 VSTGUI）不在仓库里，CI 构建时现取现编
  （`steinbergmedia/vst3sdk`，tag `v3.8.0_build_66`）。
  MIT 原文：Copyright (c) 2025, Steinberg Media Technologies GmbH。
  OFX API 与 Support 库是 BSD-3-Clause（本批没引入 OFX 代码）。
  “VST” 是 Steinberg Media Technologies GmbH 的注册商标，仅作格式名称使用，
  不声称 Steinberg 背书或关联。
- VST2 已废弃、AAX / AU 是别家专用格式，一律不扫描、不加载。

## 字体

随附阿里巴巴普惠体 3.0 Regular / Medium / SemiBold，文件保持原样。字体不使用 MIT，也不使用 OFL，按其原始授权声明使用与分发。

- [字体说明](Resources/Fonts/README.md)
- [完整许可原文](Resources/Fonts/LICENSE.txt)
- 官方来源：[阿里巴巴字体](https://www.alibabafonts.com/)

## 图片与截图

原版图标、界面参考图和柔光背景来自原项目。柔光背景的生成来源记录于 [SOURCE.json](Resources/Onboarding/SOURCE.json)。

`docs/windows/` 为本项目 Windows 版本的实际界面截图，使用随附柔光背景或程序生成的合成测试图，不含用户真实桌面、录屏、备忘录或项目内容。原版 macOS 截图保留于 `docs/images/`，README 的功能展示使用 Windows 截图。
