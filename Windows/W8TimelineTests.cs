// W8 自测（2026-11-18）：--w8timeline-test 入口，无窗口，纯逻辑 + 合成素材实测。
// 跑在云端构建里（build-test.yml 的 W8 checks 步），结果写
// Windows/bin/w8timeline-results.txt（PASS: 开头才算过）。本地 Linux 跑不了 WPF，
// 但这些测试不碰窗口，只碰模型/滤镜串/ffmpeg/真实导出，所以云端是唯一可信的验证。
// 断言值全部来自已验证的引擎口径（见 W8TimelinePanels.cs 头注释的出处）与
// 本地 FFmpeg 8.1.2 探针：正弦满幅 volumedetect 均值约 -9 dB、数字静音 -inf（记 -91）；
// 灰 128 源中心亮度约 128；节拍 120 BPM（0.5 秒一拍）。
// 云端 runner 无真 GPU/摄像头/麦克风：面板拖动、导出窗口交互、真机录音
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
 static class W8TimelineTests {
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
  static bool HasStream(string file, string type) {
   string text = Probe("-v error -show_entries stream=codec_type -of csv=p=0 " + Media.Q(file));
   foreach (string line in text.Split('\n')) if (line.Trim() == type) return true;
   return false;
  }
  static double MeanVolume(string file, double from, double duration) {
   // 注意：不能加 -v error——volumedetect 的统计是 info 级输出，加了就看不到 mean_volume。
   using (var p = Media.Start("ffmpeg", "-ss " + Media.N(from) + " -t " + Media.N(duration) + " -i " + Media.Q(file) + " -af volumedetect -f null -", false)) {
    var err = p.StandardError.ReadToEndAsync();
    p.StandardInput.Close();
    p.WaitForExit();
    if (p.ExitCode != 0) throw new Exception("volumedetect 失败：" + err.Result);
    foreach (string raw in err.Result.Split('\n')) {
     string line = raw.Trim();
     if (line.StartsWith("mean_volume:", StringComparison.Ordinal)) {
      string v = line.Substring(12).Trim();
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
  static double MeanLumaCenter(string file, double time) {
   byte[] png = StudioMedia.Frame(file, time, 640, CancellationToken.None);
   using (var ms = new MemoryStream(png))
   using (var bmp = new D.Bitmap(ms)) {
    double sum = 0; int n = 0;
    for (int y = bmp.Height / 2 - 32; y < bmp.Height / 2 + 32; y += 4)
     for (int x = bmp.Width / 2 - 32; x < bmp.Width / 2 + 32; x += 4) {
      var c = bmp.GetPixel(x, y);
      sum += (c.R + c.G + c.B) / 3.0; n++;
     }
    return sum / n;
   }
  }
  public static void Run() {
   Folder = Path.Combine(Media.Root, "bin", "w8timeline-test");
   Directory.CreateDirectory(Folder);
   string log = Path.Combine(Media.Root, "bin", "w8timeline-results.txt");
   LogPath = log;
   File.WriteAllText(log, "RUNNING\n");
   try {
    // 素材：6 秒 testsrc2 + 440Hz 正弦（只在 2–4 秒有声，其余静音）；
    // 4 秒灰 128；4 秒 880Hz 节拍音（50ms 一声、0.5 秒一拍 = 120 BPM）。
    string srcA = Path.Combine(Folder, "w8-src.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=6 -f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=6,volume='if(between(t,2,4),1,0)':eval=frame\" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(srcA));
    string greySrc = Path.Combine(Folder, "w8-grey.mp4");
    RunFfmpeg("-v error -y -f lavfi -i color=c=0x808080:size=640x360:rate=30:duration=4 -f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=4\" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(greySrc));
    string clickSrc = Path.Combine(Folder, "w8-click.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=4 -f lavfi -i \"sine=frequency=880:sample_rate=48000:duration=4,volume='if(lt(mod(t,0.5),0.05),1,0)':eval=frame\" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(clickSrc));
    Mark("STEP 0 sources OK");
    // 1. 复合片段：验证 + 展开/折叠大纲 + 中间片渲染。
    var child = StudioMedia.Import(srcA);
    child.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 }, new Cut { Start = 2, End = 4 } };
    string childPath = Path.Combine(Folder, "child.dogscwin");
    child.Save(childPath);
    var parent = StudioMedia.Import(srcA);
    var cc = new CompoundClip { Name = "子", ProjectPath = childPath, In = 1, Out = 3, Depth = 0 };
    parent.CompoundClips = new List<CompoundClip> { cc };
    var collapsed = CompoundTimeline.Outline(parent, null);
    Require(collapsed.Count == 2 && collapsed[1].IsCompound && !collapsed[1].Expanded && Near(collapsed[1].Start, 6, .01) && Near(collapsed[1].End, 8, .01), "compound collapsed outline is 1 cut row + 1 compound row [6,8]");
    cc.Expanded = true;
    var children = new Dictionary<string, EditDocument> { { childPath, child } };
    var expanded = CompoundTimeline.Outline(parent, children);
    Require(expanded.Count == 3 && !expanded[1].IsCompound && Near(expanded[1].Start, 6, .01) && Near(expanded[1].End, 7, .01) && Near(expanded[2].Start, 7, .01) && Near(expanded[2].End, 8, .01) && expanded[1].Depth == 1, "compound expanded outline shows windowed child rows [6,7]+[7,8] at depth 1");
    bool threw = false;
    try { CompoundTimeline.ValidateClip(new CompoundClip { ProjectPath = childPath, In = 0, Out = 2, Depth = 2 }, child.Length); } catch { threw = true; }
    Require(threw, "compound depth 2 is rejected (max 2 levels)");
    threw = false;
    try { CompoundTimeline.ValidateClip(new CompoundClip { ProjectPath = childPath, In = 0, Out = 99, Depth = 0 }, child.Length); } catch { threw = true; }
    Require(threw, "compound window past child duration is rejected");
    cc.Expanded = false;
    string render = CompoundTimeline.RenderIntermediate(child, cc, 0, Folder, 360, 30, CancellationToken.None);
    Require(File.Exists(render) && Near(StudioMedia.Import(render).Duration, 2.0, 0.15), "compound intermediate render.mp4 is 2.0s window [1,3] (got " + StudioMedia.Import(render).Duration.ToString("0.00") + "s)");
    Mark("STEP 1 compound OK");
    // 2. 导出队列：增删/排序/逐个跑、中间失败不堵后面、未知预设只坏该项。
    var qdoc = StudioMedia.Import(srcA);
    qdoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 } };
    var qdocShort = StudioMedia.Import(srcA);
    qdocShort.Cuts = new List<Cut> { new Cut { Start = 0, End = 1 } };
    var qdocBad = StudioMedia.Import(srcA);
    qdocBad.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 } };
    qdocBad.Source = Path.Combine(Folder, "missing.mp4");
    var queue = new List<ExportQueueItem>();
    queue = ExportQueue.Add(queue, new ExportQueueItem { Id = "q1", Label = "第一段", Doc = qdoc, Output = Path.Combine(Folder, "q1.mp4"), Options = new ExportOptions { PresetName = "SDR 1080p", Height = 360, Fps = 30, Codec = "h264", Crf = 18 } });
    queue = ExportQueue.Add(queue, new ExportQueueItem { Id = "q2", Label = "坏源", Doc = qdocBad, Output = Path.Combine(Folder, "q2.mp4"), Options = new ExportOptions { PresetName = "SDR 1080p", Height = 360, Fps = 30, Codec = "h264", Crf = 18 } });
    queue = ExportQueue.Add(queue, new ExportQueueItem { Id = "q3", Label = "第三段", Doc = qdocShort, Output = Path.Combine(Folder, "q3.mp4"), Options = new ExportOptions { PresetName = "SDR 1080p", Height = 360, Fps = 30, Codec = "h264", Crf = 18 } });
    threw = false;
    try { ExportQueue.Add(queue, new ExportQueueItem { Id = "q1", Label = "重名", Doc = qdoc, Output = Path.Combine(Folder, "q1b.mp4"), Options = new ExportOptions { PresetName = "SDR 1080p", Height = 360, Fps = 30, Codec = "h264", Crf = 18 } }); } catch { threw = true; }
    Require(threw, "queue duplicate id is rejected");
    threw = false;
    try { ExportQueue.Move(queue, "q1", 99); } catch { threw = true; }
    Require(threw, "queue move out of range is rejected");
    threw = false;
    try { ExportQueue.Remove(queue, "nope"); } catch { threw = true; }
    Require(threw, "queue remove unknown id is rejected");
    queue = ExportQueue.Move(queue, "q3", 0);
    Require(queue[0].Id == "q3" && queue[1].Id == "q1" && queue[2].Id == "q2", "queue move reorders (q3 first)");
    var results = ExportQueue.Run(queue, (v, s) => { }, CancellationToken.None);
    Require(results.Count == 3 && results[0].Status == "done" && results[1].Status == "done" && results[2].Status == "failed", "queue runs in order, failed middle item does not block the rest (got " + string.Join(",", results.Select(r => r.Id + ":" + r.Status).ToArray()) + ")");
    Require(File.Exists(Path.Combine(Folder, "q1.mp4")) && File.Exists(Path.Combine(Folder, "q3.mp4")) && !File.Exists(Path.Combine(Folder, "q2.mp4")), "queue outputs: q1/q3 exist, failed q2 has no file");
    var badPreset = ExportQueue.Run(new List<ExportQueueItem> { new ExportQueueItem { Id = "qp", Label = "坏预设", Doc = qdocShort, Output = Path.Combine(Folder, "qp.mp4"), Options = new ExportOptions { PresetName = "不存在的预设", Height = 360, Fps = 30, Codec = "h264", Crf = 18 } } }, (v, s) => { }, CancellationToken.None);
    Require(badPreset.Count == 1 && badPreset[0].Status == "failed" && badPreset[0].Error.Contains("未知导出预设"), "queue unknown preset fails only that item");
    Mark("STEP 2 export queue OK");
    // 3. J/L 剪辑：视频 [0,2]（本是静音段），音频窗口 [1,3]（与视频窗口重叠，
    //    后半段 [2,3] 有音）→ 前 2 秒后半段应有音；窗口须与视频重叠是引擎
    //    validateJLClip 的硬性要求（完全不重叠的窗口应被拒绝，见下面反向用例）。
    var jlDoc = StudioMedia.Import(srcA);
    jlDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2, AudioIn = 1, AudioOut = 3 }, new Cut { Start = 2, End = 4 } };
    string jlOut = Path.Combine(Folder, "jl-out.mp4");
    StudioRenderer.Export(jlDoc, jlOut, 360, 30, (v, s) => { }, CancellationToken.None);
    double jlVol = MeanVolume(jlOut, 0, 2);
    Require(jlVol > -30, "J cut: audio window [1,3] on video [0,2] brings tone into first 2s (mean " + jlVol.ToString("0.0") + " dB)");
    var ctlDoc = StudioMedia.Import(srcA);
    ctlDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 }, new Cut { Start = 2, End = 4 } };
    string ctlOut = Path.Combine(Folder, "jl-ctl.mp4");
    StudioRenderer.Export(ctlDoc, ctlOut, 360, 30, (v, s) => { }, CancellationToken.None);
    double ctlVol = MeanVolume(ctlOut, 0, 2);
    Require(ctlVol < -60, "control without J/L is silent in first 2s (mean " + ctlVol.ToString("0.0") + " dB)");
    threw = false;
    try { JlAudio.Validate(new Cut { Start = 2, End = 4, AudioIn = 0, AudioOut = 1 }, 6); } catch { threw = true; }
    Require(threw, "J/L window with no overlap with the video window is rejected");
    threw = false;
    try { JlAudio.Validate(new Cut { Start = 0, End = 2, Speed = 2, AudioIn = 0, AudioOut = 2 }, 6); } catch { threw = true; }
    Require(threw, "J/L window on a speed-changed clip is rejected");
    Mark("STEP 3 J/L OK");
    // 4. 音画联动锁定：联动删整段；关时（或 Alt）只删视频留音频；波纹关留空隙。
    var linkDoc = StudioMedia.Import(srcA);
    linkDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 }, new Cut { Start = 2, End = 4 }, new Cut { Start = 4, End = 6 } };
    TimelineLink.DeleteCut(linkDoc, 1, true, false);
    Require(linkDoc.Cuts.Count == 2 && Near(linkDoc.Length, 4, .01), "linked delete removes the whole clip (3 cuts -> 2, length 6 -> 4)");
    var unDoc = StudioMedia.Import(srcA);
    unDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 }, new Cut { Start = 2, End = 4 }, new Cut { Start = 4, End = 6 } };
    TimelineLink.DeleteCut(unDoc, 1, true, true);
    Require(unDoc.Cuts.Count == 3 && unDoc.Cuts[1].AudioOnly && Near(unDoc.Length, 6, .01), "Alt delete keeps the audio as an audio-only clip (count stays 3, length stays 6)");
    string unOut = Path.Combine(Folder, "unlinked-out.mp4");
    StudioRenderer.Export(unDoc, unOut, 360, 30, (v, s) => { }, CancellationToken.None);
    double blackLuma = MeanLumaCenter(unOut, 3);
    double liveLuma = MeanLumaCenter(unOut, 1);
    Require(blackLuma < 10 && liveLuma > 30, "audio-only clip renders black video (luma " + blackLuma.ToString("0.0") + " at t=3) while neighbours stay live (" + liveLuma.ToString("0.0") + " at t=1)");
    double keptVol = MeanVolume(unOut, 2, 2);
    Require(keptVol > -30, "audio-only clip keeps its audio (mean " + keptVol.ToString("0.0") + " dB in [2,4])");
    var gapDoc = StudioMedia.Import(srcA);
    gapDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 }, new Cut { Start = 2, End = 4 }, new Cut { Start = 4, End = 6 } };
    TimelineLink.DeleteCut(gapDoc, 1, false, false);
    Require(gapDoc.Cuts.Count == 3 && gapDoc.Cuts[1].Gap && Near(gapDoc.Length, 6, .01), "linked delete with ripple off leaves a gap (length stays 6)");
    Mark("STEP 4 linked selection OK");
    // 5. 时间线索引搜索。
    var sdoc = StudioMedia.Import(srcA);
    sdoc.RecordingMarkers.Add(new RecordingMarker { Time = 1, Label = "Intro" });
    sdoc.Subtitles.Add(new SubtitleCue { Start = 3, End = 3.8, Text = "你好世界" });
    sdoc.Mixer.Add(new MixerChannel { Role = "音乐", SourcePath = "", Start = 0 });
    var hitsIntro = TimelineSearch.Search(sdoc, "intro");
    Require(hitsIntro.Count == 1 && hitsIntro[0].Type == "marker" && Near(hitsIntro[0].Time, 1, .01), "search 'intro' hits the marker at 1.0s");
    var hitsSub = TimelineSearch.Search(sdoc, "你好");
    Require(hitsSub.Count == 1 && hitsSub[0].Type == "subtitle" && Near(hitsSub[0].Time, 3, .01), "search '你好' hits the subtitle at 3.0s");
    var hitsRole = TimelineSearch.Search(sdoc, "音乐");
    Require(hitsRole.Count == 1 && hitsRole[0].Type == "role", "search '音乐' hits the role");
    var hitsClip = TimelineSearch.Search(sdoc, "w8-src");
    Require(hitsClip.Count >= 1 && hitsClip[0].Type == "clip" && Near(hitsClip[0].Time, 0, .01), "search by source filename hits the clip at 0s");
    Require(TimelineSearch.Search(sdoc, "").Count == 0 && TimelineSearch.Search(sdoc, "不存在的词").Count == 0, "empty query and no-match query return no hits");
    Mark("STEP 5 timeline search OK");
    // 6. 三点编辑：插入分裂、覆盖总时长不变、换源保留剪辑点、变速片段拒绝。
    var tpDoc = StudioMedia.Import(srcA);
    tpDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 }, new Cut { Start = 2, End = 6 } };
    ThreePoint.Insert(tpDoc, 0, 1, 1.0);
    Require(tpDoc.Cuts.Count == 4 && Near(tpDoc.Length, 7, .01) && Near(tpDoc.Cuts[1].Start, 0, .01) && Near(tpDoc.Cuts[1].End, 1, .01) && Near(tpDoc.Cuts[2].Start, 1, .01) && Near(tpDoc.Cuts[2].End, 2, .01), "three-point insert splits the clip at 1.0s (4 cuts, length 6 -> 7)");
    var owDoc = StudioMedia.Import(srcA);
    owDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 }, new Cut { Start = 2, End = 6 } };
    ThreePoint.Overwrite(owDoc, 0, 1, 5.0);
    Require(owDoc.Cuts.Count == 3 && Near(owDoc.Length, 6, .01) && Near(owDoc.Cuts[1].Start, 2, .01) && Near(owDoc.Cuts[1].End, 5, .01) && Near(owDoc.Cuts[2].Start, 0, .01) && Near(owDoc.Cuts[2].End, 1, .01), "three-point overwrite replaces [5,6] and keeps total length 6");
    string srcCopy = Path.Combine(Folder, "w8-src-copy.mp4");
    File.Copy(srcA, srcCopy, true);
    var rpDoc = StudioMedia.Import(srcA);
    rpDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 }, new Cut { Start = 2, End = 6 } };
    ThreePoint.ReplaceSource(rpDoc, srcCopy);
    Require(rpDoc.Source == Path.GetFullPath(srcCopy) && rpDoc.Cuts.Count == 2 && Near(rpDoc.Cuts[1].End, 6, .01), "replace footage swaps the source and keeps the edit points");
    threw = false;
    try { ThreePoint.ReplaceSource(rpDoc, greySrc); } catch { threw = true; }
    Require(threw, "replace footage with a shorter file (4s < cut end 6s) is rejected");
    var spdDoc = StudioMedia.Import(srcA);
    spdDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2, Speed = 2 }, new Cut { Start = 2, End = 6 } };
    threw = false;
    try { ThreePoint.Insert(spdDoc, 0, 1, 1.0); } catch { threw = true; }
    Require(threw, "three-point insert into a speed-changed clip is rejected");
    Mark("STEP 6 three-point edit OK");
    // 7. 粘贴属性：变速 + 调色 + 音频快照；源不变；空选拒绝。
    var paSrc = StudioMedia.Import(srcA);
    paSrc.Grade.Brightness = 0.5;
    paSrc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2, Speed = 0.5 } };
    string before = paSrc.Serialize();
    var attrs = PasteAttributes.Capture(paSrc, 0);
    var paDst = StudioMedia.Import(srcA);
    paDst.Cuts = new List<Cut> { new Cut { Start = 0, End = 2, Speed = 1 } };
    PasteAttributes.Paste(paDst, 0, attrs, true, true, true);
    Require(Near(paDst.Cuts[0].Speed, 0.5, .001) && Near(paDst.Grade.Brightness, 0.5, .001), "paste attributes copies speed 0.5x and grade brightness +0.5");
    Require(paSrc.Serialize() == before, "paste attributes never mutates the source");
    threw = false;
    try { PasteAttributes.Paste(paDst, 0, attrs, false, false, false); } catch { threw = true; }
    Require(threw, "paste attributes with no fields selected is rejected");
    var gapPa = StudioMedia.Import(srcA);
    gapPa.Cuts = new List<Cut> { new Cut { Gap = true, GapDuration = 1, Start = 0, End = 0 } };
    threw = false;
    try { PasteAttributes.Capture(gapPa, 0); } catch { threw = true; }
    Require(threw, "copy attributes from a gap clip is rejected");
    Mark("STEP 7 paste attributes OK");
    // 8. 调整层：层内提亮、层外不变；滤镜串带 enable=between；校验拒绝。
    var adjDoc = StudioMedia.Import(greySrc);
    adjDoc.AdjustmentLayers = new List<AdjustmentLayer> { new AdjustmentLayer { Start = 1, End = 3, Brightness = 0.2 } };
    string adjFilter = AdjustmentLayerFilter.Build(adjDoc);
    Require(adjFilter.Contains("brightness=0.2") && adjFilter.Contains("enable='between(t,1,3)'"), "adjustment layer filter carries eq + enable=between(t,1,3) (" + adjFilter + ")");
    string adjOut = Path.Combine(Folder, "adj-out.mp4");
    StudioRenderer.Export(adjDoc, adjOut, 360, 30, (v, s) => { }, CancellationToken.None);
    double outLuma = MeanLumaCenter(adjOut, 0.5);
    double inLuma = MeanLumaCenter(adjOut, 2);
    Require(outLuma > 110 && outLuma < 145 && inLuma - outLuma > 30, "adjustment layer brightens inside the span (luma " + outLuma.ToString("0.0") + " outside -> " + inLuma.ToString("0.0") + " inside)");
    threw = false;
    try { AdjustmentLayerFilter.Validate(new AdjustmentLayer { Start = 0, End = 99, Brightness = 0.2 }, 4); } catch { threw = true; }
    Require(threw, "adjustment layer past the timeline end is rejected");
    threw = false;
    try { AdjustmentLayerFilter.Validate(new AdjustmentLayer { Start = 1, End = 2 }, 4); } catch { threw = true; }
    Require(threw, "adjustment layer with no effect set is rejected");
    Mark("STEP 8 adjustment layer OK");
    // 9. 文字剪切：删词即删对应时间段；词级时间戳不完整拒绝；删光拒绝。
    var txDoc = StudioMedia.Import(srcA);
    txDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 6 } };
    var words = new List<WordItem> {
     new WordItem { Text = "hello", Start = 2, End = 3 },
     new WordItem { Text = "world", Start = 3, End = 4 },
     new WordItem { Text = "keep", Start = 4, End = 5 } };
    double removed = TextCut.Apply(txDoc, words, new List<string> { "hello", "world" });
    Require(Near(removed, 2.0, .05) && Near(txDoc.Length, 4.0, .05), "text cut deletes [2,4] (removed 2.0s, length 6 -> 4)");
    string txOut = Path.Combine(Folder, "tx-out.mp4");
    StudioRenderer.Export(txDoc, txOut, 360, 30, (v, s) => { }, CancellationToken.None);
    Require(Math.Abs(StudioMedia.Import(txOut).Duration - 4) < 0.15, "export after text cut is 4.0s");
    Require(!TextCut.HasWordTimestamps(new List<WordItem> { new WordItem { Text = "x", Start = 1, End = 1 } }), "word with empty time range has no usable timestamps");
    threw = false;
    try { TextCut.Apply(StudioMedia.Import(srcA), new List<WordItem> { new WordItem { Text = "x", Start = 1, End = 1 } }, new List<string> { "x" }); } catch { threw = true; }
    Require(threw, "text cut without word timestamps is rejected");
    var txAll = StudioMedia.Import(srcA);
    txAll.Cuts = new List<Cut> { new Cut { Start = 0, End = 6 } };
    threw = false;
    try { TextCut.Apply(txAll, new List<WordItem> { new WordItem { Text = "all", Start = 0, End = 6 } }, new List<string> { "all" }); } catch { threw = true; }
    Require(threw, "text cut deleting everything is rejected");
    Mark("STEP 9 text cut OK");
    // 10. Remix：节拍检测（120 BPM）+ 按节拍拼贴到 6 秒 + 导出 6 秒；全程不改速。
    var grid = Remix.DetectBeats(clickSrc, 4, CancellationToken.None);
    Require(grid.Bpm > 110 && grid.Bpm < 130 && grid.Beats.Count >= 6, "beat detect on click track: " + grid.Bpm.ToString("0.00") + " BPM, " + grid.Beats.Count + " beats (expect ~120 BPM)");
    var plan = Remix.Plan(grid.Beats, 4, 6);
    Require(Near(plan.Total, 6.0, .001) && plan.Segments.Count >= 2, "remix plan fills 6.0s from 4s of beats (" + plan.Segments.Count + " segments)");
    foreach (var seg in plan.Segments) Require(seg.SourceStart >= -0.001 && seg.SourceEnd <= 4.001 && seg.Length >= 0.1, "remix segment stays inside the source");
    var rxDoc = StudioMedia.Import(clickSrc);
    var remixDoc = Remix.BuildDoc(rxDoc, plan);
    Require(remixDoc.Cuts.All(c => Math.Abs(c.Speed - 1) < 0.000001) && Near(remixDoc.Length, 6.0, .01), "remix doc is all 1x cuts, length 6.0s (no atempo speed change, so no pitch shift)");
    string rxOut = Path.Combine(Folder, "rx-out.mp4");
    StudioRenderer.Export(remixDoc, rxOut, 360, 30, (v, s) => { }, CancellationToken.None);
    Require(Math.Abs(StudioMedia.Import(rxOut).Duration - 6) < 0.15, "remix export is 6.0s");
    threw = false;
    try { Remix.Plan(new List<double> { 1.0 }, 4, 6); } catch { threw = true; }
    Require(threw, "remix with fewer than 2 beats is rejected");
    threw = false;
    try { Remix.Plan(grid.Beats, 4, 0); } catch { threw = true; }
    Require(threw, "remix with target duration 0 is rejected");
    Mark("STEP 10 remix OK");
    // 11. 仅导出三开关：videoOnly 无音轨、audioOnly 无视频轨、subtitleOnly 只出字幕文件。
    Require(ExportOnly.Resolve(false, false, false) == "none" && ExportOnly.Resolve(false, true, false) == "audio" && ExportOnly.Resolve(true, false, false) == "video" && ExportOnly.Resolve(false, false, true) == "subtitle", "export-only resolve maps the three switches");
    threw = false;
    try { ExportOnly.Resolve(true, true, false); } catch { threw = true; }
    Require(threw, "two export-only switches at once are rejected");
    threw = false;
    try { new ExportOptions { Height = 360, Fps = 30, Codec = "h264", Crf = 18, OnlyMode = "both" }.Validate(); } catch { threw = true; }
    Require(threw, "bad OnlyMode string is rejected");
    var voDoc = StudioMedia.Import(srcA);
    voDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 } };
    string voOut = Path.Combine(Folder, "vo-out.mp4");
    StudioRenderer.Export(voDoc, voOut, new ExportOptions { PresetName = "test", Height = 360, Fps = 30, Codec = "h264", Crf = 18, OnlyMode = "video" }, (v, s) => { }, CancellationToken.None);
    Require(!HasStream(voOut, "audio") && HasStream(voOut, "video") && Math.Abs(StudioMedia.Import(voOut).Duration - 2) < 0.15, "video-only export has no audio stream, 2.0s");
    var aoDoc = StudioMedia.Import(srcA);
    aoDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 } };
    string aoOut = Path.Combine(Folder, "ao-out.mp4");
    StudioRenderer.Export(aoDoc, aoOut, new ExportOptions { PresetName = "test", Height = 360, Fps = 30, Codec = "h264", Crf = 18, OnlyMode = "audio" }, (v, s) => { }, CancellationToken.None);
    Require(HasStream(aoOut, "audio") && !HasStream(aoOut, "video") && Math.Abs(StudioMedia.Import(aoOut).Duration - 2) < 0.15, "audio-only export has no video stream, 2.0s");
    var soDoc = StudioMedia.Import(srcA);
    soDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 } };
    soDoc.Subtitles.Add(new SubtitleCue { Start = 0.5, End = 1.5, Text = "测试字幕" });
    string soOut = Path.Combine(Folder, "so-out.mp4");
    StudioRenderer.Export(soDoc, soOut, new ExportOptions { PresetName = "test", Height = 360, Fps = 30, Codec = "h264", Crf = 18, OnlyMode = "subtitle" }, (v, s) => { }, CancellationToken.None);
    string soSrt = Path.Combine(Folder, "so-out.srt");
    Require(File.Exists(soSrt) && File.ReadAllText(soSrt).Contains("测试字幕") && !File.Exists(soOut), "subtitle-only export writes only the .srt sidecar (no mp4 rendered)");
    Mark("STEP 11 export-only switches OK");
    File.WriteAllText(log, "PASS: compound collapsed 2 rows / expanded 3 rows [6,7]+[7,8] depth 1, depth-2/window-overrun rejected, intermediate render.mp4 2.0s; queue move/reorder + run done/done/failed in order (q1/q3 exist, q2 none), duplicate/move/remove rejected, unknown preset fails only that item; J cut audio [1,3] on video [0,2] mean " + jlVol.ToString("0.0") + " dB vs control " + ctlVol.ToString("0.0") + " dB, no-overlap/speed-change rejected; linked delete 3->2 cuts length 6->4, Alt delete keeps audio-only (count 3, length 6, black luma " + blackLuma.ToString("0.0") + " vs live " + liveLuma.ToString("0.0") + ", kept audio " + keptVol.ToString("0.0") + " dB), ripple-off leaves gap; search hits marker 1.0s / subtitle 3.0s / role / clip 0s, empty/no-match none; three-point insert 4 cuts length 6->7, overwrite 3 cuts length stays 6, replace keeps edit points, short-file/speed-change rejected; paste copies speed 0.5x + brightness +0.5, source unchanged, no-fields/gap rejected; adjustment layer filter eq + enable=between(t,1,3), luma " + outLuma.ToString("0.0") + " outside -> " + inLuma.ToString("0.0") + " inside, overrun/no-effect rejected; text cut removes 2.0s (6->4), export 4.0s, no-timestamps/delete-all rejected; remix beat " + grid.Bpm.ToString("0.00") + " BPM/" + grid.Beats.Count + " beats, plan 6.0s all 1x, export 6.0s, <2 beats/target 0 rejected; export-only resolve + mutual exclusion + bad mode rejected, video-only no audio 2.0s, audio-only no video 2.0s, subtitle-only .srt only.\n");
   }
   catch (Exception ex) { File.AppendAllText(log, "FAIL\n" + ex + "\n"); Mark("FAIL: " + ex.Message); Environment.ExitCode = 1; }
  }
 }
}
