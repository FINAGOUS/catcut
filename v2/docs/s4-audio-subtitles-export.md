# CatCut v2 — S4 音频、字幕与导出

> 阶段：S4。复用 S2 的 TimelineEvaluator 逐帧求值 + S3 的共享渲染路径
> （TimelineFrameRenderer / ExportFrameRenderer）；导出不另起渲染。
> 响度目标 -16 LUFS；码率推荐档 = 像素数 × 帧率 / 6（DogSC 公式）。

## 1. 导出管线（ExportPipeline）

入口：`src/media/ExportPipeline.{h,cpp}`。

- **视频**：每帧 `t = i / fps`，经 `ExportFrameRenderer::renderExportFrame`
  （Evaluator → FrameScene → TimelineFrameRenderer，与预览同一条路）
  得到 RGBA 帧 → swscale 转 YUV420P → libavcodec 编码 → MP4/MOV 复用。
  导出永远从原始素材重链：渲染器直接解码 `Clip::mediaPath`，本文件
  任何地方都不读代理——代理只用于预览（架构硬规矩 4）。
- **编码器探测**（按顺序试开，失败换下一个并记录原因）：
  - H.264：`h264_nvenc` → `h264_qsv` → `h264_amf` → `libopenh264` → `h264_mf`
  - H.265：`hevc_nvenc` → `hevc_qsv` → `hevc_amf` → `hevc_mf`
  - 云端 runner 没有 GPU，硬件编码器打不开，自动落到软编码并在
    `ExportResult::fallbackNote` 里写清；真机 GPU 编码必须在用户电脑上验证。
- **H.265 没有 LGPL 软编码**：libx265 是 GPL，永不进发行版。没有硬件
  HEVC 编码器的机器上，H.265 预设导出会失败并给出可读原因（建议改用
  H.264），绝不静默换编码器。
- **音频**：AAC（预设 192 kbps），与视频交叉写入（`av_interleaved_write_frame`
  负责按时间戳交错）。AAC 编码器不可用时导出无音轨的视频并注明，不整个失败。
- **可取消**：`ExportOptions::cancel` 每帧检查一次；取消后删除未完成文件。
- **进度**：`ExportOptions::progress(done, total)` 每帧回调一次。

### 导出预设（ExportPreset，`src/core/ExportPreset.{h,cpp}`）

内置 6 档：1080p / 4K / 8K × H.264 / H.265，默认 30 fps、MP4、推荐码率。

| 档位 | 码率 |
|---|---|
| 更低 | 推荐档 × 0.5（不低于 2 Mbps） |
| 推荐 | 像素数 × 帧率 / 6，夹在 [12 Mbps, 分档上限] |
| 更高 | 推荐档 × 1.5（不超过分档上限） |
| 自定义 | 指定值，夹在 [1, 200] Mbps |

分档上限：1080p 及以下 65 Mbps；4K 及以下 100 Mbps；8K 130 Mbps。
宽高必须是偶数（YUV420 要求），否则预设校验失败。

## 2. 音频混音（AudioMix）

`src/core/AudioMix.{h,cpp}`，FCP Roles 模型：

- 每角色：gain −60..+12 dB、pan −1..+1（等功率声像：中置 0.707/0.707）、
  mute、solo。任一角色 solo 时，其余非 solo 角色静音。
- 片段音量（`Clip::volume` × 音量关键帧）是另一层独立 trim，与角色
  gain 相乘；淡入淡出（`Clip::fadeInSeconds` / `fadeOutSeconds`，线性）
  同样相乘。求值器把淡入淡出带进 `FrameAudioLayer`。
- 混音在 48 kHz 立体声 float 下做；解码由 `AudioDecoder`（libavformat /
  libavcodec / swresample）完成，按片段范围 seek 后解码。

### 响度统一（Loudness，`src/media/Loudness.{h,cpp}`）

- 目标 **−16 LUFS**（综合响度；剪映是 −12，v2 另有自己的目标值，
  写在 `AudioMix::kLoudnessTargetLUFS` 与本文）。
- 做法是**先测后补**：整段混音过一遍 FFmpeg `loudnorm` 滤镜（print 模式）
  测出综合响度，再以一个线性增益（目标 − 实测，夹 ±30 dB）统一，
  不做动态压缩、不削波。导出后自测用同一测量函数复核成品文件。

### 降噪

FFmpeg `afftdn` 是本阶段的指定方案。S6 已把它接进导出效果链：
`ExportOptions::denoise`（默认关）→ 导出对话框里的"降噪（afftdn）"
复选框 → 混音先过 `AudioDenoise::applyAfftdn`（abuffer → afftdn
nr=12 → abuffersink），再做响度统一。实现在
`src/media/AudioDenoise.{h,cpp}`，量化自测在 verify-s6。

实测口径（FFmpeg 8.1 afftdn 默认参数，本地探针）：轻微嘶声
（0.02 幅白噪 + 0.5 的 440 Hz 音）高频 RMS 比率约 0.78，音调本身
电平不变（-30.2 dB → -30.3 dB）；响亮的宽带噪声（0.3 幅）远高于
afftdn 的 -50 dB 本底，几乎去不掉（比率约 1.0）。所以这是嘶声 /
环境底噪消除器，不是"去掉一切噪声"的按钮，对话框 tooltip 如实写了这一点。

## 3. 字幕（Subtitles）

`src/core/Subtitles.{h,cpp}` + 时间线模型上的工程级字幕轨：

- 模型：`SubtitleItem { text, start, end }`（工程时间，秒）；
  `SubtitleTrack`：按时间排序、`indexAt(t)` / `itemAt(t)`、SRT 导入导出、
  JSON 序列化。
