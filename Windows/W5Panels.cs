// W5 收尾面板接线（2026-11-18）：Whisper 自动字幕、HSL 曲线编辑器、电平表、
// 变速/美颜/降噪、系统声音混音、录制标记。C# 原生实现，TS 引擎只作规格/
// 参照（路线与 W3 相同，见 FeaturePanels.cs 头注释）：便携包无 node，
// C# 直接 shell 调 ffmpeg、照抄已验证的滤镜串。
//
// 规格出处（参数逐一照抄，出处写在各节注释里）：
// - HSL 曲线：color.ts 的 HslCurves / applyCurve（分段线性、端点外钳制），
//   烤进 17^3 .cube（ColorLut.Apply），与 huevsat/huevlum 同效果。
// - Whisper：transcribe.ts 的 FasterWhisperTranscriber（16 kHz 单声道 PCM
//   → faster-whisper，small 默认；输出繁体，转简体后再烧录）+ 脚注的
//   Windows 路线（whisper.cpp 或 ONNX）。本批接 whisper.cpp CLI（主）
//   与 faster-whisper Python（备），模型首次运行从 Hugging Face 下载。
// - 美颜/降噪：beauty.ts 的 hqdn3dFilter / beautyFilter（hqdn3d + 提亮 +
//   unsharp 0.1）与 filtergraph.ts 的 applyBeautyStage（split → 美颜分支
//   → alphamerge 遮罩 → overlay 回原图；遮罩经 fps + format=gray + gblur
//   羽化）。遮罩由 scripts/portrait_segment.py（MediaPipe Selfie
//   Segmentation ONNX）+ beauty_mask.py 生成，随包分发。
// - 节拍检测 + 卡点变速：beat.ts（对数能量差包络 + 自相关 BPM + 起音中
//   位数周期精修 + 采样级起音精修；变速按节拍点交替 0.5x/2x）与
//   splitClipByBeats（按节拍切分）。C# 侧变速以切分片段实现（每拍一切，
//   慢/快交替），用现有匀速 Cut  machinery，输出时长与引擎一致。
// - 电平表：混音台的峰值/RMS 显示，ffmpeg astats + volumedetect 驱动，
//   播放时 -re 实时跟随（近似同步）；M4 §8 混音台行要求 astats/volume 采样。
// - 系统声音：W4Camera.Survey 的立体声混音候选作第二路 dshow 音频输入，
//   与麦克风经 amix 混入录制（normalize=0，roles.ts 的 amix 同款语义）。
// - 录制标记：M4 §8 标记行（时间 + 文字）；录制时打点，落到时间线对应
//   位置、可跳转。章节导出（ffmetadata）引擎已验证，WPF 导出未接。
//
// 诚实记录：云端 runner 无真 GPU/摄像头/立体声混音设备、无 Whisper 与
// Python onnxruntime 后端，--w5-test 只验纯逻辑 + 合成素材实测；真机
// 交互（面板操作、摄像头、系统声音、Whisper 实录、ONNX 遮罩生成）
// 仍等他在自己电脑上测。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using DogSC.Windows;

namespace DogSC.Replica {
 public class CurvePoint { public double X; public double Y; }

 // color.ts 的 HslCurves / applyCurve / validateHueCurve 的 C# 移植。
 static class HslCurves {
  public static List<CurvePoint> IdentitySat() { return new List<CurvePoint> { new CurvePoint { X = 0, Y = 1 }, new CurvePoint { X = 1, Y = 1 } }; }
  public static List<CurvePoint> IdentityLum() { return new List<CurvePoint> { new CurvePoint { X = 0, Y = 0 }, new CurvePoint { X = 1, Y = 0 } }; }
  // 分段线性查值；端点外钳制到端点 y（不外推），与 TS applyCurve 逐行一致。
  public static double ApplyCurve(List<CurvePoint> points, double x) {
   if (points == null || points.Count == 0) return x;
   if (x <= points[0].X) return points[0].Y;
   var last = points[points.Count - 1];
   if (x >= last.X) return last.Y;
   for (int i = 0; i < points.Count - 1; i++) {
    var p0 = points[i]; var p1 = points[i + 1];
    if (x >= p0.X && x <= p1.X) { double t = (x - p0.X) / (p1.X - p0.X); return p0.Y + t * (p1.Y - p0.Y); }
   }
   return last.Y;
  }
  public static bool IsIdentitySat(List<CurvePoint> points) {
   if (points == null || points.Count == 0) return true;
   foreach (var p in points) if (Math.Abs(p.Y - 1) > .000001) return false;
   return true;
  }
  public static bool IsIdentityLum(List<CurvePoint> points) {
   if (points == null || points.Count == 0) return true;
   foreach (var p in points) if (Math.Abs(p.Y) > .000001) return false;
   return true;
  }
  public static void ValidateCurve(List<CurvePoint> points, string name, double yLo, double yHi) {
   if (points == null || points.Count == 0) return;
   if (points.Count < 2) throw new Exception("HSL 曲线 " + name + " 至少需要 2 个点。");
   double prev = -1;
   foreach (var p in points) {
    if (!EditDocument.Finite(p.X) || !EditDocument.Finite(p.Y) || p.X < 0 || p.X > 1 || p.Y < yLo || p.Y > yHi) throw new Exception("HSL 曲线 " + name + " 的点 (" + Media.N(p.X) + ", " + Media.N(p.Y) + ") 超出 x [0, 1] / y [" + Media.N(yLo) + ", " + Media.N(yHi) + "]。");
    if (p.X <= prev) throw new Exception("HSL 曲线 " + name + " 的 x 必须严格递增。");
    prev = p.X;
   }
  }
  public static string Key(List<CurvePoint> points) {
   if (points == null) return "";
   var sb = new StringBuilder();
   foreach (var p in points) sb.Append(Media.N(p.X)).Append(":").Append(Media.N(p.Y)).Append(";");
   return sb.ToString();
  }
 }

 public enum WhisperBackend { None, WhisperCpp, FasterWhisper }
 public class WhisperResult { public List<SubtitleCue> Cues = new List<SubtitleCue>(); public string Backend = ""; public string Model = ""; }

