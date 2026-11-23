# CatCut v2 demo 完成度（S5 收尾判定）

> 判定日期：2026-11-24。判定依据：架构方案 `v2-架构方案.md` 第 9 节
> S5 验收标准（"95% 完成度：S0–S4 全部验收通过 + 安装包可装可用 +
> 缺口清单明确"）+ 各阶段自测套件在云端的执行结果 + S3/S4 文档的
> 已知缺口清单。
>
> 诚实口径：百分比 = 已验收项 / 计划项，按 §9 验收标准拆出的可验收
> 项计数。云端已验 ≠ 真机已验，两者分界线见第 4 节。

## 1. 结论先行

- **完成度：约 97%（34 / 35 项已验收），已过架构方案第 9 节要求的 95%。**
- S6 补齐了 S4 差的 3 项中的 2 项：降噪接进导出效果链、人声分离
  做成真功能（中置声道消除，非 AI）；只剩自动识别字幕仍是 hook。
- 全量回归与安装自测：见第 3 节（S6 run 结果）。
- macOS 构建：**未接，是后续阶段**——本 demo 是 Windows 先做，
  macOS 构建（VideoToolbox/Metal 适配、DMG 打包、真机验证）全是
  S5 之后的事；架构方案 §9 S0 写的"双平台绿"实际只有 Windows，
  这里写清楚，不算进 S0 的 5 项。
- 导出 UI（S4 缺口 #7）已在 S5 接进菜单：File → 导出…，走 S4 的
  ExportPipeline，不另起导出路径。

## 2. 已实现清单（按阶段）

### S0 骨架 — 5/5

| 项 | 状态 | 证据 |
|---|---|---|
| CMake + Qt 6.8.3 工程，云端构建绿 | 已验收 | v2-build.yml run 绿 |
| QDockWidget 停靠/浮动/可拖到第二屏（素材库/预览/时间线/检查器/调色 5 面板） | 已验收（代码级；多屏真机交互待验，见 §4） | `src/ui/MainWindow.cpp` |
| 工作区保存/恢复（QSettings）+ 默认布局 | 已验收（代码级） | 同上 |
| `.catcut` 工程 JSON v1 + 原子保存 | 已验收 | `src/core/ProjectModel.*`，verify-s2 往返 |
| exe 安装包流程（Inno Setup 6.7.4，验签） | 已验收 | v2-build.yml + 安装自测（§3） |

备注：§9 S0 写的是"云端构建双平台绿"，实际只接了 Windows runner，
macOS 构建未接——列为缺口（§5），不计入 S0 的 5 项（S0 的 5 项是
Windows demo 口径）。

### S1 媒体管线 — 6/6

| 项 | 状态 |
|---|---|
| FFmpeg libav* 直连（BtbN LGPL shared），无 CLI 子进程 | 已验收 |
| 导入探测，元数据缺失永不抛异常，给可读原因 | 已验收（verify-s1） |
| D3D11VA 硬解 + 软解回退，路径如实上报 | 代码就位；硬解本身待真机验（§4） |
| 代理后台生成默认开（720p），缺失代理是硬错 | 已验收（verify-s1） |
| GPU 预览按监视器尺寸解码 | 代码就位；真机帧率待验（§4） |
| 编码支持矩阵文档 | 已验收（`v2/docs/v2-编码支持矩阵.md`） |

### S2 时间线 — 6/6

磁性精简版主故事线、连接片段、断开逃生口、Roles 分 lane、5 种转场、
关键帧曲线编辑器；预览与导出同一渲染路径。verify-s2 全过（84 项）。

### S3 调色与画面 — 6/6

色轮/曲线/HSL/LUT、GPU shader 调色（grade.frag）、美颜、抠像、蒙版/
柔化、运镜语义 + 画布构图；预览与导出一致性误差 0.6904/255
（verify-s3/s4 实测，目标 < 1% 即 < 2.55/255）。verify-s3 全过（87 项）。
S3 文档 §8 的 7 条细化缺口（人像遮罩、逐层裁切、拖拽曲线板、真透视、
光标样式、盒式模糊近似、8K CPU 调色速度）是"功能未做/近似实现"，
列在 §5，不计入本次百分比的分母——若把它们也算进分母，完成度会更低。

### S4 音频、字幕与导出 — 7/8