- SRT：`HH:MM:SS,mmm --> HH:MM:SS,mmm`，块间空行；读时接受可选的数字
  序号行；坏时间码返回可读错误，不静默丢弃。
- 烧录：求值器把当前活动的字幕放进 `FrameScene::activeSubtitle`，
  `TimelineFrameRenderer` 在共享渲染路径里画到底部中央（白字 + 半透明
  黑底框），预览与导出烧出完全相同的像素。导出时同时在成片旁写
  `<输出名>.srt` sidecar。

## 4. 按角色分轨导出（stems）

`ExportPipeline::exportStems`：按 `TimelineModel::stemsByRole()` 的每个
有声角色，单独混音后写 16-bit PCM WAV（`<base>_<角色>.wav`），时长与
时间线总时长一致。分轨保持混音平衡，**不**逐轨做响度统一（分轨是交付
用的干声/分 stem，不是成品）。

## 5. 未接入的能力（honest hook，不编假功能）

| 能力 | 状态 | 接入点 |
|---|---|---|
| 人声分离 | **S6 已接入：内置中置声道消除（非 AI）**，见下 | `src/media/VocalSeparation.{h,cpp}`：`isAvailable()` 为 true；`separate()` 解码成立体声后做左右相减 `(L-R)/2` 输出音乐轨，`(L+R)/2` 另存中置内容文件。UI 音频面板有"人声分离（中置消除）"按钮；处处诚实标注"中置声道消除（非 AI）"，绝不冒充 AI。Demucs 级 AI 分离是后续项（见 `setupInstructions()`）。单声道素材无法分离，报可读错误。 |
| 自动识别字幕 | 未接入（`AutoTranscriber::isAvailable()` 为 false） | `src/media/AutoTranscription.{h,cpp}`：接口 + hook。计划路线是 whisper.cpp vendored 源码库（CI 干净编译才留）；替代路线是旧引擎已验证的 faster-whisper Python 助手（中文用 small 及以上，输出繁体转简体）。接入后只需产出带时间戳的 `SubtitleItem`，字幕模型/SRT/烧录已就绪。 |

## 6. 已知缺口清单（S4 结束时）

（S4 实施中顺带修掉的两个旧问题，写在这里备查：① 求值器以前把纯音频
片段也放进 `FrameScene::videoLayers`，渲染器去解码 WAV 当画面，整个
导出失败——现音频片段只进 audio layers，渲染器另有一道 `ClipKind::Audio`
跳过保护；② `Loudness` 的测量曾用 `anullsink` 当 sink，`av_buffersink_get_frame`
在它上面是空指针解引用（本地 gdb 定位）——现用 `abuffersink`。）

1. H.265 软编码：LGPL 发行版无软 HEVC 编码器，无 GPU 的机器导不出 H.265（可读报错）。见 §1。
2. 自动识别字幕：只有 hook + honest error，见 §5。人声分离 S6 已接入
   （中置声道消除，非 AI），不再是缺口；Demucs 级 AI 分离是后续项。
3. ~~降噪（afftdn）未接进导出效果链~~ —— S6 已接进（见 §2），本条作废。
4. 硬件编码（NVENC/QSV/AMF）与硬件解码的真机验证：云端无 GPU，只能验证
   编译 + 回退到软编码；NVENC/QSV/AMF 的实际速度与画质待用户电脑验证。
5. 8K 导出速度（架构目标 ≥1× 实时，硬件编码）：云端只跑 1080p 软编码
   自测，未测 8K。
6. 导出混音目前是整段预混进内存（48 kHz float）：超长工程内存占用随
   时长线性增长；流式混音是后续优化项。
7. UI 尚未接导出：导出目前是 `ExportPipeline` API + 自测调用；导出菜单 /
   进度条 / 预设选择器是 S5 的 UI 工作。
8. 响度测量依赖 `loudnorm` 滤镜的日志输出解析；若 FFmpeg 未来改动其
   打印格式，测量会报可读错误而非静默错值（自测会立即失败）。
9. 降噪只对接近本底的轻微噪声有效（见 §2 实测口径），响亮宽带噪声
   去不掉；人声分离是中置消除不是 AI（见 §5），居中乐器会一起被消掉。

## 7. 自测（verify-s4 + verify-s6）

verify-s6（S6 新增，`v2/tests/verify-s6/main.cpp`）覆盖：afftdn 单元
降噪（带噪音调高频 RMS 比率 < 0.90）、同一时间线导出两次（开降噪 /
不开，响度统一关掉以便同增益比较，降噪版噪声电平更低，比率 < 0.95）、
导出对话框降噪默认关、中置消除人声分离（Goertzel 频段检查：居中人声
< 10%、左右乐器保留 > 30%、中置文件保留人声 > 30%）、单声道与缺失
文件的可读拒绝。

`v2/tests/verify-s4/main.cpp`，`verify-s4 <probe-dir> <output-dir>`，
exit 0 为过。覆盖：预设码率公式与分档上限、Roles 混音数学（gain/pan/
mute/solo）、淡入淡出、SRT 往返、3 段 + 1 叠化 + 调色导出 MP4（1080p
H.264 软编码）、MediaProbe 核查（时长/分辨率/编码/音轨）、导出首帧与
预览渲染的通道均值误差 < 1%、2 角色分轨 WAV（存在 + 时长）、成品响度
复核（−16 ± 2 LUFS）、字幕烧录（底部像素带变化）、人声分离真实可用
（S6 起：居中音调在音乐轨里抵消、中置文件保留音调；自动识别字幕仍是
honest-error hook）、取消导出不留文件。
