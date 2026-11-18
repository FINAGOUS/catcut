// W8 音频高级收尾批（2026-11-18）：音频修复、人声分离、变声、TTS 面板、
// 环绕声、子片段、EQ 曲线拖动 UI、压缩器旋钮。
// 模型与纯逻辑；UI 见 W8AudioUI.cs。滤镜串与参数出处（全部是已验证的数，不是现编的）：
// - 音频修复：audiorepair.ts（adeclick → highpass → afftdn nr=25:nf=-30）。
//   本地探针（2026-11-18，FFmpeg 8.1.2）：爆音峰值 1.000→0.136、440Hz 音调
//   -12.04→-12.09dB 不变；高通 f=100 去 50Hz 嗡鸣 -28.52→-40.84dB（降 12.3dB，
//   与引擎 -13.47→-25.78dB 的降幅一致）、440Hz 不变；afftdn 默认 nr=12:nf=-50
//   近乎无效，修复用 nr=25:nf=-30（间隙底噪 -30.76→-47.92dB，音调 -20.64→-21.07dB）。
//   强度滑杆只缩放降噪 nr（5 + 20×强度/100，100 时正好是验证过的 nr=25）；
//   去混响 v1 不做（FFmpeg 没有去混响滤镜，面板写明）。
// - 人声分离：vocalsep.ts（本地 Demucs htdemucs，MIT；权重首次运行下载，
//   不随包分发，发版前核实权重许可）。引擎实测：4 秒片 CPU 约 26 秒；人声轨
//   660Hz 压低 51.7dB、伴奏轨保留 ±5dB。模型/脚本缺失时诚实报错，绝不返回空音轨。
// - 变声：audiofx.ts 的 asetrate+aresample 变调路线（LGPL；先 aresample=48000，
//   再 asetrate，最后 atempo 补时长）。本地探针：+12 半音 440Hz→880Hz
//   （-18.07dB，440Hz 处 -123dB）、时长 3.982s（误差 0.018s，与引擎一致）。
//   高质量变声走 rubberband 是 GPL，LGPL 包里没有，发版前换方案，面板写明。
// - TTS：tts.ts（本地 Sherpa-ONNX VITS，Apache 2.0；单音色 aishell3 女声，
//   sid 0，8kHz 原生，混音时重采样到 48kHz）。引擎实测：12 字→2.65s、
//   13 字→3.45s（约 0.22–0.27s/字）；空文本/超 2000 字/速度越界全部拒绝。
//   模型缺失时诚实报错，绝不返回静音冒充语音。
// - 环绕声：surround.ts（立体声混音末尾一次 pan 上混；LFE 静音是设计如此，
//   不是 bug）。本地探针：5.1 + AC-3 → ffprobe ac3/6 声道/5.1(side)；
//   7.1 + AAC → aac/8 声道/7.1；AC-3 装不下 7.1（会静默下混到 5.1），
//   所以 7.1 默认 AAC；单声道源用单声道映射（FC -18.16dB，错用立体声映射
//   FC 会掉 6dB 到 -24.18dB，引擎同款实测）。C# 链里 RoleFilter 已把单声道
//   转成立体声总线，所以上混一律按立体声输入映射（见 Surround.UpmixFilter 注释）。
// - 子片段：medialib.ts 的 createSubclip（只存引用不复制文件；子片段套子片段、
//   超父时长、重复 id、空范围全部拒绝）。
// - EQ：audiofx.ts 的 equalizer（参量频段 +6dB 精确 +6.00dB，-6 精确 -6.01dB）。
//   本地探针（双音 440+3000Hz）：+6dB@3000Hz 后 3000Hz -24.08→-18.09dB
//   （+5.99dB）、440Hz -24.08→-23.95dB 不变。曲线编辑器只是换一种输入方式：
//   横轴对数频率 20–20000Hz、纵轴增益 -15–+15dB，点 = 参量频段（Q 默认 1，可调）。
// - 压缩器：audiofx.ts 的 acompressor（阈值 dB 转线性 10^(dB/20)，与闪避同款换算）。
//   本地探针（两段电平源，响 -9.03/静 -29.03dB）：阈值 -20dB/比率 4 → 响段
//   -18.85dB（压 9.8dB）、静段 -29.03dB 不变，动态范围 20.00→10.19dB（与引擎一致）。
// 链顺序（与 filtergraph.ts 的 clipAudioChains 一致）：变声 → EQ → 压缩器 →
// 修复 → 音频类型预设（含 loudnorm）→ 闪避 → 音量/增益 → 环绕上混。
// 导出始终用原片（relink），代理只做预览——W8 不改代理语义（见 W6）。
// 云端 runner 无真 GPU/摄像头/麦克风、无 Demucs/Sherpa 模型：success 只证明
// 编译 + 自测能过，不证明真机视觉、交互与模型实跑，别谎称已验证。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using DogSC.Windows;

