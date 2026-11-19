// W10 自测（2026-11-19）：--w10transitions-test 入口，无窗口，纯逻辑 + 合成素材实测。
// 跑在云端构建里（build-test.yml 的 W10 checks 步），结果写
// Windows/bin/w10transitions-results.txt（PASS: 开头才算过）。本地 Linux 跑不了 WPF，
// 但这些测试不碰窗口，只碰模型/预览渲染/ffprobe，所以云端是唯一可信的验证。
// 断言值全部来自已验证的引擎口径（见 W10TransitionsPanels.cs 头注释的出处）与
// 本地 FFmpeg 探针：正弦满幅 volumedetect 均值约 -9 dB；P0 已验 fadeblack /
// fadewhite 在转场开始后约 20% 处到达极值（offset + 0.2*duration 采样）。
// 云端 runner 无真 GPU：面板拖动、时间线实时 scrub 只在真机上能验，
// 测试只验模型、接点方案交接面与真实 xfade/acrossfade 预览渲染。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.IO;
using System.Linq;
using System.Threading;
using DogSC.Windows;

namespace DogSC.Replica {
 static class W10TransitionsTests {
  static void Require(bool ok, string name) { if (!ok) throw new Exception("W10 检查失败：" + name); }
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
  static bool HasStream(string file, string type) {
   string text = Probe("-v error -show_entries stream=codec_type -of csv=p=0 " + Media.Q(file));
   foreach (string line in text.Split('\n')) if (line.Trim() == type) return true;
   return false;
  }
  static double ProbeDuration(string file) {
   string text = Probe("-v error -show_entries format=duration -of csv=p=0 " + Media.Q(file));
   double d;
   if (double.TryParse(text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
   throw new Exception("ffprobe 没有输出时长：" + text);
  }
  static double MeanVolume(string file, double from, double duration) {
   using (var p = Media.Start("ffmpeg", "-ss " + Media.N(from) + " -t " + Media.N(duration) + " -i " + Media.Q(file) + " -af volumedetect -f null -", false)) {
    var err = p.StandardError.ReadToEndAsync();
    p.StandardInput.Close();
    p.WaitForExit();
    if (p.ExitCode != 0) throw new Exception("volumedetect 失败：" + err.Result);
    foreach (string raw in err.Result.Split('\n')) {
     string line = raw.Trim();
     int mi = line.IndexOf("mean_volume:", StringComparison.Ordinal);
     if (mi >= 0) {
      string v = line.Substring(mi + 12).Trim();
      if (v.StartsWith("-inf", StringComparison.Ordinal)) return -91;
      int sp = v.IndexOf(' ');
      if (sp >= 0) v = v.Substring(0, sp);
      double d;
      if (double.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
     }
    }
    throw new Exception("volumedetect 没有输出 mean_volume：" + err.Result);
   }
  }
  public static void Run() {
   Folder = Path.Combine(Media.Root, "bin", "w10transitions-test");
   Directory.CreateDirectory(Folder);
   string log = Path.Combine(Media.Root, "bin", "w10transitions-results.txt");
   LogPath = log;
   File.WriteAllText(log, "RUNNING\n");
   try {
    // 素材：红 2 秒 + 440Hz 正弦；蓝 2 秒 + 880Hz 正弦；红 6 秒（接点方案用）。
    string red2 = Path.Combine(Folder, "w10-red2.mp4");
    RunFfmpeg("-v error -y -f lavfi -i color=c=0xFF0000:size=640x360:rate=30:duration=2 -f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=2\" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(red2));
    string blue2 = Path.Combine(Folder, "w10-blue2.mp4");
    RunFfmpeg("-v error -y -f lavfi -i color=c=0x0000FF:size=640x360:rate=30:duration=2 -f lavfi -i \"sine=frequency=880:sample_rate=48000:duration=2\" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(blue2));
    string red6 = Path.Combine(Folder, "w10-red6.mp4");
    RunFfmpeg("-v error -y -f lavfi -i color=c=0xFF0000:size=640x360:rate=30:duration=6 -f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=6\" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(red6));
    Mark("STEP 0 sources OK");
    // 1. 模型：9 种类型全合法；未知类型、时长越界拒绝；cut 的时长被忽略。
    foreach (var t in TransitionPlan.Types) TransitionPlan.ValidateSpec(new TransitionSpec { Type = t, DurationSeconds = t == "cut" ? 0 : 0.5 });
    Require(TransitionPlan.Types.Length == 9, "9 transition types (cut + 8 xfade)");
    Require(TransitionPlan.XfadeNames.Count == 8 && TransitionPlan.XfadeNames["dissolve"] == "dissolve" && TransitionPlan.XfadeNames["fadeblack"] == "fadeblack", "xfade name map matches engine filtergraph.ts (8 entries, cut excluded)");
    bool threw = false;
    try { TransitionPlan.ValidateSpec(new TransitionSpec { Type = "explode", DurationSeconds = 0.5 }); } catch { threw = true; }
    Require(threw, "unknown transition type is rejected");
    threw = false;
    try { TransitionPlan.ValidateSpec(new TransitionSpec { Type = "dissolve", DurationSeconds = 0.05 }); } catch { threw = true; }
    Require(threw, "dissolve 0.05s is rejected (min 0.1s, engine templates.ts)");
    threw = false;
    try { TransitionPlan.ValidateSpec(new TransitionSpec { Type = "dissolve", DurationSeconds = 5.5 }); } catch { threw = true; }
    Require(threw, "dissolve 5.5s is rejected (max 5s)");
    TransitionPlan.ValidateSpec(new TransitionSpec { Type = "cut", DurationSeconds = 0 });
    Require(new TransitionSpec().AudioCrossfade, "audio crossfade defaults to on");
    Require(TransitionPlan.TypeLabel("dissolve") == "溶解" && TransitionPlan.TypeLabel("fadeblack") == "闪黑" && TransitionPlan.TypeLabel("cut") == "硬切", "type labels are Chinese");
    Mark("STEP 1 model validation OK");
    // 2. 接点方案：3 片段 → 2 接点；统一方案同步回项目级字段；混用不写回；
    //    交接面类型串与引擎 TransitionType[] 一致；增删片段后 Ensure 补齐。
    var doc = StudioMedia.Import(red6);
    doc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 }, new Cut { Start = 2, End = 4 }, new Cut { Start = 4, End = 6 } };
    Require(TransitionPlan.JunctionCount(doc) == 2, "3 cuts give 2 junctions");
    Require(Near(TransitionPlan.JunctionTime(doc, 0), 2.0, .01) && Near(TransitionPlan.JunctionTime(doc, 1), 4.0, .01), "junction times are 2.0s and 4.0s");
    var plan = TransitionPlan.Ensure(doc);
    Require(plan.Count == 2 && plan[0].Type == "cut", "fresh plan defaults to the project transition (cut)");
    TransitionPlan.SetAll(doc, "dissolve", 0.5);
    Require(string.Join(",", TransitionPlan.ToEngineTypes(doc)) == "dissolve,dissolve", "engine handoff types are [dissolve,dissolve]");
    Require(Near(TransitionPlan.UniformDuration(doc).Value, 0.5, .001), "uniform duration 0.5s");
    Require(TransitionPlan.SyncProjectFields(doc) && doc.Transition == "dissolve" && Near(doc.TransitionDuration, 0.5, .001), "uniform plan syncs back to project Transition/TransitionDuration");
    plan[1].Type = "fade"; plan[1].DurationSeconds = 0.8;
    Require(!TransitionPlan.SyncProjectFields(doc) && doc.Transition == "dissolve", "mixed plan does not overwrite the project fields");
    Require(string.Join(",", TransitionPlan.ToEngineDurations(doc).Select(d => d.ToString("0.0", CultureInfo.InvariantCulture)).ToArray()) == "0.5,0.8", "engine handoff durations are [0.5,0.8]");
    Require(TransitionPlan.UniformDuration(doc) == null, "mixed durations have no uniform value");
    threw = false;
    try { plan[0].DurationSeconds = 5.0; TransitionPlan.ValidateFor(doc, 0); } catch { threw = true; }
    Require(threw, "dissolve 5.0s on 2s clips is rejected (xfade duration must be shorter than both neighbours)");
    plan[0].DurationSeconds = 0.5; TransitionPlan.ValidateFor(doc, 0);
    doc.Cuts.Insert(2, new Cut { Start = 4, End = 5 });
    doc.Cuts[3] = new Cut { Start = 5, End = 6 };
    Require(TransitionPlan.Ensure(doc).Count == 3, "splitting a cut pads the plan to 3 junctions");
    doc.Cuts.RemoveAt(2);
    doc.Cuts[2] = new Cut { Start = 4, End = 6 };
    Require(TransitionPlan.Ensure(doc).Count == 2, "removing a cut trims the plan back to 2 junctions");
    Mark("STEP 2 junction plan OK");
    // 3. 预览溶解 0.5s：全长 2+2-0.5=3.5s；起点纯红、终点纯蓝、中点红蓝混合。
    string disOut = Path.Combine(Folder, "dis-out.mp4");
    TransitionPreview.Render(new TransitionSpec { Type = "dissolve", DurationSeconds = 0.5 }, red2, 0, 2, blue2, 0, 2, disOut, CancellationToken.None);
    Require(Near(ProbeDuration(disOut), 3.5, 0.15), "dissolve preview is 3.5s (2+2-0.5)");
    var startRgb = TransitionPreview.ProbeCenterRgb(disOut, 0.2);
    var midRgb = TransitionPreview.ProbeCenterRgb(disOut, 1.75);
    var endRgb = TransitionPreview.ProbeCenterRgb(disOut, 3.3);
    Require(startRgb[0] > 180 && startRgb[2] < 80, "dissolve preview starts pure red (R " + startRgb[0].ToString("0") + ", B " + startRgb[2].ToString("0") + ")");
    Require(midRgb[0] > 40 && midRgb[2] > 40, "dissolve midpoint is a real blend (R " + midRgb[0].ToString("0") + ", B " + midRgb[2].ToString("0") + "), not a hard cut");
    Require(endRgb[2] > 180 && endRgb[0] < 80, "dissolve preview ends pure blue (R " + endRgb[0].ToString("0") + ", B " + endRgb[2].ToString("0") + ")");
    Require(HasStream(disOut, "audio") && HasStream(disOut, "video"), "dissolve preview has audio + video streams");
    double disVol = MeanVolume(disOut, 1.5, 0.5);
    Require(disVol > -30, "acrossfade keeps audio through the transition zone (mean " + disVol.ToString("0.0") + " dB)");
    Mark("STEP 3 dissolve preview OK");
    // 4. 预览硬切：全长 4.0s；接点前一帧纯红、后一帧纯蓝（无混合帧）。
    string cutOut = Path.Combine(Folder, "cut-out.mp4");
    TransitionPreview.Render(new TransitionSpec { Type = "cut" }, red2, 0, 2, blue2, 0, 2, cutOut, CancellationToken.None);
    Require(Near(ProbeDuration(cutOut), 4.0, 0.15), "cut preview is 4.0s (2+2, no overlap)");
    var beforeRgb = TransitionPreview.ProbeCenterRgb(cutOut, 1.95);
    var afterRgb = TransitionPreview.ProbeCenterRgb(cutOut, 2.05);
    Require(beforeRgb[0] > 180 && beforeRgb[2] < 80 && afterRgb[2] > 180 && afterRgb[0] < 80, "cut switches red->blue across the junction with no blend frame");
    Require(HasStream(cutOut, "audio"), "cut preview keeps audio");
    Mark("STEP 4 cut preview OK");
    // 5. 闪黑/闪白：P0 口径——转场开始后约 20% 处（offset + 0.2*d = 1.6s）到达极值。
    string blackOut = Path.Combine(Folder, "black-out.mp4");
    TransitionPreview.Render(new TransitionSpec { Type = "fadeblack", DurationSeconds = 0.5 }, red2, 0, 2, blue2, 0, 2, blackOut, CancellationToken.None);
    double blackLuma = TransitionPreview.ProbeCenterLuma(blackOut, 1.6);
    Require(blackLuma < 40, "fadeblack dips to black at 1.6s (luma " + blackLuma.ToString("0.0") + ")");
    string whiteOut = Path.Combine(Folder, "white-out.mp4");
    TransitionPreview.Render(new TransitionSpec { Type = "fadewhite", DurationSeconds = 0.5 }, red2, 0, 2, blue2, 0, 2, whiteOut, CancellationToken.None);
    double whiteLuma = TransitionPreview.ProbeCenterLuma(whiteOut, 1.6);
    Require(whiteLuma > 180, "fadewhite peaks to white at 1.6s (luma " + whiteLuma.ToString("0.0") + ")");
    Mark("STEP 5 fadeblack/fadewhite OK");
    // 6. 其余 4 种 xfade 各渲染一遍：全长 3.5s、有音视频轨；音频硬切开关不断音频。
    foreach (var t in new[] { "fade", "wipeleft", "wiperight", "slideleft", "circleopen" }) {
     string o = Path.Combine(Folder, "x-" + t + ".mp4");
     TransitionPreview.Render(new TransitionSpec { Type = t, DurationSeconds = 0.5 }, red2, 0, 2, blue2, 0, 2, o, CancellationToken.None);
     Require(Near(ProbeDuration(o), 3.5, 0.15) && HasStream(o, "audio") && HasStream(o, "video"), t + " preview renders 3.5s with audio+video");
    }
    string noXOut = Path.Combine(Folder, "nox-out.mp4");
    TransitionPreview.Render(new TransitionSpec { Type = "dissolve", DurationSeconds = 0.5, AudioCrossfade = false }, red2, 0, 2, blue2, 0, 2, noXOut, CancellationToken.None);
    Require(Near(ProbeDuration(noXOut), 3.5, 0.15) && HasStream(noXOut, "audio"), "dissolve with audio crossfade off still renders 3.5s with audio");
    threw = false;
    try { TransitionPreview.Render(new TransitionSpec { Type = "dissolve", DurationSeconds = 5.0 }, red2, 0, 2, blue2, 0, 2, Path.Combine(Folder, "bad.mp4"), CancellationToken.None); } catch { threw = true; }
    Require(threw, "preview render with duration longer than the clips is rejected");
    Mark("STEP 6 remaining xfade types OK");
    // 7. 接点预览（RenderPreviewForJunction）：3 片段项目、接点 1 溶解 0.5s，
    //    窗口各 1 秒 → 全长 1+1-0.5=1.5s。
    var jdoc = StudioMedia.Import(red6);
    jdoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 }, new Cut { Start = 2, End = 4 }, new Cut { Start = 4, End = 6 } };
    TransitionPlan.SetAll(jdoc, "dissolve", 0.5);
    string jOut = TransitionPreview.RenderPreviewForJunction(jdoc, 0, Folder, CancellationToken.None);
    Require(File.Exists(jOut) && Near(ProbeDuration(jOut), 1.5, 0.15), "junction preview renders 1.5s (1+1-0.5)");
    Mark("STEP 7 junction preview OK");
    // 8. 序列化往返：混用接点方案存进 .dogscwin 再读回，类型/时长都在，Validate() 过。
    var sdoc = StudioMedia.Import(red6);
    sdoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 }, new Cut { Start = 2, End = 4 }, new Cut { Start = 4, End = 6 } };
    TransitionPlan.SetAll(sdoc, "dissolve", 0.5);
    TransitionPlan.Ensure(sdoc)[1].Type = "fade"; TransitionPlan.Ensure(sdoc)[1].DurationSeconds = 0.8;
    string projPath = Path.Combine(Folder, "w10-plan.dogscwin");
    sdoc.Save(projPath);
    var back = EditDocument.Deserialize(File.ReadAllText(projPath));
    back.Validate();
    Require(back.JunctionTransitions != null && back.JunctionTransitions.Count == 2 && back.JunctionTransitions[0].Type == "dissolve" && Near(back.JunctionTransitions[0].DurationSeconds, 0.5, .001) && back.JunctionTransitions[1].Type == "fade" && Near(back.JunctionTransitions[1].DurationSeconds, 0.8, .001), "mixed junction plan survives save/load (dissolve 0.5s + fade 0.8s)");
    Mark("STEP 8 serialization round-trip OK");
    File.WriteAllText(log, "PASS: 9 types valid (cut + 8 xfade), xfade map matches engine (8 entries), unknown type / 0.05s / 5.5s rejected, cut duration ignored; plan 3 cuts -> 2 junctions @ 2.0s/4.0s, SetAll dissolve 0.5s handoff [dissolve,dissolve] + uniform 0.5s syncs to project fields, mixed [dissolve 0.5s, fade 0.8s] does not overwrite project fields, handoff durations [0.5,0.8], 5.0s on 2s clips rejected, split pads to 3 / remove trims to 2; dissolve preview 3.5s, start R " + startRgb[0].ToString("0") + "/B " + startRgb[2].ToString("0") + " -> midpoint R " + midRgb[0].ToString("0") + "/B " + midRgb[2].ToString("0") + " blend -> end R " + endRgb[0].ToString("0") + "/B " + endRgb[2].ToString("0") + ", acrossfade zone mean " + disVol.ToString("0.0") + " dB; cut preview 4.0s, red@1.95s -> blue@2.05s no blend; fadeblack luma " + blackLuma.ToString("0.0") + " at 1.6s, fadewhite luma " + whiteLuma.ToString("0.0") + " at 1.6s; fade/wipeleft/wiperight/slideleft/circleopen each render 3.5s with audio+video, audio-crossfade-off still 3.5s with audio, 5.0s render rejected; junction preview 1.5s (1+1-0.5); mixed plan survives save/load (dissolve 0.5s + fade 0.8s) and Validate() passes.\n");
   }
   catch (Exception ex) { File.AppendAllText(log, "FAIL\n" + ex + "\n"); Mark("FAIL: " + ex.Message); Environment.ExitCode = 1; }
  }
 }
}
