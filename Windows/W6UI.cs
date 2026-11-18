// W6 收尾批 UI（2026-11-18）：RGB/主曲线、卡点闪白、音频类型一键处理、
// 平滑跳切 Morph Cut、时间线内录配音、代理与缓存磁盘管理、360° 基础。
// 控件全部复用现有检查器助手（Section/Note/Slider/Number/Toggle/Buttons/
// Choices/InspectorAction/HslCurveEditor），不抄任何闭源软件的界面。
// 诚实说明写在各面板的 Note 里；云端 runner 无真 GPU/摄像头/麦克风，
// 那些交互只能在真机上验证，面板里写明，不假装验过。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using DogSC.Windows;

namespace DogSC.Replica {
 public partial class Studio {
  // ---- 1. RGB/主曲线（画面-调色，HSL 曲线之后）----
  void BuildRgbCurveSection() {
   var g = Doc.Grade;
   if (g.RgbR == null) g.RgbR = RgbCurves.Identity();
   if (g.RgbG == null) g.RgbG = RgbCurves.Identity();
   if (g.RgbB == null) g.RgbB = RgbCurves.Identity();
   if (g.RgbMaster == null) g.RgbMaster = RgbCurves.Identity();
   Section("RGB / 主曲线");
   HslCurveEditor("红通道（x = 输入亮度，y = 输出亮度，对角线 = 不变）", g.RgbR, 0, 1, .5, () => { Checkpoint(); g.RgbR = RgbCurves.Identity(); Changed(); BuildInspector(); });
   HslCurveEditor("绿通道（x = 输入亮度，y = 输出亮度，对角线 = 不变）", g.RgbG, 0, 1, .5, () => { Checkpoint(); g.RgbG = RgbCurves.Identity(); Changed(); BuildInspector(); });
   HslCurveEditor("蓝通道（x = 输入亮度，y = 输出亮度，对角线 = 不变）", g.RgbB, 0, 1, .5, () => { Checkpoint(); g.RgbB = RgbCurves.Identity(); Changed(); BuildInspector(); });
   HslCurveEditor("主曲线（亮度，同时作用于 R/G/B，对角线 = 不变）", g.RgbMaster, 0, 1, .5, () => { Checkpoint(); g.RgbMaster = RgbCurves.Identity(); Changed(); BuildInspector(); });
   Note("RGB 三通道先逐通道查表，再过主曲线（color.ts 的 curves 顺序），与 HSL 分区/色轮/HSL 曲线烤进同一张 17³ .cube，预览与导出一致。拖点移动，双击加曲点，右键点删除（至少留 2 个点）。");
  }
  // ---- 2. 卡点闪白（运镜 tab）----
  void BuildFlashSection() {
   Section("卡点闪白");
   Toggle("节拍点处闪白", Doc.FlashEnabled, v => { Doc.FlashEnabled = v; BuildInspector(); });
   if (Doc.FlashEnabled) {
    Slider("闪白帧数", 1, 10, Doc.FlashFrames, " 帧", v => Doc.FlashFrames = (int)Math.Round(v));
    Slider("闪白强度", .3, 1, Doc.FlashIntensity, "", v => Doc.FlashIntensity = v);
    Note("已记录 " + (Doc.FlashBeats == null ? 0 : Doc.FlashBeats.Count) + " 个闪白点（时间线时间）。");
    inspector.Children.Add(InspectorAction("plus", "检测全片节拍并设为闪白点", () => DetectFlashBeats()));
    inspector.Children.Add(InspectorAction("trash", "清除闪白点", () => { Checkpoint(); Doc.FlashBeats = new List<double>(); Changed(); BuildInspector(); }, true));
   }
   Note("节拍点处白场 1–10 帧（默认 2 帧），画在预览与导出同一层（字幕之上）；GPU 预览模式下以导出为准。只对有起音的音频有效（与节拍检测同款限制）。");
  }
  async void DetectFlashBeats() {
   if (Doc == null || !Doc.Audio) { Status("当前素材没有音轨，无法检测节拍。"); return; }
   Status("正在检测节拍…");
   try {
    var grid = await Task.Run(() => BeatDetector.Detect(Doc.Source, 0, Doc.Duration, CancellationToken.None));
    var mapped = BeatFlash.MapBeats(Doc, grid.Beats);
    if (mapped.Count == 0) throw new Exception("没有检测到节拍（音频里没有清晰的起音）。");
    Checkpoint(); Doc.FlashBeats = mapped; Changed(); BuildInspector();
    Status("已设 " + mapped.Count + " 个闪白点 · BPM " + grid.Bpm.ToString("0") + "（置信度 " + grid.Confidence.ToString("0%") + "）");
   } catch (Exception ex) { Error(ex); }
  }
  // ---- 2b. 平滑跳切 Morph Cut（运镜 tab）----
  void BuildMorphSection() {
   Section("平滑跳切 Morph Cut");
   Toggle("跳切处光流插值过渡", Doc.MorphEnabled, v => { Doc.MorphEnabled = v; BuildInspector(); });
   if (Doc.MorphEnabled) {
    Slider("过渡时长", .1, .5, Doc.MorphSeconds, " 秒", v => Doc.MorphSeconds = v);
    Note("当前时间线有 " + CountMorphBoundaries() + " 处跳切边界符合插值条件。");
   }
   Note("只对同源、1×、无变速的跳切边界生效；多机位切换点、变速片段、空隙边界保持硬切。质量不如 Adobe Morph Cut：小幅运动插得准，快速运动会糊成重影。只在导出里生效，预览仍显示硬切。");
  }
  int CountMorphBoundaries() {
   var segs = MulticamModel.BuildSegments(Doc); int n = 0;
   for (int i = 0; i + 1 < segs.Count; i++) if (MorphCut.BoundaryOk(segs[i], segs[i + 1], Doc.MorphSeconds, Doc.FrameRate)) n++;
   return n;
  }
  // ---- 3. 音频类型一键处理（声音 tab）----
  void BuildAudioTypeSection() {
   Section("音频类型一键处理");
   if (!Doc.Audio) { Note("当前素材没有音轨，预设与闪避都不可用。"); return; }
   Buttons(AudioTypePreset.Types, Doc.AudioType, v => { Checkpoint(); Doc.AudioType = v; Doc.AudioDucking = (v == "对话"); Changed(); BuildInspector(); });
   Note(AudioTypePreset.Describe(Doc.AudioType));
   Toggle("对话出现时压低音乐床（闪避）", Doc.AudioDucking, v => { Doc.AudioDucking = v; BuildInspector(); });
   Note("预设只作用于主音轨；音乐床不受预设影响。闪避在有音乐床时才生效（对话出现时音乐压低约 8dB，对话结束恢复）。音频处理只在导出里生效，预览只调音量。");
  }
  // ---- 5. 时间线内录配音（配音 tab）----
  Process voiceoverProcess; string voiceoverTakePath = ""; double voiceoverStart; DispatcherTimer voiceoverTimer; int voiceoverCountdown;
  string voiceoverMic = "";
  void BuildVoiceoverInspector() {
   Section("时间线内录配音");
   var takes = Doc.Mixer == null ? new List<MixerChannel>() : Doc.Mixer.Where(c => c.Role == "旁白" && !string.IsNullOrEmpty(c.SourcePath)).ToList();
   if (voiceoverProcess != null && !voiceoverProcess.HasExited) {
    Note("正在录配音…（从 " + UI.Time(voiceoverStart) + " 开始）");
    inspector.Children.Add(UI.Button("停止录配音", () => StopVoiceover()));
    return;
   }
   var mics = Voiceover.ListMicrophones();
   if (mics.Count == 0) {
    Note("没有找到 DirectShow 麦克风。接好麦克风、确认系统里能识别，再点下面刷新。");
    inspector.Children.Add(InspectorAction("plus", "刷新麦克风列表", () => BuildInspector()));
   } else {
    if (string.IsNullOrEmpty(voiceoverMic) || !mics.Contains(voiceoverMic)) voiceoverMic = mics[0];
    Choices("麦克风", voiceoverMic, mics.Select(m => new[] { m, m }).ToArray(), v => voiceoverMic = v);
   }
   Note("从当前播放头开始录，倒计时 3 秒后时间线播放、同时开始录音；点停止后这一遍进试演槽。");
   inspector.Children.Add(InspectorAction("plus", "开始录配音（3 秒倒计时）", () => StartVoiceover()));
   if (takes.Count > 0) {
    Section("试演槽（" + takes.Count + " 遍）");
    foreach (var t in takes.ToList()) {
     var take = t;
     Section("配音 · " + Path.GetFileName(take.SourcePath) + "（从 " + UI.Time(take.Start) + " 起）");
     Toggle("独奏试听", take.Solo, v => { take.Solo = v; Changed(); BuildInspector(); });
     Toggle("静音", take.Mute, v => { take.Mute = v; Changed(); BuildInspector(); });
     Slider("增益", -60, 12, take.GainDb, " dB", v => take.GainDb = v);
     inspector.Children.Add(InspectorAction("trash", "删除这一遍", () => { Checkpoint(); Doc.Mixer.Remove(take); Changed(); BuildInspector(); RefreshMediaLibrary(); }, true));
    }
    Note("试听 = 独奏该遍（混音台里同样可以独奏/静音）；留一遍、删掉其余遍即定稿。配音按录制位置对齐进成片，不循环。");
   } else Note("还没有配音。录好的每一遍都会出现在这里。");
   Note("录音是 WASAPI 经 DirectShow 采的 48kHz 单声道 WAV；云端 runner 没有麦克风，录音本身只能在真机上验证。");
  }
  void StartVoiceover() {
   if (Doc == null) return;
   if (voiceoverProcess != null && !voiceoverProcess.HasExited) { Status("已经在录配音了。"); return; }
   if (string.IsNullOrEmpty(voiceoverMic)) { Status("请先选麦克风。"); return; }
   int index = (Doc.Mixer == null ? 0 : Doc.Mixer.Count(c => c.Role == "旁白" && !string.IsNullOrEmpty(c.SourcePath))) + 1;
   string path;
   try { path = Voiceover.TakePathFor(FilePath, Doc, index); } catch (Exception ex) { Error(ex); return; }
   voiceoverStart = position; voiceoverTakePath = path; voiceoverCountdown = 3;
   Status("配音倒计时 3…");
   voiceoverTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
   voiceoverTimer.Tick += (s, e) => {
    voiceoverCountdown--;
    if (voiceoverCountdown > 0) { Status("配音倒计时 " + voiceoverCountdown + "…"); return; }
    voiceoverTimer.Stop();
    try {
     voiceoverProcess = Voiceover.StartRecording(voiceoverMic, voiceoverTakePath);
     BuildInspector(); Play();
     Status("正在录配音…（从 " + UI.Time(voiceoverStart) + " 开始）");
    } catch (Exception ex) { voiceoverProcess = null; Error(ex); BuildInspector(); }
   };
   voiceoverTimer.Start();
   BuildInspector();
  }
  void StopVoiceover() {
   if (voiceoverProcess == null) return;
   var p = voiceoverProcess; voiceoverProcess = null;
   Pause();
   Status("正在保存配音…");
   string takePath = voiceoverTakePath; double takeStart = voiceoverStart;
   Task.Run(() => {
    Voiceover.StopRecording(p);
    try { p.Dispose(); } catch { }
    Window.Dispatcher.Invoke(() => {
     try {
      if (!File.Exists(takePath)) throw new Exception("录音文件没有生成。");
      double dur = Media.Duration(takePath);
      if (dur < 0.5) throw new Exception("录音只有 " + dur.ToString("0.0") + " 秒，太短，未入库。");
      if (Doc.Mixer == null) Doc.Mixer = new List<MixerChannel>();
      Checkpoint();
      Doc.Mixer.Add(new MixerChannel { Role = "旁白", SourcePath = Path.GetFullPath(takePath), Start = takeStart });
      Changed(); BuildInspector(); RefreshMediaLibrary();
      Status("配音已入库 · " + Path.GetFileName(takePath) + "（" + dur.ToString("0.0") + " 秒，从 " + UI.Time(takeStart) + " 起）");
     } catch (Exception ex) { Error(ex); BuildInspector(); }
    });
   });
  }
  // ---- 6. 代理与缓存的磁盘管理（代理 tab 内）----
  void BuildProxyDiskSection() {
   Section("磁盘占用");
   string dir = RenderCache.CacheDirFor(FilePath, Doc);
   Note(ProxyDisk.UsageLine(FilePath, Doc) + "\n缓存目录：" + dir);
   inspector.Children.Add(InspectorAction("trash", "清理渲染缓存", () => { try { int removed = RenderCache.ClearRenderCache(dir); Status(removed == 0 ? "缓存已经是空的。" : "已清理缓存 " + removed + " 个文件。"); BuildInspector(); } catch (Exception ex) { Error(ex); } }, true));
   Note("代理只对主源生成（角度代理目前不参与预览与导出，生成了也没用，所以不生成）。清理只删 rendercache 里的中间片，不删原片、代理和工程。");
  }
  // ---- 7. 360° 基础（画面 tab 的第五页 frameTab=="360°"）----
  void BuildSphericalInspector() {
   Section("360° 视频");
   var det = Spherical.Detect(Doc.Source);
   Note("当前素材：" + det.Reason);
   Toggle("导出时注入 360° 球面元数据", Doc.Spherical360, v => { Doc.Spherical360 = v; BuildInspector(); });
   if (Doc.Spherical360) Note("导出成片时会写入 Spherical Video V2 元数据（sv3d），YouTube / VLC 会认出这是 360° 视频。只对 MP4 导出生效；注入失败时导出会明确报错，不会静默出一份普通视频。");
   Note("监视器里现在看到的就是等距柱状平铺画面（2:1 全幅平铺）；全景漫游交互不做——要在播放器里拖动视角看。");
  }
  // 打开视频文件时顺带识别 360° 素材（只对视频文件，不对 .dogscwin 工程）。
  void NoteSphericalOnOpen() {
   if (Doc == null) return;
   try {
    var det = Spherical.Detect(Doc.Source);
    if (det.Kind == SphericalKind.Definite) { Doc.Spherical360 = true; Status("已识别为 360° 等距柱状素材 · 导出默认注入球面元数据（画面-360° 里可关）"); }
    else if (det.Kind == SphericalKind.Likely) Status("画面 2:1，可能是 360° 等距柱状素材 · 可在 画面-360° 里确认");
   } catch { }
  }
 }
}
