// W8 自测（2026-11-18）：--w8effects-test 入口，无窗口，纯逻辑 + 合成素材实测。
// 跑在云端构建里（build-test.yml 的 W8 effects checks 步），结果写
// Windows/bin/w8effects-results.txt（PASS: 开头才算过）。本地 Linux 跑不了 WPF，
// 但这些测试不碰窗口，只碰模型/滤镜串/ffmpeg/真实导出，所以云端是唯一可信的验证。
// 断言值全部来自本地探针实测（见 W8EffectsPanels.cs 头注释的出处）：
// 场景切分 6 秒红/亮绿/蓝硬切 → [2.0, 4.0]；抠像合成角点 (254,0,0)、
// 中心与原片一致；dilation 白像素 3600 → 3844（1 遍）→ 4356（3 遍）；
// 移动白盒跟踪 0.061 → 0.498 → 0.892；马赛克单帧区域 PSNR 40.0。
// 云端 runner 无真 GPU/摄像头/麦克风、无 ONNX 后端：人像遮罩生成与
// AI 放大只验“缺后端/缺模型时诚实报错”，不假装真机验过。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.IO;
using System.Linq;
using System.Threading;
using DogSC.Windows;

namespace DogSC.Replica {
 static class W8EffectsTests {
  static void Require(bool ok, string name) { if (!ok) throw new Exception("W8 检查失败：" + name); }
  static bool Near(double a, double b, double tol) { return Math.Abs(a - b) <= tol; }
  static string Folder;
  static string LogPath;
  static void Mark(string s) { try { File.AppendAllText(LogPath, s + "\n"); } catch { } }
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
  static string CodecOf(string file) {
   return Probe("-v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 " + Media.Q(file)).Trim();
  }
  static string StreamSize(string file) {
   return Probe("-v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 " + Media.Q(file)).Trim();
  }
  static double Psnr(string a, string b, string crop) {
   using (var p = Media.Start("ffmpeg", "-v info -i " + Media.Q(a) + " -i " + Media.Q(b) + " -filter_complex \"[0:v]" + crop + "[x];[1:v]" + crop + "[y];[x][y]psnr\" -f null -", false)) {
    var err = p.StandardError.ReadToEndAsync();
    p.StandardInput.Close();
    p.WaitForExit();
    if (p.ExitCode != 0) throw new Exception("PSNR 测量失败：" + err.Result);
    string text = err.Result;
    int at = text.LastIndexOf("average:", StringComparison.Ordinal);
    if (at < 0) throw new Exception("PSNR 输出里没有 average：" + text);
    string num = text.Substring(at + 8).Trim().Split(' ')[0];
    if (num == "inf") return 99;
    double v;
    if (!double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) throw new Exception("PSNR 数值解析失败：" + num);
    return v;
   }
  }
  // 单帧 PSNR（两路都 -ss 到同一时刻再比一帧）。
  static double PsnrAt(string a, string b, double time, string crop) {
   using (var p = Media.Start("ffmpeg", "-v info -ss " + Media.N(time) + " -i " + Media.Q(a) + " -ss " + Media.N(time) + " -i " + Media.Q(b) + " -filter_complex \"[0:v]" + crop + "[x];[1:v]" + crop + "[y];[x][y]psnr\" -frames:v 1 -f null -", false)) {
    var err = p.StandardError.ReadToEndAsync();
    p.StandardInput.Close();
    p.WaitForExit();
    if (p.ExitCode != 0) throw new Exception("单帧 PSNR 测量失败：" + err.Result);
    string text = err.Result;
    int at = text.LastIndexOf("average:", StringComparison.Ordinal);
    if (at < 0) throw new Exception("单帧 PSNR 输出里没有 average：" + text);
    string num = text.Substring(at + 8).Trim().Split(' ')[0];
    if (num == "inf") return 99;
    double v;
    if (!double.TryParse(num, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) throw new Exception("单帧 PSNR 数值解析失败：" + num);
    return v;
   }
  }
  // 取一帧某区域的平均 RGB（16x16 裁剪再缩到 1x1；1x1 裁剪在 yuv420p 上会失败）。
  static int[] MeanRgb(string file, double time, string crop) {
   using (var p = Media.Start("ffmpeg", "-v error -ss " + Media.N(time) + " -i " + Media.Q(file) + " -frames:v 1 -vf \"" + crop + ",scale=1:1\" -f rawvideo -pix_fmt rgb24 -", true)) {
    var err = p.StandardError.ReadToEndAsync();
    using (var ms = new MemoryStream()) {
     p.StandardOutput.BaseStream.CopyTo(ms);
     p.WaitForExit();
     if (p.ExitCode != 0) throw new Exception("取像素失败：" + err.Result);
     byte[] b = ms.ToArray();
     if (b.Length < 3) throw new Exception("取像素没有数据。");
     return new[] { (int)b[0], (int)b[1], (int)b[2] };
    }
   }
  }
  // 取一帧、经指定 vf 后的白像素数（灰度 >128）。
  static int CountWhite(string file, double time, string vf, int w, int h) {
   using (var p = Media.Start("ffmpeg", "-v error -ss " + Media.N(time) + " -i " + Media.Q(file) + " -frames:v 1 -vf \"" + vf + ",scale=" + w + ":" + h + "\" -f rawvideo -pix_fmt gray -", true)) {
    var err = p.StandardError.ReadToEndAsync();
    using (var ms = new MemoryStream()) {
     p.StandardOutput.BaseStream.CopyTo(ms);
     p.WaitForExit();
     if (p.ExitCode != 0) throw new Exception("数白像素失败：" + err.Result);
     byte[] b = ms.ToArray();
     int n = 0;
     foreach (byte v in b) if (v > 128) n++;
     return n;
    }
   }
  }
  static EditDocument DocFor(string file) { return StudioMedia.Import(file); }
  public static void Run() {
   Folder = Path.Combine(Media.Root, "bin", "w8-test");
   Directory.CreateDirectory(Folder);
   string log = Path.Combine(Media.Root, "bin", "w8effects-results.txt");
   LogPath = log;
   File.WriteAllText(log, "RUNNING\n");
   try {
    // ---- 素材 ----
    string src2s = Path.Combine(Folder, "src2s.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=2 -f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=2\" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(src2s));
    string src4s = Path.Combine(Folder, "src4s.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=4 -f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=4\" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(src4s));
    string sceneSrc = Path.Combine(Folder, "scene.mp4");
    RunFfmpeg("-v error -y -f lavfi -i color=c=red:s=320x180:r=30:d=2 -f lavfi -i color=c=0x00FF00:s=320x180:r=30:d=2 -f lavfi -i color=c=blue:s=320x180:r=30:d=2 -filter_complex \"[0:v][1:v][2:v]concat=n=3:v=1:a=0\" -c:v libx264 -pix_fmt yuv420p " + Media.Q(sceneSrc));
    // 移动白盒（overlay 的 x 表达式逐帧求值；drawbox 的 x 只在初始化求值一次，t 恒为 0，不能用）。
    string boxPng = Path.Combine(Folder, "box.png");
    RunFfmpeg("-v error -y -f lavfi -i color=c=white:s=40x40:r=30:d=1 -frames:v 1 -c:v png " + Media.Q(boxPng));
    string moveSrc = Path.Combine(Folder, "move.mp4");
    RunFfmpeg("-v error -y -f lavfi -i color=c=black:s=320x180:r=30:d=4 -loop 1 -i " + Media.Q(boxPng) + " -filter_complex \"[0:v][1:v]overlay=x='(W-40)*t/4':y=100:shortest=1\" -c:v libx264 -pix_fmt yuv420p " + Media.Q(moveSrc));
    // 移动纹理盒（模板跟踪用：纯白盒没有纹理，NCC 分母为 0，跟不住）。
    string texBox = Path.Combine(Folder, "texbox.png");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=320x180:rate=30:duration=1 -vf crop=40:40:100:100 -frames:v 1 -c:v png " + Media.Q(texBox));
    string moveTexSrc = Path.Combine(Folder, "movetex.mp4");
    RunFfmpeg("-v error -y -f lavfi -i color=c=black:s=320x180:r=30:d=4 -loop 1 -i " + Media.Q(texBox) + " -filter_complex \"[0:v][1:v]overlay=x='(W-40)*t/4':y=100:shortest=1\" -c:v libx264 -pix_fmt yuv420p " + Media.Q(moveTexSrc));
    string maskSrc = Path.Combine(Folder, "mask.mp4");
    RunFfmpeg("-v error -y -f lavfi -i color=c=black:s=640x360:r=30:d=2 -vf \"drawbox=x=220:y=80:w=200:h=200:color=white:t=fill\" -c:v libx264 -pix_fmt yuv420p " + Media.Q(maskSrc));
    string sqMask = Path.Combine(Folder, "sqmask.mp4");
    RunFfmpeg("-v error -y -f lavfi -i color=c=black:s=320x180:r=30:d=1 -vf \"drawbox=x=130:y=60:w=60:h=60:color=white:t=fill\" -c:v libx264 -pix_fmt yuv420p -r 30 " + Media.Q(sqMask));
    Mark("STEP 0 fixtures OK");

    // 1. 防抖：滤镜串 + 校验 + deshake 真实跑。
    var stabDoc = DocFor(src2s);
    stabDoc.StabilizeEnabled = true;
    Require(Stabilizer.DeshakeFilter(stabDoc) == "deshake=rx=16:ry=16:edge=3", "deshake filter string is rx=16:ry=16:edge=3 (got " + Stabilizer.DeshakeFilter(stabDoc) + ")");
    string trf = Path.Combine(Folder, "stab.trf");
    Require(Stabilizer.VidstabTransformFilter(trf, stabDoc).Contains("smoothing=15") && Stabilizer.VidstabTransformFilter(trf, stabDoc).Contains("optalgo=0"), "vidstab transform filter carries smoothing=15 + optalgo=0");
    bool threw = false;
    try { var bad = DocFor(src2s); bad.StabilizeEnabled = true; bad.StabilizeSmoothing = 1001; Stabilizer.Validate(bad); } catch { threw = true; }
    Require(threw, "stabilize smoothing 1001 is rejected");
    threw = false;
    try { var bad = DocFor(src2s); bad.StabilizeEnabled = true; bad.StabilizeMethod = "foo"; Stabilizer.Validate(bad); } catch { threw = true; }
    Require(threw, "stabilize method foo is rejected");
    bool hasVidstab = Stabilizer.HasVidstab();
    string deshFile = Stabilizer.StabilizeFile(src2s, new EditDocument { Source = src2s, StabilizeEnabled = true, StabilizeMethod = "deshake", DeshakeRx = 16, DeshakeRy = 16 }, Folder, CancellationToken.None);
    Require(Math.Abs(Media.Duration(deshFile) - 2) < .1, "deshake keeps 2.0s duration");
    string vidstabNote;
    if (hasVidstab) {
     var vdoc = DocFor(src2s);
     vdoc.StabilizeEnabled = true;
     vdoc.StabilizeMethod = "vidstab";
     string vFile = Stabilizer.StabilizeFile(src2s, vdoc, Folder, CancellationToken.None);
     Require(Math.Abs(Media.Duration(vFile) - 2) < .1, "vidstab two-pass keeps 2.0s duration");
     vidstabNote = "vidstab present, two-pass export 2.0s";
    } else {
     threw = false;
     try { var vdoc = DocFor(src2s); vdoc.StabilizeEnabled = true; vdoc.StabilizeMethod = "vidstab"; Stabilizer.StabilizeFile(src2s, vdoc, Folder, CancellationToken.None); } catch (Exception ex) { threw = ex.Message.Contains("vidstab"); }
     Require(threw, "vidstab missing means an honest vidstab error, not a silent deshake fallback");
     vidstabNote = "vidstab absent, honest error raised";
    }
    Mark("STEP 1 stabilize OK (" + vidstabNote + ")");
    // 2. 人像抠像背景：图串 + 合成实测（合成遮罩，不跑 ONNX）。
    var pdoc = DocFor(src2s);
    pdoc.PortraitEnabled = true;
    pdoc.PortraitBgMode = "color";
    pdoc.PortraitBgColor = "#FF0000";
    string colorGraph = PortraitBackground.FilterComplex("scale=640:360", 30, 640, 360, pdoc, "");
    Require(colorGraph.Contains("geq=r=255:g=0:b=0") && colorGraph.Contains("alphamerge") && colorGraph.Contains("overlay=0:0"), "color background graph has geq red + alphamerge + overlay");
    pdoc.PortraitBgMode = "blur";
    pdoc.PortraitBgBlur = 6;
    Require(PortraitBackground.FilterComplex("scale=640:360", 30, 640, 360, pdoc, "").Contains("gblur=sigma=6"), "blur background graph has gblur sigma=6");
    pdoc.PortraitBgMode = "image";
    pdoc.PortraitBgImage = maskSrc;
    Require(PortraitBackground.FilterComplex("scale=640:360", 30, 640, 360, pdoc, "").Contains("[2:v]scale="), "image background graph uses second input");
    pdoc.PortraitBgMode = "original";
    Require(!PortraitBackground.FilterComplex("scale=640:360", 30, 640, 360, pdoc, "").Contains("geq="), "original background graph has no geq");
    pdoc.PortraitBgMode = "color";
    pdoc.OutlineEnabled = true;
    pdoc.OutlineColor = "#FFFFFF";
    pdoc.OutlineWidth = 2;
    string outlineGraph = PortraitBackground.FilterComplex("scale=640:360", 30, 640, 360, pdoc, "");
    Require(outlineGraph.Contains("dilation=threshold0=255") && outlineGraph.Contains("blend=all_mode=difference"), "outline graph has dilation + difference ring");
    string compOut = Path.Combine(Folder, "comp.mp4");
    pdoc.OutlineEnabled = false;
    string compGraph = PortraitBackground.FilterComplex("scale=640:360", 30, 640, 360, pdoc, "");
    RunFfmpeg("-v error -y -i " + Media.Q(src2s) + " -i " + Media.Q(maskSrc) + " -filter_complex " + Media.Q(compGraph) + " -map \"[out]\" -c:v libx264 -pix_fmt yuv420p " + Media.Q(compOut));
    int[] corner = MeanRgb(compOut, 1, "crop=16:16:0:0");
    Require(corner[0] > 240 && corner[1] < 20 && corner[2] < 20, "portrait composite corner is red (got " + corner[0] + "," + corner[1] + "," + corner[2] + ")");
    double centerPsnr = PsnrAt(compOut, src2s, 1, "crop=16:16:312:172");
    Require(centerPsnr > 40, "portrait composite keeps the foreground (center PSNR " + centerPsnr.ToString("0.0") + ")");
    string outlineOut = Path.Combine(Folder, "comp-outline.mp4");
    pdoc.OutlineEnabled = true;
    RunFfmpeg("-v error -y -i " + Media.Q(src2s) + " -i " + Media.Q(maskSrc) + " -filter_complex " + Media.Q(PortraitBackground.FilterComplex("scale=640:360", 30, 640, 360, pdoc, "")) + " -map \"[out]\" -c:v libx264 -pix_fmt yuv420p " + Media.Q(outlineOut));
    Require(Math.Abs(Media.Duration(outlineOut) - 2) < .1, "outline composite exports 2.0s");
    Mark("STEP 2 portrait background OK (corner " + corner[0] + "," + corner[1] + "," + corner[2] + ", center PSNR " + centerPsnr.ToString("0.0") + ")");
    // 3. 抠像描边：颜色解析 + 粗细校验 + dilation 像素数。
    int[] red = KeyOutline.ParseColor("red");
    Require(red[0] == 255 && red[1] == 0 && red[2] == 0, "named color red parses");
    int[] hex = KeyOutline.ParseColor("#00FF00");
    Require(hex[0] == 0 && hex[1] == 255 && hex[2] == 0, "#00FF00 parses");
    threw = false;
    try { KeyOutline.ParseColor("notacolor"); } catch { threw = true; }
    Require(threw, "unknown outline color is rejected");
    threw = false;
    try { var oDoc = DocFor(src2s); oDoc.OutlineEnabled = true; oDoc.OutlineWidth = 0; KeyOutline.Validate(oDoc); } catch { threw = true; }
    Require(threw, "outline width 0 is rejected");
    threw = false;
    try { var oDoc = DocFor(src2s); oDoc.OutlineEnabled = true; oDoc.OutlineWidth = 11; KeyOutline.Validate(oDoc); } catch { threw = true; }
    Require(threw, "outline width 11 is rejected");
    Require(KeyOutline.DilationFilter(3) == "dilation=threshold0=255,dilation=threshold0=255,dilation=threshold0=255", "dilation filter chains 3 passes");
    int baseWhite = CountWhite(sqMask, 0.5, "null", 320, 180);
    int dil1 = CountWhite(sqMask, 0.5, "dilation=threshold0=255", 320, 180);
    int dil3 = CountWhite(sqMask, 0.5, "dilation=threshold0=255,dilation=threshold0=255,dilation=threshold0=255", 320, 180);
    Require(Near(baseWhite, 3600, 60) && Near(dil1, 3844, 60) && Near(dil3, 4356, 80), "dilation grows white pixels 3600 -> 3844 -> 4356 (got " + baseWhite + " -> " + dil1 + " -> " + dil3 + ")");
    Mark("STEP 3 key outline OK (" + baseWhite + " -> " + dil1 + " -> " + dil3 + ")");
    // 4. 模板商店：4 个内置 + 应用 + 10 种坏模板拒绝。
    Require(TemplateStore.BuiltIn().Count == 4 && TemplateStore.Find("talking-clean") != null && TemplateStore.Find("vlog-film") != null && TemplateStore.Find("beat-energetic") != null && TemplateStore.Find("interview-duo") != null, "4 built-in templates load");
    Require(TemplateStore.Find("nope") == null, "unknown template id returns null");
    var tdoc = DocFor(src2s);
    TemplateStore.Apply(tdoc, "vlog-film");
    Require(tdoc.TemplateId == "vlog-film" && Near(tdoc.Grade.Temperature, .35, .001) && tdoc.Transition == "dissolve", "vlog-film applies warm + dissolve");
    TemplateStore.Apply(tdoc, "beat-energetic");
    Require(Near(tdoc.Grade.Temperature, -.35, .001) && tdoc.Transition == "cut", "beat-energetic applies cool + cut");
    string[] badTemplates = {
     "{不是 json",
     "{\"label\":\"x\",\"description\":\"x\"}",
     "{\"id\":\"t\",\"description\":\"x\"}",
     "{\"id\":\"t\",\"label\":\"x\"}",
     "{\"id\":\"t\",\"label\":\"x\",\"description\":\"x\",\"transition\":\"spin\"}",
     "{\"id\":\"t\",\"label\":\"x\",\"description\":\"x\",\"textStylePreset\":\"huge\"}",
     "{\"id\":\"t\",\"label\":\"x\",\"description\":\"x\",\"colorPreset\":\"neon\"}",
     "{\"id\":\"t\",\"label\":\"x\",\"description\":\"x\",\"textStylePreset\":\"title\",\"textStyle\":{}}",
     "{\"id\":\"t\",\"label\":\"x\",\"description\":\"x\",\"mask\":{\"shape\":\"triangle\"}}",
     "{\"id\":\"t\",\"label\":\"x\",\"description\":\"x\",\"surprise\":1}"
    };
    int rejected = 0;
    foreach (string bad in badTemplates) { try { TemplateStore.Parse(bad); } catch { rejected++; } }
    Require(rejected == 10, "10 bad templates are all rejected (got " + rejected + "/10)");
    Mark("STEP 4 template store OK (4 built-in, 10/10 bad rejected)");
    // 5. 场景切分：检测 + 分段 + 进时间线。
    threw = false;
    try { SceneCut.Detect(sceneSrc, 0.01, CancellationToken.None); } catch { threw = true; }
    Require(threw, "scene threshold 0.01 is rejected");
    var cuts = SceneCut.Detect(sceneSrc, 0.4, CancellationToken.None);
    Require(cuts.Count == 2 && Near(cuts[0], 2.0, .05) && Near(cuts[1], 4.0, .05), "scene detect finds [2.0, 4.0] (got " + string.Join(",", cuts.Select(c => c.ToString("0.00")).ToArray()) + ")");
    var segs = SceneCut.ToSegments(cuts, 6);
    Require(segs.Count == 3 && Near(segs[1].Start, 2.0, .05) && Near(segs[2].Start, 4.0, .05), "scene segments split into 3");
    var sdoc = DocFor(sceneSrc);
    int nCuts = SceneCut.Apply(sdoc, cuts);
    Require(nCuts == 3 && Near(sdoc.Cuts[1].Start, 2.0, .05) && Near(sdoc.Cuts[2].Start, 4.0, .05) && Near(sdoc.Length, 6, .01), "scene cuts enter the timeline (3 cuts, length stays 6s)");
    Mark("STEP 5 scene cut OK ([" + cuts[0].ToString("0.00") + ", " + cuts[1].ToString("0.00") + "], 3 cuts)");
    // 6. 对象跟踪：颜色质心 + 模板 NCC + 马赛克/贴纸实测。
    var trackDoc = DocFor(moveSrc);
    trackDoc.ObjectTrackEnabled = true;
    trackDoc.ObjectTrackMethod = "color";
    trackDoc.ObjectTrackColor = "#FFFFFF";
    trackDoc.ObjectTrackTolerance = 60;
    trackDoc.ObjectTrackSticker = "跟住我";
    var track = ObjectTracker.Track(moveSrc, trackDoc, CancellationToken.None);
    Require(track.Count == 20, "color track returns 20 points at 5fps over 4s (got " + track.Count + ")");
    Require(track[0].X < .2 && track[track.Count - 1].X > .7 && track.Count(p => p.Lost) == 0, "color track follows the box 0.06 -> 0.89, no lost frames (first " + track[0].X.ToString("0.00") + ", last " + track[track.Count - 1].X.ToString("0.00") + ")");
    var texDoc = DocFor(moveTexSrc);
    texDoc.ObjectTrackEnabled = true;
    texDoc.ObjectTrackMethod = "template";
    texDoc.TrackBoxX = 0;
    texDoc.TrackBoxY = 100.0 / 180;
    texDoc.TrackBoxW = 40.0 / 320;
    texDoc.TrackBoxH = 40.0 / 180;
    texDoc.ObjectTrackSticker = "跟住我";
    var texTrack = ObjectTracker.Track(moveTexSrc, texDoc, CancellationToken.None);
    Require(texTrack.Count == 20 && Near(texTrack[0].X, .0625, .05) && texTrack[texTrack.Count - 1].X > .6, "template track follows the textured box (first " + texTrack[0].X.ToString("0.00") + ", last " + texTrack[texTrack.Count - 1].X.ToString("0.00") + ")");
    threw = false;
    try { var bad = DocFor(moveSrc); bad.ObjectTrackEnabled = true; bad.ObjectTrackMethod = "color"; bad.ObjectTrackColor = "#FFFFFF"; bad.ObjectTrackMosaic = 0; bad.ObjectTrackSticker = ""; ObjectTracker.Validate(bad); } catch { threw = true; }
    Require(threw, "object track with neither sticker nor mosaic is rejected");
    var mosDoc = DocFor(moveSrc);
    mosDoc.ObjectTrackEnabled = true;
    mosDoc.ObjectTrackMethod = "color";
    mosDoc.ObjectTrackColor = "#FFFFFF";
    mosDoc.ObjectTrackMosaic = 0.2;
    string trackedFile = ObjectTracker.ApplyToFile(moveSrc, mosDoc, Folder, CancellationToken.None);
    Require(Math.Abs(Media.Duration(trackedFile) - 4) < .1, "mosaic follow keeps 4.0s duration");
    double mosPsnr = PsnrAt(trackedFile, moveSrc, 2, "crop=64:64:128:88");
    Require(mosPsnr < 45, "mosaic region differs from the original (single-frame region PSNR " + mosPsnr.ToString("0.0") + ")");
    var stkDoc = DocFor(moveSrc);
    stkDoc.ObjectTrackEnabled = true;
    stkDoc.ObjectTrackMethod = "color";
    stkDoc.ObjectTrackColor = "#FFFFFF";
    stkDoc.ObjectTrackSticker = "跟住我";
    string stickerFile = ObjectTracker.ApplyToFile(moveSrc, stkDoc, Folder, CancellationToken.None);
    Require(Math.Abs(Media.Duration(stickerFile) - 4) < .1, "sticker follow keeps 4.0s duration");
    Mark("STEP 6 object track OK (color 0.06 -> " + track[track.Count - 1].X.ToString("0.00") + ", template last " + texTrack[texTrack.Count - 1].X.ToString("0.00") + ", mosaic region PSNR " + mosPsnr.ToString("0.0") + ")");
    // 7. 克隆：校验 + 2 路/4 路真实渲染。
    threw = false;
    try { var bad = DocFor(src4s); bad.CloneEnabled = true; bad.CloneLanes = 3; CloneEffect.Validate(bad); } catch { threw = true; }
    Require(threw, "clone with 3 lanes is rejected");
    threw = false;
    try { var bad = DocFor(src4s); bad.CloneEnabled = true; bad.CloneLanes = 2; bad.CloneOffsets = "1,2"; CloneEffect.Validate(bad); } catch { threw = true; }
    Require(threw, "clone offsets not starting at 0 are rejected");
    threw = false;
    try { var bad = DocFor(src4s); bad.CloneEnabled = true; bad.CloneLanes = 2; bad.CloneOffsets = "0,0"; CloneEffect.Validate(bad); } catch { threw = true; }
    Require(threw, "clone non-increasing offsets are rejected");
    threw = false;
    try { var bad = DocFor(src4s); bad.CloneEnabled = true; bad.CloneLanes = 4; bad.CloneOffsets = "0,1,2,3"; bad.CloneLayout = "horizontal"; CloneEffect.Validate(bad); } catch { threw = true; }
    Require(threw, "clone 4 lanes with horizontal layout is rejected");
    var cloneDoc = DocFor(src4s);
    cloneDoc.CloneEnabled = true;
    cloneDoc.CloneLanes = 2;
    cloneDoc.CloneOffsets = "0,1";
    cloneDoc.CloneLayout = "horizontal";
    string cloneOut = Path.Combine(Folder, "clone.mp4");
    CloneEffect.Render(src4s, cloneDoc, 2, cloneOut, CancellationToken.None);
    Require(StreamSize(cloneOut) == "640,360" && Math.Abs(Media.Duration(cloneOut) - 2) < .1, "clone 2-lane renders 640x360 2.0s");
    var cloneDoc4 = DocFor(src4s);
    cloneDoc4.CloneEnabled = true;
    cloneDoc4.CloneLanes = 4;
    cloneDoc4.CloneOffsets = "0,1,2,3";
    cloneDoc4.CloneLayout = "grid";
    string cloneOut4 = Path.Combine(Folder, "clone4.mp4");
    CloneEffect.Render(src4s, cloneDoc4, 1, cloneOut4, CancellationToken.None);
    Require(StreamSize(cloneOut4) == "640,360" && Math.Abs(Media.Duration(cloneOut4) - 1) < .1, "clone 4-lane grid renders 640x360 1.0s");
    Mark("STEP 7 clone OK (2-lane 640x360 2.0s, 4-lane grid 640x360 1.0s)");
    // 8. AI 放大：模型缺失诚实报错（不跑真的放大）。
    string upscaleProblem = Upscaler.CheckAvailable("realesrgan-x4plus");
    threw = false;
    try { var bad = DocFor(src2s); bad.UpscaleEnabled = true; bad.UpscaleModel = "nope"; Upscaler.Validate(bad); } catch (Exception ex) { threw = ex.Message.Contains("未知"); }
    Require(threw, "unknown upscale model is rejected");
    Mark("STEP 8 upscale OK (availability: " + (upscaleProblem ?? "model + script + python all present") + ")");
    // 9. 脚本转视频：校验 + 真实组装。
    threw = false;
    try { AutoVideo.Validate(new List<AutoVideoLine>(), ""); } catch { threw = true; }
    Require(threw, "empty script is rejected");
    threw = false;
    try { AutoVideo.Validate(new List<AutoVideoLine> { new AutoVideoLine { Text = new string('x', 2001), Duration = 3 } }, ""); } catch { threw = true; }
    Require(threw, "script line over 2000 chars is rejected");
    threw = false;
    try { AutoVideo.Validate(new List<AutoVideoLine> { new AutoVideoLine { Text = "你好", Image = Path.Combine(Folder, "nope.png"), Duration = 3 } }, ""); } catch { threw = true; }
    Require(threw, "script line with a missing image is rejected");
    threw = false;
    try { AutoVideo.Validate(new List<AutoVideoLine> { new AutoVideoLine { Text = "你好", Duration = 3 } }, "nope"); } catch { threw = true; }
    Require(threw, "script with an unknown template is rejected");
    string img1 = Path.Combine(Folder, "img1.png");
    string img2 = Path.Combine(Folder, "img2.png");
    RunFfmpeg("-v error -y -f lavfi -i color=c=red:s=640x360:r=30:d=1 -frames:v 1 -c:v png " + Media.Q(img1));
    RunFfmpeg("-v error -y -f lavfi -i color=c=blue:s=640x360:r=30:d=1 -frames:v 1 -c:v png " + Media.Q(img2));
    string filmOut = Path.Combine(Folder, "film.mp4");
    AutoVideo.Build(new List<AutoVideoLine> {
     new AutoVideoLine { Text = "第一句口播", Image = img1, Duration = 3 },
     new AutoVideoLine { Text = "第二句口播", Image = img2, Duration = 3 }
    }, "", filmOut, CancellationToken.None);
    Require(Math.Abs(Media.Duration(filmOut) - 6) < .15, "script film is 6.0s");
    string srt = File.ReadAllText(Path.ChangeExtension(filmOut, ".srt"));
    Require(srt.Contains("第一句口播") && srt.Contains("第二句口播"), "script film writes an .srt sidecar with both lines");
    Mark("STEP 9 script-to-video OK (6.0s + .srt sidecar)");
    // 10. 元数据面板 + ALE：往返 + 内容。
    var mdoc = DocFor(src2s);
    mdoc.Metadata.Scene = "12";
    mdoc.Metadata.Take = "3";
    mdoc.Metadata.Keywords = new List<string> { "夜景", "雨" };
    mdoc.Metadata.Notes = "备注";
    var reopened = EditDocument.Deserialize(mdoc.Serialize());
    Require(reopened.Metadata.Scene == "12" && reopened.Metadata.Take == "3" && reopened.Metadata.Keywords.Count == 2, "metadata round-trips through project.json");
    Require(AleExport.Timecode(65.5, 30) == "00:01:05:15", "ALE timecode 65.5s is 00:01:05:15");
    string ale = AleExport.ToAle(mdoc);
    Require(ale.Contains("FIELD_DELIM") && ale.Contains("12") && ale.Contains("夜景;雨") && ale.Contains("备注"), "ALE export carries scene/take/keywords/notes");
    Mark("STEP 10 metadata + ALE OK");
    // 11. 归档/重链接。
    string proxyCopy = Path.Combine(Folder, "src2s.proxy.mp4");
    File.Copy(src2s, proxyCopy, true);
    var adoc = DocFor(src2s);
    adoc.ProxyPath = proxyCopy;
    string archiveDir = Path.Combine(Folder, "archive");
    var archived = MediaArchive.Archive(adoc, Path.Combine(Folder, "proj.dogscwin"), archiveDir);
    Require(archived.Copied.Count == 2 && File.Exists(archived.ProjectFile), "archive copies source + proxy + project");
    var archivedDoc = EditDocument.Deserialize(File.ReadAllText(archived.ProjectFile));
    Require(archivedDoc.Source == "media/src2s.mp4", "archived project uses relative paths (got " + archivedDoc.Source + ")");
    string searchDir = Path.Combine(Folder, "search");
    Directory.CreateDirectory(searchDir);
    File.Copy(src2s, Path.Combine(searchDir, "src2s.mp4"), true);
    var rdoc = DocFor(src2s);
    rdoc.Source = Path.Combine(Folder, "gone", "src2s.mp4");
    string relinkReport = MediaArchive.Relink(rdoc, searchDir);
    Require(rdoc.Source == Path.Combine(searchDir, "src2s.mp4") && relinkReport.Contains("已重链接"), "relink finds the moved source by basename + duration");
    var udoc = DocFor(src2s);
    udoc.Source = Path.Combine(Folder, "gone", "nope.mp4");
    string unmatched = MediaArchive.Relink(udoc, searchDir);
    Require(udoc.Source.EndsWith("nope.mp4") && unmatched.Contains("未找到"), "relink with no match reports unmatched and changes nothing");
    Mark("STEP 11 archive + relink OK");
    // 12. 优化媒体：DNxHR 真实转码 + 校验。
    string smallSrc = Path.Combine(Folder, "small.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=320x180:rate=30:duration=2 -f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=2\" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(smallSrc));
    string optOut = Path.Combine(Folder, "small.optimized.mov");
    var optInfo = OptimizedMedia.Generate(smallSrc, optOut, "dnxhr_hq", CancellationToken.None);
    Require(CodecOf(optOut) == "dnxhd" && Math.Abs(optInfo.Duration - 2) < .1 && optInfo.Width == 320, "DNxHR optimized media is dnxhd 320x180 2.0s");
    string oddSrc = Path.Combine(Folder, "odd.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=321x180:rate=30:duration=1 -c:v libx264 -pix_fmt yuv444p " + Media.Q(oddSrc));
    threw = false;
    try { OptimizedMedia.Generate(oddSrc, Path.Combine(Folder, "odd.optimized.mov"), "dnxhr_hq", CancellationToken.None); } catch (Exception ex) { threw = ex.Message.Contains("偶数"); }
    Require(threw, "optimized media rejects odd dimensions");
    threw = false;
    try { var bad = DocFor(smallSrc); bad.OptimizedEnabled = true; bad.OptimizedPath = Path.Combine(Folder, "missing.optimized.mov"); OptimizedMedia.Validate(bad); } catch (Exception ex) { threw = ex.Message.Contains("优化媒体"); }
    Require(threw, "optimized media missing file is a hard error");
    Mark("STEP 12 optimized media OK (dnxhd 320x180 2.0s, odd rejected)");
    // 13. 观察文件夹。
    string watchDir = Path.Combine(Folder, "watch");
    Directory.CreateDirectory(watchDir);
    File.Copy(src2s, Path.Combine(watchDir, "src2s.mp4"), true);
    File.Copy(src2s, Path.Combine(watchDir, "new.mp4"), true);
    File.WriteAllText(Path.Combine(watchDir, "notes.txt"), "not media");
    var found = WatchFolder.Scan(watchDir, new List<string> { src2s });
    Require(found.Count == 1 && found[0].EndsWith("new.mp4"), "watch folder lists only the new media file (got " + found.Count + ")");
    Require(WatchFolder.Scan(Path.Combine(Folder, "no-such-dir"), null).Count == 0, "watch folder with a missing dir returns empty");
    Mark("STEP 13 watch folder OK");
    // 14. 导入收录：复制 + 两种转码。
    string projDir = Path.Combine(Folder, "proj");
    Directory.CreateDirectory(projDir);
    var ingCopy = Ingest.IngestFile(src2s, projDir, "none", CancellationToken.None);
    Require(File.Exists(ingCopy.File) && ingCopy.File.Contains("media") && ingCopy.Transcoded == null, "ingest copy lands in the project media folder");
    var ingOpt = Ingest.IngestFile(src2s, projDir, "dnxhr", CancellationToken.None);
    Require(ingOpt.Transcoded != null && CodecOf(ingOpt.Transcoded) == "dnxhd", "ingest transcode to DNxHR works");
    var ingProxy = Ingest.IngestFile(src2s, projDir, "proxy", CancellationToken.None);
    Require(ingProxy.Transcoded != null && File.Exists(ingProxy.Transcoded), "ingest transcode to proxy works");
    threw = false;
    try { Ingest.IngestFile(Path.Combine(Folder, "nope.mp4"), projDir, "none", CancellationToken.None); } catch { threw = true; }
    Require(threw, "ingest with a missing source is rejected");
    Mark("STEP 14 ingest OK (copy + dnxhr + proxy)");
    // 15. 导出接线：防抖 / 跟踪 / 优化媒体硬错 / 放大诚实报错。
    var edoc = DocFor(src2s);
    edoc.StabilizeEnabled = true;
    edoc.StabilizeMethod = "deshake";
    string deshExport = Path.Combine(Folder, "export-desh.mp4");
    StudioRenderer.Export(edoc, deshExport, 360, 30, (v, s) => { }, CancellationToken.None);
    Require(Math.Abs(StudioMedia.Import(deshExport).Duration - 2) < .15, "export with deshake is 2.0s");
    if (hasVidstab) {
     var vedoc = DocFor(src2s);
     vedoc.StabilizeEnabled = true;
     vedoc.StabilizeMethod = "vidstab";
     string vExport = Path.Combine(Folder, "export-vidstab.mp4");
     StudioRenderer.Export(vedoc, vExport, 360, 30, (v, s) => { }, CancellationToken.None);
     Require(Math.Abs(StudioMedia.Import(vExport).Duration - 2) < .15, "export with vidstab is 2.0s");
    }
    var trackExportDoc = DocFor(moveSrc);
    trackExportDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 } };
    trackExportDoc.ObjectTrackEnabled = true;
    trackExportDoc.ObjectTrackMethod = "color";
    trackExportDoc.ObjectTrackColor = "#FFFFFF";
    trackExportDoc.ObjectTrackMosaic = 0.2;
    string trackExport = Path.Combine(Folder, "export-track.mp4");
    StudioRenderer.Export(trackExportDoc, trackExport, 360, 30, (v, s) => { }, CancellationToken.None);
    Require(Math.Abs(StudioMedia.Import(trackExport).Duration - 2) < .15, "export with object-track mosaic is 2.0s");
    threw = false;
    try {
     var bad = DocFor(smallSrc);
     bad.OptimizedEnabled = true;
     bad.OptimizedPath = Path.Combine(Folder, "missing.optimized.mov");
     StudioRenderer.Export(bad, Path.Combine(Folder, "export-bad-opt.mp4"), 360, 30, (v, s) => { }, CancellationToken.None);
    } catch (Exception ex) { threw = ex.Message.Contains("优化媒体"); }
    Require(threw, "export with missing optimized media is a hard error, not a silent fallback");
    var goodOptDoc = DocFor(smallSrc);
    goodOptDoc.OptimizedEnabled = true;
    goodOptDoc.OptimizedPath = optOut;
    string goodOptExport = Path.Combine(Folder, "export-good-opt.mp4");
    StudioRenderer.Export(goodOptDoc, goodOptExport, 360, 30, (v, s) => { }, CancellationToken.None);
    Require(Math.Abs(StudioMedia.Import(goodOptExport).Duration - 2) < .15, "export with valid optimized media still uses the original (2.0s)");
    string upscaleExportNote = "skipped (model present)";
    if (upscaleProblem != null) {
     threw = false;
     try {
      var bad = DocFor(src2s);
      bad.UpscaleEnabled = true;
      bad.UpscaleModel = "realesrgan-x4plus";
      StudioRenderer.Export(bad, Path.Combine(Folder, "export-upscale.mp4"), 360, 30, (v, s) => { }, CancellationToken.None);
     } catch (Exception ex) { threw = ex.Message.Contains("AI 放大"); }
     Require(threw, "export with upscale enabled but no model fails honestly");
     upscaleExportNote = "missing model fails honestly at export";
    }
    string portraitBackend = BeautyMask.CheckBackend();
    string portraitNote = portraitBackend == null ? "ONNX backend present, live portrait export skipped (slow)" : "backend missing, honest report: " + portraitBackend;
    Mark("STEP 15 export wiring OK (deshake/vidstab/track exports 2.0s; optimized hard error; upscale " + upscaleExportNote + "; portrait " + portraitNote + ")");
    File.WriteAllText(log, "PASS: stabilize deshake rx=16:ry=16:edge=3 + vidstab smoothing=15/optalgo=0, validation rejects smoothing 1001 + method foo, " + vidstabNote + ", deshake keeps 2.0s; portrait color/blur/image/original/outline graphs + composite corner (" + corner[0] + "," + corner[1] + "," + corner[2] + ") + center PSNR " + centerPsnr.ToString("0.0") + " + outline export 2.0s; outline colors parse, width 0/11 rejected, dilation 3600 -> " + dil1 + " -> " + dil3 + "; templates 4 built-in, warm/cool apply, 10/10 bad rejected; scene detect [" + cuts[0].ToString("0.00") + ", " + cuts[1].ToString("0.00") + "], 3 segments, 3 cuts in timeline; object track color 0.06 -> " + track[track.Count - 1].X.ToString("0.00") + " (20 pts, 0 lost), template last " + texTrack[texTrack.Count - 1].X.ToString("0.00") + ", mosaic region PSNR " + mosPsnr.ToString("0.0") + ", sticker export 4.0s; clone validation rejects 3 lanes/bad offsets/4-lane horizontal, 2-lane 640x360 2.0s, 4-lane grid 640x360 1.0s; upscale " + (upscaleProblem ?? "available") + "; script film 6.0s + .srt sidecar, 4 validation rejects; metadata round-trip + ALE timecode 00:01:05:15; archive 2 files + relative paths, relink by basename + duration, unmatched reported; DNxHR dnxhd 320x180 2.0s, odd rejected, missing optimized is a hard error; watch folder finds only new media; ingest copy + dnxhr + proxy; exports: deshake 2.0s, track mosaic 2.0s, optimized missing hard error, optimized valid exports from original, upscale " + upscaleExportNote + ", portrait: " + portraitNote + ".\n");
   }
   catch (Exception ex) { File.AppendAllText(log, "FAIL\n" + ex + "\n"); Mark("FAIL: " + ex.Message); Environment.ExitCode = 1; }
  }
 }
}
