// W6 自测（2026-11-18）：--w6-test 入口，无窗口，纯逻辑 + 合成素材实测。
// 跑在云端构建里（build-test.yml 的 W6 checks 步），结果写
// Windows/bin/w6-results.txt（PASS: 开头才算过）。本地 Linux 跑不了 WPF，
// 但这些测试不碰窗口，只碰模型/滤镜串/ffmpeg/真实导出，所以云端是唯一可信的验证。
// 断言值全部来自本地探针实测（见 W6Panels.cs 头注释的出处）：
// morph 插值帧方块落在正中间、对话预设 -30dB→-15.3dB、闪避压 8.4dB 恢复 ±0dB、
// sv3d 注入后 ffprobe 认出 Spherical Mapping。
// 云端 runner 无真 GPU/摄像头/麦克风：录音只验逻辑（枚举不抛错、错误设备明确失败），
// 真机录音、GPU 预览、摄像头画中画仍待 Simon 在自己电脑上测。
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
 static class W6Tests {
  static void Require(bool ok, string name) { if (!ok) throw new Exception("W6 检查失败：" + name); }
  static bool Near(double a, double b, double tol) { return Math.Abs(a - b) <= tol; }
  static string Folder;
  static void WriteWav(string path, int sampleRate, double seconds, Func<double, double> sample) {
   int n = (int)(sampleRate * seconds);
   using (var fs = File.Create(path))
   using (var w = new BinaryWriter(fs)) {
    w.Write(new char[] { 'R', 'I', 'F', 'F' }); w.Write(36 + n * 2); w.Write(new char[] { 'W', 'A', 'V', 'E' });
    w.Write(new char[] { 'f', 'm', 't', ' ' }); w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(sampleRate); w.Write(sampleRate * 2); w.Write((short)2); w.Write((short)16);
    w.Write(new char[] { 'd', 'a', 't', 'a' }); w.Write(n * 2);
    for (int i = 0; i < n; i++) { double v = Math.Max(-1, Math.Min(1, sample((double)i / sampleRate))); w.Write((short)(v * 32767)); }
   }
  }
  static double VolumedetectMean(string file, string pre = "") {
   using (var p = Media.Start("ffmpeg", "-v info -i " + Media.Q(file) + " -vn -af " + pre + "volumedetect -f null -", false)) {
    var err = p.StandardError.ReadToEndAsync();
    p.StandardInput.Close();
    p.WaitForExit();
    if (p.ExitCode != 0) throw new Exception("volumedetect 失败：" + err.Result);
    foreach (string line in err.Result.Split('\n')) {
     if (line.Contains("mean_volume:")) {
      double v;
      if (double.TryParse(line.Substring(line.IndexOf("mean_volume:", StringComparison.Ordinal) + 12).Replace(" dB", "").Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return v;
     }
    }
    throw new Exception("volumedetect 输出里没有 mean_volume：" + err.Result);
   }
  }
  static void RunFfmpeg(string args) { StudioMedia.Run(args, CancellationToken.None); }
  static void FramePng(string video, int frame, string outPng) {
   RunFfmpeg("-v error -y -i " + Media.Q(video) + " -vf select='eq(n\\," + frame + ")' -vsync 0 -frames:v 1 " + Media.Q(outPng));
  }
  static void FrameAtPng(string video, double time, string outPng) {
   RunFfmpeg("-v error -y -ss " + Media.N(time) + " -i " + Media.Q(video) + " -frames:v 1 " + Media.Q(outPng));
  }
  // 白色方块的 x 向质心（R/G/B 都 >200 的像素）；没有白色像素返回 -1。
  static double BrightCentroidX(string png) {
   using (var bmp = new D.Bitmap(png)) {
    long sum = 0; long count = 0;
    for (int y = 0; y < bmp.Height; y += 2) for (int x = 0; x < bmp.Width; x += 2) {
     var c = bmp.GetPixel(x, y);
     if (c.R > 200 && c.G > 200 && c.B > 200) { sum += x; count++; }
    }
    if (count == 0) return -1;
    return (double)sum / count;
   }
  }
  static double FrameMeanBrightness(string png) {
   using (var bmp = new D.Bitmap(png)) {
    long sum = 0; long count = 0;
    for (int y = 0; y < bmp.Height; y += 4) for (int x = 0; x < bmp.Width; x += 4) {
     var c = bmp.GetPixel(x, y);
     sum += c.R + c.G + c.B; count++;
    }
    return count == 0 ? 0 : sum / (double)(count * 3);
   }
  }
  public static void Run() {
   Folder = Path.Combine(Media.Root, "bin", "w6-test");
   Directory.CreateDirectory(Folder);
   string log = Path.Combine(Media.Root, "bin", "w6-results.txt");
   try {
    // 1. RGB/主曲线：纯逻辑 + 顺序（HSL 之后、先 RGB 再主曲线）。
    var grade = new ColorGrade();
    grade.RgbR = new List<CurvePoint> { new CurvePoint { X = 0, Y = 0 }, new CurvePoint { X = 1, Y = 0.5 } };
    var half = ColorLut.Apply(grade, 1, 0, 0);
    Require(Near(half[0], .5, .01) && Near(half[1], 0, .01) && Near(half[2], 0, .01), "RGB red curve halves red (got " + half[0].ToString("0.00") + ")");
    var ident = ColorLut.Apply(new ColorGrade(), 1, 0, 0);
    Require(Near(ident[0], 1, .001) && Near(ident[1], 0, .001) && Near(ident[2], 0, .001), "identity grade leaves pixel alone");
    var mgrade = new ColorGrade();
    mgrade.RgbMaster = new List<CurvePoint> { new CurvePoint { X = 0, Y = 0 }, new CurvePoint { X = 1, Y = 0.5 } };
    var mhalf = ColorLut.Apply(mgrade, 1, 1, 1);
    Require(Near(mhalf[0], .5, .01) && Near(mhalf[1], .5, .01) && Near(mhalf[2], .5, .01), "master curve halves all channels");
    // 顺序：HSL 把红变灰 (0.5,0.5,0.5)，再过 R 曲线减半 → (0.25,0.5,0.5)。
    var og = new ColorGrade();
    og.HslCurveSat = new List<CurvePoint> { new CurvePoint { X = 0, Y = 0 }, new CurvePoint { X = 0.05, Y = 0 }, new CurvePoint { X = 0.1, Y = 1 }, new CurvePoint { X = 1, Y = 1 } };
    og.RgbR = new List<CurvePoint> { new CurvePoint { X = 0, Y = 0 }, new CurvePoint { X = 1, Y = 0.5 } };
    var ordered = ColorLut.Apply(og, 1, 0, 0);
    Require(Near(ordered[0], .25, .02) && Near(ordered[1], .5, .02) && Near(ordered[2], .5, .02), "RGB curves apply after HSL (got " + ordered[0].ToString("0.00") + "," + ordered[1].ToString("0.00") + "," + ordered[2].ToString("0.00") + ")");
    Require(grade.NeedsLut() && !new ColorGrade().NeedsLut(), "RGB curve forces LUT path");
    Require(grade.Key() != new ColorGrade().Key(), "RGB curve changes LUT key");
    Require(RgbCurves.IsIdentity(RgbCurves.Identity()) && !RgbCurves.IsIdentity(grade.RgbR), "RGB identity check");
    bool threw = false;
    try { HslCurves.ValidateCurve(new List<CurvePoint> { new CurvePoint { X = 0, Y = 0 }, new CurvePoint { X = 1, Y = 1.5 } }, "test", 0, 1); } catch { threw = true; }
    Require(threw, "RGB curve rejects y > 1");
    // 2. 闪白：源→时间线映射 + 窗口谓词。
    var fdoc = new EditDocument { Source = "x.mp4", Duration = 12, Cuts = new List<Cut> { new Cut { Start = 0, End = 2, Speed = 1 }, new Cut { Gap = true, GapDuration = 0.5, Start = 2, End = 2 }, new Cut { Start = 10, End = 12, Speed = 2 } } };
    var mapped = BeatFlash.MapBeats(fdoc, new List<double> { 0.5, 1.5, 2.5, 11 });
    Require(mapped.Count == 3 && Near(mapped[0], .5, .001) && Near(mapped[1], 1.5, .001) && Near(mapped[2], 3.0, .001), "flash beats map source->timeline (gap skipped, speed honoured)");
    Require(BeatFlash.IsFlash(1.0, new List<double> { 1.0 }, 2, 30) && BeatFlash.IsFlash(1.05, new List<double> { 1.0 }, 2, 30) && !BeatFlash.IsFlash(1.07, new List<double> { 1.0 }, 2, 30) && !BeatFlash.IsFlash(0.99, new List<double> { 1.0 }, 2, 30), "flash window is [beat, beat+frames/fps)");
    // 3. 音频类型预设 + 闪避（ffmpeg 直接测滤镜串）。
    Require(AudioTypePreset.FilterFor("无") == "", "preset none is empty");
    Require(AudioTypePreset.FilterFor("对话").Contains("loudnorm=I=-16") && AudioTypePreset.FilterFor("对话").Contains("afftdn=nr=25:nf=-30") && AudioTypePreset.FilterFor("对话").Contains("deesser=i=0.5:m=0.5:f=0.85"), "dialogue preset chain parts");
    Require(AudioTypePreset.FilterFor("音乐").Contains("loudnorm=I=-14") && !AudioTypePreset.FilterFor("音乐").Contains("afftdn"), "music preset is loudnorm only");
    string quiet = Path.Combine(Folder, "quiet.wav");
    WriteWav(quiet, 48000, 2, t => 0.01 * Math.Sin(2 * Math.PI * 440 * t));
    string dlgOut = Path.Combine(Folder, "dlg-out.wav");
    RunFfmpeg("-v error -y -i " + Media.Q(quiet) + " -af " + Media.Q(AudioTypePreset.FilterFor("对话")) + " " + Media.Q(dlgOut));
    double dlgMean = VolumedetectMean(dlgOut);
    Require(dlgMean > -20, "dialogue preset lifts -40dB sine toward -16 LUFS (mean " + dlgMean.ToString("0.0") + ")");
    string music = Path.Combine(Folder, "music.wav"), dlg = Path.Combine(Folder, "dlg.wav");
    WriteWav(music, 48000, 2, t => 0.1 * Math.Sin(2 * Math.PI * 880 * t));
    WriteWav(dlg, 48000, 2, t => t < 1 ? 0.25 * Math.Sin(2 * Math.PI * 440 * t) : 0);
    string ducked = Path.Combine(Folder, "ducked.wav");
    RunFfmpeg("-v error -y -i " + Media.Q(music) + " -i " + Media.Q(dlg) + " -filter_complex \"[0:a][1:a]" + AudioTypePreset.DuckFilter + "[ducked]\" -map \"[ducked]\" " + Media.Q(ducked));
    double musicOn = VolumedetectMean(music, "atrim=0.3:0.9,");
    double duckOn = VolumedetectMean(ducked, "atrim=0.3:0.9,");
    double musicOff = VolumedetectMean(music, "atrim=1.3:1.9,");
    double duckOff = VolumedetectMean(ducked, "atrim=1.3:1.9,");
    Require(duckOn < musicOn - 4, "ducking lowers music under dialogue (" + musicOn.ToString("0.0") + " -> " + duckOn.ToString("0.0") + ")");
    Require(Math.Abs(duckOff - musicOff) < 1.5, "ducking recovers after dialogue (" + duckOff.ToString("0.0") + " vs " + musicOff.ToString("0.0") + ")");
    // 4. Morph Cut：边界判定 + 真实滤镜 + 插值帧位置。
    var segA = new PlaySegment { File = "a.mp4", Speed = 1, TimelineStart = 0, TimelineEnd = 1, SourceStart = 0, SourceEnd = 1 };
    var segB = new PlaySegment { File = "a.mp4", Speed = 1, TimelineStart = 1, TimelineEnd = 2, SourceStart = 1, SourceEnd = 2 };
    var segC = new PlaySegment { File = "b.mp4", Speed = 1, TimelineStart = 2, TimelineEnd = 3, SourceStart = 0, SourceEnd = 1 };
    var segFast = new PlaySegment { File = "a.mp4", Speed = 2, TimelineStart = 0, TimelineEnd = 0.5, SourceStart = 0, SourceEnd = 1 };
    var segGap = new PlaySegment { Gap = true, TimelineStart = 0, TimelineEnd = 0.5, SourceStart = 0, SourceEnd = 0 };
    var segShort = new PlaySegment { File = "a.mp4", Speed = 1, TimelineStart = 0, TimelineEnd = 0.15, SourceStart = 0, SourceEnd = 0.15 };
    Require(MorphCut.BoundaryOk(segA, segB, 0.2, 30), "morph ok on same-file 1x boundary");
    Require(!MorphCut.BoundaryOk(segB, segC, 0.2, 30), "morph rejects different file");
    Require(!MorphCut.BoundaryOk(segA, segFast, 0.2, 30), "morph rejects speed != 1");
    Require(!MorphCut.BoundaryOk(segA, segGap, 0.2, 30), "morph rejects gap");
    Require(!MorphCut.BoundaryOk(segA, segShort, 0.2, 30), "morph rejects too-short segment");
    string morphSrc = Path.Combine(Folder, "morph-src.mp4");
    RunFfmpeg("-v error -y -f lavfi -i \"color=c=red:s=320x180:r=30:d=1\" -f lavfi -i \"color=c=red:s=320x180:r=30:d=1\" -filter_complex \"[0:v][1:v]concat=n=2:v=1:a=0,drawbox=x=100:y=70:w=40:h=40:color=white:t=fill:enable='lt(t,1)'[a];[a]drawbox=x=110:y=70:w=40:h=40:color=white:t=fill:enable='gte(t,1)'[v]\" -map \"[v]\" -c:v libx264 -pix_fmt yuv420p -r 30 " + Media.Q(morphSrc));
    var mdoc = StudioMedia.Import(morphSrc);
    mdoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 1 }, new Cut { Start = 1, End = 2 } };
    mdoc.MorphEnabled = true; mdoc.MorphSeconds = 0.2;
    string morphFilter = StudioMedia.Filter(mdoc, false);
    Require(morphFilter.Contains("minterpolate") && morphFilter.Contains("concat=n=3"), "morph filter has interpolate + 3-way concat");
    string morphTimeline = Path.Combine(Folder, "morph-timeline.mp4");
    File.WriteAllText(Path.Combine(Folder, "morph-filter.txt"), morphFilter, new UTF8Encoding(false));
    // 注意：FFmpeg 8+ 把 -filter_complex_script 标记为废弃，9.0.2 已删掉它；
    // 读文件形式的滤镜串要用 -/filter_complex（产品 Export() 也是这个写法）。
    RunFfmpeg("-v error -y -i " + Media.Q(morphSrc) + " -/filter_complex " + Media.Q(Path.Combine(Folder, "morph-filter.txt")) + " -map \"[video]\" -c:v libx264 -pix_fmt yuv420p -r 30 " + Media.Q(morphTimeline));
    Require(Math.Abs(Media.Duration(morphTimeline) - 2) < 0.05, "morph timeline keeps 2.0s");
    string fA = Path.Combine(Folder, "mf-a.png"), fM = Path.Combine(Folder, "mf-m.png"), fB = Path.Combine(Folder, "mf-b.png");
    FramePng(morphTimeline, 15, fA); FramePng(morphTimeline, 30, fM); FramePng(morphTimeline, 45, fB);
    double cxA = BrightCentroidX(fA), cxM = BrightCentroidX(fM), cxB = BrightCentroidX(fB);
    Require(cxA > 0 && cxB > 0 && cxM > 0, "morph frames have a visible square (A " + cxA.ToString("0.0") + ", M " + cxM.ToString("0.0") + ", B " + cxB.ToString("0.0") + ")");
    Require(cxM > cxA + 2 && cxM < cxB - 2, "morph frame square sits between A and B (A " + cxA.ToString("0.0") + ", M " + cxM.ToString("0.0") + ", B " + cxB.ToString("0.0") + ")");
    mdoc.MorphEnabled = false;
    Require(!StudioMedia.Filter(mdoc, false).Contains("minterpolate"), "morph off leaves filter untouched");
    // 5. 配音：枚举不抛错、错误设备明确失败、遍往返。
    var mics = Voiceover.ListMicrophones();
    Require(mics != null, "mic enumeration never throws (found " + mics.Count + " on runner)");
    string take1 = Voiceover.TakePathFor(null, mdoc, 1);
    File.WriteAllText(take1, "x");
    string take2 = Voiceover.TakePathFor(null, mdoc, 1);
    Require(take1 != take2, "take path bumps when file exists");
    File.Delete(take1);
    Process bad = null;
    try { bad = Voiceover.StartRecording("不存在的麦克风 XYZ", Path.Combine(Folder, "bad.wav")); } catch { }
    if (bad != null) {
     bool exited = bad.WaitForExit(8000);
     try { if (!bad.HasExited) bad.Kill(); } catch { }
     Require(exited && bad.ExitCode != 0, "recording with a bogus mic fails fast, not hangs");
     bad.Dispose();
    }
    var vdoc = StudioMedia.Import(morphSrc);
    vdoc.Mixer.Add(new MixerChannel { Role = "旁白", SourcePath = dlg, Start = 0.5 });
    var vrestored = EditDocument.Deserialize(vdoc.Serialize());
    vrestored.Validate();
    Require(vrestored.Mixer.Count == 1 && Near(vrestored.Mixer[0].Start, 0.5, .001), "voiceover take round-trips with Start");
    bool startBad = false;
    vrestored.Mixer[0].Start = 99;
    try { vrestored.Validate(); } catch { startBad = true; }
    Require(startBad, "take Start beyond length throws");
    // 6. 代理与缓存：格式化 + 真实生成。
    Require(ProxyDisk.FormatSize(0) == "0 B" && ProxyDisk.FormatSize(1500) == "1.5 KB" && ProxyDisk.FormatSize(2097152) == "2.0 MB", "size formatting");
    Require(ProxyDisk.ProxyBytes(vdoc) == 0, "no proxy yet reports 0");
    string proxyPath = ProxyTools.ProxyPathFor(morphSrc);
    double proxyDur = ProxyTools.Generate(morphSrc, proxyPath);
    Require(Math.Abs(proxyDur - 2) < 0.1 && ProxyDisk.ProxyBytes(vdoc) == 0, "proxy generates at source duration (proxy belongs to its own doc)");
    var pdoc = StudioMedia.Import(morphSrc);
    pdoc.ProxyPath = proxyPath; pdoc.ProxyDuration = proxyDur;
    Require(ProxyDisk.ProxyBytes(pdoc) > 0 && ProxyDisk.UsageLine(null, pdoc).Contains("代理："), "proxy bytes + usage line");
    File.Delete(proxyPath);
    // 7. 360°：识别 + 注入 + 幂等。
    Require(Spherical.BuildSv3d().Length == 106, "sv3d box is 106 bytes");
    string flat = Path.Combine(Folder, "flat.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x320:rate=30 -t 1 -c:v libx264 -pix_fmt yuv420p " + Media.Q(flat));
    var detLikely = Spherical.Detect(flat);
    Require(detLikely.Kind == SphericalKind.Likely, "2:1 clip without metadata is Likely");
    Spherical.Inject(flat);
    var detDef = Spherical.Detect(flat);
    Require(detDef.Kind == SphericalKind.Definite, "inject makes ffprobe see Spherical Mapping");
    long sizeOnce = new FileInfo(flat).Length;
    Spherical.Inject(flat);
    Require(new FileInfo(flat).Length == sizeOnce && Spherical.Detect(flat).Kind == SphericalKind.Definite, "second inject is a no-op");
    string wide = Path.Combine(Folder, "wide.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30 -t 1 -c:v libx264 -pix_fmt yuv420p " + Media.Q(wide));
    Require(Spherical.Detect(wide).Kind == SphericalKind.None, "16:9 clip is not 360");
    // 8. 真实导出：闪白 + 音频预设/闪避/配音遍 + Morph 开关。
    string audioSrc = Path.Combine(Folder, "audio-src.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=3 -f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=3\" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(audioSrc));
    var adoc = StudioMedia.Import(audioSrc);
    adoc.AudioType = "对话"; adoc.AudioDucking = true;
    adoc.Mixer.Add(new MixerChannel { Role = "音乐", SourcePath = music });
    adoc.Mixer.Add(new MixerChannel { Role = "旁白", SourcePath = dlg, Start = 0.5 });
    string audioOut = Path.Combine(Folder, "audio-export.mp4");
    StudioRenderer.Export(adoc, audioOut, 360, 30, (v, s) => { }, CancellationToken.None);
    var aexp = StudioMedia.Import(audioOut);
    Require(Math.Abs(aexp.Duration - 3) < 0.15 && aexp.Audio, "export with dialogue preset + ducking + voiceover take keeps 3s + audio");
    var flashDoc = StudioMedia.Import(audioSrc);
    flashDoc.FlashEnabled = true; flashDoc.FlashFrames = 2; flashDoc.FlashIntensity = 1;
    flashDoc.FlashBeats = new List<double> { 1.0 };
    string flashOut = Path.Combine(Folder, "flash-export.mp4");
    StudioRenderer.Export(flashDoc, flashOut, 360, 30, (v, s) => { }, CancellationToken.None);
    string flashOn = Path.Combine(Folder, "flash-on.png"), flashOff = Path.Combine(Folder, "flash-off.png");
    FrameAtPng(flashOut, 1.0, flashOn); FrameAtPng(flashOut, 0.5, flashOff);
    double brightOn = FrameMeanBrightness(flashOn), brightOff = FrameMeanBrightness(flashOff);
    Require(brightOn > 240 && brightOff < 200, "flash frame is white at the beat (" + brightOn.ToString("0") + ") and normal elsewhere (" + brightOff.ToString("0") + ")");
    var medoc = StudioMedia.Import(morphSrc);
    medoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 1 }, new Cut { Start = 1, End = 2 } };
    medoc.MorphEnabled = true; medoc.MorphSeconds = 0.2;
    string morphOut = Path.Combine(Folder, "morph-export.mp4");
    StudioRenderer.Export(medoc, morphOut, 360, 30, (v, s) => { }, CancellationToken.None);
    Require(Math.Abs(StudioMedia.Import(morphOut).Duration - 2) < 0.15, "export with morph keeps 2.0s");
    File.WriteAllText(log, "PASS: RGB red halves (0.5,0,0), master halves all, RGB-after-HSL order (0.25,0.5,0.5), LUT key/path, y>1 rejected; flash map [0.5,1.5,3.0] gap skipped + window [beat,beat+frames/fps); dialogue preset lifts -40dB sine to " + dlgMean.ToString("0.0") + " dB mean, ducking " + musicOn.ToString("0.0") + " -> " + duckOn.ToString("0.0") + " dB under dialogue, recovers " + duckOff.ToString("0.0") + " vs " + musicOff.ToString("0.0") + "; morph boundary rules, filter minterpolate + concat n=3, timeline 2.0s, square A " + cxA.ToString("0.0") + " M " + cxM.ToString("0.0") + " B " + cxB.ToString("0.0") + ", off leaves filter untouched; mic enum no-throw (" + mics.Count + "), bogus mic fails fast, take round-trips Start 0.5; proxy generates + usage line; sv3d 106 bytes, Likely -> Definite, second inject no-op, 16:9 None; export dialogue+ducking+take 3s + audio, flash white " + brightOn.ToString("0") + " vs " + brightOff.ToString("0") + ", morph export 2.0s.\n");
   }
   catch (Exception ex) { File.WriteAllText(log, "FAIL\n" + ex); Environment.ExitCode = 1; }
  }
 }
}