namespace DogSC.Replica {
 static class W8Fmt {
  public static string N(double v) {
   if (v == Math.Floor(v)) return ((long)v).ToString(CultureInfo.InvariantCulture);
   return v.ToString("0.####", CultureInfo.InvariantCulture);
  }
 }

 // ---- 1. 音频修复（audiorepair.ts）----
 public class AudioRepairSettings {
  public bool Declick; public double HumCutoffHz; public bool Denoise; public double Strength = 50;
  public bool Active { get { return Declick || HumCutoffHz > 0 || Denoise; } }
  public void Validate() {
   if (HumCutoffHz != 0 && (HumCutoffHz < 50 || HumCutoffHz > 200)) throw new Exception("去电流声的高通截止频率无效：" + HumCutoffHz + " Hz（50–200，0 = 关闭）。");
   if (!EditDocument.Finite(Strength) || Strength < 0 || Strength > 100) throw new Exception("音频修复强度无效：" + Strength + "（0–100）。");
  }
  // 强度只缩放降噪 nr：5 + 20×强度/100；强度 100 时 nr=25，正好是验证过的数。
  public int DenoiseNr() { return 5 + (int)Math.Round(20 * Strength / 100); }
  public string Filter() {
   Validate();
   var parts = new List<string>();
   if (Declick) parts.Add("adeclick");
   if (HumCutoffHz > 0) parts.Add("highpass=f=" + W8Fmt.N(HumCutoffHz));
   if (Denoise) parts.Add("afftdn=nr=" + DenoiseNr() + ":nf=-30");
   return string.Join(",", parts.ToArray());
  }
 }

 // ---- 3. 变声（audiofx.ts 的 voiceFilter 移植）----
 public class VoiceChangeSettings {
  public string Kind = "无"; public double Semitones;
  public static readonly string[] Kinds = new[] { "无", "变调", "混响", "回声", "合唱", "震音", "颤音" };
  public bool Active { get { return Kind != "无"; } }
  public void Validate() {
   if (!Kinds.Contains(Kind)) throw new Exception("变声类型无效：" + Kind + "。");
   if (Kind == "变调" && (!EditDocument.Finite(Semitones) || Semitones < -12 || Semitones > 12)) throw new Exception("变调半音无效：" + Semitones + "（-12–+12）。");
  }
  public string Filter() {
   Validate();
   if (Kind == "无") return "";
   if (Kind == "变调") {
    if (Math.Abs(Semitones) < 0.000001) return "";
    double factor = Math.Pow(2, Semitones / 12);
    long rate = (long)Math.Round(48000 * factor);
    return "aresample=48000,asetrate=" + rate + ",aresample=48000,atempo=" + W8Fmt.N(1 / factor);
   }
   if (Kind == "混响") return "aecho=0.8:0.7:60|90|120|180:0.5|0.4|0.3|0.2";
   if (Kind == "回声") return "aecho=0.8:0.7:250:0.5";
   if (Kind == "合唱") return "chorus=0.5:0.5:50|60:0.4|0.3:2|1.5:0.4|0.4";
   if (Kind == "震音") return "tremolo=f=5:d=0.5";
   if (Kind == "颤音") return "vibrato=f=5:d=0.5";
   return "";
  }
 }

