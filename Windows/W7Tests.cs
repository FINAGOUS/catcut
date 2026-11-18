// W7 自测（2026-11-18）：--w7-test 入口，无窗口，纯逻辑 + 合成素材实测。
// 跑在云端构建里（build-test.yml 的 W7 checks 步），结果写
// Windows/bin/w7-results.txt（PASS: 开头才算过）。本地 Linux 跑不了 WPF，
// 但这些测试不碰窗口，只碰模型/滤镜串/ffmpeg/真实导出，所以云端是唯一可信的验证。
// 断言值全部来自本地探针实测（见 W7Panels.cs 头注释的出处）：
// 色轮暗红 + 阴影色相+120° 变绿 (0.055,0.500,0.000)（引擎 P3d 探针值）；
// x265-params 写色彩元数据后 ffprobe 读回 hevc/smpte2084/bt2020
// （直接写 -color_primaries/-color_trc 对 libx265 不生效，探针已证实）；
// silencedetect 6 秒片测得 [2.005, 4.011]；章节重混后 ffprobe 读回两章。
// 云端 runner 无真 GPU/摄像头/麦克风：色轮拖动、删静音按钮、导出窗口交互
// 只在真机上能验，测试只验模型、滤镜串与真实导出。
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
 static class W7Tests {
  static void Require(bool ok, string name) { if (!ok) throw new Exception("W7 检查失败：" + name); }
  static bool Near(double a, double b, double tol) { return Math.Abs(a - b) <= tol; }
  static string Folder;
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
  static string StreamInfo(string file) {
   return Probe("-v error -select_streams v:0 -show_entries stream=codec_name,width,height,pix_fmt,color_primaries,color_transfer,color_space -of default=noprint_wrappers=1 " + Media.Q(file));
  }
  static int ChapterCount(string file) {
   string text = Probe("-v error -show_chapters -of default=noprint_wrappers=1 " + Media.Q(file));
   int n = 0, at = 0;
   while ((at = text.IndexOf("[CHAPTER]", at, StringComparison.Ordinal)) >= 0) { n++; at += 9; }
   return n;
  }
  static string ChapterTitles(string file) {
   string text = Probe("-v error -show_chapters -of default=noprint_wrappers=1 " + Media.Q(file));
   var titles = new List<string>();
   foreach (string line in text.Split('\n')) {
    string t = line.Trim();
    if (t.StartsWith("TAG:title=", StringComparison.Ordinal)) titles.Add(t.Substring(10));
   }
   return string.Join("|", titles.ToArray());
  }
  public static void Run() {
   Folder = Path.Combine(Media.Root, "bin", "w7-test");
   Directory.CreateDirectory(Folder);
   string log = Path.Combine(Media.Root, "bin", "w7-results.txt");
   try {
    // 1. 色轮圆盘数学 + LUT（暗红 + 阴影色相+120° 变绿，引擎 P3d 探针值）。
    double hue, sat;
    WheelMath.FromPoint(0, 0, 58, out hue, out sat);
    Require(hue == 0 && Near(sat, 1, .001), "wheel center is identity (hue 0, sat 1)");
    WheelMath.FromPoint(58, 0, 58, out hue, out sat);
    Require(Near(hue, 0, .01) && Near(sat, 3, .01), "wheel right edge is hue 0 sat 3x");
    WheelMath.FromPoint(0, -58, 58, out hue, out sat);
    Require(Near(hue, 90, .01) && Near(sat, 3, .01), "wheel top is hue +90 sat 3x");
    WheelMath.FromPoint(-58, 0, 58, out hue, out sat);
    Require(Math.Abs(Math.Abs(hue) - 180) < .01 && Near(sat, 3, .01), "wheel left edge is hue +/-180 sat 3x");
    WheelMath.FromPoint(29, 0, 58, out hue, out sat);
    Require(Near(sat, 2, .01), "wheel half radius is sat 2x");
    double dx, dy;
    WheelMath.ToPoint(120, 3, 58, out dx, out dy);
    double hue2, sat2;
    WheelMath.FromPoint(dx, dy, 58, out hue2, out sat2);
    Require(Near(hue2, 120, .01) && Near(sat2, 3, .01), "wheel to/from point round-trips (120, 3x)");
    WheelMath.ToPoint(0, 0.5, 58, out dx, out dy);
    Require(Near(dx, 0, .01) && Near(dy, 0, .01), "sat below 1 clamps thumb to center");
    var wgrade = new ColorGrade();
    wgrade.WheelHue[0] = 120;
    var wgreen = ColorLut.Apply(wgrade, 0.5, 0, 0);
    Require(Near(wgreen[0], .055, .02) && Near(wgreen[1], .5, .02) && Near(wgreen[2], 0, .02), "dark red + shadow hue +120 turns green (got " + wgreen[0].ToString("0.00") + "," + wgreen[1].ToString("0.00") + "," + wgreen[2].ToString("0.00") + ")");
    var wident = ColorLut.Apply(new ColorGrade(), 0.5, 0, 0);
    Require(Near(wident[0], .5, .001) && Near(wident[1], 0, .001), "identity wheel leaves pixel alone");
    // 2. 导出设置：编码参数 + 校验。
    var hdr = new ExportOptions { PresetName = "HDR 4K", Height = 2160, Fps = 30, Codec = "h265", Crf = 22, Hdr = true };
    string hdrArgs = hdr.VideoEncoderArgs();
    Require(hdrArgs.Contains("libx265") && hdrArgs.Contains("yuv420p10le") && hdrArgs.Contains("colorprim=bt2020") && hdrArgs.Contains("transfer=smpte2084") && hdrArgs.Contains("colormatrix=bt2020nc"), "HDR encoder args carry x265-params color metadata");
    var sdr = ExportOptions.Sdr(1080, 30);
    string sdrArgs = sdr.VideoEncoderArgs();
    Require(sdrArgs.Contains("libx264") && sdrArgs.Contains("yuv420p") && !sdrArgs.Contains("x265"), "SDR encoder args are plain libx264");
    var h265sdr = new ExportOptions { Height = 2160, Fps = 30, Codec = "h265", Crf = 22, Hdr = false };
    Require(h265sdr.VideoEncoderArgs().Contains("libx265") && !h265sdr.VideoEncoderArgs().Contains("yuv420p10le"), "H.265 without HDR stays 8-bit");
    bool threw = false;
    try { new ExportOptions { Height = 1080, Fps = 30, Codec = "h264", Crf = 18, Hdr = true }.Validate(); } catch { threw = true; }
    Require(threw, "HDR with H.264 is rejected");
    threw = false;
    try { new ExportOptions { Height = 1080, Fps = 30, Codec = "h264", Crf = 60 }.Validate(); } catch { threw = true; }
    Require(threw, "CRF 60 is rejected");
    threw = false;
    try { new ExportOptions { Height = 99999, Fps = 30, Codec = "h264", Crf = 18 }.Validate(); } catch { threw = true; }
    Require(threw, "height 99999 is rejected");
    threw = false;
    try { new ExportOptions { Height = 1080, Fps = 0, Codec = "h264", Crf = 18 }.Validate(); } catch { threw = true; }
    Require(threw, "fps 0 is rejected");
    Require(ExportPresets.BuiltIn().Count == 4 && ExportPresets.Find("HDR 4K") != null && ExportPresets.Find("HDR 4K").Hdr && ExportPresets.Find("8K").Height == 4320, "built-in presets: SDR 1080p / SDR 4K / HDR 4K / 8K");
    // 3. 自定义预设存取（写测试目录，不碰用户配置）。
    string presetDir = Path.Combine(Folder, "presets");
    var saved = new ExportOptions { Height = 1440, Fps = 60, Codec = "h265", Crf = 20, Hdr = false, WriteChapters = false };
    ExportPresetStore.Save("我的4K", saved, presetDir);
    Require(ExportPresetStore.List(presetDir).Contains("我的4K"), "saved preset lists");
    var loaded = ExportPresetStore.Load("我的4K", presetDir);
    Require(loaded.Height == 1440 && loaded.Fps == 60 && loaded.Codec == "h265" && loaded.Crf == 20 && !loaded.WriteChapters, "preset round-trips");
    File.WriteAllText(Path.Combine(presetDir, "坏的.json"), "{不是 json", new UTF8Encoding(false));
    threw = false;
    try { ExportPresetStore.Load("坏的", presetDir); } catch { threw = true; }
    Require(threw, "broken preset JSON is rejected");
    threw = false;
    try { ExportPresetStore.Save("a/b", saved, presetDir); } catch { threw = true; }
    Require(threw, "preset name with slash is rejected");
    ExportPresetStore.Delete("我的4K", presetDir);
    Require(!ExportPresetStore.List(presetDir).Contains("我的4K"), "preset delete works");
    // 4. 章节：元数据文本 + 真实导出写章节。
    var markers = new List<RecordingMarker> { new RecordingMarker { Time = 0, Label = "Intro" }, new RecordingMarker { Time = 2, Label = "Main" } };
    string meta = Chapters.BuildMetadata(markers, 4);
    Require(meta.Contains("START=0") && meta.Contains("END=2000") && meta.Contains("title=Intro") && meta.Contains("START=2000") && meta.Contains("END=4000") && meta.Contains("title=Main"), "chapter metadata has both chapters with titles");
    Require(Chapters.ChapterCount(markers, 4) == 2, "chapter count is 2");
    Require(Chapters.ChapterCount(new List<RecordingMarker>(), 4) == 0, "no markers means no chapters");
    string chapSrc = Path.Combine(Folder, "chap-src.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=4 -f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=4\" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(chapSrc));
    var cdoc = StudioMedia.Import(chapSrc);
    cdoc.RecordingMarkers = markers;
    string chapOut = Path.Combine(Folder, "chap-out.mp4");
    StudioRenderer.Export(cdoc, chapOut, new ExportOptions { PresetName = "test", Height = 360, Fps = 30, Codec = "h264", Crf = 18, Hdr = false, WriteChapters = true }, (v, s) => { }, CancellationToken.None);
    Require(ChapterCount(chapOut) == 2 && ChapterTitles(chapOut) == "Intro|Main", "exported file carries 2 chapters (got " + ChapterTitles(chapOut) + ")");
    Require(Math.Abs(StudioMedia.Import(chapOut).Duration - 4) < 0.15, "chapter export keeps 4s duration");
    var cdocNoChap = StudioMedia.Import(chapSrc);
    string noChapOut = Path.Combine(Folder, "no-chap-out.mp4");
    StudioRenderer.Export(cdocNoChap, noChapOut, new ExportOptions { PresetName = "test", Height = 360, Fps = 30, Codec = "h264", Crf = 18, Hdr = false, WriteChapters = true }, (v, s) => { }, CancellationToken.None);
    Require(ChapterCount(noChapOut) == 0, "no markers means no chapters written");
    // 5. HDR 真实导出：小尺寸，验编码器 + 色彩元数据。
    string hdrSrc = Path.Combine(Folder, "hdr-src.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=1 -f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=1\" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(hdrSrc));
    var hdoc = StudioMedia.Import(hdrSrc);
    string hdrOut = Path.Combine(Folder, "hdr-out.mp4");
    // 真实导出用 360p（验编码器 + 色彩元数据，不用 4K 画布烧时间）。
    StudioRenderer.Export(hdoc, hdrOut, new ExportOptions { PresetName = "HDR test", Height = 360, Fps = 30, Codec = "h265", Crf = 22, Hdr = true }, (v, s) => { }, CancellationToken.None);
    string hdrInfo = StreamInfo(hdrOut);
    Require(hdrInfo.Contains("hevc") && hdrInfo.Contains("smpte2084") && hdrInfo.Contains("bt2020"), "HDR export is hevc + smpte2084 + bt2020 (" + hdrInfo.Replace("\n", " ").Replace("\r", "") + ")");
    Require(hdrInfo.Contains("yuv420p10le"), "HDR export is 10-bit");
    // 6. 8K：0.3 秒 @10fps，验尺寸 + 编码器（只 3 帧，云端跑得动）。
    string kSrc = Path.Combine(Folder, "k-src.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=1 -c:v libx264 -pix_fmt yuv420p " + Media.Q(kSrc));
    var kdoc = StudioMedia.Import(kSrc);
    kdoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 0.3 } };
    string kOut = Path.Combine(Folder, "k-out.mp4");
    StudioRenderer.Export(kdoc, kOut, new ExportOptions { PresetName = "8K", Height = 4320, Fps = 10, Codec = "h265", Crf = 22, Hdr = false }, (v, s) => { }, CancellationToken.None);
    string kInfo = StreamInfo(kOut);
    Require(kInfo.Contains("7680") && kInfo.Contains("4320") && kInfo.Contains("hevc"), "8K export is 7680x4320 hevc (" + kInfo.Replace("\n", " ").Replace("\r", "") + ")");
    // 7. 一键删静音：检测 + 应用 + 跟随前移 + 真实导出。
    string gapWav = Path.Combine(Folder, "gap.wav");
    RunFfmpeg("-v error -y -f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=6,volume='if(between(t,2,4),0,1)':eval=frame\" -c:a pcm_s16le " + Media.Q(gapWav));
    var spans = SilenceCut.Detect(gapWav, -40, 0.5, CancellationToken.None);
    Require(spans.Count == 1 && Near(spans[0].Start, 2.0, 0.05) && Near(spans[0].End, 4.0, 0.05), "silencedetect finds [2.0, 4.0] (got " + (spans.Count == 0 ? "none" : spans[0].Start.ToString("0.00") + "-" + spans[0].End.ToString("0.00")) + ")");
    string gapSrc = Path.Combine(Folder, "gap-src.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=6 -i " + Media.Q(gapWav) + " -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(gapSrc));
    var sdoc = StudioMedia.Import(gapSrc);
    sdoc.Subtitles.Add(new SubtitleCue { Start = 5.0, End = 5.8, Text = "后半句" });
    sdoc.RecordingMarkers.Add(new RecordingMarker { Time = 1.0, Label = "开头" });
    sdoc.RecordingMarkers.Add(new RecordingMarker { Time = 5.0, Label = "后半" });
    double removed = SilenceCut.Apply(sdoc, spans);
    Require(Near(removed, 2.0, 0.05) && Near(sdoc.Length, 4.0, 0.05), "silence cut removes 2.0s, length 6 -> 4 (removed " + removed.ToString("0.00") + ")");
    Require(sdoc.Cuts.Count == 2 && Near(sdoc.Cuts[0].Start, 0, .01) && Near(sdoc.Cuts[0].End, 2, .01) && Near(sdoc.Cuts[1].Start, 4, .01) && Near(sdoc.Cuts[1].End, 6, .01), "cuts split into [0,2] + [4,6]");
    Require(Near(sdoc.Subtitles[0].Start, 3.0, .05) && Near(sdoc.Subtitles[0].End, 3.8, .05), "subtitle follows the cut (5.0 -> 3.0)");
    Require(Near(sdoc.RecordingMarkers[0].Time, 1.0, .01) && Near(sdoc.RecordingMarkers[1].Time, 3.0, .05), "markers follow the cut (1.0 stays, 5.0 -> 3.0)");
    threw = false;
    try { SilenceCut.Apply(StudioMedia.Import(gapSrc), new List<SilenceCut.Span> { new SilenceCut.Span { Start = 3, End = 4 }, new SilenceCut.Span { Start = 3.5, End = 5 } }); } catch { threw = true; }
    Require(threw, "overlapping silence spans are rejected");
    string cutOut = Path.Combine(Folder, "cut-out.mp4");
    StudioRenderer.Export(sdoc, cutOut, 360, 30, (v, s) => { }, CancellationToken.None);
    Require(Math.Abs(StudioMedia.Import(cutOut).Duration - 4) < 0.15, "export after silence cut is 4.0s");
    File.WriteAllText(log, "PASS: wheel center/edges/half-radius + round-trip, dark red + shadow hue +120 -> green (" + wgreen[0].ToString("0.00") + "," + wgreen[1].ToString("0.00") + "," + wgreen[2].ToString("0.00") + "); HDR args libx265 + yuv420p10le + x265-params, HDR+H.264/CRF 60/height 99999/fps 0 rejected, 4 built-in presets; preset store round-trip + broken JSON + bad name rejected + delete; chapters metadata + export carries Intro|Main, no markers means none; HDR export hevc + smpte2084 + bt2020 10-bit; 8K export 7680x4320 hevc (0.3s @10fps); silencedetect [2.0, 4.0], cut removes 2.0s, cuts [0,2]+[4,6], subtitle 5.0 -> 3.0, markers follow, overlap rejected, export after cut 4.0s.\n");
   }
   catch (Exception ex) { File.WriteAllText(log, "FAIL\n" + ex); Environment.ExitCode = 1; }
  }
 }
}
