// W7 收尾批（2026-11-18）：色轮三区可拖拽圆盘、HDR 导出预设 + 导出设置、
// 导出写 MP4 章节、自定义导出预设管理、一键删静音。
// 模型与纯逻辑；UI 见 W7UI.cs。滤镜串与参数出处（全部是已验证的数，不是现编的）：
// - 色轮圆盘：WheelHue/WheelSat 模型与 LUT 烘焙已在 FeaturePanels.cs
//   （ColorLut.Apply：smoothstep 权重，阴影/中间调/高光；暗红 (0.5,0,0) +
//   阴影色相+120° 变绿 (0.055,0.500,0.000)，引擎 P3d 探针实测值）。
//   圆盘只是换一种输入方式：角度=色相偏移、半径=饱和度倍数，不改模型。
// - HDR：libx265 + yuv420p10le + BT.2020/PQ，引擎 P3c 的 SDR→HDR 是同一路
//   （伪 HDR：8-bit 管线提至 10-bit PQ 容器，不增加真实动态范围，面板写明）。
//   探针（2026-11-18，本地 FFmpeg 8.1.2）：直接写 -color_primaries bt2020
//   -color_trc smpte2084 对 libx265 不生效（ffprobe 读回 unknown），必须走
//   -x265-params "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc"，
//   之后 ffprobe 读回 hevc / yuv420p10le / smpte2084 / bt2020。
// - 章节：FFmpeg ffmetadata + -map_metadata 1 -map_chapters 1 -c copy 重混；
//   探针：两章 Intro 0–2000 / Main 2000–4000，ffprobe 读回一致。
// - 删静音：silencedetect（引擎 P3e 同款，noise=-40dB:d=0.5）；探针：
//   6 秒片（2 秒音 + 2 秒静 + 2 秒音）测得 silence [2.005, 4.011]，
//   与真实 [2.0, 4.0] 误差 ≤0.011 秒。
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
 // 色轮圆盘的点位数学（与界面无关，可单测）：圆盘中心 = 不变（色相 0、饱和度 1）；
 // 角度 = 色相偏移（右 0°、上 +90°、左 ±180°）；半径 = 饱和度倍数，
 // 中心 1×、边缘 3×（与滑杆 0–3 的上限一致）。去饱和（<1×）圆盘表达不了，
 // 仍用滑杆——面板里写明，不假装圆盘能做。
 static class WheelMath {
  public static void FromPoint(double dx, double dy, double radius, out double hue, out double sat) {
   double len = Math.Sqrt(dx * dx + dy * dy);
   hue = len < 0.0001 ? 0 : Math.Atan2(-dy, dx) * 180 / Math.PI;
   if (hue <= -180) hue += 360;
   sat = 1 + Math.Min(1, len / radius) * 2;
  }
  public static void ToPoint(double hue, double sat, double radius, out double dx, out double dy) {
   double len = Math.Max(0, Math.Min(1, (sat - 1) / 2)) * radius;
   double a = hue * Math.PI / 180;
   dx = len * Math.Cos(a);
   dy = -len * Math.Sin(a);
  }
 }

 // 导出设置（导出窗口的状态，不进 project.json；自定义预设另存文件）。
 public class ExportOptions {
  public string PresetName = "SDR 1080p";
  public int Height = 1080;
  public int Fps = 30;
  public string Codec = "h264";
  public int Crf = 18;
  public bool Hdr;
  public bool WriteChapters = true;
  // W8：仅导出模式（deliver.ts 的 ExportOnlyMode 同款）：none/video/audio/subtitle，
  // 三者互斥（见 ExportOnly.Resolve），默认 none = 正常导出。
  public string OnlyMode = "none";
  public static ExportOptions Sdr(int height, int fps) {
   return new ExportOptions { PresetName = "SDR", Height = height, Fps = fps, Codec = "h264", Crf = 18, Hdr = false };
  }
  public void Validate() {
   if (Height < 240 || Height > 4320 || Height % 2 != 0) throw new Exception("导出高度无效：" + Height + "（240–4320 偶数）。");
   if (Fps < 1 || Fps > 120) throw new Exception("导出帧率无效：" + Fps + "（1–120）。");
   if (Codec != "h264" && Codec != "h265") throw new Exception("导出编码器无效：" + Codec + "。");
   if (Crf < 0 || Crf > 51) throw new Exception("CRF 无效：" + Crf + "（0–51）。");
   if (Hdr && Codec != "h265") throw new Exception("HDR 只能用 H.265 编码（H.264 没有 10-bit PQ 路）。");
   if (OnlyMode != "none" && OnlyMode != "video" && OnlyMode != "audio" && OnlyMode != "subtitle") throw new Exception("仅导出模式无效：" + OnlyMode + "（none/video/audio/subtitle）。");
  }
  // 最终编码器的视频参数（时间线中间片仍是 libx264——它只负责解码成 bgra，
  // 不决定成片编码）。HDR 走 x265-params 写色彩元数据：直接写
  // -color_primaries/-color_trc 对 libx265 不生效（探针已证实），别改回 CLI 写法。
  public string VideoEncoderArgs() {
   Validate();
   if (Codec == "h265") {
    if (Hdr) return "-c:v libx265 -preset veryfast -crf " + Crf + " -pix_fmt yuv420p10le -x265-params \"colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc\"";
    return "-c:v libx265 -preset veryfast -crf " + Crf + " -pix_fmt yuv420p";
   }
   return "-c:v libx264 -preset veryfast -crf " + Crf + " -pix_fmt yuv420p";
  }
  public string Describe() {
   if (Hdr) return "H.265 · 10-bit PQ · BT.2020（伪 HDR：8-bit 管线提至 PQ 容器，不增加真实动态范围）";
   return Codec == "h265" ? "H.265 · 8-bit" : "H.264 · 8-bit";
  }
 }

 // 内置导出预设（名字 + 高度 + 编码 + CRF + HDR；帧率跟项目走，不写死）。
 static class ExportPresets {
  public static List<ExportOptions> BuiltIn() {
   return new List<ExportOptions> {
    new ExportOptions { PresetName = "SDR 1080p", Height = 1080, Codec = "h264", Crf = 18, Hdr = false },
    new ExportOptions { PresetName = "SDR 4K", Height = 2160, Codec = "h264", Crf = 18, Hdr = false },
    new ExportOptions { PresetName = "HDR 4K", Height = 2160, Codec = "h265", Crf = 22, Hdr = true },
    new ExportOptions { PresetName = "8K", Height = 4320, Codec = "h265", Crf = 22, Hdr = false }
   };
  }
  public static ExportOptions Find(string name) {
   foreach (var p in BuiltIn()) if (p.PresetName == name) return p;
   return null;
  }
 }

 // 自定义导出预设：JSON 存 %LOCALAPPDATA%\CatCut\export-presets\<名>.json。
 // 只存导出设置，不存项目内容；坏 JSON、坏名字、坏参数一律拒绝，不静默修。
 static class ExportPresetStore {
  public static string Dir(string dir = null) {
   if (!string.IsNullOrEmpty(dir)) return dir;
   return Path.Combine(AppIdentity.AppDataDir, "export-presets");
  }
  static void CheckName(string name) {
   if (string.IsNullOrWhiteSpace(name) || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || name == "." || name == "..")
    throw new Exception("预设名不可用：" + name);
  }
  public static void Save(string name, ExportOptions options, string dir = null) {
   CheckName(name);
   if (options == null) throw new Exception("没有可保存的导出设置。");
   options.Validate();
   string d = Dir(dir);
   Directory.CreateDirectory(d);
   var o = new ExportOptions { PresetName = name, Height = options.Height, Fps = options.Fps, Codec = options.Codec, Crf = options.Crf, Hdr = options.Hdr, WriteChapters = options.WriteChapters, OnlyMode = options.OnlyMode };
   File.WriteAllText(Path.Combine(d, name + ".json"), EditDocument.Serializer().Serialize(o), new UTF8Encoding(false));
  }
  public static ExportOptions Load(string name, string dir = null) {
   CheckName(name);
   string path = Path.Combine(Dir(dir), name + ".json");
   if (!File.Exists(path)) throw new Exception("找不到导出预设：" + name + "。");
   ExportOptions o;
   try { o = EditDocument.Serializer().Deserialize<ExportOptions>(File.ReadAllText(path, new UTF8Encoding(false))); }
   catch (Exception ex) { throw new Exception("导出预设文件损坏（不是有效 JSON）：" + name + "。"); }
   if (o == null) throw new Exception("导出预设文件是空的：" + name + "。");
   o.PresetName = name;
   o.Validate();
   return o;
  }
  public static List<string> List(string dir = null) {
   string d = Dir(dir);
   if (!Directory.Exists(d)) return new List<string>();
   return Directory.GetFiles(d, "*.json").Select(f => Path.GetFileNameWithoutExtension(f)).OrderBy(n => n).ToList();
  }
  public static void Delete(string name, string dir = null) {
   CheckName(name);
   string path = Path.Combine(Dir(dir), name + ".json");
   if (!File.Exists(path)) throw new Exception("找不到导出预设：" + name + "。");
   File.Delete(path);
  }
 }

 // MP4 章节：时间线标记 → ffmetadata → 重混进成片（-c copy，不重编码）。
 // 章节标题取标记文字，空文字用“标记 N”；最后一章收到片尾；标记按时间排序，
 // 超出片长或重合的跳过（不报错打断导出——面板写明跳过的条数）。
 static class Chapters {
  public static string BuildMetadata(List<RecordingMarker> markers, double length) {
   var sorted = markers == null ? new List<RecordingMarker>() : markers.Where(m => m != null && m.Time >= 0 && m.Time < length).OrderBy(m => m.Time).ToList();
   var sb = new StringBuilder();
   sb.Append(";FFMETADATA1\n");
   for (int i = 0; i < sorted.Count; i++) {
    long start = (long)Math.Round(sorted[i].Time * 1000);
    long end = i + 1 < sorted.Count ? (long)Math.Round(sorted[i + 1].Time * 1000) : (long)Math.Round(length * 1000);
    if (end <= start) continue;
    string title = string.IsNullOrWhiteSpace(sorted[i].Label) ? "标记 " + (i + 1) : sorted[i].Label.Replace("\n", " ").Replace("\r", " ").Replace("=", "-");
    sb.Append("[CHAPTER]\nTIMEBASE=1/1000\nSTART=" + start + "\nEND=" + end + "\ntitle=" + title + "\n");
   }
   return sb.ToString();
  }
  public static int ChapterCount(List<RecordingMarker> markers, double length) {
   var sorted = markers == null ? new List<RecordingMarker>() : markers.Where(m => m != null && m.Time >= 0 && m.Time < length).OrderBy(m => m.Time).ToList();
   int n = 0;
   for (int i = 0; i < sorted.Count; i++) {
    long start = (long)Math.Round(sorted[i].Time * 1000);
    long end = i + 1 < sorted.Count ? (long)Math.Round(sorted[i + 1].Time * 1000) : (long)Math.Round(length * 1000);
    if (end > start) n++;
   }
   return n;
  }
  // 在原文件上重混章节：先写临时文件，ffmpeg 校验 exit 0 才替换原文件。
  public static void WriteTo(string output, List<RecordingMarker> markers, double length, CancellationToken token) {
   if (ChapterCount(markers, length) == 0) return;
   string work = Path.Combine(Path.GetDirectoryName(output), ".dogsc-chapters-" + Guid.NewGuid().ToString("N"));
   Directory.CreateDirectory(work);
   try {
    string meta = Path.Combine(work, "chapters.txt");
    File.WriteAllText(meta, BuildMetadata(markers, length), new UTF8Encoding(false));
    string tmp = Path.Combine(work, "chapters.mp4");
    StudioMedia.Run("-v error -y -i " + Media.Q(output) + " -f ffmetadata -i " + Media.Q(meta) + " -map_metadata 1 -map_chapters 1 -c copy -movflags +faststart " + Media.Q(tmp), token);
    if (!File.Exists(tmp)) throw new Exception("章节写入失败：没有生成带章节的文件。");
    File.Replace(tmp, output, null);
   } finally {
    try { if (Directory.Exists(work)) Directory.Delete(work, true); } catch { }
   }
  }
 }

 // 一键删静音：silencedetect 定位静音段（源时间），从 Cuts 里抠掉，
 // 字幕/标记/缩放/贴图按时间线位置跟随前移。卡点闪白的节拍是源时间，
 // 删静音后源时间变了——不跟随，面板会提醒重新检测节拍。
 // W9：压缩模式（ApplyCompress）——静音段不删除，改以 0.3x 慢放（原声保留、
 // 拉长），与引擎 silencecut.ts 的 compress 模式同名但方向相反：引擎是把
 // 静音加速压短（0.3 = 压到 0.3 倍长），这里按任务要求是 0.3x 慢放拉长
 // （静音段时长 × 1/0.3）。FFmpeg 单个 atempo 只认 0.5–100（本地探针：
 // atempo=0.3 直接报错 exit 222），0.3x 必须链式 atempo=0.5,atempo=0.6
 // （0.5×0.6=0.3，2 秒音实测拉到 6.63 秒，音调不变）。
 static class SilenceCut {
  public const double CompressSpeed = 0.3;
  // 变速对应的 atempo 链：0.5–100 直接一个 atempo；低于 0.5 拆成多个 0.5
  // 再补一个余数（0.3 → atempo=0.5,atempo=0.6）。视频侧不用这个——
  // setpts=(PTS-STARTPTS)/Speed 直接支持 0.3。
  public static string AtempoChain(double speed) {
   if (!EditDocument.Finite(speed) || speed <= 0 || speed > 100) throw new Exception("变速超出范围：" + Media.N(speed) + "（0–100）。");
   var parts = new List<string>();
   double s = speed;
   int guard = 0;
   while (s < 0.5 && guard < 4) { parts.Add("atempo=0.5"); s /= 0.5; guard++; }
   if (s < 0.5 || s > 100) throw new Exception("变速无法拆成 atempo 链：" + Media.N(speed) + "。");
   parts.Add("atempo=" + Media.N(s));
   return string.Join(",", parts.ToArray());
  }
  public class Span { public double Start; public double End; public double Length { get { return End - Start; } } }
  // ffmpeg silencedetect 输出示例：
  // [Parsed_silencedetect_0] silence_start: 2.005375
  // [Parsed_silencedetect_0] silence_end: 4.010625 | silence_duration: 2.00525
  public static List<Span> Detect(string source, double thresholdDb, double minSeconds, CancellationToken token) {
   if (string.IsNullOrEmpty(source) || !File.Exists(source)) throw new Exception("找不到要检测静音的素材：" + source + "。");
   if (thresholdDb > 0 || thresholdDb < -90) throw new Exception("静音阈值无效：" + thresholdDb + " dB（-90–0）。");
   if (minSeconds < 0.1 || minSeconds > 10) throw new Exception("最短静音时长无效：" + minSeconds + " 秒（0.1–10）。");
   double duration = Media.Duration(source);
   string noise = Media.N(thresholdDb) + "dB";
   using (var p = Media.Start("ffmpeg", "-i " + Media.Q(source) + " -af silencedetect=noise=" + noise + ":d=" + Media.N(minSeconds) + " -f null -", false)) {
    var err = p.StandardError.ReadToEndAsync();
    p.StandardInput.Close();
    p.WaitForExit();
    if (p.ExitCode != 0) throw new Exception("静音检测失败：" + err.Result);
    var spans = new List<Span>();
    double? start = null;
    foreach (string raw in err.Result.Split('\n')) {
     string line = raw.Trim();
     int at = line.IndexOf("silence_start:", StringComparison.Ordinal);
     if (at >= 0) {
      double v;
      if (double.TryParse(line.Substring(at + 14).Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out v)) start = v;
      continue;
     }
     at = line.IndexOf("silence_end:", StringComparison.Ordinal);
     if (at >= 0 && start.HasValue) {
      string rest = line.Substring(at + 12).Trim();
      int bar = rest.IndexOf('|');
      if (bar >= 0) rest = rest.Substring(0, bar).Trim();
      double v;
      if (double.TryParse(rest, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) {
       double s = Math.Max(0, start.Value), e = Math.Min(duration, v);
       if (e - s >= minSeconds - 0.05) spans.Add(new Span { Start = s, End = e });
      }
      start = null;
     }
    }
    // 片尾静音可能只有 silence_start、没有 silence_end（ffmpeg 到流末尾才报）：
    // 上面循环漏掉它，这里不补——片尾静音删不删不影响成片，面板写明。
    spans.Sort((a, b) => a.Start.CompareTo(b.Start));
    return spans;
   }
  }
  static void CheckSpans(List<Span> spans, double duration) {
   if (spans == null) throw new Exception("没有静音段可删。");
   double prev = -1;
   foreach (var s in spans) {
    if (s == null || !EditDocument.Finite(s.Start) || !EditDocument.Finite(s.End) || s.Start < 0 || s.End > duration + 0.05 || s.End <= s.Start)
     throw new Exception("静音段无效：" + (s == null ? "空" : s.Start.ToString("0.00") + "–" + s.End.ToString("0.00")) + "。");
    if (s.Start < prev) throw new Exception("静音段必须按时间排序且不重叠。");
    prev = s.End;
   }
  }
  // 源时间 → 时间线时间（按 Cuts 映射；空隙没有源时间，跳过）。
  static double SourceToTimeline(EditDocument doc, double sourceTime) {
   double offset = 0;
   foreach (var c in doc.Cuts) {
    if (c.Gap) { offset += c.GapDuration; continue; }
    if (sourceTime >= c.Start && sourceTime <= c.End) return offset + (sourceTime - c.Start) / c.Speed;
    offset += c.Length;
   }
   return offset;
  }
  // 在时间线时刻 t 之前一共删掉了多少秒（静音段按时间线区间计）。
  static double RemovedBefore(EditDocument doc, List<Span> spans, double t) {
   double removed = 0;
   foreach (var s in spans) {
    double t0 = SourceToTimeline(doc, s.Start), t1 = SourceToTimeline(doc, s.End);
    if (t1 <= t0) continue;
    if (t <= t0) break;
    removed += Math.Min(t1, t) - t0;
   }
   return removed;
  }
  // 返回删掉的总时长（时间线秒）。调用前先 Checkpoint（可撤销）。
  public static double Apply(EditDocument doc, List<Span> spans) {
   if (doc == null) throw new Exception("没有打开的项目。");
   CheckSpans(spans, doc.Duration);
   if (spans.Count == 0) return 0;
   double before = doc.Length;
   var kept = new List<Cut>();
   foreach (var c in doc.Cuts) {
    if (c.Gap) { kept.Add(c); continue; }
    double cur = c.Start;
    foreach (var s in spans) {
     if (s.End <= cur || s.Start >= c.End) continue;
     double cutEnd = Math.Min(c.End, Math.Max(cur, s.Start));
     if (cutEnd > cur + 0.001) kept.Add(new Cut { Start = cur, End = cutEnd, Speed = c.Speed });
     cur = Math.Max(cur, s.End);
    }
    if (c.End > cur + 0.001) kept.Add(new Cut { Start = cur, End = c.End, Speed = c.Speed });
   }
   if (kept.Count == 0) throw new Exception("静音段盖住了全部素材，删完什么都不剩。");
   // 时间线上的东西跟随前移（按删之前的映射算）。
   foreach (var cue in doc.Subtitles) {
    double ns = cue.Start - RemovedBefore(doc, spans, cue.Start), ne = cue.End - RemovedBefore(doc, spans, cue.End);
    cue.Start = Math.Max(0, ns); cue.End = Math.Max(cue.Start + 0.05, ne);
   }
   foreach (var m in doc.RecordingMarkers) m.Time = Math.Max(0, m.Time - RemovedBefore(doc, spans, m.Time));
   foreach (var z in doc.Zooms) {
    double ns = z.Start - RemovedBefore(doc, spans, z.Start), ne = z.End - RemovedBefore(doc, spans, z.End);
    z.Start = Math.Max(0, ns); z.End = Math.Max(z.Start + 0.05, ne);
   }
   foreach (var o in doc.Overlays) {
    double ns = o.Start - RemovedBefore(doc, spans, o.Start), ne = o.End - RemovedBefore(doc, spans, o.End);
    o.Start = Math.Max(0, ns); o.End = Math.Max(o.Start + 0.05, ne);
   }
   doc.Cuts = kept;
   return before - doc.Length;
  }
  // 在时间线时刻 t 之前，压缩一共拉长了多少秒（静音段按时间线区间计，
  // 拉长系数 1/0.3−1；t 落在静音段内时按段内比例算，与 RemovedBefore 对称）。
  static double ExpandedBefore(EditDocument doc, List<Span> spans, double t) {
   double added = 0;
   double factor = 1 / CompressSpeed - 1;
   foreach (var s in spans) {
    double t0 = SourceToTimeline(doc, s.Start), t1 = SourceToTimeline(doc, s.End);
    if (t1 <= t0) continue;
    if (t <= t0) break;
    added += (t >= t1 ? (t1 - t0) : (t - t0)) * factor;
   }
   return added;
  }
  // 压缩模式：静音段不删除，改以 0.3x 慢放（原声保留、拉长）。返回拉长的
  // 总时长（时间线秒）。调用前先 Checkpoint（可撤销）。
  // 限制（与引擎 compressSilences 的守卫同款，诚实报错不静默）：只支持
  // 1× 常速片段（变速片段的静音段对不齐）；J/L 音频窗口只保留在 1× 的
  // 说话段上（0.3x 段上 JlAudio.Validate 本来就禁窗口，窗口丢了音频仍按
  // 该段源范围走，不丢声）。字幕/标记/缩放/贴图按拉长后的时间轴跟随。
  public static double ApplyCompress(EditDocument doc, List<Span> spans) {
   if (doc == null) throw new Exception("没有打开的项目。");
   CheckSpans(spans, doc.Duration);
   if (spans.Count == 0) return 0;
   foreach (var c in doc.Cuts) if (!c.Gap && Math.Abs(c.Speed - 1) > 0.000001) throw new Exception("静音压缩只支持 1× 常速片段（变速片段的静音段对不齐），请先把速度改回 1×。");
   double before = doc.Length;
   var rebuilt = new List<Cut>();
   foreach (var c in doc.Cuts) {
    if (c.Gap) { rebuilt.Add(c); continue; }
    double cur = c.Start;
    foreach (var s in spans) {
     if (s.End <= cur || s.Start >= c.End) continue;
     double segEnd = Math.Min(c.End, Math.Max(cur, s.Start));
     if (segEnd > cur + 0.001) rebuilt.Add(SubCut(c, cur, segEnd, 1));
     double silEnd = Math.Min(c.End, s.End);
     if (silEnd > Math.Max(cur, s.Start) + 0.001) rebuilt.Add(SubCut(c, Math.Max(cur, s.Start), silEnd, CompressSpeed));
     cur = Math.Max(cur, s.End);
    }
    if (c.End > cur + 0.001) rebuilt.Add(SubCut(c, cur, c.End, 1));
   }
   // 时间线上的东西跟随后移/拉长（按压缩之前的映射算）。
   foreach (var cue in doc.Subtitles) {
    double ns = cue.Start + ExpandedBefore(doc, spans, cue.Start), ne = cue.End + ExpandedBefore(doc, spans, cue.End);
    cue.Start = Math.Max(0, ns); cue.End = Math.Max(cue.Start + 0.05, ne);
   }
   foreach (var m in doc.RecordingMarkers) m.Time = Math.Max(0, m.Time + ExpandedBefore(doc, spans, m.Time));
   foreach (var z in doc.Zooms) {
    double ns = z.Start + ExpandedBefore(doc, spans, z.Start), ne = z.End + ExpandedBefore(doc, spans, z.End);
    z.Start = Math.Max(0, ns); z.End = Math.Max(z.Start + 0.05, ne);
   }
   foreach (var o in doc.Overlays) {
    double ns = o.Start + ExpandedBefore(doc, spans, o.Start), ne = o.End + ExpandedBefore(doc, spans, o.End);
    o.Start = Math.Max(0, ns); o.End = Math.Max(o.Start + 0.05, ne);
   }
   doc.Cuts = rebuilt;
   return doc.Length - before;
  }
  // 从原片段里切一段 [a, b]：1× 段保留 J/L 音频窗口（裁到段内）与
  // AudioOnly；0.3x 段不带窗口（JlAudio 只认 1×，窗口丢了音频仍按段内
  // 源范围走），AudioOnly 照留（Filter 里走同一条 atempo 链）。
  static Cut SubCut(Cut c, double a, double b, double speed) {
   var cut = new Cut { Start = a, End = b, Speed = speed, AudioOnly = c.AudioOnly };
   if (Math.Abs(speed - 1) <= 0.000001) {
    if (c.AudioIn.HasValue) cut.AudioIn = Math.Max(c.AudioIn.Value, a);
    if (c.AudioOut.HasValue) cut.AudioOut = Math.Min(c.AudioOut.Value, b);
    if (cut.AudioIn.HasValue && cut.AudioOut.HasValue && cut.AudioOut.Value <= cut.AudioIn.Value) { cut.AudioIn = null; cut.AudioOut = null; }
   }
   return cut;
  }
 }
}