 // transcribe.ts 的 Windows 路线：whisper.cpp CLI（主）与 faster-whisper
 // Python（备）。两个后端都先经 ffmpeg 解码到 16 kHz 单声道（faster-whisper
 // 用 f32le PCM——TS 脚注：faster-whisper 1.2.1 + av 19.x 的文件输入已坏；
 // whisper.cpp 用 WAV）。small 是默认模型（P0b 实测：tiny 52.4% 字错率不
 // 可用，small 26.2% 可用，需校对；medium 未在代理网速下下载成功）。
 static class WhisperTranscriber {
  public static string DefaultModel = "small";
  public static string[] Models = new[] { "tiny", "small", "medium" };
  public static string ToolsDir() { return Path.Combine(Media.Root, "tools"); }
  public static string ScriptPath() { return Path.Combine(ToolsDir(), "transcribe.py"); }
  public static string ModelDir() { return Path.Combine(ToolsDir(), "models"); }
  public static string WhisperCppModelPath(string model) { return Path.Combine(ModelDir(), "ggml-" + model + ".bin"); }
  // whisper.cpp 模型下载地址（ggerganov/whisper.cpp 官方发布，与模型同名）。
  public static string ModelDownloadUrl(string model) { return "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-" + model + ".bin"; }
  public static string FindWhisperCpp() {
   foreach (string name in new[] { "whisper-cli.exe", "main.exe" }) {
    string local = Path.Combine(ToolsDir(), name);
    if (File.Exists(local)) return local;
   }
   foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
    try { foreach (string name in new[] { "whisper-cli.exe", "main.exe" }) { string p = Path.Combine(dir.Trim('"'), name); if (File.Exists(p)) return p; } }
    catch { }
   }
   return null;
  }
  // Media.Start 只认名字（经 tools/ 与 PATH 解析）；whisper-cli 是完整路径，
  // 这里直接建 Process（与 CaptureEngine 里 Process.Start 的用法一致）。
  static Process StartExe(string exe, string args, bool output) {
   if (exe.IndexOf(Path.DirectorySeparatorChar) >= 0 || exe.IndexOf(Path.AltDirectorySeparatorChar) >= 0 || File.Exists(exe)) {
    var p = new Process();
    p.StartInfo = new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardError = true, RedirectStandardOutput = output, StandardErrorEncoding = Encoding.UTF8, StandardOutputEncoding = output ? Encoding.UTF8 : null };
    p.Start();
    return p;
   }
   return Media.Start(exe, args, output);
  }
  static bool PythonHasFasterWhisper(string python) {
   try {
    using (var p = StartExe(python, "-c \"import faster_whisper\"", false)) {
     var err = p.StandardError.ReadToEndAsync();
     if (!p.WaitForExit(15000)) { try { p.Kill(); } catch { } return false; }
     return p.ExitCode == 0;
    }
   }
   catch { return false; }
  }
  public static string FindPython() {
   foreach (string name in new[] { "python", "py", "python3" }) {
    try {
     using (var p = StartExe(name, "--version", false)) {
      var err = p.StandardError.ReadToEndAsync();
      if (!p.WaitForExit(10000)) { try { p.Kill(); } catch { } continue; }
      if (p.ExitCode == 0) return name;
     }
    }
    catch { }
   }
   return null;
  }
  public static WhisperBackend DetectBackend(out string detail) {
   string cli = FindWhisperCpp();
   if (cli != null) { detail = cli; return WhisperBackend.WhisperCpp; }
   string python = FindPython();
   if (python != null && File.Exists(ScriptPath()) && PythonHasFasterWhisper(python)) { detail = python + " + faster-whisper"; return WhisperBackend.FasterWhisper; }
   if (python == null) detail = "未找到 Python（python/py/python3 均不在 PATH）。";
   else if (!File.Exists(ScriptPath())) detail = "缺少 transcribe.py（应随包分发在 tools/ 下）。";
   else detail = "Python 已找到，但未装 faster-whisper（pip install faster-whisper）。";
   return WhisperBackend.None;
  }
  public static string DescribeBackend() {
   string detail;
   var kind = DetectBackend(out detail);
   if (kind == WhisperBackend.WhisperCpp) return "后端：whisper.cpp（" + detail + "）。模型首次运行从 Hugging Face 下载（small 约 466 MB）。";
   if (kind == WhisperBackend.FasterWhisper) return "后端：faster-whisper（" + detail + "）。模型首次运行从 Hugging Face 下载（small 约 466 MB）。";
   return "未接后端：" + detail + " whisper.cpp（whisper-cli.exe 放到 tools/ 下）或 Python faster-whisper 任选其一；模型首次运行从 Hugging Face 下载。";
  }
  // whisper.cpp CLI：-m 模型 -f 音频 -l 语言 --output-json --output-file 前缀。
  public static string BuildWhisperCppArgs(string cli, string modelPath, string wav, string language, string outPrefix) {
   return "-m " + Media.Q(modelPath) + " -f " + Media.Q(wav) + " -l " + language + " --output-json --output-file " + Media.Q(outPrefix) + " --print-progress false";
  }
  // faster-whisper：transcribe.py --pcm16k <pcm> --model small --language zh --out <json>（与 transcribe.ts 逐字一致）。
  public static string BuildFasterWhisperArgs(string python, string pcm, string model, string language, string json) {
   return Media.Q(ScriptPath()) + " --pcm16k " + Media.Q(pcm) + " --model " + model + " --language " + language + " --out " + Media.Q(json);
  }
  static double ParseWhisperTime(string s) {
   // "HH:MM:SS.mmm" 或纯秒数。
   double v;
   if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return v;
   var parts = s.Split(':');
   if (parts.Length == 3) {
    double h, m, sec;
    if (double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out h) && double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out m) && double.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out sec)) return h * 3600 + m * 60 + sec;
   }
   throw new Exception("Whisper 时间戳无法解析：" + s);
  }
  static string JsonString(string json, string key) {
   int at = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
   if (at < 0) return null;
   int colon = json.IndexOf(':', at + key.Length + 2);
   if (colon < 0) return null;
   int q1 = json.IndexOf('"', colon + 1);
   if (q1 < 0) return null;
   var sb = new StringBuilder();
   for (int i = q1 + 1; i < json.Length; i++) {
    char c = json[i];
    if (c == '\\' && i + 1 < json.Length) { char n = json[i + 1]; if (n == 'n') sb.Append('\n'); else if (n == 't') sb.Append('\t'); else if (n == 'r') sb.Append('\r'); else if (n == 'u' && i + 5 < json.Length) { int cp; if (int.TryParse(json.Substring(i + 2, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out cp)) sb.Append((char)cp); i += 5; } else sb.Append(n); i++; continue; }
    if (c == '"') break;
    sb.Append(c);
   }
   return sb.ToString();
  }
  static double JsonNumber(string json, string key) {
   int at = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
   if (at < 0) throw new Exception("Whisper JSON 缺少字段：" + key);
   int colon = json.IndexOf(':', at + key.Length + 2);
   if (colon < 0) throw new Exception("Whisper JSON 字段格式错误：" + key);
   int i = colon + 1;
   while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
   int j = i;
   while (j < json.Length && (char.IsDigit(json[j]) || json[j] == '.' || json[j] == '-' || json[j] == 'e' || json[j] == 'E' || json[j] == '+')) j++;
   double v;
   if (!double.TryParse(json.Substring(i, j - i), NumberStyles.Float, CultureInfo.InvariantCulture, out v)) throw new Exception("Whisper JSON 数字解析失败：" + key);
   return v;
  }
  static List<string> SplitTopObjects(string json, string arrayKey) {
   int at = json.IndexOf("\"" + arrayKey + "\"", StringComparison.Ordinal);
   if (at < 0) return new List<string>();
   int open = json.IndexOf('[', at);
   if (open < 0) return new List<string>();
   var list = new List<string>();
   int depth = 0; int start = -1; bool inStr = false;
   for (int i = open; i < json.Length; i++) {
    char c = json[i];
    if (inStr) { if (c == '\\') i++; else if (c == '"') inStr = false; continue; }
    if (c == '"') { inStr = true; continue; }
    if (c == '{') { if (depth == 0) start = i; depth++; }
    else if (c == '}') { depth--; if (depth == 0 && start >= 0) { list.Add(json.Substring(start, i - start + 1)); start = -1; } }
    else if (c == ']' && depth == 0) break;
   }
   return list;
  }
  // whisper.cpp --output-json：{"transcription": [{"timestamps": {"from": "00:00:00.000", "to": "..."}, "text": "..."}]}
  public static List<SubtitleCue> ParseWhisperCppJson(string json) {
   var cues = new List<SubtitleCue>();
   foreach (string obj in SplitTopObjects(json, "transcription")) {
    string from = null, to = null;
    int ts = obj.IndexOf("\"timestamps\"", StringComparison.Ordinal);
    if (ts >= 0) { string sub = obj.Substring(ts); from = JsonString(sub, "from"); to = JsonString(sub, "to"); }
    if (from == null) {
     // 退路：offsets 是毫秒数（{"from": 0, "to": 1000}）。
     int off = obj.IndexOf("\"offsets\"", StringComparison.Ordinal);
     if (off >= 0) { string sub = obj.Substring(off); from = (JsonNumber(sub, "from") / 1000).ToString(CultureInfo.InvariantCulture); to = (JsonNumber(sub, "to") / 1000).ToString(CultureInfo.InvariantCulture); }
    }
    string text = JsonString(obj, "text");
    if (from == null || to == null || string.IsNullOrWhiteSpace(text)) continue;
    var cue = new SubtitleCue { Start = ParseWhisperTime(from), End = ParseWhisperTime(to), Text = text.Trim() };
    if (cue.End > cue.Start) cues.Add(cue);
   }
   if (cues.Count == 0) throw new Exception("whisper.cpp 输出里没有解析出字幕段。");
   return cues;
  }
  // faster-whisper transcribe.py：{"segments": [{"text", "start", "end", "words": [...]}]}
  public static List<SubtitleCue> ParseFasterWhisperJson(string json) {
   var cues = new List<SubtitleCue>();
   foreach (string obj in SplitTopObjects(json, "segments")) {
    string text = JsonString(obj, "text");
    if (string.IsNullOrWhiteSpace(text)) continue;
    var cue = new SubtitleCue { Start = JsonNumber(obj, "start"), End = JsonNumber(obj, "end"), Text = text.Trim() };
    if (cue.End > cue.Start) cues.Add(cue);
   }
   if (cues.Count == 0) throw new Exception("faster-whisper 输出里没有解析出字幕段。");
   return cues;
  }
  static void RunChecked(string exe, string args, CancellationToken token, string what) {
   using (var p = StartExe(exe, args, false))
   using (token.Register(() => { try { p.Kill(); } catch { } })) {
    var err = p.StandardError.ReadToEndAsync();
    p.StandardInput.Close();
    p.WaitForExit();
    token.ThrowIfCancellationRequested();
    if (p.ExitCode != 0) throw new Exception(what + "失败：" + err.Result);
   }
  }
  public static async Task<WhisperResult> TranscribeAsync(string audioFile, string model, string language, Action<string> status, CancellationToken token) {
   if (!Models.Contains(model)) throw new Exception("Whisper 模型必须是 tiny/small/medium。");
   if (string.IsNullOrEmpty(language)) language = "zh";
   string detail;
   var backend = DetectBackend(out detail);
   if (backend == WhisperBackend.None) throw new Exception("没有可用的 Whisper 后端。" + detail);
   string work = Path.Combine(Path.GetTempPath(), "catcut-whisper-" + Guid.NewGuid().ToString("N"));
   Directory.CreateDirectory(work);
   try {
    string wav = Path.Combine(work, "audio-16k.wav");
    string pcm = Path.Combine(work, "audio-16k.raw");
    string json = Path.Combine(work, "subtitles.json");
    status("正在解码音频到 16 kHz 单声道…");
    await Task.Run(() => RunChecked("ffmpeg", "-v error -i " + Media.Q(audioFile) + " -ar 16000 -ac 1 -y " + Media.Q(wav), token, "音频解码"), token);
    var cues = new List<SubtitleCue>();
    if (backend == WhisperBackend.WhisperCpp) {
     string modelPath = WhisperCppModelPath(model);
     if (!File.Exists(modelPath)) throw new Exception("缺少 whisper.cpp 模型：" + modelPath + "。请先在字幕面板点“下载 " + model + " 模型”（约 " + (model == "tiny" ? "75 MB" : model == "small" ? "466 MB" : "1.5 GB") + "，从 Hugging Face 下载）。");
     string cli = FindWhisperCpp();
     string prefix = Path.Combine(work, "out");
     status("正在转写（whisper.cpp · " + model + "，首次加载模型较慢）…");
     await Task.Run(() => RunChecked(cli, BuildWhisperCppArgs(cli, modelPath, wav, language, prefix), token, "whisper.cpp 转写"), token);
     cues = ParseWhisperCppJson(File.ReadAllText(prefix + ".json", Encoding.UTF8));
     return new WhisperResult { Cues = cues, Backend = "whisper.cpp", Model = model };
    }
    await Task.Run(() => RunChecked("ffmpeg", "-v error -i " + Media.Q(wav) + " -f f32le -y " + Media.Q(pcm), token, "PCM 解码"), token);
    string python = FindPython();
    status("正在转写（faster-whisper · " + model + "，首次加载模型较慢）…");
    await Task.Run(() => RunChecked(python, BuildFasterWhisperArgs(python, pcm, model, language, json), token, "faster-whisper 转写"), token);
    cues = ParseFasterWhisperJson(File.ReadAllText(json, Encoding.UTF8));
    return new WhisperResult { Cues = cues, Backend = "faster-whisper", Model = model };
   }
   finally { try { Directory.Delete(work, true); } catch { } }
  }
  public static async Task DownloadModelAsync(string model, Action<string> status, CancellationToken token) {
   string url = ModelDownloadUrl(model);
   string path = WhisperCppModelPath(model);
   Directory.CreateDirectory(ModelDir());
   string tmp = path + ".download";
   using (var web = new WebClient()) {
    web.DownloadProgressChanged += (s, e) => status("正在下载 " + model + " 模型…" + (e.TotalBytesToReceive > 0 ? " " + (e.BytesReceived / 1048576) + " / " + (e.TotalBytesToReceive / 1048576) + " MB" : " " + (e.BytesReceived / 1048576) + " MB"));
    token.Register(() => { try { web.CancelAsync(); } catch { } });
    await web.DownloadFileTaskAsync(new Uri(url), tmp);
   }
   token.ThrowIfCancellationRequested();
   if (File.Exists(path)) File.Delete(path);
   File.Move(tmp, path);
  }
 }

 // beauty.ts 的 hqdn3dFilter / beautyFilter / validateBeauty 与
 // filtergraph.ts 的 applyBeautyStage 的 C# 移植。
 static class BeautyFilter {
  // hqdn3d 强度映射（P3d 探针实测：强度 25→HF 10.49、50→10.37、
  // 75→9.25、100→6.37；亮度均值不变）。
  public static string Hqdn3dFilter(double strength) {
   double s = Math.Max(0, Math.Min(100, strength));
   return "hqdn3d=" + (s * 0.08).ToString("F2", CultureInfo.InvariantCulture) + ":" + (s * 0.06).ToString("F2", CultureInfo.InvariantCulture) + ":" + (s * 0.1).ToString("F2", CultureInfo.InvariantCulture) + ":" + (s * 0.08).ToString("F2", CultureInfo.InvariantCulture);
  }
  // 美颜链：hqdn3d + 轻微提亮 + unsharp 0.1（0.3 会把柔化吃回去，
  // P3d 探针实测：in-mask HF 2.60→2.33，out-of-mask 1.74 不动）。
  public static string Chain(double strength) {
   double s = Math.Max(0, Math.Min(100, strength));
   string bright = (0.03 * s / 100).ToString("F3", CultureInfo.InvariantCulture);
   return Hqdn3dFilter(s) + ",eq=brightness=" + bright + ",unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=0.1";
  }
  public static string MaskPathFor(string source) { return source + ".beauty-mask.mp4"; }
  public static bool IsMasked(EditDocument doc) {
   return doc.BeautyEnabled && !string.IsNullOrEmpty(doc.BeautyMaskPath) && File.Exists(doc.BeautyMaskPath);
  }
  public static void Validate(EditDocument doc) {
   if (!EditDocument.Finite(doc.DenoiseStrength) || doc.DenoiseStrength < 0 || doc.DenoiseStrength > 100) throw new Exception("视频降噪强度超出 0–100。");
   if (!doc.BeautyEnabled) return;
   if (!EditDocument.Finite(doc.BeautyStrength) || doc.BeautyStrength < 0 || doc.BeautyStrength > 100) throw new Exception("美颜强度超出 0–100。");
   if (doc.BeautyMode != "single" && doc.BeautyMode != "multi") throw new Exception("美颜模式必须是“单人”或“多人”。");
   if (!EditDocument.Finite(doc.BeautyEdgeFeather) || doc.BeautyEdgeFeather < 0 || doc.BeautyEdgeFeather > 5) throw new Exception("美颜边缘羽化超出 0–5。");
   if (MulticamModel.Active(doc)) throw new Exception("美颜不支持多机位片段（遮罩按单源算，引擎 v1 限制）。");
   foreach (var c in doc.Cuts) if (!c.Gap && Math.Abs(c.Speed - 1) > .000001) throw new Exception("美颜要求变速为 1x（遮罩按源帧算，变速会错位，引擎 v1 限制）。");
   if (string.IsNullOrEmpty(doc.BeautyMaskPath) || !File.Exists(doc.BeautyMaskPath)) throw new Exception("美颜已开启，但人像遮罩缺失：" + (string.IsNullOrEmpty(doc.BeautyMaskPath) ? "（未生成）" : doc.BeautyMaskPath) + "。请先在美颜面板生成遮罩，或关闭美颜。");
  }
  // applyBeautyStage 的图（TS 逐字照抄，只改标签名）：
  // [v]split[v1][v2];[v2]<美颜链>[vb];[vb]format=yuva420p[vbf];
  // [vbf][m]alphamerge[bm];[v1][bm]overlay=0:0,format=yuv420p[out]
  // 遮罩链（调用方拼在前面）：[1:v]fps=fps=<fps>,scale=<w>:<h>,
  // format=gray[,gblur=sigma=<羽化>][m]。TS 的遮罩已预缩放到项目尺寸，
  // C# 在图里 scale（解码尺寸因代理/预览而变，见 W5Media）。
  public static string MaskedGraph(double strength, double feather, string gradeFilters) {
   var sb = new StringBuilder();
   sb.Append("[v]split[v1][v2];");
   sb.Append("[v2]").Append(Chain(strength)).Append("[vb];");
   sb.Append("[vb]format=yuva420p[vbf];");
   sb.Append("[vbf][m]alphamerge[bm];");
   if (string.IsNullOrEmpty(gradeFilters)) {
    sb.Append("[v1][bm]overlay=0:0,format=yuv420p[out];");
    return sb.ToString();
   }
   sb.Append("[v1][bm]overlay=0:0,format=yuv420p[vb2];");
   sb.Append("[vb2]").Append(gradeFilters).Append("[out];");
   return sb.ToString();
  }
  public static string MaskChain(double fps, string width, string height, double feather) {
   string blur = feather > 0 ? ",gblur=sigma=" + Media.N(feather) : "";
   return "[1:v]fps=fps=" + Media.N(fps) + ",scale=" + width + ":" + height + ",format=gray" + blur + "[m];";
  }
 }

 // 人像遮罩生成：portrait_segment.py（MediaPipe Selfie Segmentation
 // ONNX，模型随包分发）→ beauty_mask.py（单人取最大连通域 / 多人全留）。
 // 需要系统 Python + onnxruntime + numpy；缺一不可，缺了就报清楚缺什么。
 static class BeautyMask {
  public static string ScriptDir() { return Path.Combine(Media.Root, "tools"); }
  public static string PortraitScript() { return Path.Combine(ScriptDir(), "portrait_segment.py"); }
  public static string FilterScript() { return Path.Combine(ScriptDir(), "beauty_mask.py"); }
  public static string ModelPath() { return Path.Combine(ScriptDir(), "models", "selfie_segmentation_256x256.onnx"); }
  public static string CheckBackend() {
   string python = WhisperTranscriber.FindPython();
   if (python == null) return "未找到 Python（python/py/python3 均不在 PATH）。装 Python 后再生成遮罩。";
   if (!File.Exists(PortraitScript()) || !File.Exists(FilterScript())) return "缺少遮罩脚本（tools/portrait_segment.py、beauty_mask.py 应随包分发）。";
   if (!File.Exists(ModelPath())) return "缺少人像分割模型（tools/models/selfie_segmentation_256x256.onnx 应随包分发）。";
   try {
    using (var p = Media.Start(python, "-c \"import onnxruntime, numpy\"", false)) {
     var err = p.StandardError.ReadToEndAsync();
     if (!p.WaitForExit(20000)) { try { p.Kill(); } catch { } return "检查 onnxruntime 超时。"; }
     if (p.ExitCode != 0) return "Python 未装 onnxruntime / numpy（pip install onnxruntime numpy），报错：" + err.Result.Trim();
    }
   }
   catch (Exception ex) { return "检查 Python 后端失败：" + ex.Message; }
   return null;
  }
  public static async Task<string> GenerateAsync(string source, string mode, Action<string> status, CancellationToken token) {
   string problem = CheckBackend();
   if (problem != null) throw new Exception(problem);
   var info = StudioMedia.Import(source);
   string mask = BeautyFilter.MaskPathFor(source);
   string raw = Path.Combine(Path.GetDirectoryName(source), Path.GetFileNameWithoutExtension(source) + ".beauty-raw-mask.mp4");
   string python = WhisperTranscriber.FindPython();
   try {
    status("正在生成人像遮罩（ONNX 逐帧推理，首次较慢）…");
    await Task.Run(() => {
     using (var p = Media.Start(python, Media.Q(PortraitScript()) + " --video " + Media.Q(source) + " --model " + Media.Q(ModelPath()) + " --out " + Media.Q(raw) + " --fps " + Media.N(info.FrameRate) + " --dur " + Media.N(info.Duration) + " --width " + info.Width + " --height " + info.Height, false))
     using (token.Register(() => { try { p.Kill(); } catch { } })) {
      var err = p.StandardError.ReadToEndAsync();
      p.StandardInput.Close();
      p.WaitForExit();
      token.ThrowIfCancellationRequested();
      if (p.ExitCode != 0) throw new Exception("人像分割失败：" + err.Result);
     }
    }, token);
    status("正在筛选遮罩（" + (mode == "multi" ? "多人全员" : "单人只修主角") + "）…");
    await Task.Run(() => {
     using (var p = Media.Start(python, Media.Q(FilterScript()) + " --mask " + Media.Q(raw) + " --out " + Media.Q(mask) + " --mode " + mode + " --width " + info.Width + " --height " + info.Height + " --fps " + Media.N(info.FrameRate), false))
     using (token.Register(() => { try { p.Kill(); } catch { } })) {
      var err = p.StandardError.ReadToEndAsync();
      p.StandardInput.Close();
      p.WaitForExit();
      token.ThrowIfCancellationRequested();
      if (p.ExitCode != 0) throw new Exception("遮罩筛选失败：" + err.Result);
     }
    }, token);
    return mask;
   }
   finally { try { if (File.Exists(raw)) File.Delete(raw); } catch { } }
  }
  // 导出用的同步版：从已拼好的时间线媒体（timeline.mp4）重建遮罩——
  // 源遮罩与拼好的时间线不对齐（切分/变速/空隙），不能复用。
  // from/duration 是时间线内的范围；fps/width/height 是导出规格。
  public static string GenerateSync(string source, string mode, double from, double duration, double fps, int width, int height, string outputPath, CancellationToken token) {
   string problem = CheckBackend();
   if (problem != null) throw new Exception(problem);
   string python = WhisperTranscriber.FindPython();
   string raw = Path.Combine(Path.GetDirectoryName(outputPath), Path.GetFileNameWithoutExtension(outputPath) + ".raw.mp4");
   try {
    using (var p = Media.Start(python, Media.Q(PortraitScript()) + " --video " + Media.Q(source) + " --model " + Media.Q(ModelPath()) + " --out " + Media.Q(raw) + " --fps " + Media.N(fps) + " --in " + Media.N(from) + " --dur " + Media.N(duration) + " --width " + width + " --height " + height, false))
    using (token.Register(() => { try { p.Kill(); } catch { } })) {
     var err = p.StandardError.ReadToEndAsync();
     p.StandardInput.Close(); p.WaitForExit(); token.ThrowIfCancellationRequested();
     if (p.ExitCode != 0) throw new Exception("人像分割失败：" + err.Result);
    }
    using (var p = Media.Start(python, Media.Q(FilterScript()) + " --mask " + Media.Q(raw) + " --out " + Media.Q(outputPath) + " --mode " + mode + " --width " + width + " --height " + height + " --fps " + Media.N(fps), false))
    using (token.Register(() => { try { p.Kill(); } catch { } })) {
     var err = p.StandardError.ReadToEndAsync();
     p.StandardInput.Close(); p.WaitForExit(); token.ThrowIfCancellationRequested();
     if (p.ExitCode != 0) throw new Exception("遮罩筛选失败：" + err.Result);
    }
    return outputPath;
   }
   finally { try { if (File.Exists(raw)) File.Delete(raw); } catch { } }
  }
  public static bool IsStale(string source, string mask) {
   if (!File.Exists(mask)) return true;
   try { return File.GetLastWriteTimeUtc(source) > File.GetLastWriteTimeUtc(mask); }
   catch { return true; }
  }
 }

 // 解码 vf 链的 W5 追加片段（以逗号开头，拼在 scale=... 之后，与
 // Grade.VideoFilter() 的用法一致）。降噪是整条时间线统一强度（引擎
 // 是逐片段；C# 解码时作用于已拼好的时间线，见面板 Note）。美颜有遮罩
 // 时走遮罩图（W5Media），这里只出降噪；美颜开但遮罩缺失是硬错。
 static class W5Effects {
  public static string VideoFilter(EditDocument doc) {
   if (doc.BeautyEnabled && string.IsNullOrEmpty(doc.BeautyMaskPath)) throw new Exception("美颜已开启，但人像遮罩缺失。请先在美颜面板生成遮罩，或关闭美颜。");
   if (doc.BeautyEnabled && !File.Exists(doc.BeautyMaskPath)) throw new Exception("美颜已开启，但人像遮罩文件不存在：" + doc.BeautyMaskPath + "。请重新生成遮罩，或关闭美颜。");
   if (doc.DenoiseStrength <= 0) return "";
   return "," + BeautyFilter.Hqdn3dFilter(doc.DenoiseStrength);
  }
  // 调色片段去掉开头的逗号（供 filter_complex 里拼在标签后）。
  public static string GradeChain(ColorGrade grade) {
   string vf = grade.VideoFilter();
   return vf.StartsWith(",") ? vf.Substring(1) : vf;
  }
 }

 // 遮罩美颜的解码入口（暂停预览用；导出与播放各有一份同款拼装，
 // 见 EditorCore.Export 与 EditorApp.Play，图结构与这里一致）。
 static class W5Media {
  // videoFilters：[0:v] 之后、split 之前的链（如 scale=640:-2,hqdn3d=…）。
  // maskW/maskH：遮罩缩放目标（与视频帧同尺寸，alphamerge 要求同尺寸）。
  public static string MaskedFilterComplex(string videoFilters, double maskFps, string maskW, string maskH, EditDocument doc) {
   var sb = new StringBuilder();
   sb.Append("[0:v]").Append(videoFilters).Append("[v];");
   sb.Append(BeautyFilter.MaskChain(maskFps, maskW, maskH, doc.BeautyEdgeFeather));
   sb.Append(BeautyFilter.MaskedGraph(doc.BeautyStrength, doc.BeautyEdgeFeather, W5Effects.GradeChain(doc.Grade)));
   return sb.ToString();
  }
  public static byte[] FrameMasked(string path, double time, int width, CancellationToken token, string videoFilters, EditDocument doc) {
   token.ThrowIfCancellationRequested();
   string graph = MaskedFilterComplex(videoFilters, doc.FrameRate, width.ToString(CultureInfo.InvariantCulture), "-2", doc);
   using (var p = Media.Start("ffmpeg", "-v error -threads 2 -filter_threads 1 -ss " + Media.N(Math.Max(0, time)) + " -i " + Media.Q(path) + " -ss " + Media.N(Math.Max(0, time)) + " -i " + Media.Q(doc.BeautyMaskPath) + " -frames:v 1 -filter_complex " + Media.Q(graph) + " -map [out] -threads 1 -f image2pipe -vcodec png pipe:1", true))
   using (token.Register(() => { try { if (!p.HasExited) p.Kill(); } catch { } })) {
    var errors = p.StandardError.ReadToEndAsync();
    using (var ms = new MemoryStream()) { p.StandardOutput.BaseStream.CopyTo(ms); p.WaitForExit(); token.ThrowIfCancellationRequested(); if (p.ExitCode != 0) throw new Exception(errors.Result); return ms.ToArray(); }
   }
  }
 }

 public class BeatGrid { public double Bpm; public double Period; public List<double> Beats = new List<double>(); public List<double> Onsets = new List<double>(); public double Confidence; public double Duration; }

 // beat.ts 的 C# 移植：对数能量差包络（窗 1024 / 跳 256）+ 自相关 BPM
 // （60–200）+ 起音中位数周期精修 + 采样级起音精修（25% 峰值穿越，
 // 搜索窗 [-10ms, +80ms]）。只认起音丰富的音频（鼓点/打击乐），人声
 // 独白置信度低——与引擎限制一致。
 static class BeatDetector {
  const int SampleRate = 16000;
  public static float[] DecodeAudioMono(string file, double from, double duration, CancellationToken token) {
   using (var p = Media.Start("ffmpeg", "-v error -ss " + Media.N(Math.Max(0, from)) + " -t " + Media.N(duration) + " -i " + Media.Q(file) + " -ac 1 -ar " + SampleRate + " -f f32le -", true))
   using (token.Register(() => { try { if (!p.HasExited) p.Kill(); } catch { } })) {
    var errors = p.StandardError.ReadToEndAsync();
    using (var ms = new MemoryStream()) { p.StandardOutput.BaseStream.CopyTo(ms); p.WaitForExit(); token.ThrowIfCancellationRequested(); if (p.ExitCode != 0) throw new Exception(errors.Result); byte[] bytes = ms.ToArray(); var samples = new float[bytes.Length / 4]; for (int i = 0; i < samples.Length; i++) samples[i] = BitConverter.ToSingle(bytes, i * 4); return samples; }
   }
  }
  static double[] OnsetEnvelope(float[] samples, out double hopSec) {
   const int win = 1024; const int hop = 256;
   hopSec = (double)hop / SampleRate;
   int n = Math.Max(1, (samples.Length - win) / hop + 1);
   var energy = new double[n];
   for (int i = 0; i < n; i++) { double e = 0; int off = i * hop; for (int j = 0; j < win; j++) { double v = samples[off + j]; e += v * v; } energy[i] = e / win; }
   var env = new double[n];
   for (int i = 1; i < n; i++) { double d = Math.Log(energy[i] + 1e-12) - Math.Log(energy[i - 1] + 1e-12); env[i] = d > 0 ? d : 0; }
   return env;
  }
  static List<double> PickOnsets(double[] env, double hopSec, double thresholdFrac) {
   double max = 0;
   foreach (double v in env) if (v > max) max = v;
   if (max <= 0) return new List<double>();
   double thr = max * thresholdFrac;
   int minGap = Math.Max(1, (int)Math.Round(0.12 / hopSec));
   var onsets = new List<double>();
   int last = -minGap - 1;
   for (int i = 1; i + 1 < env.Length; i++) {
    if (env[i] >= thr && env[i] >= env[i - 1] && env[i] >= env[i + 1] && i - last >= minGap) { onsets.Add(i * hopSec); last = i; }
   }
   return onsets;
  }
  static List<double> RefineOnsets(float[] samples, List<double> coarse) {
   var refined = new List<double>();
   foreach (double c in coarse) {
    int centre = (int)Math.Round(c * SampleRate);
    int lo = Math.Max(0, centre - (int)Math.Round(0.01 * SampleRate));
    int hi = Math.Min(samples.Length - 1, centre + (int)Math.Round(0.08 * SampleRate));
    double peak = 0;
    for (int i = lo; i <= hi; i++) { double a = Math.Abs(samples[i]); if (a > peak) peak = a; }
    if (peak <= 0) { refined.Add(c); continue; }
    double thr = 0.25 * peak;
    int found = -1;
    for (int i = lo; i <= hi; i++) if (Math.Abs(samples[i]) >= thr) { found = i; break; }
    refined.Add(found >= 0 ? (double)found / SampleRate : c);
   }
   return refined;
  }
  static double Autocorr(double[] env, int lag) {
   double s = 0;
   for (int i = 0; i + lag < env.Length; i++) s += env[i] * env[i + lag];
   return s;
  }
  public static BeatGrid DetectFromSamples(float[] samples) {
   double duration = (double)samples.Length / SampleRate;
   double hopSec;
   double[] env = OnsetEnvelope(samples, out hopSec);
   var onsets = RefineOnsets(samples, PickOnsets(env, hopSec, 0.3));
   double ac0 = Autocorr(env, 0);
   if (onsets.Count < 2 || ac0 <= 0) return new BeatGrid { Bpm = 0, Period = 0, Beats = new List<double>(), Onsets = onsets, Confidence = 0, Duration = duration };
   Func<double, int> lagForBpm = bpm => (int)Math.Round(60 / bpm / hopSec);
   int minLag = lagForBpm(200), maxLag = lagForBpm(60);
   int bestLag = minLag; double bestVal = -1;
   for (int lag = minLag; lag <= maxLag; lag++) { double v = Autocorr(env, lag); if (v > bestVal) { bestVal = v; bestLag = lag; } }
   int lag = bestLag;
   int halfLag = (int)Math.Round(bestLag / 2.0);
   if (halfLag >= minLag && Autocorr(env, halfLag) >= 0.9 * bestVal) { lag = halfLag; bestVal = Autocorr(env, halfLag); }
   double coarsePeriod = lag * hopSec;
   var intervals = new List<double>();
   for (int i = 1; i < onsets.Count; i++) { double d = onsets[i] - onsets[i - 1]; if (d >= 0.8 * coarsePeriod && d <= 1.25 * coarsePeriod) intervals.Add(d); }
   double period = coarsePeriod;
   if (intervals.Count > 0) { intervals.Sort(); period = intervals[intervals.Count / 2]; }
   double bpm = 60 / period;
   double confidence = Math.Min(1, bestVal / ac0);
   double maxOnset = 0;
   foreach (double v in env) if (v > maxOnset) maxOnset = v;
   double anchor = onsets[0];
   foreach (double t in onsets) { int i = (int)Math.Round(t / hopSec); if (i >= 0 && i < env.Length && env[i] >= 0.5 * maxOnset) { anchor = t; break; } }
   var beats = new List<double>();
   for (double t = anchor; t <= duration + 1e-6; t += period) {
    double best = t; double bestD = 0.06;
    foreach (double on in onsets) { double d = Math.Abs(on - t); if (d < bestD) { bestD = d; best = on; } }
    beats.Add(best);
   }
   return new BeatGrid { Bpm = bpm, Period = period, Beats = beats, Onsets = onsets, Confidence = confidence, Duration = duration };
  }
  public static BeatGrid Detect(string file, double from, double duration, CancellationToken token) {
   float[] samples = DecodeAudioMono(file, from, duration, token);
   return DetectFromSamples(samples);
  }
  // beatSpeedNodes（project.ts）：首节点 t=0 取 startWith 速度，每拍翻转。
  public static List<CurvePoint> BeatSpeedNodes(List<double> beats, double slow, double fast, bool startSlow) {
   var nodes = new List<CurvePoint> { new CurvePoint { X = 0, Y = startSlow ? slow : fast } };
   bool curSlow = startSlow;
   foreach (double b in beats) { curSlow = !curSlow; nodes.Add(new CurvePoint { X = b, Y = curSlow ? slow : fast }); }
   return nodes;
  }
  // splitClipByBeats（beat.ts）的 C# 版：按节拍把一个 Cut 切成多个匀速
  // Cut，速度按节拍交替（默认慢 0.5x / 快 2x）。切点落在 (Start, End)
  // 内；过短（< minSegment）的段丢弃（与相邻段合并速度不变）。
  // 返回切分后的片段数；beats 是片段内源时间（相对 Cut.Start）。
  public static int ApplyBeatSplit(EditDocument doc, int cutIndex, List<double> beats, double slow, double fast, bool startSlow, double minSegment) {
   if (cutIndex < 0 || cutIndex >= doc.Cuts.Count) throw new Exception("没有选中的片段。");
   var cut = doc.Cuts[cutIndex];
   if (cut.Gap) throw new Exception("空隙片段不能卡点变速。");
   if (slow < 0.25 || slow > 4 || fast < 0.25 || fast > 4) throw new Exception("卡点变速的慢/快速必须在 0.25–4x 之间。");
   if (minSegment < 0.1 || minSegment > 5) throw new Exception("卡点变速的最短片段必须在 0.1–5 秒之间。");
   if (beats == null || beats.Count == 0) throw new Exception("没有检测到节拍，先点“检测节拍”。");
   double prev = -1;
   foreach (double b in beats) { if (b <= 0 || b >= cut.End - cut.Start) throw new Exception("节拍点 " + Media.N(b) + "s 不在片段源范围内。"); if (b <= prev) throw new Exception("节拍点必须严格递增。"); prev = b; }
   var nodes = BeatSpeedNodes(beats, slow, fast, startSlow);
   // 节点是源时间；切分点 = Start + 节点 t（去掉 t=0 的首节点）。
   var edges = new List<double> { cut.Start };
   foreach (var n in nodes) { double at = cut.Start + n.X; if (at > cut.Start + 1e-6 && at < cut.End - 1e-6) edges.Add(at); }
   edges.Add(cut.End);
   // 先按节点速度切好，再把过短的段并入相邻段（并入后速度取合并段起始节点的速度，
   // 与 TS splitClipByBeats“丢弃过短切分点”的语义一致）。
   var segs = new List<double[]>();
   for (int i = 0; i < edges.Count - 1; i++) segs.Add(new[] { edges[i], edges[i + 1], nodes[Math.Min(i, nodes.Count - 1)].Y });
   for (int i = segs.Count - 1; i >= 0; i--) {
    if (segs[i][1] - segs[i][0] >= minSegment || segs.Count <= 1) continue;
    if (i > 0) { segs[i - 1][1] = segs[i][1]; segs.RemoveAt(i); }
    else { segs[1][0] = segs[0][0]; segs[1][2] = segs[0][2]; segs.RemoveAt(0); }
   }
   var pieces = new List<Cut>();
   foreach (var s in segs) pieces.Add(new Cut { Start = s[0], End = s[1], Speed = s[2] });
   if (pieces.Count < 2) throw new Exception("按节拍切分后只剩一段（节拍太稀或片段太短），未改动。");
   doc.Cuts.RemoveAt(cutIndex);
   doc.Cuts.InsertRange(cutIndex, pieces);
   return pieces.Count;
  }
 }

 // 电平表：astats 实时跟随（-re）+ volumedetect 静态分析。
 // astats 输出的 -inf（数字静音）按 -91 dB 计（与引擎的静音底一致）。
 public class LevelMeter {
  public event Action<double, double, double> Updated;
  Process process;
  readonly object gate = new object();
  bool running;
  public bool IsRunning { get { lock (gate) return running; } }
  public static double ParseDb(string text) {
   if (string.IsNullOrWhiteSpace(text)) return -91;
   double v;
   if (double.TryParse(text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return v;
   return -91;
  }
  public static Tuple<double, double> ParseAstatsLine(string line, ref double rms, ref double peak) {
   if (line == null) return null;
   int at = line.IndexOf("lavfi.astats.Overall.RMS_level", StringComparison.Ordinal);
   if (at >= 0) { int eq = line.IndexOf('=', at); if (eq >= 0) rms = ParseDb(line.Substring(eq + 1)); return null; }
   at = line.IndexOf("lavfi.astats.Overall.Peak_level", StringComparison.Ordinal);
   if (at >= 0) { int eq = line.IndexOf('=', at); if (eq >= 0) peak = ParseDb(line.Substring(eq + 1)); return Tuple.Create(rms, peak); }
   return null;
  }
  public void Start(string source, double from, double duration) {
   Stop();
   lock (gate) running = true;
   var watch = Stopwatch.StartNew();
   Task.Run(() => {
    try {
     using (var p = Media.Start("ffmpeg", "-v info -re -ss " + Media.N(Math.Max(0, from)) + " -i " + Media.Q(source) + " -t " + Media.N(duration) + " -vn -af astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:key=lavfi.astats.Overall.Peak_level -f null -", false)) {
      lock (gate) process = p;
      string line;
      // ametadata=print 把数值打到 stderr（-v info）；逐行解析。
      using (var sr = new StreamReader(p.StandardError.BaseStream, Encoding.UTF8)) {
       double rms = -91, peak = -91;
       while ((line = sr.ReadLine()) != null) {
        lock (gate) if (!running) break;
        var pair = ParseAstatsLine(line, ref rms, ref peak);
        if (pair != null && Updated != null) Updated(watch.Elapsed.TotalSeconds, pair.Item1, pair.Item2);
       }
      }
      p.WaitForExit();
     }
    }
    catch { }
    finally { lock (gate) { running = false; process = null; } }
   });
  }
  public void Stop() {
   lock (gate) running = false;
   try { if (process != null && !process.HasExited) process.Kill(); } catch { }
  }
  // volumedetect 静态分析：返回 (mean_volume, max_volume)。
  public static Tuple<double, double> Analyze(string source, double from, double duration, CancellationToken token) {
   using (var p = Media.Start("ffmpeg", "-v info -ss " + Media.N(Math.Max(0, from)) + " -t " + Media.N(duration) + " -i " + Media.Q(source) + " -vn -af volumedetect -f null -", false))
   using (token.Register(() => { try { p.Kill(); } catch { } })) {
    var err = p.StandardError.ReadToEndAsync();
    p.StandardInput.Close();
    p.WaitForExit();
    token.ThrowIfCancellationRequested();
    if (p.ExitCode != 0) throw new Exception("电平分析失败：" + err.Result);
    string text = err.Result;
    double mean = -91, max = -91;
    foreach (string line in text.Split('\n')) {
     if (line.Contains("mean_volume:")) mean = ParseDb(line.Substring(line.IndexOf("mean_volume:", StringComparison.Ordinal) + 12).Replace(" dB", ""));
     if (line.Contains("max_volume:")) max = ParseDb(line.Substring(line.IndexOf("max_volume:", StringComparison.Ordinal) + 11).Replace(" dB", ""));
    }
    return Tuple.Create(mean, max);
   }
  }
 }

 public class RecordingMarker { public double Time; public string Label = ""; }

 // 系统声音混音：立体声混音作第二路 dshow 音频输入（W4Camera.Survey 的
 // 候选设备），与麦克风经 amix 混入录制。amix normalize=0（不改电平，
 // roles.ts 的混音同款语义）；系统音量只作用于系统那路。
 static class SystemAudio {
  public static string PreferencePath() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DogSC.Windows", "recording-system-audio.txt"); }
  public static void Save(string device, double volume) {
   try { Directory.CreateDirectory(Path.GetDirectoryName(PreferencePath())); File.WriteAllText(PreferencePath(), (device ?? "") + "|" + Media.N(Math.Max(0, Math.Min(1, volume)))); }
   catch { }
  }
  public static Tuple<string, double> Load() {
   try {
    string text = File.ReadAllText(PreferencePath());
    var parts = text.Split('|');
    if (parts.Length == 2) { double v; if (double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return Tuple.Create(parts[0], Math.Max(0, Math.Min(1, v))); }
   }
   catch { }
   return Tuple.Create("", 0.8);
  }
  // 追加的 dshow 输入参数（放在麦克风输入之后）。
  public static string ExtraInputArgs(string systemAudio) {
   if (string.IsNullOrEmpty(systemAudio)) return "";
   return "-thread_queue_size 8 -f dshow -i " + Media.Q("audio=" + systemAudio) + " ";
  }
  // 音频滤镜片段（不含 -filter_complex 包装）：micIdx/sysIdx 是输入编号。
  // 只有系统声音时直接调音量；两路都有时 amix 混音（duration=first）。
  public static string AudioFilter(int micIdx, int sysIdx, double sysVol, bool hasMic, bool hasSys) {
   if (!hasSys) return "";
   string vol = Media.N(Math.Max(0, Math.Min(1, sysVol)));
   if (!hasMic) return "[" + sysIdx + ":a]volume=" + vol + "[aout]";
   return "[" + sysIdx + ":a]volume=" + vol + "[s];[" + micIdx + ":a][s]amix=inputs=2:duration=first:normalize=0[aout]";
  }
 }
}