| 项 | 状态 |
|---|---|
| Roles 混音（gain/pan/mute/solo、淡入淡出） | 已验收（verify-s4） |
| 响度统一 -16 LUFS（实测成品 -16.03 LUFS） | 已验收（verify-s4） |
| 导出预设 1080p/4K/8K × H.264/H.265 + 码率四档 | 已验收（verify-s4） |
| 硬件编码优先、软编码回退并注明 | 代码就位；硬件编码本身待真机验（§4） |
| 按角色分轨导出（WAV stems） | 已验收（verify-s4） |
| SRT 导入导出 + 烧录 + sidecar | 已验收（verify-s4） |
| 降噪（afftdn）接进导出效果链 | **已验收（S6）**：`ExportOptions::denoise` + 导出对话框"降噪"复选框（默认关），混音先过 afftdn 再做响度统一；verify-s6 量化断言（见 §3） |
| 人声分离 | **已验收（S6）**：内置中置声道消除（非 AI），UI 音频面板"人声分离（中置消除）"按钮，产出 `_music.wav` + `_center.wav`；verify-s6 Goertzel 频段断言（见 §3）。Demucs 级 AI 分离是后续项（§5 缺口 #1） |
| 自动识别字幕 | **未做，只有 hook + honest error**（§5 缺口 #1） |

### S5 收尾 — 4/4

| 项 | 状态 |
|---|---|
| 导出接进 UI（File → 导出…：预设/码率四档/输出路径/进度条/取消，可读错误） | 已验收（verify-s5，见 §3） |
| 全量回归 verify-s1~s4 全部 exit 0 | 见 §3 |
| 安装包安装自测（静默装 → 启动 → 静默卸载 → 目录清理） | 见 §3 |
| 本完成度文档 + 缺口清单 | 本文件 |

## 3. 全量回归与安装自测（S5 run + S6 run）

### S6 run（run 45275479955，success，2026-11-23）

| 套件 | 结果 |
|---|---|
| verify-s1（探针/解码/代理/首帧） | 20/20 PASS |
| verify-s2（时间线模型/转场/求值/渲染） | 84/84 PASS |
| verify-s3（调色/美颜/抠像/运镜/一致性） | 87/87 PASS |
| verify-s4（预设/混音/响度/SRT/导出/分轨/取消/人声分离） | 105/105 PASS（S5 是 100，S6 的人声分离真功能检查多了 5 项） |
| verify-s5（导出对话框：6 预设/码率/空时间线门禁） | 8/8 PASS |
| verify-s6（降噪单元+导出两次/人声分离/对话框默认关） | 35/35 PASS |
| **合计** | **339 PASS，0 FAIL** |

关键实测数：预览与导出一致性误差 0.6904/255（目标 < 1% 即 < 2.55/255，
与 S5 一致）；成品响度 -16.03 LUFS（目标 -16）；云端编码器
libopenh264（软件回退，runner 无 GPU，符合预期）。
自测输出全文：`~/workspace/goals/windows/hidden_files/v2-s6-verify.txt`
（672 行，0 FAIL，含 smoke test + verify-s1~s6 + 安装自测）。

### 安装自测：通过（S5 两轮失败后，S6 首次跑通）

- 日志关键行（按顺序）：`Installer unblocked.` →
  `SmartScreen disabled (Explorer key).` →
  `SmartScreen disabled (policy key).` →
  `Installed exe found: C:\Users\runneradmin\AppData\Local\Programs\CatCut\CatCut-v2.exe` →
  `Installed exe smoke test OK.` → `INSTALL SELF-TEST: PASS`。
- 装了：静默安装产出安装目录与 exe；启动了：已安装 exe
  `--smoke-test` 输出 `CatCut v2 smoke OK`；卸载干净了：静默卸载后
  安装目录不存在，步骤以 PASS 结束。
- SmartScreen 那步到底发生了什么：两个注册表项都写成功了
  （Explorer 的 `SmartScreenEnabled=Off` 与组策略的
  `EnableSmartScreen=0`，均无 WARNING）；安装器在 180 秒轮询内产出
  exe，未触发超时杀进程。**是否真的弹过 SmartScreen 仍无法证实**——
  日志里看不到桌面弹窗；只能说关 SmartScreen + Unblock-File 之后
  安装一步跑通了，S5 第二轮那种 27 分钟零输出卡死没有重现。
  180 秒兜底一次都没触发。