 // ---- 7. EQ：参量频段 + 曲线数学（audiofx.ts 的 eqFilter 移植）----
 public class EqBand {
  public double Frequency = 1000; public double GainDb; public double Width = 1;
 }
 public class EqSettings {
  public double LowCutHz; public double HighCutHz; public List<EqBand> Bands = new List<EqBand>();
  public bool Active { get { return LowCutHz > 0 || HighCutHz > 0 || (Bands != null && Bands.Count > 0); } }
  public void Validate() {
   if (LowCutHz != 0 && (LowCutHz < 20 || LowCutHz > 20000)) throw new Exception("EQ 低切频率无效：" + LowCutHz + " Hz（20–20000，0 = 关闭）。");
   if (HighCutHz != 0 && (HighCutHz < 20 || HighCutHz > 20000)) throw new Exception("EQ 高切频率无效：" + HighCutHz + " Hz（20–20000，0 = 关闭）。");
   if (LowCutHz > 0 && HighCutHz > 0 && LowCutHz >= HighCutHz) throw new Exception("EQ 低切 " + LowCutHz + " Hz 必须低于高切 " + HighCutHz + " Hz。");
   if (Bands == null) return;
   if (Bands.Count > 5) throw new Exception("EQ 频段最多 5 个，现有 " + Bands.Count + " 个。");
   foreach (var b in Bands) {
    if (b == null || !EditDocument.Finite(b.Frequency) || b.Frequency < 20 || b.Frequency > 20000) throw new Exception("EQ 频段中心频率无效（20–20000 Hz）。");
    if (!EditDocument.Finite(b.GainDb) || b.GainDb < -30 || b.GainDb > 30) throw new Exception("EQ 频段增益无效（-30–+30 dB）。");
    if (!EditDocument.Finite(b.Width) || b.Width < 0.1 || b.Width > 10) throw new Exception("EQ 频段 Q 值无效（0.1–10）。");
   }
   for (int i = 1; i < Bands.Count; i++) if (Bands[i].Frequency <= Bands[i - 1].Frequency) throw new Exception("EQ 频段必须按频率从低到高排列。");
  }
  public string Filter() {
   Validate();
   var parts = new List<string>();
   if (LowCutHz > 0) parts.Add("highpass=f=" + W8Fmt.N(LowCutHz));
   if (HighCutHz > 0) parts.Add("lowpass=f=" + W8Fmt.N(HighCutHz));
   foreach (var b in Bands) parts.Add("equalizer=f=" + W8Fmt.N(b.Frequency) + ":width_type=q:width=" + W8Fmt.N(b.Width) + ":g=" + W8Fmt.N(b.GainDb));
   return string.Join(",", parts.ToArray());
  }
 }
 // EQ 曲线编辑器的坐标数学（与界面无关，可单测）：横轴对数频率 20–20000Hz，
 // 纵轴增益 -15–+15dB；频响曲线是各频段在对数频率上的高斯叠加，单频段时
 // 中心处正好等于该段增益（测试断言的依据）。
 static class EqCurveMath {
  public const double FreqMin = 20, FreqMax = 20000, GainMin = -15, GainMax = 15;
  public static double FreqToX(double freq) { return (Math.Log10(Math.Max(FreqMin, Math.Min(FreqMax, freq))) - Math.Log10(FreqMin)) / (Math.Log10(FreqMax) - Math.Log10(FreqMin)); }
  public static double XToFreq(double x) { return Math.Pow(10, Math.Log10(FreqMin) + Math.Max(0, Math.Min(1, x)) * (Math.Log10(FreqMax) - Math.Log10(FreqMin))); }
  public static double GainToY(double gain) { return (GainMax - Math.Max(GainMin, Math.Min(GainMax, gain))) / (GainMax - GainMin); }
  public static double YToGain(double y) { return GainMax - Math.Max(0, Math.Min(1, y)) * (GainMax - GainMin); }
  public static double ResponseAt(double freq, List<EqBand> bands) {
   double g = 0;
   if (bands == null) return 0;
   foreach (var b in bands) {
    double octaves = Math.Log(freq / b.Frequency, 2);
    double sigma = 0.5 / Math.Max(0.1, b.Width);
    g += b.GainDb * Math.Exp(-0.5 * octaves * octaves / (sigma * sigma));
   }
   return g;
  }
 }

