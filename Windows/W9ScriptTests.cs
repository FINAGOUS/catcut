// W9 自测（2026-11-19）：--w9script-test 入口，无窗口，纯逻辑 + 合成素材实测。
// 跑在云端构建里（build-test.yml 的 W9 scriptvideo checks 步），结果写
// Windows/bin/w9script-results.txt（PASS: 开头才算过）。本地 Linux 跑不了 WPF，
// 但这些测试不碰窗口，只碰模型/滤镜串/ffmpeg/真实组装，所以云端是唯一可信的验证。
// 覆盖（任务清单逐项）：
//  1. 原有静音成片回归仍过（老 Build 入口，6.0s + .srt）。
//  2. 纯逻辑 ComputeDurations：有节拍向前贴 0.35 秒内、边界前的节拍不贴、
//     无网格退化等长、配音段长取 TTS 时长。
//  3. 配音组装接线（合成音调 wav 当旁白替身——不是 TTS，不冒充）：成片带
//     配音（切片峰值 > -40dB）、段长与旁白时长对齐、.srt 边界一致。
//  4. 配音 + 节拍同步：边界贴到节拍网格、卡点延长段由 apad 垫满（延长区
//     是静音、不是截断也不是循环），总时长 = 贴合后段长之和。
//  5. 缺 TTS 模型时诚实报错且不产出假配音（云端无模型时走这条；模型在
//     时改走真 TTS 合成并验非静音）。
//  6. 无节拍时退化等长分段（静音音乐、没选音乐两种），不报错、不硬编节拍。
// 云端 runner 无 TTS 模型：真 TTS 合成只在模型在场时验；其余接线用合成
// 音调 wav 验证，不谎称云端验过真 TTS。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using DogSC.Windows;

namespace DogSC.Replica {
 static class W9ScriptTests {
  static void Require(bool ok, string name) { if (!ok) throw new Exception("W9 script checks failed: " + name); }
  static bool Near(double a, double b, double tol) { return Math.Abs(a - b) <= tol; }
  static string Folder;
  static string LogPath;
  static void Mark(string s) { try { File.AppendAllText(LogPath, s + "\n"); } catch { } }
  static void RunFfmpeg(string args) { StudioMedia.Run(args, CancellationToken.None); }
  // W5Tests.WriteWav 同款：16 位单声道 PCM wav，采样函数逐点写。
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
  // 切片峰值：从 at 起取 len 秒，volumedetect max_volume。-91 dB = 数字静音。
  static double SliceMaxVolume(string file, double at, double len) {
   string slice = Path.Combine(Folder, "slice-" + at.ToString("0.00", CultureInfo.InvariantCulture) + "-" + len.ToString("0.00", CultureInfo.InvariantCulture) + ".wav");
   RunFfmpeg("-v error -y -ss " + Media.N(at) + " -t " + Media.N(len) + " -i " + Media.Q(file) + " -vn -ac 1 -ar 16000 " + Media.Q(slice));
   return AudioProbe.MaxVolume(slice);
  }
  static List<AutoVideoLine> TwoLines(string img1, string img2, double dur) {
   return new List<AutoVideoLine> {
    new AutoVideoLine { Text = "第一句口播", Image = img1, Duration = dur },
    new AutoVideoLine { Text = "第二句口播", Image = img2, Duration = dur }
   };
  }
  static string WorkDir(string name) { string d = Path.Combine(Folder, name); Directory.CreateDirectory(d); return d; }