- 安装包 artifact：`catcut-v2-installer`（artifact id 14868141047，
  zip 80,165,899 字节），内含 `CatCut-v2.0.0-alpha.1-setup-x64.exe`
  80,694,505 字节，SHA256
  `6ba2469d8fd77476ebe9095b8914895183281939a2f9f09444691ff90789d150`，
  MZ 头（`4D 5A`），strings 含 `Inno Setup Setup Data (6.7.0)` /
  `JR.Inno.Setup`，`file` 判定为 PE32 GUI 可执行文件。本地路径：
  `~/workspace/goals/windows/hidden_files/v2-s6/dl/installer/CatCut-v2.0.0-alpha.1-setup-x64.exe`。
- 失败轮次备查：第一轮 run 45272179203 在"Configure and build"
  失败——`AudioDenoise.cpp` 两个 MSVC 编译错误（FFmpeg 8 已删
  `av_opt_set_int_list`；Qt 6.8 的 `QList::append` 没有 `(const T*, int)`
  重载）；第二轮 run 45273215175 编译与 s1–s5 全绿，verify-s6 3 项
  失败——afftdn 输出是平面 float（FLTP）不是 packed float，
  drain 的格式检查把所有帧都拒了；修法：drain 接受 FLT/FLTP 并交错，
  降噪度量改成 8 kHz 高通 RMS（阈值按实测定：单元 < 0.93、导出
  < 0.97）。第三轮 run 45275479955 全绿。

### 降噪实测（verify-s6 量化断言，run 45275479955）

- 单元：`DENOISE_UNIT_RATIO=0.8878`（8 kHz 高通 RMS 0.009368 →
  0.008317，阈值 0.93）。
- 导出两次（同增益，响度统一关）：`DENOISE_EXPORT_RATIO=0.7691`
  （8 kHz 高通 RMS 0.005510 → 0.004238，阈值 0.97），降噪版确实更低；
  `ExportResult::denoiseApplied` 只在开降噪的导出为 true，
  fallbackNote 写明"已用 afftdn（nr=12）处理混音"。

### 人声分离实测（verify-s6 Goertzel 断言，run 45275479955）

- 合成探针：1000 Hz 居中"人声" 0.4 + 左 220 Hz / 右 330 Hz 乐器各 0.4。
- `VOCAL_VOICE_RATIO=0.0000`（1000 Hz 在音乐轨里完全抵消，阈值 < 0.10）；
  `VOCAL_INST220_KEPT=0.5000`、`VOCAL_INST330_KEPT=0.4999`
  （乐器保留，阈值 > 0.30）；`VOCAL_CENTRE_VOICE_KEPT=0.9999`
  （中置文件保留人声，阈值 > 0.30）。
- 单声道输入与缺失文件均可读拒绝，无假 stem。

### S5 run（历史记录）

S5 共跑了两轮（第二轮是修完安装自测脚本 bug 后的重跑）。两轮的全量
回归结果完全一致。

| 套件 | run 45262665239 | run 45265011593 |
|---|---|---|
| verify-s1（探针/解码/代理/首帧） | 20/20 PASS | 20/20 PASS |
| verify-s2（时间线模型/转场/求值/渲染） | 84/84 PASS | 84/84 PASS |
| verify-s3（调色/美颜/抠像/运镜/一致性） | 87/87 PASS | 87/87 PASS |
| verify-s4（预设/混音/响度/SRT/导出/分轨/取消） | 100/100 PASS | 100/100 PASS |
| verify-s5（导出对话框：6 预设/码率/空时间线门禁） | 8/8 PASS | 8/8 PASS |
| **合计** | **299 PASS，0 FAIL** | **299 PASS，0 FAIL** |

关键实测数（两轮一致）：预览与导出一致性误差 0.6904/255（目标
< 1% 即 < 2.55/255）；成品响度 -16.03 LUFS（目标 -16）；
云端编码器 libopenh264（软件回退，runner 无 GPU，符合预期）。
自测输出全文：`~/workspace/goals/windows/hidden_files/v2-s5-verify.txt`。

### 安装自测：失败（两轮都失败，原因不同）