 // ---- 8. 压缩器（audiofx.ts 的 compressorFilter 移植）----
 public class CompressorSettings {
  public bool Enabled; public double ThresholdDb = -18; public double Ratio = 3; public double AttackMs = 10; public double ReleaseMs = 100; public double MakeupDb;
  public void Validate() {
   if (!Enabled) return;
   if (!EditDocument.Finite(ThresholdDb) || ThresholdDb < -60 || ThresholdDb > 0) throw new Exception("压缩器阈值无效：" + ThresholdDb + " dB（-60–0）。");
   if (!EditDocument.Finite(Ratio) || Ratio < 1 || Ratio > 20) throw new Exception("压缩器比率无效：" + Ratio + "（1–20）。");
   if (!EditDocument.Finite(AttackMs) || AttackMs < 0.1 || AttackMs > 2000) throw new Exception("压缩器起音无效：" + AttackMs + " ms（0.1–2000）。");
   if (!EditDocument.Finite(ReleaseMs) || ReleaseMs < 0.1 || ReleaseMs > 9000) throw new Exception("压缩器释放无效：" + ReleaseMs + " ms（0.1–9000）。");
   if (!EditDocument.Finite(MakeupDb) || MakeupDb < 0 || MakeupDb > 30) throw new Exception("压缩器补偿增益无效：" + MakeupDb + " dB（0–30）。");
  }
  public string Filter() {
   Validate();
   if (!Enabled) return "";
   double threshold = Math.Max(0.000976563, Math.Min(1, Math.Pow(10, ThresholdDb / 20)));
   double makeup = Math.Max(1, Math.Min(64, Math.Pow(10, MakeupDb / 20)));
   return "acompressor=threshold=" + W8Fmt.N(threshold) + ":ratio=" + W8Fmt.N(Ratio) + ":attack=" + W8Fmt.N(AttackMs) + ":release=" + W8Fmt.N(ReleaseMs) + ":makeup=" + W8Fmt.N(makeup) + ":knee=2.82843:link=average:detection=rms:mix=1";
  }
  // 静态增益衰减估算（峰值电平已知时）：超过阈值的部分按 (1 - 1/比率) 压掉。
  // 是估算不是实测——面板写明，实测值用“测峰值”按钮跑 volumedetect 验。
  public double EstimatedReduction(double peakDb) {
   if (!Enabled || peakDb <= ThresholdDb) return 0;
   return (peakDb - ThresholdDb) * (1 - 1 / Ratio);
  }
 }

 // ---- 5. 环绕声（surround.ts 移植）----
 static class Surround {
  public static readonly string[] Layouts = new[] { "立体声", "5.1", "7.1" };
  public static int Channels(string layout) { return layout == "5.1" ? 6 : layout == "7.1" ? 8 : 2; }
  public static void Validate(string layout, string codec) {
   if (!Layouts.Contains(layout)) throw new Exception("环绕声布局无效：" + layout + "（立体声 / 5.1 / 7.1）。");
   if (codec != "自动" && codec != "aac" && codec != "ac3") throw new Exception("环绕声音频编码器无效：" + codec + "。");
   if (layout == "7.1" && codec == "ac3") throw new Exception("AC-3 装不下 7.1 声道（会静默下混到 5.1），7.1 请用 AAC 或自动。");
  }
  // 上混映射（surround.ts 的 surroundUpmixFilter，立体声输入版）：
  // 5.1: FL=c0, FR=c1, FC=0.5*c0+0.5*c1, LFE 静音, BL=c0, BR=c1；
  // 7.1 再加 SL=c0, SR=c1。LFE 写 0*c0（pan 不接受裸常量 c3=0，引擎已证实）。
  // C# 链里 RoleFilter 已把单声道/多声道统一成立体声总线，所以这里 inputChannels
  // 恒为 2；单声道源的专用映射只在引擎层存在，面板写明总线是立体声。
  public static string UpmixFilter(string layout) {
   if (layout == "5.1") return "pan=5.1|c0=c0|c1=c1|c2=0.5*c0+0.5*c1|c3=0*c0|c4=c0|c5=c1";
   if (layout == "7.1") return "pan=7.1|c0=c0|c1=c1|c2=0.5*c0+0.5*c1|c3=0*c0|c4=c0|c5=c1|c6=c0|c7=c1";
   return "";
  }
  // 5.1 默认 AC-3（内置编码器，专利已过期）；7.1 默认 AAC（AC-3 顶到 5.1）；
  // 立体声默认 AAC。显式选择优先于默认。
  public static string AudioCodec(string layout, string explicitCodec) {
   if (explicitCodec == "aac" || explicitCodec == "ac3") return explicitCodec;
   if (layout == "5.1") return "ac3";
   return "aac";
  }
  public static string Bitrate(string layout, string codec) {
   if (codec != "ac3" && layout != "7.1") return "";
   if (layout == "5.1") return "384k";
   if (layout == "7.1") return "448k";
   return "";
  }
 }