  public static void Run() {
   Folder = Path.Combine(Media.Root, "bin", "w9script-test");
   Directory.CreateDirectory(Folder);
   string log = Path.Combine(Media.Root, "bin", "w9script-results.txt");
   LogPath = log;
   File.WriteAllText(log, "RUNNING\n");
   try {
    // ---- 素材 ----
    string img1 = Path.Combine(Folder, "img1.png");
    string img2 = Path.Combine(Folder, "img2.png");
    RunFfmpeg("-v error -y -f lavfi -i color=c=red:s=640x360:r=30:d=1 -frames:v 1 -c:v png " + Media.Q(img1));
    RunFfmpeg("-v error -y -f lavfi -i color=c=blue:s=640x360:r=30:d=1 -frames:v 1 -c:v png " + Media.Q(img2));
    // 120 BPM 点击轨（W5Tests 同款写法：每 0.5 秒一个 0.02 秒 1000Hz 脉冲）。
    string clicks = Path.Combine(Folder, "clicks.wav");
    WriteWav(clicks, 16000, 8, t => {
     double ph = t % 0.5;
     if (ph < 0.02) return 0.8 * Math.Sin(2 * Math.PI * 1000 * ph);
     return 0;
    });
    var grid = BeatDetector.Detect(clicks, 0, 8, CancellationToken.None);
    Require(Near(grid.Bpm, 120, 1) && grid.Beats.Count >= 15 && grid.Beats.Count <= 17, "click track detects 120 BPM (got " + grid.Bpm.ToString("0.00") + ", " + grid.Beats.Count + " beats)");
    Mark("STEP 0 fixtures OK (120 BPM clicks: " + grid.Bpm.ToString("0.00") + ", " + grid.Beats.Count + " beats)");

    // 1. 原有静音成片回归：老 Build 入口，6.0s + .srt。
    string filmOut = Path.Combine(Folder, "film.mp4");
    AutoVideo.Build(TwoLines(img1, img2, 3), "", filmOut, CancellationToken.None);
    Require(Math.Abs(Media.Duration(filmOut) - 6) < .15, "silent script film is 6.0s");
    string srt = File.ReadAllText(Path.ChangeExtension(filmOut, ".srt"));
    Require(srt.Contains("第一句口播") && srt.Contains("第二句口播"), "silent script film writes an .srt sidecar with both lines");
    Mark("STEP 1 silent regression OK (6.0s + .srt)");

    // 2. 纯逻辑 ComputeDurations：贴合只向前、无网格退化、配音段长取 TTS 时长。
    var lines3 = TwoLines(img1, img2, 3);
    var plain = new AutoVideoOptions { NarrationEnabled = false, BeatSyncEnabled = false };
    var snapped = AutoVideo.ComputeDurations(lines3, plain, null, new BeatGrid { Bpm = 120, Period = 0.5, Beats = new List<double> { 3.2, 6.0 } });
    Require(snapped[0].Snapped && Near(snapped[0].Beat, 3.2, 0.01) && Near(snapped[0].Duration, 3.2, 0.01) && Near(snapped[1].Duration, 3, 0.01) && Near(snapped[0].Start + snapped[0].Duration + snapped[1].Duration, 6.2, 0.01),
     "beat snap extends first segment 3.0 -> 3.2 (got " + snapped[0].Duration.ToString("0.00") + ", snapped=" + snapped[0].Snapped + ")");
    var noGrid = AutoVideo.ComputeDurations(lines3, plain, null, null);
    Require(!noGrid[0].Snapped && Near(noGrid[0].Duration, 3, 0.01) && Near(noGrid[1].Duration, 3, 0.01), "no grid degrades to equal 3.0s segments");
    var beforeOnly = AutoVideo.ComputeDurations(lines3, plain, null, new BeatGrid { Bpm = 120, Period = 0.5, Beats = new List<double> { 2.8 } });
    Require(!beforeOnly[0].Snapped && Near(beforeOnly[0].Duration, 3, 0.01), "a beat before the boundary does not snap (forward only)");
    var narr = new AutoVideoOptions { NarrationEnabled = true, BeatSyncEnabled = false };
    var narrSegs = AutoVideo.ComputeDurations(lines3, narr, new List<double> { 2.0, 2.5 }, new BeatGrid { Bpm = 120, Period = 0.5, Beats = new List<double> { 2.2 } });
    Require(Near(narrSegs[0].Duration, 2.2, 0.01) && narrSegs[0].Snapped && Near(narrSegs[1].Duration, 2.5, 0.01) && Near(narrSegs[0].TtsDuration, 2.0, 0.01),
     "narration segments take TTS durations (2.0 -> 2.2 snapped, 2.5)");
    Mark("STEP 2 ComputeDurations OK (snap 3.0->3.2, no-grid equal, before-beat ignored, TTS durations)");

    // 3. 配音组装接线（合成音调 wav 当旁白替身）：段长与旁白对齐、成片带配音。
    string tone1 = Path.Combine(Folder, "tone1.wav");
    string tone2 = Path.Combine(Folder, "tone2.wav");
    WriteWav(tone1, 16000, 1.0, t => 0.5 * Math.Sin(2 * Math.PI * 440 * t));
    WriteWav(tone2, 16000, 2.0, t => 0.5 * Math.Sin(2 * Math.PI * 880 * t));
    string narrOut = Path.Combine(Folder, "film-narr.mp4");
    var narrPlan = AutoVideo.Assemble(TwoLines(img1, img2, 3), "", narrOut,
     new AutoVideoOptions { NarrationEnabled = true, BeatSyncEnabled = false },
     new List<string> { tone1, tone2 }, WorkDir("narr-work"), CancellationToken.None);
    Require(Near(narrPlan[0].Duration, 1.0, 0.05) && Near(narrPlan[1].Duration, 2.0, 0.05) && Math.Abs(Media.Duration(narrOut) - 3) < .15,
     "narrated film takes narration durations (1.0 + 2.0 = 3.0s, got " + Media.Duration(narrOut).ToString("0.00") + "s)");
    double volSeg0 = SliceMaxVolume(narrOut, 0.5, 0.4);
    double volSeg1 = SliceMaxVolume(narrOut, 2.0, 0.4);
    Require(volSeg0 > -40 && volSeg1 > -40, "narrated film is non-silent in both segments (seg0 " + volSeg0.ToString("0.0") + "dB, seg1 " + volSeg1.ToString("0.0") + "dB)");
    string narrSrt = File.ReadAllText(Path.ChangeExtension(narrOut, ".srt"));
    Require(narrSrt.Contains("00:00:01,000 --> 00:00:03,000"), ".srt boundaries follow narration durations (1.0s / 3.0s)");
    Mark("STEP 3 narration assembly OK (1.0 + 2.0s, slices " + volSeg0.ToString("0.0") + "/" + volSeg1.ToString("0.0") + "dB, .srt 1.0/3.0)");

    // 4. 配音 + 节拍同步：边界贴到节拍网格、延长段 apad 垫满（延长区静音）。
    string toneShort = Path.Combine(Folder, "tone-short.wav");
    WriteWav(toneShort, 16000, 1.7, t => 0.5 * Math.Sin(2 * Math.PI * 440 * t));
    string beatOut = Path.Combine(Folder, "film-beat.mp4");
    var beatPlan = AutoVideo.Assemble(TwoLines(img1, img2, 3), "", beatOut,
     new AutoVideoOptions { NarrationEnabled = true, BeatSyncEnabled = true, MusicPath = clicks },
     new List<string> { toneShort, toneShort }, WorkDir("beat-work"), CancellationToken.None);
    Require(beatPlan[0].Snapped && Near(beatPlan[0].Beat, 2.0, 0.05) && Near(beatPlan[0].Duration, 2.0, 0.05) && Near(beatPlan[1].Duration, 1.7, 0.05),
     "beat sync snaps first boundary 1.7 -> 2.0 (beat " + beatPlan[0].Beat.ToString("0.00") + ", dur " + beatPlan[0].Duration.ToString("0.00") + ")");
    Require(Math.Abs(Media.Duration(beatOut) - 3.7) < .15, "beat-synced film is 3.7s (2.0 + 1.7, got " + Media.Duration(beatOut).ToString("0.00") + "s)");
    double volTone = SliceMaxVolume(beatOut, 0.5, 0.4);
    // 延长区 1.7–2.0s：旁白已垫静音，音乐点击在 1.5s 与 2.0s，切 1.8–1.95s 应近乎静音。
    double volPad = SliceMaxVolume(beatOut, 1.8, 0.15);
    Require(volTone > -40 && volPad < -50, "snapped extension is silence-filled by apad, not truncated or looped (tone " + volTone.ToString("0.0") + "dB, pad " + volPad.ToString("0.0") + "dB)");
    string beatSrt = File.ReadAllText(Path.ChangeExtension(beatOut, ".srt"));
    Require(beatSrt.Contains("00:00:02,000 --> 00:00:03,700"), ".srt carries the snapped boundary (2.0s / 3.7s)");
    Mark("STEP 4 narration + beat sync OK (1.7 -> 2.0 snapped, 3.7s, pad " + volPad.ToString("0.0") + "dB)");

    // 5. 无节拍退化：静音音乐、没选音乐两种，都等长、不报错、不贴合。
    string silenceWav = Path.Combine(Folder, "silence.wav");
    WriteWav(silenceWav, 16000, 4, t => 0);
    string degOut = Path.Combine(Folder, "film-deg.mp4");
    var degPlan = AutoVideo.Assemble(TwoLines(img1, img2, 2.9), "", degOut,
     new AutoVideoOptions { NarrationEnabled = false, BeatSyncEnabled = true, MusicPath = silenceWav },
     null, WorkDir("deg-work"), CancellationToken.None);
    Require(!degPlan[0].Snapped && Near(degPlan[0].Duration, 2.9, 0.01) && Near(degPlan[1].Duration, 2.9, 0.01) && Math.Abs(Media.Duration(degOut) - 5.8) < .15,
     "silence music degrades to equal 2.9s segments (got " + degPlan[0].Duration.ToString("0.00") + "/" + degPlan[1].Duration.ToString("0.00") + ")");
    string degOut2 = Path.Combine(Folder, "film-deg2.mp4");
    var degPlan2 = AutoVideo.Assemble(TwoLines(img1, img2, 2.9), "", degOut2,
     new AutoVideoOptions { NarrationEnabled = false, BeatSyncEnabled = true, MusicPath = "" },
     null, WorkDir("deg2-work"), CancellationToken.None);
    Require(!degPlan2[0].Snapped && Near(degPlan2[0].Duration, 2.9, 0.01) && Math.Abs(Media.Duration(degOut2) - 5.8) < .15,
     "no music selected degrades to equal 2.9s segments without error");
    Mark("STEP 5 no-beat degrade OK (silence music + no music, both 5.8s equal)");

    // 6. TTS 缺模型诚实报错、不产出假配音；模型在场时改走真合成。
    string modelOnnx = Path.Combine(TtsSynth.ModelDir(), "model.onnx");
    string ttsNote;
    if (!File.Exists(modelOnnx)) {
     bool threw = false;
     try { TtsSynth.Synthesize("你好", 1, Path.Combine(Folder, "should-not-exist.wav")); } catch (Exception ex) { threw = ex.Message.Contains("缺少语音模型"); }
     Require(threw, "TTS without a model fails honestly (missing-model message)");
     string noModelOut = Path.Combine(Folder, "film-nomodel.mp4");
     threw = false;
     try { AutoVideo.BuildDetailed(TwoLines(img1, img2, 3), "", noModelOut, new AutoVideoOptions { NarrationEnabled = true, BeatSyncEnabled = false }, CancellationToken.None); }
     catch (Exception ex) { threw = ex.Message.Contains("缺少语音模型"); }
     Require(threw, "BuildDetailed without a model fails honestly");
     Require(!File.Exists(noModelOut), "no fake narrated film is produced without a model");
     ttsNote = "model missing, honest error, no fake narration";
    } else {
     string realOut = Path.Combine(Folder, "film-real-tts.mp4");
     var realPlan = AutoVideo.BuildDetailed(
      new List<AutoVideoLine> { new AutoVideoLine { Text = "你好", Image = img1, Duration = 3 }, new AutoVideoLine { Text = "再见", Image = img2, Duration = 3 } },
      "", realOut, new AutoVideoOptions { NarrationEnabled = true, BeatSyncEnabled = false }, CancellationToken.None);
     double realVol = SliceMaxVolume(realOut, 0.3, 0.4);
     Require(realPlan[0].Duration > 0.3 && realVol > -40, "real TTS film is non-silent (seg0 " + realPlan[0].Duration.ToString("0.00") + "s, slice " + realVol.ToString("0.0") + "dB)");
     ttsNote = "model present, real TTS film non-silent (seg0 " + realPlan[0].Duration.ToString("0.00") + "s)";
    }
    Mark("STEP 6 TTS availability OK (" + ttsNote + ")");

    // 7. 选项校验拒绝：坏音色、坏语速、缺音乐文件、配音缺 wav。
    bool threw2 = false;
    try { AutoVideo.ValidateOptions(new AutoVideoOptions { Voice = "nope" }); } catch { threw2 = true; }
    Require(threw2, "unknown TTS voice is rejected");
    threw2 = false;
    try { AutoVideo.ValidateOptions(new AutoVideoOptions { TtsSpeed = 3 }); } catch { threw2 = true; }
    Require(threw2, "TTS speed 3 is rejected");
    threw2 = false;
    try { AutoVideo.ValidateOptions(new AutoVideoOptions { BeatSyncEnabled = true, MusicPath = Path.Combine(Folder, "nope.mp3") }); } catch { threw2 = true; }
    Require(threw2, "missing music file is rejected");
    threw2 = false;
    try { AutoVideo.Assemble(TwoLines(img1, img2, 3), "", Path.Combine(Folder, "film-bad.mp4"), new AutoVideoOptions { NarrationEnabled = true }, new List<string> { tone1 }, WorkDir("bad-work"), CancellationToken.None); } catch { threw2 = true; }
    Require(threw2, "narration with a missing per-line wav is rejected, not silenced");
    Mark("STEP 7 option validation OK (voice/speed/music/wav rejects)");

    File.WriteAllText(log, "PASS: silent regression 6.0s + .srt; ComputeDurations snap 3.0->3.2, no-grid equal, before-beat ignored, TTS durations 2.0->2.2; narration assembly 1.0+2.0s non-silent both segments (" + volSeg0.ToString("0.0") + "/" + volSeg1.ToString("0.0") + "dB) + .srt 1.0/3.0; narration + beat sync 1.7->2.0 snapped (beat " + beatPlan[0].Beat.ToString("0.00") + "), 3.7s, apad pad " + volPad.ToString("0.0") + "dB + .srt 2.0/3.7; no-beat degrade silence-music + no-music both 5.8s equal; TTS: " + ttsNote + "; validation rejects voice/speed/music/wav.\n");
   }
   catch (Exception ex) { File.AppendAllText(log, "FAIL\n" + ex + "\n"); Mark("FAIL: " + ex.Message); Environment.ExitCode = 1; }
  }
 }
}