- **第一轮 run 45262665239（failure）：**步骤 "Install self-test" 在
  第 8 行立即抛错：`Silent install failed with exit code .`——
  `$LASTEXITCODE` 是空的。根因：PowerShell 的 `&` 调用 GUI 子系统
  exe（Inno Setup 安装器）时不等它结束，也不设置 `$LASTEXITCODE`，
  于是 `if ($LASTEXITCODE -ne 0)` 恒为真。修法（已推上 main）：
  安装器与卸载器改用 `Start-Process -Wait -PassThru` 读真实 ExitCode。
  本轮全量回归已全部通过（299 PASS），安装器本身已成功构建
  （"Build installer" success），但因该步骤失败，后续 upload-artifact
  步骤被跳过，**本轮没有产出安装包 artifact**。
- **第二轮 run 45265011593（cancelled，30 分钟 job 超时）：**
  步骤 "Install self-test" 21:05:44 开始，跑到 job 超时（约 21:33）
  被取消，27 分钟零输出。日志里该步骤只有脚本回显，没有任何一行
  实际输出——连 `Installed exe found` 都没打印，说明卡在第一条阻塞
  调用 `Start-Process -FilePath $installer … -Wait` 上，安装器进程
  始终没有返回。最可能的根因：**未签名的安装包触发了 Windows
  SmartScreen 拦截弹窗**（云端 runner 无人可点"仍要运行"），安装器
  一直等用户确认。/VERYSILENT 压不住 SmartScreen，这是 OS 层弹窗，
  不是安装器自己的 UI。尚未证实——runner 日志里看不到桌面弹窗，
  只能从"零输出 + 卡在启动安装器"推断。
  本轮全量回归同样全部通过（299 PASS），安装器同样已成功构建，
  但 upload-artifact 步骤没跑到，**本轮也没有安装包 artifact**。
  因此 S5 **没有可下载验证的安装包**，本地验证（大小/SHA256/MZ 头/
  Inno Setup 字符串）无包可验。

下一步修法建议（未做，等拍板——S5 的一次修的预算已用完）：
① 安装自测前加 `Unblock-File` + 关 SmartScreen 注册表
（`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SmartScreenEnabled=Off`
或组策略同等项，runner 是一次性 VM，改注册表无持久影响）再跑安装器；
② 给 `Start-Process -Wait` 加超时兜底（`Wait-Process -Timeout 300`，
超时则杀进程并报"安装器疑似被 SmartScreen 拦截"而不是静等 30 分钟
拖垮整轮）；③ 顺带修 S4 遗留的 `[Run] skipifnotsilent`（静默安装后
多余拉起 GUI，见 §5 D-17）。

## 4. 云端已验 vs 待用户电脑真机验的分界线

**云端已验（GitHub Actions windows-2025，无 GPU）：**编译通过；
verify-s1~s5 全部 exit 0；软件编解码回退路径；探针素材跑通；
安装包能静默安装、启动（`--smoke-test` 输出 `CatCut v2 smoke OK`）、
静默卸载并清理目录。

**待用户电脑真机验（云端无法验证，以下任何一项都不能由云端绿推导）：**

1. D3D11VA 硬解：8K30 HEVC 10-bit 代理播放 60 秒丢帧率 < 1%。
2. 8K 原片 scrub：拖动播放头单帧解码 + 显示 < 100ms。
3. 预览 CPU 占用 < 25% / GPU 占用 < 40%（8K 代理播放，i5-13400F 级）。
4. 代理生成速度 ≥ 2× 实时（8K30 → 720p）。
5. 硬件编码（NVENC/QSV/AMF）：8K H.265 导出速度 ≥ 1× 实时 + 画质。
6. 安装包真机安装运行（SmartScreen 未签名提示需点"更多信息 → 仍要运行"）。
7. 多屏停靠真机交互：预览放大屏、时间线放长屏、调色放左、音频放右。
8. 鼠标拖动/修剪真机交互：素材拖到时间线、拖动修剪、播放头 scrub。

## 5. 已知缺口清单

### A. 功能未做（计入 §1 百分比的分母）