 // ---- 2. 人声分离（vocalsep.ts 移植：接口 + 校验 + 诚实报错）----
 public class VocalSepSettings {
  public string Mode = "关"; public string Model = "htdemucs"; public string VocalsPath = ""; public string AccompPath = "";
  public static readonly string[] Modes = new[] { "关", "人声", "伴奏" };
  public static readonly string[] Models = new[] { "htdemucs", "htdemucs_ft", "mdx_extra" };
  public bool Active { get { return Mode != "关"; } }
  public string StemPath() { return Mode == "人声" ? VocalsPath : Mode == "伴奏" ? AccompPath : ""; }
  public void Validate() {
   if (!Modes.Contains(Mode)) throw new Exception("人声分离模式无效：" + Mode + "（关 / 人声 / 伴奏）。");
   if (!Models.Contains(Model)) throw new Exception("Demucs 模型无效：" + Model + "（htdemucs / htdemucs_ft / mdx_extra）。");
   if (Active) {
    string stem = StemPath();
    if (string.IsNullOrEmpty(stem)) throw new Exception("人声分离已选“" + Mode + "”，但还没有分离出音轨：请先点“开始分离”。");
    if (!File.Exists(stem)) throw new Exception("人声分离的音轨文件缺失：" + stem + "。请重新分离，或把模式改回“关”。");
   }
  }
 }
 static class VocalSep {
  public const string Setup =
   "人声分离（Demucs）未就绪：\n" +
   "1. 装 Python（python/py/python3 任一在 PATH），再 pip install demucs（会连带装 torch；CPU 轮子约数百 MB，首次运行还需下载模型权重约 400 MB 到 torch 缓存）。\n" +
   "2. Demucs 本身是 MIT 许可；模型权重是另外的产物，发版前须核实权重许可，不要随包分发权重。\n" +
   "3. 分离是 CPU 慢活：4 秒片约 26 秒，长文件要几分钟，请耐心等，不要反复点。";
  public static string ToolsDir() { return Path.Combine(Media.Root, "tools"); }
  public static string ScriptPath() { return Path.Combine(ToolsDir(), "vocalsep.py"); }
  // 分离一次，返回（人声 wav，伴奏 wav）。Demucs 或模型缺失时抛错，绝不返回空音轨。
  public static string[] Separate(string source, string model, string outDir) {
   if (string.IsNullOrEmpty(source) || !File.Exists(source)) throw new Exception("人声分离：找不到源文件：" + source + "。");
   if (!VocalSepSettings.Models.Contains(model)) throw new Exception("人声分离：未知模型 " + model + "。");
   string python = WhisperTranscriber.FindPython();
   if (python == null) throw new Exception("人声分离：未找到 Python。\n" + Setup);
   if (!File.Exists(ScriptPath())) throw new Exception("人声分离：缺少 vocalsep.py（应随包分发在 tools/ 下）。\n" + Setup);
   Directory.CreateDirectory(outDir);
   string args = Media.Q(ScriptPath()) + " --source " + Media.Q(source) + " --out " + Media.Q(outDir) + " --model " + model;
   string stdout, stderr;
   using (var p = Media.Start(python, args, true)) {
    var err = p.StandardError.ReadToEndAsync();
    stdout = p.StandardOutput.ReadToEnd();
    p.WaitForExit();
    stderr = err.Result;
    if (p.ExitCode != 0) throw new Exception("人声分离失败（Demucs 未装或模型下载失败，见下）：\n" + stderr + "\n" + Setup);
   }
   string vocals = JsonString(stdout, "vocals"), accomp = JsonString(stdout, "accompaniment");
   if (string.IsNullOrEmpty(vocals) || string.IsNullOrEmpty(accomp) || !File.Exists(vocals) || !File.Exists(accomp))
    throw new Exception("人声分离没有返回可用的双音轨（Demucs 输出解析失败）。\n" + Setup);
   return new[] { vocals, accomp };
  }
  static string JsonString(string json, string key) {
   int at = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
   if (at < 0) return null;
   int colon = json.IndexOf(':', at + key.Length + 2);
   if (colon < 0) return null;
   int q1 = json.IndexOf('"', colon + 1);
   if (q1 < 0) return null;
   int q2 = json.IndexOf('"', q1 + 1);
   if (q2 < 0) return null;
   return json.Substring(q1 + 1, q2 - q1 - 1);
  }
 }

