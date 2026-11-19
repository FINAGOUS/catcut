// W8 自测（2026-11-18）：--w8colour-test 入口，无窗口，纯逻辑 + 合成素材实测。
// 跑在云端构建里（build-test.yml 的 W8 colour checks 步），结果写
// Windows/bin/w8colour-results.txt（PASS: 开头才算过）。本地 Linux 跑不了
// WPF，但这些测试不碰窗口，只碰模型/滤镜串/ffmpeg/真实导出与解码器图，
// 所以云端是唯一可信的验证。断言值全部来自引擎探针实测或本地 ffmpeg
// 探针（见 W8ColourPanels.cs 头注释的出处）：
// 节点串联提亮+去饱和与逐节点手算一致、并联 multiply 手算 (0.5,0.1,0.1)
// 量级、暗红 + 阴影色相+120° 变绿；S-Log3 锚点 18% 灰 420/1023、90% 白
// 598/1023；直方图匹配目标 (100,30,30)→参考 (199,48,49) 每通道差 0
// （阈值 8）；色度键 similarity 默认 0.1（0.01 完全不抠）；示波器纯红
// 亮度 54.2、色相 0°、饱和度 1.000。
// 云端 runner 无真 GPU：节点编辑器、LUT 库悬停、对比帧按钮、取色器点击、
// 示波器跟随播放只在真机上能验，测试只验模型、滤镜串与真实导出/解码。
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
 static class W8Tests {
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
  static void SolidPng(string path, string hex, int w, int h) {
   RunFfmpeg("-v error -y -f lavfi -i color=c=" + hex + ":s=" + w + "x" + h + ":d=0.2 -frames:v 1 " + Media.Q(path));
  }
  static int[] PngPixel(string path, int x, int y) {
   using (var bmp = new D.Bitmap(path)) {
    var c = bmp.GetPixel(x, y);
    return new[] { (int)c.R, (int)c.G, (int)c.B };
   }
  }
  static byte[] RunRaw(string args) {
   using (var p = Media.Start("ffmpeg", args, true)) {
    var err = p.StandardError.ReadToEndAsync();
    using (var ms = new MemoryStream()) {
     p.StandardOutput.BaseStream.CopyTo(ms); p.WaitForExit();
     if (p.ExitCode != 0) throw new Exception("ffmpeg 失败：" + err.Result);
     return ms.ToArray();
    }
   }
  }
  static ColorGrade TempGrade(double t) { return new ColorGrade { Temperature = t }; }
  public static void Run() {
   Folder = Path.Combine(Media.Root, "bin", "w8-test");
   Directory.CreateDirectory(Folder);
   string log = Path.Combine(Media.Root, "bin", "w8colour-results.txt");
   LogPath = log;
   File.WriteAllText(log, "RUNNING\n");
   try {
    // 1. 节点图：串联/并联/拓扑顺序/蒙版规则/校验。
    var wheelNode = new GradeNode { Id = "n1", Adjust = new ColorGrade() };
    wheelNode.Adjust.WheelHue[0] = 120;
    var g1 = new GradeNodeGraph { Nodes = new List<GradeNode> { wheelNode }, Output = "n1" };
    var baked1 = GradeNodeGraphOps.Bake(g1);
    var s1 = GradeNodeGraphOps.Sample(baked1.Final, 0.5, 0, 0);
    Require(Near(s1[0], .055, .02) && Near(s1[1], .5, .02) && Near(s1[2], 0, .02), "single node dark red + shadow hue +120 turns green (got " + s1[0].ToString("0.00") + "," + s1[1].ToString("0.00") + "," + s1[2].ToString("0.00") + ")");
    var ident = GradeNodeGraphOps.Bake(new GradeNodeGraph { Nodes = new List<GradeNode> { new GradeNode { Id = "a", Adjust = new ColorGrade() } }, Output = "a" });
    var si = GradeNodeGraphOps.Sample(ident.Final, 0.5, 0.5, 0.5);
    Require(Near(si[0], .5, .001) && Near(si[1], .5, .001) && Near(si[2], .5, .001), "identity node graph is identity");
    // 并联 multiply：n1 色温+1、n2 恒等，输出节点以 multiply 折叠两者。
    // LUT 值相乘：(0.625,0.5,0.375) * (0.5,0.5,0.5) = (0.3125,0.25,0.1875)。
    var n1 = new GradeNode { Id = "n1", Adjust = TempGrade(1) };
    var n2 = new GradeNode { Id = "n2", Adjust = new ColorGrade() };
    var n3 = new GradeNode { Id = "out", Adjust = new ColorGrade(), Inputs = new List<string> { "n1", "n2" }, Blend = "multiply" };
    var gPar = new GradeNodeGraph { Nodes = new List<GradeNode> { n1, n2, n3 }, Output = "out" };
    var sp = GradeNodeGraphOps.Sample(GradeNodeGraphOps.Bake(gPar).Final, 0.5, 0.5, 0.5);
    Require(Near(sp[0], .3125, .02) && Near(sp[1], .25, .02) && Near(sp[2], .1875, .02), "parallel multiply blends LUT values (got " + sp[0].ToString("0.00") + "," + sp[1].ToString("0.00") + "," + sp[2].ToString("0.00") + ")");
    // 串联 + 乱序列出：n2（色轮）依赖 n1（色温），列出顺序反过来也一样。
    var sA = new GradeNode { Id = "n1", Adjust = TempGrade(1) };
    var sB = new GradeNode { Id = "n2", Adjust = new ColorGrade(), Inputs = new List<string> { "n1" } };
    sB.Adjust.WheelHue[0] = 120;
    var gSer = new GradeNodeGraph { Nodes = new List<GradeNode> { sB, sA }, Output = "n2" };
    var ss = GradeNodeGraphOps.Sample(GradeNodeGraphOps.Bake(gSer).Final, 0.5, 0, 0);
    Require(ss[1] > 0.5 && ss[0] > 0.2 && ss[0] < 0.4 && ss[2] < 0.05, "serial temp+wheel out-of-order still bakes (got " + ss[0].ToString("0.00") + "," + ss[1].ToString("0.00") + "," + ss[2].ToString("0.00") + ")");
    // 蒙版节点：主烤读恒等，单独一份烤出调色；蒙版 PNG 中心白、角落黑。
    var mNode = new GradeNode { Id = "m1", Adjust = TempGrade(1), Mask = new GradeNodeMask { Shape = "ellipse", X = 0.5, Y = 0.5, W = 0.4, H = 0.4, Feather = 0.02 } };
    var mOut = new GradeNode { Id = "out", Adjust = new ColorGrade(), Inputs = new List<string> { "m1" } };
    var gMask = new GradeNodeGraph { Nodes = new List<GradeNode> { mNode, mOut }, Output = "out" };
    var bakedM = GradeNodeGraphOps.Bake(gMask);
    Require(bakedM.Masked.Count == 1 && bakedM.Masked[0].Id == "m1", "masked node bakes a separate stage");
    var sm = GradeNodeGraphOps.Sample(bakedM.Final, 0.5, 0.5, 0.5);
    Require(Near(sm[0], .5, .001) && Near(sm[1], .5, .001), "masked node reads as identity in the main bake");
    var sm2 = GradeNodeGraphOps.Sample(bakedM.Masked[0].Grid, 0.5, 0.5, 0.5);
    Require(Near(sm2[0], .625, .02) && Near(sm2[2], .375, .02), "masked stage LUT carries the grade (got " + sm2[0].ToString("0.00") + "," + sm2[1].ToString("0.00") + "," + sm2[2].ToString("0.00") + ")");
    string maskPng = Path.Combine(Folder, "node-mask.png");
    File.WriteAllBytes(maskPng, GradeNodeMaskOps.RenderPng(mNode.Mask, 160, 90));
    var mc = PngPixel(maskPng, 80, 45);
    var mk = PngPixel(maskPng, 0, 0);
    Require(mc[0] == 255 && mk[0] == 0, "mask PNG centre white, corner black (got " + mc[0] + "/" + mk[0] + ")");
    bool threw = false;
    try { GradeNodeGraphOps.Bake(new GradeNodeGraph { Nodes = new List<GradeNode> { new GradeNode { Id = "a", Inputs = new List<string> { "b" } }, new GradeNode { Id = "b", Inputs = new List<string> { "a" } } }, Output = "a" }); } catch { threw = true; }
    Require(threw, "cyclic node graph is rejected");
    threw = false;
    try { GradeNodeGraphOps.Bake(new GradeNodeGraph { Nodes = new List<GradeNode> { new GradeNode { Id = "a" }, new GradeNode { Id = "a" } }, Output = "a" }); } catch { threw = true; }
    Require(threw, "duplicate node id is rejected");
    threw = false;
    try {
     var bad = new GradeNode { Id = "m1", Adjust = new ColorGrade(), Mask = new GradeNodeMask(), Inputs = new List<string> { "m2" } };
     var bad2 = new GradeNode { Id = "m2", Adjust = new ColorGrade(), Mask = new GradeNodeMask() };
     GradeNodeGraphOps.Bake(new GradeNodeGraph { Nodes = new List<GradeNode> { bad, bad2, new GradeNode { Id = "out", Inputs = new List<string> { "m1" } } }, Output = "out" });
    } catch { threw = true; }
    Require(threw, "masked node reading another masked node is rejected");
    threw = false;
    try {
     var dangling = new GradeNode { Id = "m1", Adjust = new ColorGrade(), Mask = new GradeNodeMask() };
     GradeNodeGraphOps.Bake(new GradeNodeGraph { Nodes = new List<GradeNode> { dangling, new GradeNode { Id = "out", Inputs = new List<string> { "input" } } }, Output = "out" });
    } catch { threw = true; }
    Require(threw, "masked node not feeding the output directly is rejected");
    threw = false;
    try { GradeNodeGraphOps.Bake(new GradeNodeGraph { Nodes = new List<GradeNode> { new GradeNode { Id = "a", Adjust = new ColorGrade { Brightness = 0.5 } } }, Output = "a" }); } catch { threw = true; }
    Require(threw, "brightness inside a node is rejected (LUT params only)");
    threw = false;
    try { GradeNodeGraphOps.Bake(new GradeNodeGraph { Nodes = new List<GradeNode> { new GradeNode { Id = "a", Blend = "weird" } }, Output = "a" }); } catch { threw = true; }
    Require(threw, "unknown blend mode is rejected");
    Mark("STEP 1 node graph OK");
    // 2. 色彩管理：S-Log3 锚点 + 传输 LUT + zscale 串 + 非法空间。
    Require(Near(ColourMgmt.Slog3Decode(420.0 / 1023), 0.18, 0.005), "slog3 18% grey anchor decodes to 0.18 (got " + ColourMgmt.Slog3Decode(420.0 / 1023).ToString("0.000") + ")");
    Require(Near(ColourMgmt.Slog3Decode(598.0 / 1023), 0.90, 0.01), "slog3 90% white anchor decodes to 0.90 (got " + ColourMgmt.Slog3Decode(598.0 / 1023).ToString("0.000") + ")");
    Require(Near(ColourMgmt.Rec709Oetf(0.18), 0.409, 0.002), "rec709 OETF(0.18) is 0.409");
    var xfer = ColourMgmt.BuildTransferLut("slog3", "rec709");
    var sx = GradeNodeGraphOps.Sample(xfer, 0.4375, 0.4375, 0.4375);
    Require(Near(sx[0], 0.47, 0.02), "slog3->rec709 transfer LUT at 0.4375 is ~0.47 (got " + sx[0].ToString("0.00") + ")");
    var xfer2 = ColourMgmt.BuildTransferLut("rec709", "srgb");
    var sx2 = GradeNodeGraphOps.Sample(xfer2, 0.5, 0.5, 0.5);
    Require(sx2[0] > 0.5 && sx2[0] < 0.6, "rec709->srgb transfer LUT lifts mid grey (got " + sx2[0].ToString("0.00") + ")");
    var cLog = ColourMgmt.InputConversionFor("log100", "rec709");
    Require(cLog.Filter != null && cLog.Filter.Contains("setparams") && cLog.Filter.Contains("log100") && cLog.Filter.Contains("zscale"), "log100 goes through setparams+zscale");
    var cHlg = ColourMgmt.InputConversionFor("hlg", "rec709");
    Require(cHlg.Filter != null && cHlg.Filter.Contains("arib-std-b67"), "hlg is tagged arib-std-b67 before zscale");
    var cPq = ColourMgmt.InputConversionFor("pq", "rec709");
    Require(cPq.Filter != null && cPq.Filter.Contains("tonemap=hable"), "pq goes through Hable tonemap");
    var cSrgb = ColourMgmt.InputConversionFor("rec709", "srgb");
    Require(cSrgb.HasLut && cSrgb.LutFrom == "rec709" && cSrgb.LutTo == "srgb", "rec709->srgb working space is a LUT conversion");
    threw = false;
    try { ColourMgmt.InputConversionFor("foobar", "rec709"); } catch { threw = true; }
    Require(threw, "unknown input space is rejected");
    threw = false;
    try { ColourMgmt.ValidateSpaces("rec709", "aces", "rec709"); } catch { threw = true; }
    Require(threw, "unknown working space is rejected");
    Mark("STEP 2 colour management OK");
    // 3. 镜头匹配：固色目标 (100,30,30) → 参考 (199,48,49)，数值 + 真实 lut3d。
    string refPng = Path.Combine(Folder, "match-ref.png");
    string tgtPng = Path.Combine(Folder, "match-tgt.png");
    SolidPng(refPng, "0xC73031", 160, 90);
    SolidPng(tgtPng, "0x641E1E", 160, 90);
    var refPx = ColourMatchOps.DecodeFrameRgb24(refPng, 0, 160, 90, CancellationToken.None);
    var tgtPx = ColourMatchOps.DecodeFrameRgb24(tgtPng, 0, 160, 90, CancellationToken.None);
    var matchGrid = ColourMatchOps.BuildMatchGrid(refPx, tgtPx, 1);
    var mg = GradeNodeGraphOps.Sample(matchGrid, 100.0 / 255, 30.0 / 255, 30.0 / 255);
    Require(Near(mg[0], 199.0 / 255, 8.0 / 255) && Near(mg[1], 48.0 / 255, 8.0 / 255) && Near(mg[2], 49.0 / 255, 8.0 / 255), "match LUT maps (100,30,30) to ~(199,48,49) (got " + (mg[0] * 255).ToString("0") + "," + (mg[1] * 255).ToString("0") + "," + (mg[2] * 255).ToString("0") + ")");
    var matchId = ColourMatchOps.BuildMatchGrid(refPx, tgtPx, 0);
    var mi = GradeNodeGraphOps.Sample(matchId, 100.0 / 255, 30.0 / 255, 30.0 / 255);
    Require(Near(mi[0], 100.0 / 255, 0.02) && Near(mi[1], 30.0 / 255, 0.02), "match strength 0 is identity");
    string matchCube = Path.Combine(Folder, "match.cube");
    File.WriteAllText(matchCube, LutCube.GridToText(matchGrid, 17, "CatCut test match"), new UTF8Encoding(false));
    string matchOut = Path.Combine(Folder, "match-out.png");
    RunFfmpeg("-v error -y -i " + Media.Q(tgtPng) + " -vf " + Media.Q(ColorLut.Lut3dFilter(matchCube)) + " -frames:v 1 " + Media.Q(matchOut));
    var mp = PngPixel(matchOut, 80, 45);
    Require(Math.Abs(mp[0] - 199) <= 8 && Math.Abs(mp[1] - 48) <= 8 && Math.Abs(mp[2] - 49) <= 8, "real lut3d render maps target to reference (got " + mp[0] + "," + mp[1] + "," + mp[2] + ")");
    Mark("STEP 3 colour match OK");
    // 4. 跟踪窗口：插值/丢帧停留/遮罩缓冲/遮罩视频时长。
    var tw = new TrackedWindow {
     Shape = "ellipse", W = 0.3, H = 0.3, Adjust = TempGrade(1),
     Track = new List<ColourTrackPoint> { new ColourTrackPoint { Time = 0, X = 0.25, Y = 0.5 }, new ColourTrackPoint { Time = 2, X = 0.75, Y = 0.5 } },
     SampleFps = 5
    };
    var c0 = TrackedWindowOps.CenterAt(tw.Track, 0);
    var c1 = TrackedWindowOps.CenterAt(tw.Track, 1);
    var c2 = TrackedWindowOps.CenterAt(tw.Track, 3);
    Require(Near(c0.X, 0.25, .001) && Near(c1.X, 0.5, .001) && Near(c2.X, 0.75, .001), "track centre interpolates 0.25 -> 0.5 -> 0.75");
    var lostTrack = new List<ColourTrackPoint> { new ColourTrackPoint { Time = 0, X = 0.25, Y = 0.5 }, new ColourTrackPoint { Time = 1, X = 0.9, Y = 0.5, Lost = true } };
    var cl = TrackedWindowOps.CenterAt(lostTrack, 1);
    Require(Near(cl.X, 0.25, .001), "lost track point parks at the last known position");
    var buf = TrackedWindowOps.BuildMaskBuffer(tw, 320, 180, 2);
    Require(buf[5 * 320 * 180 + 90 * 320 + 160] == 255 && buf[5 * 320 * 180 + 0] == 0, "mask buffer at t=1: centre white, corner black");
    Require(buf[0 * 320 * 180 + 90 * 320 + 80] == 255 && buf[0 * 320 * 180 + 90 * 320 + 240] == 0, "mask buffer at t=0: window sits at x=0.25");
    string maskVideo = Path.Combine(Folder, "trackwin-mask.mp4");
    TrackedWindowOps.EncodeMaskVideo(buf, 320, 180, 5, maskVideo, CancellationToken.None);
    Require(Math.Abs(ProbeDuration(maskVideo) - 2) < 0.2, "tracked mask video is 2.0s (got " + ProbeDuration(maskVideo).ToString("0.00") + ")");
    threw = false;
    try { TrackedWindowOps.Validate(new TrackedWindow { Track = new List<ColourTrackPoint>() }); } catch { threw = true; }
    Require(threw, "tracked window without points is rejected");
    Mark("STEP 4 tracked window OK");
    // 5. LUT 库：分类/收藏/搜索/重复/缺失/坏文件/缩略图。
    string libDir = Path.Combine(Folder, "lutlib");
    var identCube = Path.Combine(Folder, "lib-ident.cube");
    File.WriteAllText(identCube, LutCube.GridToText(GradeNodeGraphOps.IdentityGrid(), 17, "identity"), new UTF8Encoding(false));
    var warmCube = Path.Combine(Folder, "lib-warm.cube");
    File.WriteAllText(warmCube, ColorLut.BuildCube(TempGrade(0.5)), new UTF8Encoding(false));
    var lib = new List<LutLibraryEntry>();
    lib = LutLibrary.Add(lib, new LutLibraryEntry { Id = "warm", Name = "暖调", Category = "film", File = warmCube, Tags = new List<string> { "暖" } });
    lib = LutLibrary.Add(lib, new LutLibraryEntry { Id = "plain", Name = "原片", Category = "bw", File = identCube });
    LutLibrary.Save(lib, libDir);
    var loaded = LutLibrary.Load(libDir);
    Require(loaded.Count == 2 && LutLibrary.Filter(loaded, "film", null, null).Count == 1, "library filters by category (film -> 1)");
    Require(LutLibrary.Filter(loaded, null, null, "暖").Count == 1, "library searches by name/tag");
    Require(LutLibrary.LibraryCategories(loaded).Count == 2, "library lists 2 categories");
    var fav = LutLibrary.ToggleFavorite(loaded, "warm");
    Require(fav.First(e => e.Id == "warm").Favorite && LutLibrary.Filter(fav, null, true, null).Count == 1, "favourite toggle works");
    threw = false;
    try { LutLibrary.Add(loaded, new LutLibraryEntry { Id = "warm", Name = "又一个暖", Category = "film", File = warmCube }); } catch { threw = true; }
    Require(threw, "duplicate library id is rejected");
    threw = false;
    try { LutLibrary.Add(loaded, new LutLibraryEntry { Id = "gone", Name = "没了", Category = "film", File = Path.Combine(Folder, "nope.cube") }); } catch { threw = true; }
    Require(threw, "library entry with a missing file is rejected");
    string badCube = Path.Combine(Folder, "bad.cube");
    File.WriteAllText(badCube, "LUT_3D_SIZE 17\n0 0\n", new UTF8Encoding(false));
    threw = false;
    try { LutLibrary.Add(loaded, new LutLibraryEntry { Id = "bad", Name = "坏的", Category = "film", File = badCube }); } catch { threw = true; }
    Require(threw, "broken .cube is rejected at library time");
    string thumbSrc = Path.Combine(Folder, "thumb-src.mp4");
    SolidVideo(thumbSrc, "0x808080", 320, 180, 1);
    string thumbDir = Path.Combine(Folder, "thumbs");
    string thumb = LutLibrary.Thumbnail(warmCube, thumbSrc, 0, thumbDir);
    var ts = CompareOps.ProbeSize(thumb);
    Require(ts[0] == 160 && ts[1] == 90, "LUT thumbnail is 160x90 (got " + ts[0] + "x" + ts[1] + ")");
    Mark("STEP 5 LUT library OK");
    // 6. 前后对比 + 参考帧：分屏/擦除像素 + still 存取/篡改拒绝/列表。
    string greySrc = Path.Combine(Folder, "grey-src.mp4");
    SolidVideo(greySrc, "0x808080", 320, 180, 1);
    string tempCube = Path.Combine(Folder, "temp.cube");
    File.WriteAllText(tempCube, ColorLut.BuildCube(TempGrade(1)), new UTF8Encoding(false));
    string cmpPng = Path.Combine(Folder, "compare.png");
    CompareOps.RenderComparisonFrame(greySrc, tempCube, cmpPng, "split", 0.5, 0, 320, 180, CancellationToken.None);
    var left = PngPixel(cmpPng, 40, 90);
    var right = PngPixel(cmpPng, 280, 90);
    Require(Math.Abs(left[0] - 128) <= 6 && Math.Abs(left[1] - 128) <= 6, "split left is the original grey (got " + left[0] + "," + left[1] + "," + left[2] + ")");
    Require(Math.Abs(right[0] - 160) <= 8 && Math.Abs(right[2] - 96) <= 8, "split right is temp+1 graded (got " + right[0] + "," + right[1] + "," + right[2] + ")");
    string wipePng = Path.Combine(Folder, "wipe.png");
    CompareOps.RenderComparisonFrame(greySrc, tempCube, wipePng, "wipe", 0.25, 0, 320, 180, CancellationToken.None);
    var wLeft = PngPixel(wipePng, 40, 90);
    var wRight = PngPixel(wipePng, 160, 90);
    Require(Math.Abs(wLeft[0] - 128) <= 6 && Math.Abs(wRight[0] - 160) <= 8, "wipe 0.25: left original, right graded");
    threw = false;
    try { CompareOps.RenderComparisonFrame(greySrc, tempCube, Path.Combine(Folder, "bad.png"), "wipe", 1.5, 0, 320, 180, CancellationToken.None); } catch { threw = true; }
    Require(threw, "wipe outside (0, 1) is rejected");
    string stillsDir = Path.Combine(Folder, "stills");
    Directory.CreateDirectory(stillsDir);
    string stillPng = Path.Combine(stillsDir, "still-0.png");
    var still = CompareOps.SaveReferenceStill(greySrc, 0, stillPng, "开场", "测试", CancellationToken.None);
    Require(still.Width == 320 && still.Height == 180 && still.Label == "开场" && File.Exists(stillPng + ".json"), "reference still saves PNG + sidecar");
    var back = CompareOps.LoadReferenceStill(stillPng);
    Require(back.Label == "开场" && back.Source == still.Source && back.Width == 320, "reference still round-trips");
    Require(CompareOps.ListReferenceStills(stillsDir).Count == 1, "stills list finds 1");
    File.WriteAllText(stillPng + ".json", File.ReadAllText(stillPng + ".json", new UTF8Encoding(false)).Replace("\"Width\":320", "\"Width\":321"), new UTF8Encoding(false));
    threw = false;
    try { CompareOps.LoadReferenceStill(stillPng); } catch { threw = true; }
    Require(threw, "tampered still sidecar is rejected");
    Mark("STEP 6 compare + reference stills OK");
    // 7. 色度键：滤镜串/去绿边类型/校验/帧上取色。
    var ck = new ChromaKey { Color = "0x00ff00", Similarity = 0.1, Blend = 0, Despill = true };
    string ckf = ChromaKeyOps.FilterFragment(ck);
    Require(ckf.Contains("chromakey=color=0x00ff00:similarity=0.1:blend=0") && ckf.Contains("despill=type=green"), "chroma filter is chromakey 0.1 + despill green (" + ckf + ")");
    Require(ChromaKeyOps.DespillType("0x0000ff") == "blue" && ChromaKeyOps.DespillType("0x00ff00") == "green", "despill type follows the key colour");
    threw = false;
    try { ChromaKeyOps.Validate(new ChromaKey { Similarity = 0 }); } catch { threw = true; }
    Require(threw, "chroma similarity 0 is rejected");
    threw = false;
    try { ChromaKeyOps.Validate(new ChromaKey { Similarity = 1.5 }); } catch { threw = true; }
    Require(threw, "chroma similarity 1.5 is rejected");
    threw = false;
    try { ChromaKeyOps.Validate(new ChromaKey { BackgroundColor = "0x000000", BackgroundSource = "x.mp4" }); } catch { threw = true; }
    Require(threw, "chroma background colour + source together is rejected");
    string greenSrc = Path.Combine(Folder, "green-src.mp4");
    SolidVideo(greenSrc, "0x00ff00", 320, 180, 1);
    string picked = ChromaKeyOps.SamplePixel(greenSrc, 0, 0.5, 0.5, CancellationToken.None);
    var prgb = ChromaKeyOps.ParseColor(picked, "取色");
    Require(prgb[1] > 200 && prgb[0] < 10 && prgb[2] < 10, "pixel pick on a green frame returns green (got " + picked + ")");
    Mark("STEP 7 chroma key OK");
    // 8. 示波器：合成缓冲 + 真实帧 + 自绘图。
    var redBuf = new byte[16 * 16 * 3];
    for (int i = 0; i < 16 * 16; i++) { redBuf[i * 3] = 255; redBuf[i * 3 + 1] = 0; redBuf[i * 3 + 2] = 0; }
    var redScope = ScopeAnalysis.AnalyzeRgbFrame(redBuf, 16, 16, "red", 0);
    Require(Near(redScope.LumaMean, 54.2, 1.0) && redScope.DominantHue.HasValue && Near(redScope.DominantHue.Value, 0, 1) && Near(redScope.SaturationMean, 1, 0.01), "pure red: luma 54.2, hue 0, sat 1.0 (got " + redScope.LumaMean.ToString("0.0") + "/" + (redScope.DominantHue.HasValue ? redScope.DominantHue.Value.ToString("0") : "null") + "/" + redScope.SaturationMean.ToString("0.00") + ")");
    Require(redScope.R.PeakBin == 255 && redScope.R.P99 == 255 && redScope.G.PeakBin == 0, "pure red: R peak 255, G peak 0");
    var greyBuf = new byte[16 * 16 * 3];
    for (int i = 0; i < 16 * 16; i++) { greyBuf[i * 3] = 128; greyBuf[i * 3 + 1] = 128; greyBuf[i * 3 + 2] = 128; }
    var greyScope = ScopeAnalysis.AnalyzeRgbFrame(greyBuf, 16, 16, "grey", 0);
    Require(!greyScope.DominantHue.HasValue && Near(greyScope.SaturationMean, 0, 0.001), "grey frame has no dominant hue");
    var whiteBuf = new byte[16 * 16 * 3];
    for (int i = 0; i < whiteBuf.Length; i++) whiteBuf[i] = 255;
    Require(Near(ScopeAnalysis.AnalyzeRgbFrame(whiteBuf, 16, 16, "white", 0).HighlightClip, 1, 0.001), "white frame clips highlight 1.0");
    var blackBuf = new byte[16 * 16 * 3];
    Require(Near(ScopeAnalysis.AnalyzeRgbFrame(blackBuf, 16, 16, "black", 0).ShadowClip, 1, 0.001), "black frame clips shadow 1.0");
    var halfBuf = new byte[16 * 16 * 3];
    for (int i = 0; i < 16 * 16; i++) {
     bool leftHalf = (i % 16) < 8;
     halfBuf[i * 3] = (byte)(leftHalf ? 255 : 0); halfBuf[i * 3 + 1] = 0; halfBuf[i * 3 + 2] = (byte)(leftHalf ? 0 : 255);
    }
    var halfScope = ScopeAnalysis.AnalyzeRgbFrame(halfBuf, 16, 16, "half", 0);
    Require(halfScope.HueHistogram[0] == 128 && halfScope.HueHistogram[8] == 128, "red/blue halves give two hue peaks of 128 each");
    string redSrc = Path.Combine(Folder, "red-src.mp4");
    SolidVideo(redSrc, "0xff0000", 320, 180, 1);
    var realScope = ScopeAnalysis.SampleFrame(redSrc, 0, 160, 90, CancellationToken.None);
    Require(Near(realScope.LumaMean, 54.2, 2.0) && realScope.DominantHue.HasValue && Near(realScope.DominantHue.Value, 0, 2), "real red frame analyses the same (luma " + realScope.LumaMean.ToString("0.0") + ", hue " + (realScope.DominantHue.HasValue ? realScope.DominantHue.Value.ToString("0") : "null") + ")");
    var realScope2 = ScopeAnalysis.SampleFrame(redSrc, 0, 160, 90, CancellationToken.None);
    Require(Near(realScope2.LumaMean, realScope.LumaMean, 0.001), "scope sampling is deterministic");
    var wavePng = ScopeAnalysis.DrawScopePng(ColourMatchOps.DecodeFrameRgb24(redSrc, 0, 160, 90, CancellationToken.None), 160, 90, "waveform", 320, 180);
    var vecPng = ScopeAnalysis.DrawScopePng(ColourMatchOps.DecodeFrameRgb24(redSrc, 0, 160, 90, CancellationToken.None), 160, 90, "vectorscope", 320, 180);
    Require(wavePng.Length > 100 && wavePng[0] == 0x89 && wavePng[1] == 0x50 && vecPng.Length > 100 && vecPng[0] == 0x89, "scope images are real PNGs (waveform " + wavePng.Length + " bytes, vectorscope " + vecPng.Length + " bytes)");
    Mark("STEP 8 scopes OK");
    // 9. 调色链组装 + 校验组合。
    string chainSrc = Path.Combine(Folder, "chain-src.mp4");
    SolidVideo(chainSrc, "0x808080", 320, 180, 2);
    var cdoc = StudioMedia.Import(chainSrc);
    string plainChain = W8ColourFilters.Chain(cdoc, false);
    Require(plainChain == cdoc.Grade.VideoFilter(), "no W8 features means the chain is exactly Grade.VideoFilter()");
    cdoc.InputSpace = "slog3";
    cdoc.Match = new ColourMatch { ReferenceFrame = refPng, Strength = 1 };
    cdoc.Grade.Temperature = 0.5;
    cdoc.Grade.WheelHue[0] = 30; // 触发 NeedsLut：温度单独只走 colorbalance，不进 LUT；色轮偏移才让线性调色烤出第 3 张 LUT。
    string fullChain = W8ColourFilters.Chain(cdoc, false);
    int lutCount = 0, at = 0;
    while ((at = fullChain.IndexOf("lut3d=", at, StringComparison.Ordinal)) >= 0) { lutCount++; at += 6; }
    Require(fullChain.Contains("format=rgb24") && lutCount == 3, "chain carries input + match + grade LUTs (got " + lutCount + " lut3d)");
    var ndoc = StudioMedia.Import(chainSrc);
    ndoc.GradeNodes = new GradeNodeGraph { Nodes = new List<GradeNode> { new GradeNode { Id = "n1", Adjust = new ColorGrade() } }, Output = "n1" };
    ndoc.Grade.Temperature = 0.5;
    threw = false;
    try { W8ColourFilters.Validate(ndoc); } catch { threw = true; }
    Require(threw, "node graph + linear grade together is rejected");
    ndoc.Grade.Reset();
    W8ColourFilters.Validate(ndoc);
    var bdoc = StudioMedia.Import(chainSrc);
    bdoc.BeautyEnabled = true;
    bdoc.BeautyMaskPath = Path.Combine(Folder, "beauty-mask.mp4");
    bdoc.GradeNodes = ndoc.GradeNodes;
    // W9：美颜 + 节点图不再互斥——Validate 通过，调色链里仍有节点 LUT，
    // 导出走合成图（见 W9FixesTests 的真实导出）。旧的互斥报错已删。
    W8ColourFilters.Validate(bdoc);
    Require(W8ColourFilters.Chain(bdoc, false).Contains("lut3d="), "beauty + node graph validates and the chain still carries the node LUT");
    Require(W8ColourFilters.Chain(cdoc, true).Contains("chromakey") == false, "chain without chroma has no chromakey");
    var kdoc = StudioMedia.Import(chainSrc);
    kdoc.Chroma = new ChromaKey { Color = "0x00ff00" };
    Require(W8ColourFilters.Chain(kdoc, true).Contains("chromakey=color=0x00ff00"), "preview chain appends the chroma vf fragment");
    Require(W8ColourFilters.NeedsComplexDecoder(kdoc) && !W8ColourFilters.NeedsComplexDecoder(cdoc), "chroma needs the complex decoder, plain grade does not");
    Mark("STEP 9 chain + validation OK");
    // 10. 解码器图真实跑帧：色度键 / 跟踪窗口 / 蒙版节点。
    string keySrc = Path.Combine(Folder, "key-src.mp4");
    RunFfmpeg("-v error -y -f lavfi -i color=c=0x00ff00:s=320x180:d=2 -vf drawbox=x=110:y=60:w=100:h=60:color=red:t=fill -c:v libx264 -pix_fmt yuv420p -r 30 " + Media.Q(keySrc));
    var kdoc2 = StudioMedia.Import(keySrc);
    kdoc2.Chroma = new ChromaKey { Color = "0x00ff00", Similarity = 0.1, Blend = 0, Despill = true };
    string kwork = Path.Combine(Folder, "kwork");
    Directory.CreateDirectory(kwork);
    var kprep = W8ColourExport.Prepare(kdoc2, kwork, 320, 180, 30, CancellationToken.None);
    string kargs = W8ColourExport.DecoderArgs(kdoc2, kprep, keySrc, "", 320, 180, 30, "", "", 1);
    var kframe = RunRaw(kargs);
    Require(kframe.Length == 320 * 180 * 4, "chroma decoder frame is complete (" + kframe.Length + " bytes)");
    int ki = (10 * 320 + 10) * 4;
    int kc = (90 * 320 + 160) * 4;
    Require(kframe[ki] < 20 && kframe[ki + 1] < 20 && kframe[ki + 2] < 20, "chroma corner is keyed to black (got " + kframe[ki + 2] + "," + kframe[ki + 1] + "," + kframe[ki] + ")");
    Require(kframe[kc + 2] > 200 && kframe[kc + 1] < 40 && kframe[kc] < 40, "chroma centre stays red (got " + kframe[kc + 2] + "," + kframe[kc + 1] + "," + kframe[kc] + ")");
    string whiteSrc = Path.Combine(Folder, "white-src.mp4");
    SolidVideo(whiteSrc, "0xffffff", 320, 180, 2);
    var tdoc = StudioMedia.Import(whiteSrc);
    tdoc.TrackedWin = new TrackedWindow {
     Shape = "ellipse", W = 0.4, H = 0.4, Adjust = TempGrade(1),
     Track = new List<ColourTrackPoint> { new ColourTrackPoint { Time = 0, X = 0.5, Y = 0.5 } }, SampleFps = 5
    };
    string twork = Path.Combine(Folder, "twork");
    Directory.CreateDirectory(twork);
    var tprep = W8ColourExport.Prepare(tdoc, twork, 320, 180, 30, CancellationToken.None);
    string targs = W8ColourExport.DecoderArgs(tdoc, tprep, whiteSrc, "", 320, 180, 30, "", "", 1);
    var tframe = RunRaw(targs);
    int tci = (90 * 320 + 160) * 4, tki = (10 * 320 + 10) * 4;
    Require(tframe[tci] < 230 && tframe[tki] > 250, "tracked window: inside is graded (B " + tframe[tci] + "), outside is untouched (B " + tframe[tki] + ")");
    var mdoc = StudioMedia.Import(whiteSrc);
    var mn1 = new GradeNode { Id = "m1", Adjust = TempGrade(1), Mask = new GradeNodeMask { Shape = "ellipse", X = 0.5, Y = 0.5, W = 0.4, H = 0.4, Feather = 0.02 } };
    mdoc.GradeNodes = new GradeNodeGraph { Nodes = new List<GradeNode> { mn1, new GradeNode { Id = "out", Inputs = new List<string> { "m1" } } }, Output = "out" };
    string mwork = Path.Combine(Folder, "mwork");
    Directory.CreateDirectory(mwork);
    var mprep = W8ColourExport.Prepare(mdoc, mwork, 320, 180, 30, CancellationToken.None);
    string margs = W8ColourExport.DecoderArgs(mdoc, mprep, whiteSrc, "", 320, 180, 30, "", "", 1);
    var mframe = RunRaw(margs);
    int mci = (90 * 320 + 160) * 4, mki = (10 * 320 + 10) * 4;
    Require(mframe[mci] < 230 && mframe[mki] > 250, "masked node: inside is graded (B " + mframe[mci] + "), outside is untouched (B " + mframe[mki] + ")");
    Mark("STEP 10 decoder graph frames OK");
    // 11. 整条导出（色度键走 complex 解码器分支）：文件 + 时长。
    // 导出高度下限 240（ExportOptions.Validate），所以导出源单独做 320x240，
    // 与 Height=240 一致，不缩放。
    string expSrc = Path.Combine(Folder, "export-src.mp4");
    RunFfmpeg("-v error -y -f lavfi -i color=c=0x00ff00:s=320x240:d=2 -vf drawbox=x=110:y=60:w=100:h=60:color=red:t=fill -c:v libx264 -pix_fmt yuv420p -r 30 " + Media.Q(expSrc));
    var edoc = StudioMedia.Import(expSrc);
    edoc.Chroma = new ChromaKey { Color = "0x00ff00", Similarity = 0.1, Blend = 0, Despill = true };
    string expOut = Path.Combine(Folder, "chroma-export.mp4");
    StudioRenderer.Export(edoc, expOut, new ExportOptions { PresetName = "test", Height = 240, Fps = 30, Codec = "h264", Crf = 18, Hdr = false, WriteChapters = false }, (v, s) => { }, CancellationToken.None);
    Require(File.Exists(expOut) && Math.Abs(StudioMedia.Import(expOut).Duration - 2) < 0.15, "full export with chroma key is 2.0s");
    Mark("STEP 11 full export with chroma OK");
    File.WriteAllText(log, "PASS: node serial/parallel-multiply (0.31,0.25,0.19) + out-of-order topo + masked stage LUT (0.63,0.50,0.38) + mask PNG centre 255/corner 0 + cycle/duplicate/masked-reads-masked/dangling-masked/brightness-in-node/bad-blend rejected; slog3 anchors 0.18/0.90, rec709 OETF(0.18)=0.409, slog3->rec709 LUT 0.47, log100/hlg setparams+zscale, pq Hable, unknown space rejected; match (100,30,30)->(199,48,49) numeric + real lut3d pixel, strength 0 identity; track centre 0.25->0.5->0.75, lost parks, mask buffer centre/corner, mask video 2.0s; LUT library film filter/search/categories/favourite/duplicate/missing/bad-cube rejected, thumbnail 160x90; compare split left grey/right temp+1, wipe 0.25, still round-trip + tampered sidecar rejected + list 1; chroma filter 0.1 + despill green/blue, similarity 0/1.5 rejected, pixel pick green; scopes red luma 54.2/hue 0/sat 1.0, grey hue null, white highlight 1.0, black shadow 1.0, red/blue hue peaks 128/128, real frame + deterministic, scope PNGs; chain input+match+grade = 3 lut3d, plain chain == Grade.VideoFilter(), node+linear rejected, beauty+node validates (W9: composes instead of rejecting), preview chroma vf, complex decoder detection; decoder frames: chroma corner black + centre red, tracked window inside B<230/outside B>250, masked node same; full chroma export 2.0s.\n");
   }
   catch (Exception ex) { File.AppendAllText(log, "FAIL\n" + ex + "\n"); Mark("FAIL: " + ex.Message); Environment.ExitCode = 1; }
  }
 }
}
