// W9 自测（2026-11-19）：--w9fixes-test 入口，无窗口，纯逻辑 + 合成素材实测。
// 跑在云端构建里（build-test.yml 的 W9 fixes checks 步），结果写
// Windows/bin/w9fixes-results.txt（PASS: 开头才算过）。本地 Linux 跑不了
// WPF，但这些测试不碰窗口，只碰模型/滤镜串/ffmpeg/真实导出与解码器图，
// 所以云端是唯一可信的验证。断言值来源：
// - atempo：本地 FFmpeg 8.1.2 实测，单个 atempo=0.3 报错 exit 222
//   （tempo out of range [0.5-100]），链式 atempo=0.5,atempo=0.6 把 2 秒
//   音拉到 6.63 秒（理论 6.667，容限内）。
// - 静音段：W7 同款 6 秒片（2 秒音 + 2 秒静 + 2 秒音），silencedetect
//   [2.005, 4.011]；压缩后静音段 2 秒 × 1/0.3 = 6.667 秒，全片 10.667 秒。
// - 美颜+调色：色温+1 的节点 LUT 把中灰 (0.5,0.5,0.5) 烤成
//   (0.625,0.5,0.375)（W8 探针值），即 R≈159、G≈128、B≈96；美颜单开
//   的中灰只提亮 0.015（≈131，三通道相等）。
// 云端 runner 无真 GPU/ONNX：美颜遮罩用现成白场视频代替（直接导出路径
// 复用源遮罩，不走 ONNX 生成），遮罩生成与真机播放只在真机上能验。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.IO;
using System.Linq;
using System.Threading;
using DogSC.Windows;
using D = System.Drawing;