 // ---- 4. TTS（tts.ts 移植：接口 + 校验 + 诚实报错）----
 public class TtsSettings {
  public string Text = ""; public double Speed = 1; public string Voice = "aishell3 女声"; public double Start; public double GainDb; public string WavPath = "";
  public static readonly string[] Voices = new[] { "aishell3 女声" };
  public const int MaxChars = 2000;
  public bool HasAudio { get { return !string.IsNullOrEmpty(WavPath); } }
  public void Validate() {
   if (!Voices.Contains(Voice)) throw new Exception("TTS 音色无效：" + Voice + "（v1 只有一个开源音色 aishell3 女声，更多音色需另下载模型）。");
   if (!EditDocument.Finite(Speed) || Speed < 0.5 || Speed > 2) throw new Exception("TTS 语速无效：" + Speed + "（0.5–2）。");
   if (!EditDocument.Finite(Start) || Start < 0) throw new Exception("TTS 起始时间无效：" + Start + "（≥ 0）。");
   if (!EditDocument.Finite(GainDb) || GainDb < -30 || GainDb > 12) throw new Exception("TTS 增益无效：" + GainDb + " dB（-30–+12）。");
   if (HasAudio && !File.Exists(WavPath)) throw new Exception("TTS 旁白文件缺失：" + WavPath + "。请重新生成，或清除旁白。");
  }
  public void ValidateText(string text) {
   if (string.IsNullOrWhiteSpace(text)) throw new Exception("TTS 文本不能为空。");
   if (text.Length > MaxChars) throw new Exception("TTS 文本 " + text.Length + " 字，超过 " + MaxChars + " 字上限——请分段生成。");
  }
 }
 static class TtsSynth {
  public const string Setup =
   "本地 TTS（sherpa-onnx）未就绪：\n" +
   "1. 装 Python，再 pip install sherpa-onnx。\n" +
   "2. 下载 vits-icefall-zh-aishell3 模型（k2-fsa/sherpa-onnx 发布页 tts-models 标签，约 30 MB）放到 tools/models/vits-icefall-zh-aishell3/。\n" +
   "3. 合成走 CPU，不走云端，运行时不需要账号与网络。";
  public static string ToolsDir() { return Path.Combine(Media.Root, "tools"); }
  public static string ScriptPath() { return Path.Combine(ToolsDir(), "tts.py"); }
  public static string ModelDir() { return Path.Combine(ToolsDir(), "models", "vits-icefall-zh-aishell3"); }
  // 生成一段旁白 wav，返回 ffprobe 测得的时长。模型缺失时抛错，绝不返回静音冒充语音。
  public static double Synthesize(string text, double speed, string outWav) {
   if (string.IsNullOrWhiteSpace(text)) throw new Exception("TTS 文本不能为空。");
   if (text.Length > TtsSettings.MaxChars) throw new Exception("TTS 文本超过 " + TtsSettings.MaxChars + " 字上限。");
   if (speed < 0.5 || speed > 2) throw new Exception("TTS 语速无效：" + speed + "（0.5–2）。");
   string python = WhisperTranscriber.FindPython();
   if (python == null) throw new Exception("TTS：未找到 Python。\n" + Setup);
   if (!File.Exists(ScriptPath())) throw new Exception("TTS：缺少 tts.py（应随包分发在 tools/ 下）。\n" + Setup);
   if (!File.Exists(Path.Combine(ModelDir(), "model.onnx"))) throw new Exception("TTS：缺少语音模型 vits-icefall-zh-aishell3（tools/models 下没有 model.onnx）。\n" + Setup);
   string args = Media.Q(ScriptPath()) + " --text " + Media.Q(text) + " --out " + Media.Q(outWav) + " --model-dir " + Media.Q(ModelDir()) + " --speed " + W8Fmt.N(speed);
   using (var p = Media.Start(python, args, true)) {
    var err = p.StandardError.ReadToEndAsync();
    string stdout = p.StandardOutput.ReadToEnd();
    p.WaitForExit();
    if (p.ExitCode != 0) throw new Exception("TTS 合成失败：\n" + err.Result + "\n" + Setup);
   }
   if (!File.Exists(outWav)) throw new Exception("TTS 合成没有生成音频文件。\n" + Setup);
   double duration = Media.Duration(outWav);
   if (duration <= 0) throw new Exception("TTS 合成出的音频时长为 0。\n" + Setup);
   return duration;
  }
 }

