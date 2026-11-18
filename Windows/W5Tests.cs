// W5 自测（2026-11-18）：--w5-test 入口，无窗口，纯逻辑 + 合成素材实测。
// 跑在云端构建里（build-test.yml 的 W5 checks 步），结果写
// Windows/bin/w5-results.txt（PASS: 开头才算过）。本地 Linux 跑不了 WPF，
// 但这些测试不碰窗口，只碰模型/滤镜串/ffmpeg，所以云端是唯一可信的验证。
// 断言值全部来自 TS 引擎的探针实测（见 W5Panels.cs 头注释的出处）。
// 云端 runner 无 Whisper/Python onnxruntime/立体声混音设备，那三条只验
// 纯逻辑（解析、拼参、缺后端报错）+ 合成素材实测，不假装真机验过。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using DogSC.Windows;
using D = System.Drawing;
using Imaging = System.Drawing.Imaging;

namespace DogSC.Replica {
 static class W5Tests {
  static void Require(bool ok, string name) { if (!ok) throw new Exception("W5 检查失败：" + name); }
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
  static double Psnr(string a, string b, string crop) {
   string log = Path.Combine(Folder, "psnr.txt");
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
  static double VolumedetectMean(string file) {
   using (var p = Media.Start("ffmpeg", "-v info -i " + Media.Q(file) + " -vn -af volumedetect -f null -", false)) {
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
    throw new Exception("volumedetect 输出里没有 mean_volume。");
   }
  }
  public static void Run() {
   Folder = Path.Combine(Media.Root, "bin", "w5-test");
   Directory.CreateDirectory(Folder);
   string log = Path.Combine(Media.Root, "bin", "w5-results.txt");
   try {
    // 1. HSL 曲线：分段线性 + 端点钳制（color.ts applyCurve）。
    var curve = new List<CurvePoint> { new CurvePoint { X = 0, Y = 0 }, new CurvePoint { X = 0.5, Y = 2 }, new CurvePoint { X = 1, Y = 1 } };
    Require(Near(HslCurves.ApplyCurve(curve, 0.25), 1, .001) && Near(HslCurves.ApplyCurve(curve, 0.75), 1.5, .001), "curve piecewise linear");
    Require(Near(HslCurves.ApplyCurve(curve, -0.1), 0, .001) && Near(HslCurves.ApplyCurve(curve, 1.5), 1, .001), "curve clamps outside endpoints");
    Require(HslCurves.IsIdentitySat(HslCurves.IdentitySat()) && HslCurves.IsIdentityLum(HslCurves.IdentityLum()), "curve identity defaults");
    bool threw = false;
    try { HslCurves.ValidateCurve(new List<CurvePoint> { new CurvePoint { X = 0.5, Y = 1 }, new CurvePoint { X = 0.2, Y = 1 } }, "test", 0, 3); } catch { threw = true; }
    Require(threw, "curve rejects non-increasing x");
    threw = false;
    try { HslCurves.ValidateCurve(new List<CurvePoint> { new CurvePoint { X = 0, Y = 1 }, new CurvePoint { X = 1, Y = 4 } }, "test", 0, 3); } catch { threw = true; }
    Require(threw, "curve rejects y out of range");
    // LUT：红区去饱和变灰（P3d 探针实测 (0.5,0.5,0.5)），绿区不受影响。
    var grade = new ColorGrade();
    grade.HslCurveSat = new List<CurvePoint> { new CurvePoint { X = 0, Y = 0 }, new CurvePoint { X = 0.05, Y = 0 }, new CurvePoint { X = 0.1, Y = 1 }, new CurvePoint { X = 1, Y = 1 } };
    var red = ColorLut.Apply(grade, 1, 0, 0);
    Require(Near(red[0], .5, .02) && Near(red[1], .5, .02) && Near(red[2], .5, .02), "LUT hueVsSat kills red to grey");
    var green = ColorLut.Apply(grade, 0, 1, 0);
    Require(Near(green[0], 0, .02) && Near(green[1], 1, .02) && Near(green[2], 0, .02), "LUT hueVsSat leaves green alone");
    string cube1 = ColorLut.BuildCube(grade), cube2 = ColorLut.BuildCube(grade);
    Require(cube1 == cube2 && cube1 != ColorLut.BuildCube(new ColorGrade()), "LUT deterministic + curve changes cube");
    Require(grade.NeedsLut() && !new ColorGrade().NeedsLut(), "curve forces LUT path");
    Require(grade.Key() != new ColorGrade().Key(), "curve changes LUT key");
    // 2. Whisper：两种 JSON 解析 + 拼参与后端检测（云端无后端，只验逻辑）。
    string cppJson = "{\"transcription\": [{\"timestamps\": {\"from\": \"00:00:00.200\", \"to\": \"00:00:01.500\"}, \"offsets\": {\"from\": 200, \"to\": 1500}, \"text\": \"你好世界\"}, {\"timestamps\": {\"from\": \"00:00:02.000\", \"to\": \"00:00:03.000\"}, \"text\": \"再见\"}]}";
    var cppCues = WhisperTranscriber.ParseWhisperCppJson(cppJson);
    Require(cppCues.Count == 2 && Near(cppCues[0].Start, .2, .001) && Near(cppCues[0].End, 1.5, .001) && cppCues[0].Text == "你好世界" && cppCues[1].Text == "再见", "whisper.cpp JSON parse");
    string fwJson = "{\"segments\": [{\"text\": \"你好\", \"start\": 0.2, \"end\": 1.5, \"words\": []}, {\"text\": \"再见\", \"start\": 2, \"end\": 3, \"words\": []}]}";
    var fwCues = WhisperTranscriber.ParseFasterWhisperJson(fwJson);
    Require(fwCues.Count == 2 && Near(fwCues[1].End, 3, .001) && fwCues[0].Text == "你好", "faster-whisper JSON parse");
    string cppArgs = WhisperTranscriber.BuildWhisperCppArgs("whisper-cli.exe", "m.bin", "a.wav", "zh", "out");
    Require(cppArgs.Contains("--output-json") && cppArgs.Contains("-l zh") && cppArgs.Contains("m.bin"), "whisper.cpp args");
    string fwArgs = WhisperTranscriber.BuildFasterWhisperArgs("python", "a.raw", "small", "zh", "o.json");
    Require(fwArgs.Contains("--pcm16k") && fwArgs.Contains("--model small") && fwArgs.Contains("--language zh"), "faster-whisper args (transcribe.ts)");
    Require(WhisperTranscriber.DefaultModel == "small", "whisper default model small");
    Require(WhisperTranscriber.ModelDownloadUrl("small").Contains("ggml-small.bin"), "whisper model URL");
    string backendDetail;
    var backend = WhisperTranscriber.DetectBackend(out backendDetail);
    Require(!string.IsNullOrEmpty(backendDetail), "whisper backend detection reports");
    string maskProblem = BeautyMask.CheckBackend();
    // 云端 runner 无 Python onnxruntime：只要求检查本身不抛错、给得出结论。
    Require(maskProblem == null || maskProblem.Length > 0, "beauty backend check reports");
    // 3. 美颜/降噪：滤镜串（beauty.ts 公式逐字）+ 校验 + 遮罩图实测。
    Require(BeautyFilter.Hqdn3dFilter(50) == "hqdn3d=4.00:3.00:5.00:4.00", "hqdn3d mapping 50");
    Require(BeautyFilter.Hqdn3dFilter(100) == "hqdn3d=8.00:6.00:10.00:8.00", "hqdn3d mapping 100");
    string chain = BeautyFilter.Chain(50);
    Require(chain.Contains("hqdn3d=4.00:3.00:5.00:4.00") && chain.Contains("eq=brightness=0.015") && chain.Contains("unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=0.1"), "beauty chain (hqdn3d+brighten+unsharp 0.1)");
    string source = Path.Combine(Folder, "source.mp4");
    StudioMedia.Run("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac " + Media.Q(source), CancellationToken.None);
    var doc = StudioMedia.Import(source);
    doc.DenoiseStrength = 50;
    Require(W5Effects.VideoFilter(doc).Contains("hqdn3d=4.00:3.00:5.00:4.00"), "denoise vf wired");
    doc.DenoiseStrength = 0;
    Require(W5Effects.VideoFilter(doc) == "", "effect vf empty when off");
    doc.BeautyEnabled = true;
    doc.BeautyStrength = 50;
    threw = false;
    try { W5Effects.VideoFilter(doc); } catch (Exception ex) { threw = ex.Message.Contains("遮罩"); }
    Require(threw, "beauty without mask is a hard error");
    doc.Cuts = new List<Cut> { new Cut { Start = 0, End = 3, Speed = 2 } };
    threw = false;
    try { BeautyFilter.Validate(doc); } catch (Exception ex) { threw = ex.Message.Contains("变速"); }
    Require(threw, "beauty rejects speed cuts");
    doc.Cuts = new List<Cut> { new Cut { Start = 0, End = 3 } };
    doc.MulticamAngles.Add(source);
    threw = false;
    try { BeautyFilter.Validate(doc); } catch (Exception ex) { threw = ex.Message.Contains("多机位"); }
    Require(threw, "beauty rejects multicam");
    doc.MulticamAngles.Clear();
    // 合成遮罩：左白右黑；遮罩图实测——左半边变了、右半边几乎不动。
    string mask = Path.Combine(Folder, "mask.mp4");
    StudioMedia.Run("-v error -y -f lavfi -i color=c=white:s=320x360:r=30:d=3 -f lavfi -i color=c=black:s=320x360:r=30:d=3 -filter_complex \"[0:v][1:v]hstack\" -c:v libx264 -preset ultrafast -qp 0 -pix_fmt yuv420p " + Media.Q(mask), CancellationToken.None);
    doc.BeautyMaskPath = mask;
    doc.BeautyEdgeFeather = 1;
    BeautyFilter.Validate(doc);
    Require(W5Effects.VideoFilter(doc) == "", "masked beauty leaves the plain vf alone");
    string maskedOut = Path.Combine(Folder, "masked.mp4");
    string graph = W5Media.MaskedFilterComplex("scale=640:360", 30, "640", "360", doc);
    StudioMedia.Run("-v error -y -i " + Media.Q(source) + " -i " + Media.Q(mask) + " -filter_complex " + Media.Q(graph) + " -map [out] -c:v libx264 -preset ultrafast -qp 0 -pix_fmt yuv420p -t 3 " + Media.Q(maskedOut), CancellationToken.None);
    double leftPsnr = Psnr(maskedOut, source, "crop=200:360:0:0");
    double rightPsnr = Psnr(maskedOut, source, "crop=200:360:440:0");
    Require(leftPsnr < 45 && rightPsnr > 50, "masked beauty changes inside mask only (left PSNR " + leftPsnr.ToString("0.0") + ", right PSNR " + rightPsnr.ToString("0.0") + ")");
    byte[] frameBytes = W5Media.FrameMasked(source, 1.0, 640, CancellationToken.None, "scale=640:-2", doc);
    using (var ms = new MemoryStream(frameBytes))
    using (var bmp = new D.Bitmap(ms)) Require(bmp.Width == 640 && bmp.Height == 360, "FrameMasked returns 640x360 frame");
    // 4. 节拍检测：C# 合成的 120 BPM 点击轨（beat.ts 算法移植）。
    string clicks = Path.Combine(Folder, "clicks.wav");
    WriteWav(clicks, 16000, 8, t => {
     double ph = t % 0.5;
     if (ph < 0.02) return 0.8 * Math.Sin(2 * Math.PI * 1000 * ph);
     return 0;
    });
    var grid = BeatDetector.Detect(clicks, 0, 8, CancellationToken.None);
    Require(Near(grid.Bpm, 120, 1) && grid.Beats.Count >= 15 && grid.Beats.Count <= 17 && grid.Confidence > 0.5, "beat detect 120 BPM (got " + grid.Bpm.ToString("0.00") + ", " + grid.Beats.Count + " beats, conf " + grid.Confidence.ToString("0.00") + ")");
    var silence = new float[16000 * 2];
    var noGrid = BeatDetector.DetectFromSamples(silence);
    Require(noGrid.Bpm == 0 && noGrid.Beats.Count == 0 && noGrid.Confidence == 0, "beat detect silence has no beats");
    var nodes = BeatDetector.BeatSpeedNodes(new List<double> { 1, 2, 3 }, 0.5, 2, true);
    Require(nodes.Count == 4 && Near(nodes[0].Y, .5, .001) && Near(nodes[1].Y, 2, .001) && Near(nodes[2].Y, .5, .001) && Near(nodes[3].Y, 2, .001), "beat speed nodes alternate slow/fast");
    var beatDoc = StudioMedia.Import(source);
    beatDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 3 } };
    int pieces = BeatDetector.ApplyBeatSplit(beatDoc, 0, new List<double> { 1, 2 }, 0.5, 2, true, 0.5);
    Require(pieces == 3 && beatDoc.Cuts.Count == 3 && Near(beatDoc.Cuts[0].Speed, .5, .001) && Near(beatDoc.Cuts[1].Speed, 2, .001) && Near(beatDoc.Cuts[2].Speed, .5, .001) && Near(beatDoc.Length, 2 + .5 + 2, .001), "beat split 3 cuts alternate speeds, total 4.5s");
    threw = false;
    try { BeatDetector.ApplyBeatSplit(beatDoc, 0, new List<double>(), 0.5, 2, true, 0.5); } catch { threw = true; }
    Require(threw, "beat split rejects empty beats");
    // 5. 电平表：已知幅度正弦的 volumedetect + astats 行解析 + 实时跟随。
    string sine = Path.Combine(Folder, "sine.wav");
    WriteWav(sine, 48000, 2, t => 0.5 * Math.Sin(2 * Math.PI * 440 * t));
    var levels = LevelMeter.Analyze(sine, 0, 2, CancellationToken.None);
    Require(Near(levels.Item1, -9.03, .5) && Near(levels.Item2, -6.02, .5), "volumedetect sine 0.5 amp (mean " + levels.Item1.ToString("0.00") + ", max " + levels.Item2.ToString("0.00") + ")");
    double rms = -91, peak = -91;
    Require(LevelMeter.ParseAstatsLine("[Parsed_ametadata] lavfi.astats.Overall.RMS_level=-23.45", ref rms, ref peak) == null && Near(rms, -23.45, .001), "astats RMS line parse");
    var pair = LevelMeter.ParseAstatsLine("[Parsed_ametadata] lavfi.astats.Overall.Peak_level=-12.30", ref rms, ref peak);
    Require(pair != null && Near(pair.Item1, -23.45, .001) && Near(pair.Item2, -12.3, .001), "astats Peak line completes pair");
    Require(Near(LevelMeter.ParseDb("-inf"), -91, .001), "astats -inf floors at -91");
    var meter = new LevelMeter();
    var got = new ManualResetEventSlim(false);
    double seenRms = -91, seenPeak = -91;
    meter.Updated += (t, r, p) => { seenRms = r; seenPeak = p; if (r > -60) got.Set(); };
    meter.Start(sine, 0, 2);
    bool arrived = got.Wait(8000);
    meter.Stop();
    Require(arrived && seenRms > -60 && seenPeak > -60 && !meter.IsRunning, "level meter follows playback (rms " + seenRms.ToString("0.0") + ", peak " + seenPeak.ToString("0.0") + ")");
    // 6. 系统声音：拼参（三种组合）+ 真实 amix 混音（两路音调都在）。
    Require(SystemAudio.AudioFilter(0, 1, 0.8, true, false) == "", "mic only needs no audio filter");
    string mixFilter = SystemAudio.AudioFilter(1, 2, 0.8, true, true);
    Require(mixFilter.Contains("amix=inputs=2") && mixFilter.Contains("volume=0.8") && mixFilter.Contains("[aout]"), "mic+sys amix filter");
    string sysOnly = SystemAudio.AudioFilter(0, 0, 0.8, false, true);
    Require(sysOnly.Contains("volume=0.8") && sysOnly.Contains("[aout]") && !sysOnly.Contains("amix"), "sys only is a plain volume stage");
    Require(SystemAudio.ExtraInputArgs("Stereo Mix (Realtek Audio)").Contains("audio=Stereo Mix (Realtek Audio)"), "sys dshow input args");
    string toneA = Path.Combine(Folder, "tone440.wav"), toneB = Path.Combine(Folder, "tone660.wav");
    WriteWav(toneA, 48000, 2, t => 0.5 * Math.Sin(2 * Math.PI * 440 * t));
    WriteWav(toneB, 48000, 2, t => 0.5 * Math.Sin(2 * Math.PI * 660 * t));
    string mixed = Path.Combine(Folder, "mixed.wav");
    StudioMedia.Run("-v error -y -i " + Media.Q(toneA) + " -i " + Media.Q(toneB) + " -filter_complex \"[1:a]volume=0.8[s];[0:a][s]amix=inputs=2:duration=first:normalize=0[aout]\" -map [aout] " + Media.Q(mixed), CancellationToken.None);
    Require(File.Exists(mixed) && Math.Abs(Media.Duration(mixed) - 2) < .1, "amix renders 2s mix");
    string low = Path.Combine(Folder, "mixed-low.wav"), high = Path.Combine(Folder, "mixed-high.wav");
    StudioMedia.Run("-v error -y -i " + Media.Q(mixed) + " -af lowpass=f=500 " + Media.Q(low), CancellationToken.None);
    StudioMedia.Run("-v error -y -i " + Media.Q(mixed) + " -af highpass=f=500 " + Media.Q(high), CancellationToken.None);
    Require(VolumedetectMean(low) > -40 && VolumedetectMean(high) > -40, "amix keeps both tones (low " + VolumedetectMean(low).ToString("0.0") + ", high " + VolumedetectMean(high).ToString("0.0") + ")");
    // 7. 录制标记：模型往返 + 校验。
    var markDoc = StudioMedia.Import(source);
    markDoc.RecordingMarkers.Add(new RecordingMarker { Time = 0.5, Label = "标记 1" });
    markDoc.RecordingMarkers.Add(new RecordingMarker { Time = 2.0, Label = "标记 2" });
    var restored = EditDocument.Deserialize(markDoc.Serialize());
    restored.Validate();
    Require(restored.RecordingMarkers.Count == 2 && Near(restored.RecordingMarkers[1].Time, 2, .001) && restored.RecordingMarkers[0].Label == "标记 1", "markers serialize round-trip");
    restored.RecordingMarkers.Add(new RecordingMarker { Time = 99, Label = "越界" });
    threw = false;
    try { restored.Validate(); } catch (Exception ex) { threw = ex.Message.Contains("标记"); }
    Require(threw, "marker beyond length throws");
    // 8. 导出端到端：降噪 + 卡点变速切分走真实导出。
    var expDoc = StudioMedia.Import(source);
    expDoc.DenoiseStrength = 50;
    expDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 3 } };
    BeatDetector.ApplyBeatSplit(expDoc, 0, new List<double> { 1, 2 }, 0.5, 2, true, 0.5);
    string output = Path.Combine(Folder, "export.mp4");
    StudioRenderer.Export(expDoc, output, 360, 30, (v, s) => { }, CancellationToken.None);
    var exported = StudioMedia.Import(output);
    Require(Math.Abs(exported.Duration - 4.5) < .15, "export with denoise + beat split is 4.5s (got " + exported.Duration.ToString("0.00") + ")");
    File.WriteAllText(log, "PASS: HSL curve piecewise+clamp, LUT red->grey (0.5,0.5,0.5) green untouched, LUT deterministic/key; whisper.cpp + faster-whisper JSON parse, arg building, default small, backend detection reports (backend on runner: " + backend + "); beauty hqdn3d 50/100 exact, chain parts, validate rejects speed/multicam/missing-mask, masked graph left PSNR " + leftPsnr.ToString("0.0") + " < 45 + right PSNR " + rightPsnr.ToString("0.0") + " > 50, FrameMasked 640x360; beat detect 120 BPM " + grid.Bpm.ToString("0.00") + " / " + grid.Beats.Count + " beats conf " + grid.Confidence.ToString("0.00") + ", silence empty, nodes alternate, split 3 cuts total 4.5s; volumedetect sine mean " + levels.Item1.ToString("0.00") + " max " + levels.Item2.ToString("0.00") + ", astats parse + live follow rms " + seenRms.ToString("0.0") + " peak " + seenPeak.ToString("0.0") + "; sys audio filter 3 cases + real amix both tones present; markers round-trip + out-of-range throws; export denoise+beat-split 4.5s.\nBeauty mask backend on runner: " + (maskProblem ?? "python + onnxruntime present") + ".\n");
   }
   catch (Exception ex) { File.WriteAllText(log, "FAIL\n" + ex); Environment.ExitCode = 1; }
  }
 }
}