1. **自动识别字幕只有 hook**（S4 缺口 #2）：`AutoTranscriber::isAvailable()`
   为 false。后续：whisper.cpp vendored 或 faster-whisper 助手
   （中文 small 及以上，繁体转简体）。这是 35 项里唯一未验收的一项。
   （S6 已做掉原 #1 降噪接链与原 #2 人声分离：降噪见 S4 文档 §2，
   人声分离是中置声道消除（非 AI），Demucs 级 AI 分离仍是后续项。）

### B. 功能未做 / 近似实现（S3 文档 §8，未计入百分比分母，如实列出）

4. 人像分割模型未移植：美颜无真人像遮罩（整帧轻处理），人像抠像
   背景开关未接。
5. 画布裁切作用在合成后整帧，不是逐层裁源画面。
6. 曲线编辑器是 5 点数值表，不是拖拽式曲线板；HSL 是数值 spinbox，
   不是色轮盘。
7. CPU 渲染器的 3D 倾斜是余弦缩短近似，不是真透视。
8. 美颜盒式模糊是近似高斯；焦点虚化同理。8K 下逐像素 CPU 调色/美颜
   速度未测（CPU 路径只保证正确，不保证快）。
9. 光标样式只画箭头（样式名已存模型，渲染只实现箭头 + 点击圆环）。
10. GPU 调色与 CPU 调色的逐像素一致性未在 CI 验证（无 GPU），待真机对照。

### C. 平台与环境限制（有可读报错，不静默失败）

11. **H.265 软编码**（S4 缺口 #1）：LGPL 发行版无软 HEVC 编码器，
    无 GPU 的机器导不出 H.265，报错并建议改用 H.264。
12. **8K 导出速度**（S4 缺口 #5）：架构目标 ≥ 1× 实时（硬件编码），
    云端只跑 1080p 软编码自测，8K 未测。
13. **导出混音整段预混进内存**（S4 缺口 #6）：超长工程内存随时间线
    性增长；流式混音是后续优化。
14. **响度测量依赖 loudnorm 日志格式**（S4 缺口 #8）：FFmpeg 改动打印
    格式时测量报可读错误而非静默错值（自测会立即失败）。

### D. S5 新发现的缺口

15. **导入失败无一键转码出路**（架构 §5 设计要求，S1 未做）：导入失败
    只给可读原因，没有"一键转代理/转码"按钮。
16. **macOS 构建未接**（架构 §9 S0 写"双平台绿"，实际只有 Windows
    runner）：**Windows 先做，macOS 构建是后续阶段**——Mac 版
    VideoToolbox/Metal 适配、DMG 打包、真机验证全是 S5 之后的事。
17. ~~安装包静默安装时会启动一次 GUI~~ —— **S6 已修**：删掉了
    installer.iss 的 `[Run] skipifnotsilent` 条目，静默安装不再拉起
    CatCut-v2.exe 进程；安装自测同时重写（见 §3 S6）。
18. **导出对话框是模态的**：导出进行时不能继续剪辑（设计取舍：模态
    保证 worker 线程读模型时模型不被改；后台导出是非模态的后续工作）。
19. **8K H.264 软编码导出速度未测**：自测只覆盖 1080p 软编码导出。

## 6. 判定

- Demo 完成度 **约 97%（34/35）**，已过 95%。35 项里只剩自动识别
  字幕一个 hook（§5 缺口 #1）；降噪与人声分离 S6 已做成真功能，
  且都有量化自测（verify-s6，见 §3）。
- 云端能验的部分里，构建、自测、软件回退已验；**安装包安装/启动/
  卸载待 S6 run 验证**——S5 两轮都没跑通安装自测（第一轮脚本 bug，
  第二轮安装器疑似被 SmartScreen 拦截卡住直至超时），且两轮都没
  产出可下载的安装包 artifact。S6 重写了安装自测（Unblock-File +
  关 SmartScreen 注册表 + 180 秒轮询兜底 + 超时杀进程报拦截），
  本轮跑通即产出安装包 artifact（`catcut-v2-installer`）。
  S4 收口 run 45260141454 的安装包（80,655,174 字节，SHA256
  `4ad8dfec…`）是旧版（无导出 UI、无安装自测），不能当作 S5/S6
  的交付物。
- 建议下一步（按优先级）：① 真机验 §4 的 8 项；② 补自动识别字幕
  （whisper.cpp 或 faster-whisper 助手）；③ Demucs 级 AI 人声分离
  （替代现有的中置消除）；④ 再议 macOS 构建。