 // ---- 6. 子片段（medialib.ts 的 createSubclip 移植）----
 public class MediaLibraryItem {
  public string Id; public string Name; public string File; public string Kind = "media"; public string ParentId = "";
  public double In; public double Out; public double Duration; public string Bin = ""; public int Rating; public bool Favorite;
  public bool IsSubclip { get { return Kind == "subclip"; } }
 }
 static class Subclips {
  public static void ValidateItem(MediaLibraryItem item) {
   if (item == null || string.IsNullOrWhiteSpace(item.Id)) throw new Exception("素材库条目需要非空 id。");
   if (string.IsNullOrEmpty(item.File)) throw new Exception("素材库条目缺少文件：" + item.Id + "。");
   if (item.Kind != "media" && item.Kind != "subclip") throw new Exception("素材库条目 kind 必须是 media 或 subclip：" + item.Id + "。");
   if (item.IsSubclip) {
    if (string.IsNullOrEmpty(item.ParentId)) throw new Exception("子片段需要 parentId：" + item.Id + "。");
    if (item.In < 0 || item.Out <= item.In) throw new Exception("子片段 in/out 无效 [" + item.In + ", " + item.Out + ")：" + item.Id + "。");
   }
   if (item.Rating < 0 || item.Rating > 5) throw new Exception("素材评分无效（0–5）：" + item.Id + "。");
  }
  public static void ValidateLibrary(List<MediaLibraryItem> items) {
   if (items == null) return;
   var seen = new HashSet<string>();
   foreach (var item in items) {
    ValidateItem(item);
    if (!seen.Add(item.Id)) throw new Exception("素材库 id 重复：" + item.Id + "。");
    if (item.IsSubclip && !items.Any(i => i.Id == item.ParentId)) throw new Exception("子片段的父项不在库里：" + item.Id + "（parent " + item.ParentId + "）。");
   }
  }
  // 从长素材圈范围生成入库子片段：只存引用不复制文件，in/out 进项目文件。
  // 父项缺失、父项本身是子片段、id 重复、空范围、超父时长全部拒绝。
  public static MediaLibraryItem Create(List<MediaLibraryItem> items, string parentId, string id, string name, double start, double end) {
   var parent = items == null ? null : items.FirstOrDefault(i => i.Id == parentId);
   if (parent == null) throw new Exception("子片段：父项不在库里：" + parentId + "。");
   if (parent.IsSubclip) throw new Exception("子片段：父项 " + parentId + " 本身就是子片段，v1 不支持子片段套子片段。");
   if (items.Any(i => i.Id == id)) throw new Exception("子片段：id 已被占用：" + id + "。");
   if (!EditDocument.Finite(start) || !EditDocument.Finite(end) || start < 0 || end <= start) throw new Exception("子片段：范围 [" + start + ", " + end + ") 为空或为负。");
   if (parent.Duration > 0 && end > parent.Duration + 0.05) throw new Exception("子片段：结束 " + end + "s 超出父项时长 " + parent.Duration.ToString("0.000") + "s。");
   return new MediaLibraryItem { Id = id, Name = name, File = parent.File, Kind = "subclip", ParentId = parentId, In = start, Out = end, Duration = end - start, Bin = parent.Bin };
  }
  public static Cut ToCut(MediaLibraryItem subclip) {
   if (subclip == null || !subclip.IsSubclip) throw new Exception("只有子片段能加入时间线。");
   return new Cut { Start = subclip.In, End = subclip.Out, Speed = 1 };
  }
 }