namespace DogSC.Replica {
 static class W9FixesTests {
  static void Require(bool ok, string name) { if (!ok) throw new Exception("W9 检查失败：" + name); }
  static bool Near(double a, double b, double tol) { return Math.Abs(a - b) <= tol; }
  static string Folder;
  static string LogPath;
  static void Mark(string s) { try { File.AppendAllText(LogPath, s + "\\n"); } catch { } }
  static void RunFfmpeg(string args) { StudioMedia.Run(args, CancellationToken.None); }
  static string Probe(string args) {
   using (var p = Media.Start("ffprobe", args, true)) {
    var err = p.StandardError.ReadToEndAsync();
    string text = p.StandardOutput.ReadToEnd();
    p.WaitForExit();
    if (p.ExitCode != 0) throw new Exception("ffprobe 失败：" + err.Result);
    return text;
   }
  }
  static double ProbeDuration(string file) {
   string text = Probe("-v error -show_entries format=duration -of default=noprint_wrappers=1 " + Media.Q(file));
   foreach (string line in text.Split('\n')) {
    string t = line.Trim();
    if (t.StartsWith("duration=", StringComparison.Ordinal)) return double.Parse(t.Substring(9), CultureInfo.InvariantCulture);
   }
   throw new Exception("探不到时长：" + file);
  }
  static void SolidVideo(string path, string hex, int w, int h, double dur) {
   RunFfmpeg("-v error -y -f lavfi -i color=c=" + hex + ":s=" + w + "x" + h + ":d=" + Media.N(dur) + " -c:v libx264 -pix_fmt yuv420p -r 30 " + Media.Q(path));
  }
  static int[] FramePixel(string file, double time, int x, int y) {
   string png = Path.Combine(Folder, "frame-" + Guid.NewGuid().ToString("N").Substring(0, 6) + ".png");
   RunFfmpeg("-v error -y -ss " + Media.N(time) + " -i " + Media.Q(file) + " -frames:v 1 " + Media.Q(png));
   using (var bmp = new D.Bitmap(png)) {
    var c = bmp.GetPixel(x, y);
    return new[] { (int)c.R, (int)c.G, (int)c.B };
   }
  }
  static ColorGrade TempGrade(double t) { return new ColorGrade { Temperature = t }; }
  // 6 秒测试音：[0,2) 440Hz 大声、[2,4) 220Hz 极轻（-40dB，低于 -30dB
  // 检测阈值，算静音段）、[4,6) 440Hz 大声。轻段留 220Hz 是为了验压缩
  // 后“原声还在、音调没变”，而不是被删了拿静音垫上。
  static void WriteGapWav(string path) {
   int rate = 48000, n = rate * 6;
   using (var fs = new FileStream(path, FileMode.Create))
   using (var w = new BinaryWriter(fs)) {
    w.Write(new char[] { 'R', 'I', 'F', 'F' }); w.Write(36 + n * 2); w.Write(new char[] { 'W', 'A', 'V', 'E' });
    w.Write(new char[] { 'f', 'm', 't', ' ' }); w.Write(16); w.Write((short)1); w.Write((short)1);
    w.Write(rate); w.Write(rate * 2); w.Write((short)2); w.Write((short)16);
    w.Write(new char[] { 'd', 'a', 't', 'a' }); w.Write(n * 2);
    for (int i = 0; i < n; i++) {
     double t = (double)i / rate;
     double v = (t >= 2 && t < 4) ? 0.01 * Math.Sin(2 * Math.PI * 220 * t) : 0.8 * Math.Sin(2 * Math.PI * 440 * t);
     w.Write((short)Math.Max(-32768, Math.Min(32767, (int)Math.Round(v * 32767))));
    }
   }
  }
  static short[] ExtractPcm(string file, double from, double dur) {
   using (var p = Media.Start("ffmpeg", "-v error -ss " + Media.N(from) + " -t " + Media.N(dur) + " -i " + Media.Q(file) + " -ac 1 -ar 48000 -f s16le -", true)) {
    var err = p.StandardError.ReadToEndAsync();
    using (var ms = new MemoryStream()) {
     p.StandardOutput.BaseStream.CopyTo(ms); p.WaitForExit();
     if (p.ExitCode != 0) throw new Exception("PCM 提取失败：" + err.Result);
     byte[] b = ms.ToArray();
     var s = new short[b.Length / 2];
     for (int i = 0; i < s.Length; i++) s[i] = (short)(b[2 * i] | (b[2 * i + 1] << 8));
     return s;
    }
   }
  }
  static double Goertzel(short[] s, int rate, double freq) {
   double coeff = 2 * Math.Cos(2 * Math.PI * freq / rate);
   double s1 = 0, s2 = 0;
   for (int i = 0; i < s.Length; i++) {
    double v = s[i] / 32768.0;
    double s0 = v + coeff * s1 - s2; s2 = s1; s1 = s0;
   }
   double power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
   return Math.Sqrt(Math.Max(0, power)) / Math.Max(1, s.Length);
  }
  static string ExportName(string tag) { return Path.Combine(Folder, tag + "-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".mp4"); }
  public static void Run() {
   Folder = Path.Combine(Media.Root, "bin", "w9-test");
   Directory.CreateDirectory(Folder);
   string log = Path.Combine(Media.Root, "bin", "w9fixes-results.txt");
   LogPath = log;
   File.WriteAllText(log, "RUNNING\n");
   try {
    // 1. atempo 链：0.3 单值报错、链式可用、时长 2 -> 6.67、辅助函数拼串。
    Require(SilenceCut.AtempoChain(0.3) == "atempo=0.5,atempo=0.6", "AtempoChain(0.3) is atempo=0.5,atempo=0.6 (got " + SilenceCut.AtempoChain(0.3) + ")");
    Require(SilenceCut.AtempoChain(1) == "atempo=1" && SilenceCut.AtempoChain(2) == "atempo=2" && SilenceCut.AtempoChain(0.5) == "atempo=0.5", "AtempoChain(1/2/0.5) stays a single atempo");
    string tone = Path.Combine(Folder, "tone2s.wav");
    RunFfmpeg("-v error -y -f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=2\" -c:a pcm_s16le " + Media.Q(tone));
    int singleExit;
    using (var p = Media.Start("ffmpeg", "-v error -y -i " + Media.Q(tone) + " -af atempo=0.3 -c:a pcm_s16le " + Media.Q(Path.Combine(Folder, "single.wav")), false)) {
     p.StandardError.ReadToEndAsync(); p.StandardInput.Close(); p.WaitForExit(); singleExit = p.ExitCode;
    }
    Require(singleExit != 0, "single atempo=0.3 fails (exit " + singleExit + ")");
    string chained = Path.Combine(Folder, "chained.wav");
    RunFfmpeg("-v error -y -i " + Media.Q(tone) + " -af atempo=0.5,atempo=0.6 -c:a pcm_s16le " + Media.Q(chained));
    Require(Near(ProbeDuration(chained), 2.0 / 0.3, 0.15), "chained atempo stretches 2s to 6.67s (got " + ProbeDuration(chained).ToString("0.00") + ")");
    Mark("STEP 1 atempo chain OK");
    // 2. 静音压缩模型：检测 + 切分 + 跟随 + 校验 + 拒绝项。
    string gapWav = Path.Combine(Folder, "gap.wav");
    WriteGapWav(gapWav);
    var spans = SilenceCut.Detect(gapWav, -30, 0.5, CancellationToken.None);
    Require(spans.Count == 1 && Near(spans[0].Start, 2.0, 0.05) && Near(spans[0].End, 4.0, 0.05), "silencedetect finds [2.0, 4.0] in the quiet-220Hz gap (got " + (spans.Count == 0 ? "none" : spans[0].Start.ToString("0.00") + "-" + spans[0].End.ToString("0.00")) + ")");
    string gapSrc = Path.Combine(Folder, "gap-src.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=6 -i " + Media.Q(gapWav) + " -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(gapSrc));
    var sdoc = StudioMedia.Import(gapSrc);
    sdoc.Subtitles.Add(new SubtitleCue { Start = 5.0, End = 5.8, Text = "后半句" });
    sdoc.RecordingMarkers.Add(new RecordingMarker { Time = 1.0, Label = "开头" });
    sdoc.RecordingMarkers.Add(new RecordingMarker { Time = 3.0, Label = "静音里" });
    sdoc.RecordingMarkers.Add(new RecordingMarker { Time = 5.0, Label = "后半" });
    sdoc.Zooms.Add(new Zoom { Start = 5.0, End = 5.5 });
    sdoc.Overlays.Add(new OverlayClip { Start = 5.0, End = 5.8 });
    double added = SilenceCut.ApplyCompress(sdoc, spans);
    double expectAdded = 2.0 * (1 / 0.3 - 1);
    Require(Near(added, expectAdded, 0.05) && Near(sdoc.Length, 6.0 + expectAdded, 0.05), "compress adds 4.67s, length 6 -> 10.67 (added " + added.ToString("0.00") + ")");
    Require(sdoc.Cuts.Count == 3 && Near(sdoc.Cuts[0].Start, 0, .01) && Near(sdoc.Cuts[0].End, 2.0, .05) && Near(sdoc.Cuts[0].Speed, 1, .001) && Near(sdoc.Cuts[1].Start, 2.0, .05) && Near(sdoc.Cuts[1].End, 4.0, .05) && Near(sdoc.Cuts[1].Speed, 0.3, .001) && Near(sdoc.Cuts[2].Start, 4.0, .05) && Near(sdoc.Cuts[2].End, 6.0, .01) && Near(sdoc.Cuts[2].Speed, 1, .001), "cuts split into [0,2]@1x + [2,4]@0.3x + [4,6]@1x");
    Require(Near(sdoc.Subtitles[0].Start, 5.0 + expectAdded, .05) && Near(sdoc.Subtitles[0].End, 5.8 + expectAdded, .05), "subtitle follows the stretch (5.0 -> 9.67)");
    Require(Near(sdoc.RecordingMarkers[0].Time, 1.0, .01) && Near(sdoc.RecordingMarkers[1].Time, 2.0 + 1.0 / 0.3, .05) && Near(sdoc.RecordingMarkers[2].Time, 5.0 + expectAdded, .05), "markers follow (1.0 stays, 3.0 -> 5.33 inside the stretch, 5.0 -> 9.67)");
    Require(Near(sdoc.Zooms[0].Start, 5.0 + expectAdded, .05) && Near(sdoc.Zooms[0].End, 5.5 + expectAdded, .05), "zoom follows the stretch");
    Require(Near(sdoc.Overlays[0].Start, 5.0 + expectAdded, .05) && Near(sdoc.Overlays[0].End, 5.8 + expectAdded, .05), "overlay follows the stretch");
    sdoc.Validate();
    bool threw = false;
    try { SilenceCut.ApplyCompress(StudioMedia.Import(gapSrc), new List<SilenceCut.Span> { new SilenceCut.Span { Start = 3, End = 4 }, new SilenceCut.Span { Start = 3.5, End = 5 } }); } catch { threw = true; }
    Require(threw, "compress rejects overlapping spans");
    threw = false;
    var vdoc = StudioMedia.Import(gapSrc);
    vdoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 6, Speed = 2 } };
    try { SilenceCut.ApplyCompress(vdoc, spans); } catch { threw = true; }
    Require(threw, "compress rejects varispeed cuts");
    var edoc = StudioMedia.Import(gapSrc);
    Require(SilenceCut.ApplyCompress(edoc, new List<SilenceCut.Span>()) == 0 && Near(edoc.Length, 6.0, .001), "compress with no spans is a no-op");
    Mark("STEP 2 compress model OK");
    // 3. 压缩真实导出：时长 10.67 + 拉长段里轻声 220Hz 还在、后半段 440Hz 还在。
    string compOut = ExportName("compress-out");
    StudioRenderer.Export(sdoc, compOut, 360, 30, (v, s) => { }, CancellationToken.None);
    var compInfo = StudioMedia.Import(compOut);
    Require(Math.Abs(compInfo.Duration - 10.667) < 0.3 && compInfo.Audio, "export after compress is 10.67s with audio (got " + compInfo.Duration.ToString("0.00") + "s)");
    double quietMean = LevelMeter.Analyze(compOut, 5.0, 0.5, CancellationToken.None).Item1;
    Require(quietMean > -50 && quietMean < -30, "stretched silence keeps the quiet tone (-40dB), not digital silence (mean " + quietMean.ToString("0.0") + " dB)");
    var quietPcm = ExtractPcm(compOut, 5.0, 0.5);
    double q220 = Goertzel(quietPcm, 48000, 220), q440 = Goertzel(quietPcm, 48000, 440);
    Require(q220 > 1.5 * q440, "stretched silence is still 220Hz (220Hz " + q220.ToString("0.000") + " vs 440Hz " + q440.ToString("0.000") + ")");
    var speechPcm = ExtractPcm(compOut, 9.8, 0.5);
    double s440 = Goertzel(speechPcm, 48000, 440), s220 = Goertzel(speechPcm, 48000, 220);
    Require(s440 > 2 * s220, "speech after the gap is still 440Hz (440Hz " + s440.ToString("0.000") + " vs 220Hz " + s220.ToString("0.000") + ")");
    Mark("STEP 3 compress export OK");
    // 4. 美颜 + 高级调色：校验通过（旧的互斥报错已删）、图里两边都在。
    string whiteMask = Path.Combine(Folder, "white-mask.mp4");
    SolidVideo(whiteMask, "0xffffff", 320, 240, 2);
    string greySrc = Path.Combine(Folder, "grey-src.mp4");
    SolidVideo(greySrc, "0x808080", 320, 240, 2);
    var tempNodes = new GradeNodeGraph { Nodes = new List<GradeNode> { new GradeNode { Id = "n1", Adjust = TempGrade(1) } }, Output = "n1" };
    var bdoc = StudioMedia.Import(greySrc);
    bdoc.Style.Ratio = "4:3";
    bdoc.BeautyEnabled = true; bdoc.BeautyStrength = 50; bdoc.BeautyMode = "single"; bdoc.BeautyEdgeFeather = 1;
    bdoc.BeautyMaskPath = whiteMask;
    bdoc.GradeNodes = tempNodes;
    bdoc.Validate();
    string bgraph = W5Media.MaskedFilterComplex("scale=320:240", 30, "320", "240", bdoc, W8ColourFilters.ChainForGraph(bdoc));
    Require(bgraph.Contains("hqdn3d") && bgraph.Contains("lut3d=") && bgraph.Contains("overlay"), "beauty+node graph carries hqdn3d + node lut3d + overlay");
    var ldoc = StudioMedia.Import(greySrc);
    ldoc.BeautyEnabled = true; ldoc.BeautyMaskPath = whiteMask;
    string identityCube = Path.Combine(Folder, "identity.cube");
    File.WriteAllText(identityCube, LutCube.GridToText(GradeNodeGraphOps.IdentityGrid(), 17, "W9 identity"), new UTF8Encoding(false));
    ldoc.AppliedLutPath = identityCube;
    ldoc.Validate();
    Require(W8ColourFilters.Chain(ldoc, false).Contains("lut3d="), "beauty + LUT library validates and the chain carries the LUT");
    bool threw2 = false;
    var ndoc = StudioMedia.Import(greySrc);
    ndoc.GradeNodes = tempNodes; ndoc.Grade.Temperature = 0.5;
    try { W8ColourFilters.Validate(ndoc); } catch { threw2 = true; }
    Require(threw2, "node graph + linear grade is still rejected");
    threw2 = false;
    var pdoc = StudioMedia.Import(greySrc);
    pdoc.BeautyEnabled = true; pdoc.BeautyMaskPath = whiteMask; pdoc.PortraitEnabled = true;
    try { pdoc.Validate(); } catch { threw2 = true; }
    Require(threw2, "portrait background + beauty is still rejected");
    Mark("STEP 4 beauty+grade validation OK");
    // 5. 美颜 + 节点调色真实导出：调色没丢（中灰变暖），美颜没炸（时长对）。
    string bothOut = ExportName("beauty-node-out");
    StudioRenderer.Export(bdoc, bothOut, new ExportOptions { PresetName = "test", Height = 240, Fps = 30, Codec = "h264", Crf = 18, Hdr = false, WriteChapters = false }, (v, s) => { }, CancellationToken.None);
    Require(Math.Abs(StudioMedia.Import(bothOut).Duration - 2) < 0.15, "beauty+node export is 2.0s");
    int[] bp = FramePixel(bothOut, 1.0, 160, 120);
    Require(bp[0] > bp[1] + 15 && bp[2] < bp[1] - 10, "beauty+node centre pixel is warmed by the node LUT (got " + bp[0] + "," + bp[1] + "," + bp[2] + ")");
    var beautyOnly = StudioMedia.Import(greySrc);
    beautyOnly.Style.Ratio = "4:3";
    beautyOnly.BeautyEnabled = true; beautyOnly.BeautyStrength = 50; beautyOnly.BeautyMode = "single"; beautyOnly.BeautyEdgeFeather = 1;
    beautyOnly.BeautyMaskPath = whiteMask;
    string beautyOut = ExportName("beauty-only-out");
    StudioRenderer.Export(beautyOnly, beautyOut, new ExportOptions { PresetName = "test", Height = 240, Fps = 30, Codec = "h264", Crf = 18, Hdr = false, WriteChapters = false }, (v, s) => { }, CancellationToken.None);
    Require(Math.Abs(StudioMedia.Import(beautyOut).Duration - 2) < 0.15, "beauty-only export is still 2.0s");
    int[] op = FramePixel(beautyOut, 1.0, 160, 120);
    Require(Math.Abs(op[0] - op[1]) < 12 && Math.Abs(op[1] - op[2]) < 12, "beauty-only centre pixel stays grey (got " + op[0] + "," + op[1] + "," + op[2] + ")");
    var gradeOnly = StudioMedia.Import(greySrc);
    gradeOnly.Style.Ratio = "4:3";
    gradeOnly.GradeNodes = tempNodes;
    string gradeOut = ExportName("grade-only-out");
    StudioRenderer.Export(gradeOnly, gradeOut, new ExportOptions { PresetName = "test", Height = 240, Fps = 30, Codec = "h264", Crf = 18, Hdr = false, WriteChapters = false }, (v, s) => { }, CancellationToken.None);
    Require(Math.Abs(StudioMedia.Import(gradeOut).Duration - 2) < 0.15, "grade-only export is still 2.0s");
    int[] gp = FramePixel(gradeOut, 1.0, 160, 120);
    Require(gp[0] > gp[1] + 15 && gp[2] < gp[1] - 10, "grade-only centre pixel is warmed (got " + gp[0] + "," + gp[1] + "," + gp[2] + ")");
    Mark("STEP 5 beauty+node export OK");
    // 6. 美颜 + 蒙版节点（complex 解码器合成图）：中心调了、画角没调。
    var mdoc = StudioMedia.Import(greySrc);
    mdoc.Style.Ratio = "4:3";
    mdoc.BeautyEnabled = true; mdoc.BeautyStrength = 50; mdoc.BeautyMode = "single"; mdoc.BeautyEdgeFeather = 1;
    mdoc.BeautyMaskPath = whiteMask;
    var mn1 = new GradeNode { Id = "m1", Adjust = TempGrade(1), Mask = new GradeNodeMask { Shape = "ellipse", X = 0.5, Y = 0.5, W = 0.4, H = 0.4, Feather = 0.02 } };
    mdoc.GradeNodes = new GradeNodeGraph { Nodes = new List<GradeNode> { mn1, new GradeNode { Id = "out", Inputs = new List<string> { "m1" } } }, Output = "out" };
    mdoc.Validate();
    string mwork = Path.Combine(Folder, "mwork");
    Directory.CreateDirectory(mwork);
    var mprep = W8ColourExport.Prepare(mdoc, mwork, 320, 240, 30, CancellationToken.None);
    string mbGraph = W8ColourExport.BuildBeautyGraph(mdoc, mprep, 320, 240, 30, "fps=30,scale=320:240", 50, 1);
    Require(mbGraph.Contains("[1:v]") && mbGraph.Contains("[2:v]") && mbGraph.Contains("alphamerge") && mbGraph.Contains("lut3d="), "beauty+masked-node graph has beauty mask on input 1, node mask on input 2, alphamerge + lut3d");
    string maskOut = ExportName("beauty-masked-out");
    StudioRenderer.Export(mdoc, maskOut, new ExportOptions { PresetName = "test", Height = 240, Fps = 30, Codec = "h264", Crf = 18, Hdr = false, WriteChapters = false }, (v, s) => { }, CancellationToken.None);
    Require(Math.Abs(StudioMedia.Import(maskOut).Duration - 2) < 0.15, "beauty+masked-node export is 2.0s");
    int[] mc = FramePixel(maskOut, 1.0, 160, 120);
    Require(mc[0] > mc[1] + 15 && mc[2] < mc[1] - 10, "beauty+masked-node centre is graded (got " + mc[0] + "," + mc[1] + "," + mc[2] + ")");
    int[] mk = FramePixel(maskOut, 1.0, 50, 45);
    Require(Math.Abs(mk[0] - mk[1]) < 12 && Math.Abs(mk[1] - mk[2]) < 12, "beauty+masked-node video corner stays grey (got " + mk[0] + "," + mk[1] + "," + mk[2] + ")");
    Mark("STEP 6 beauty+masked-node export OK");
    // 7. 美颜 + 色度键（complex 解码器合成图）：绿抠成黑、红框留住。
    string keySrc = Path.Combine(Folder, "key-src.mp4");
    RunFfmpeg("-v error -y -f lavfi -i color=c=0x00ff00:s=320x240:d=2 -vf drawbox=x=110:y=60:w=100:h=60:color=red:t=fill -c:v libx264 -pix_fmt yuv420p -r 30 " + Media.Q(keySrc));
    var kdoc = StudioMedia.Import(keySrc);
    kdoc.Style.Ratio = "4:3";
    kdoc.BeautyEnabled = true; kdoc.BeautyStrength = 50; kdoc.BeautyMode = "single"; kdoc.BeautyEdgeFeather = 1;
    kdoc.BeautyMaskPath = whiteMask;
    kdoc.Chroma = new ChromaKey { Color = "0x00ff00", Similarity = 0.1, Blend = 0, Despill = true };
    kdoc.Validate();
    string kwork = Path.Combine(Folder, "kwork");
    Directory.CreateDirectory(kwork);
    var kprep = W8ColourExport.Prepare(kdoc, kwork, 320, 240, 30, CancellationToken.None);
    string kbGraph = W8ColourExport.BuildBeautyGraph(kdoc, kprep, 320, 240, 30, "fps=30,scale=320:240", 50, 1);
    Require(kbGraph.Contains("[1:v]") && kbGraph.Contains("alphamerge") && kbGraph.Contains("chromakey"), "beauty+chroma graph has beauty mask on input 1, alphamerge + chromakey");
    string keyOut = ExportName("beauty-chroma-out");
    StudioRenderer.Export(kdoc, keyOut, new ExportOptions { PresetName = "test", Height = 240, Fps = 30, Codec = "h264", Crf = 18, Hdr = false, WriteChapters = false }, (v, s) => { }, CancellationToken.None);
    Require(Math.Abs(StudioMedia.Import(keyOut).Duration - 2) < 0.15, "beauty+chroma export is 2.0s");
    int[] kk = FramePixel(keyOut, 1.0, 50, 45);
    Require(kk[0] < 20 && kk[1] < 20 && kk[2] < 20, "beauty+chroma video corner is keyed to black (got " + kk[0] + "," + kk[1] + "," + kk[2] + ")");
    int[] kc = FramePixel(keyOut, 1.0, 160, 100);
    Require(kc[0] > 200 && kc[1] < 40 && kc[2] < 40, "beauty+chroma centre stays red (got " + kc[0] + "," + kc[1] + "," + kc[2] + ")");
    Mark("STEP 7 beauty+chroma export OK");
    File.WriteAllText(log, "PASS: atempo=0.3 single fails, chain atempo=0.5,atempo=0.6 stretches 2s to 6.67s; silencedetect [2.0, 4.0], compress adds 4.67s (6 -> 10.67), cuts [0,2]@1x + [2,4]@0.3x + [4,6]@1x, subtitle 5.0 -> 9.67, markers 1.0 stays / 3.0 -> 5.33 / 5.0 -> 9.67, zoom + overlay follow, doc validates at 0.3x, overlap/varispeed rejected, empty spans no-op; compress export 10.67s with audio, stretched silence keeps quiet 220Hz tone (mean -40dB, 220Hz dominates 440Hz), speech after the gap still 440Hz; beauty+node and beauty+LUT validate (old mutual-exclusion error removed), graph carries hqdn3d + lut3d + overlay, node+linear and portrait+beauty still rejected; beauty+node export 2.0s centre warmed (" + bp[0] + "," + bp[1] + "," + bp[2] + "), beauty-only stays grey, grade-only warmed; beauty+masked-node export 2.0s centre graded / corner grey; beauty+chroma export 2.0s corner black / centre red.\n");
   }
   catch (Exception ex) { File.AppendAllText(log, "FAIL\n" + ex + "\n"); Mark("FAIL: " + ex.Message); Environment.ExitCode = 1; }
  }
 }
}