 // ---- 波形图（showwavespic，EQ 面板与播放波形共用）----
 static class Waveform {
  public static string Png(string source, string outPng, int width, int height) {
   if (string.IsNullOrEmpty(source) || !File.Exists(source)) throw new Exception("波形图：找不到音频来源：" + source + "。");
   StudioMedia.Run("-v error -y -i " + Media.Q(source) + " -filter_complex \"[0:a]showwavespic=s=" + width + "x" + height + ":colors=#667870[w]\" -map \"[w]\" -frames:v 1 " + Media.Q(outPng), CancellationToken.None);
   if (!File.Exists(outPng) || new FileInfo(outPng).Length == 0) throw new Exception("波形图没有生成。");
   return outPng;
  }
 }

 // ---- 电平探针（volumedetect，供压缩器“测峰值”与测试共用）----
 static class AudioProbe {
  static double ReadVolume(string file, string key) {
   using (var p = Media.Start("ffmpeg", "-v info -i " + Media.Q(file) + " -vn -af volumedetect -f null -", false)) {
    var err = p.StandardError.ReadToEndAsync();
    p.StandardInput.Close();
    p.WaitForExit();
    if (p.ExitCode != 0) throw new Exception("volumedetect 失败：" + err.Result);
    foreach (string line in err.Result.Split('\n')) {
     if (line.Contains(key)) {
      double v;
      string num = line.Substring(line.IndexOf(key, StringComparison.Ordinal) + key.Length).Replace(" dB", "").Trim();
      if (double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return v;
     }
    }
    throw new Exception("volumedetect 输出里没有 " + key + "。");
   }
  }
  public static double MaxVolume(string file) { return ReadVolume(file, "max_volume:"); }
  public static double MeanVolume(string file) { return ReadVolume(file, "mean_volume:"); }
 }

 // ---- W8 音频链总装（供 EditorCore.AudioArgs 调用）----
 // 顺序与引擎 filtergraph.ts 一致：变声 → EQ → 压缩器 → 修复 →（预设）→（闪避）→ 音量。
 static class W8AudioChain {
  public static string BuildChain(EditDocument doc) {
   var parts = new List<string>();
   string voice = doc.VoiceChange.Filter();
   if (!string.IsNullOrEmpty(voice)) parts.Add(voice);
   string eq = doc.Eq.Filter();
   if (!string.IsNullOrEmpty(eq)) parts.Add(eq);
   string comp = doc.Compressor.Filter();
   if (!string.IsNullOrEmpty(comp)) parts.Add(comp);
   string repair = doc.Repair.Filter();
   if (!string.IsNullOrEmpty(repair)) parts.Add(repair);
   return string.Join(",", parts.ToArray());
  }
  public static bool Active(EditDocument doc) { return !string.IsNullOrEmpty(BuildChain(doc)); }
  public static void Validate(EditDocument doc) {
   doc.Repair.Validate();
   doc.VoiceChange.Validate();
   doc.Eq.Validate();
   doc.Compressor.Validate();
   Surround.Validate(doc.SurroundLayout, doc.SurroundCodec);
   doc.VocalSep.Validate();
   doc.Tts.Validate();
   Subclips.ValidateLibrary(doc.MediaLibrary);
  }
  // 人声分离导出时的音频源：只支持单片段直接导出（音轨与时间线一一对应）；
  // 多段/变速/多机位项目请把分离后的音轨加进混音轨（面板按钮），不要硬套。
  public static string AudioSourceForExport(EditDocument doc, bool direct) {
   if (!doc.VocalSep.Active) return doc.Source;
   if (!direct) throw new Exception("人声分离导出只支持单片段直接导出：多段项目请把分离后的音轨加进混音轨（人声分离面板里有按钮），不要直接导出。");
   return doc.VocalSep.StemPath();
  }
 }
}
