// W9 多轨时间线自测（2026-11-19）：--w9mt-test 入口，无窗口，纯逻辑 + 合成素材实测。
// 跑在云端构建里（build-test.yml 的 W9 multitrack checks 步），结果写
// Windows/bin/w9mt-results.txt（PASS: 开头才算过）。本地 Linux 跑不了 WPF，
// 但这些测试不碰窗口，只碰模型/滤镜串/ffmpeg/真实导出，所以云端是唯一可信的验证。
// 断言值出处：引擎 multitrack.ts / filtergraph.ts / export.ts（已合 main，
// verify-multitrack.mjs 95/95）；正弦满幅 volumedetect 均值约 -9 dB、数字静音 -inf
// （记 -91）沿用 W8 探针；红源中心亮度 (255+0+0)/3 = 85。
// 云端 runner 无真 GPU/摄像头/麦克风：面板拖动、播放交互、真机预览
// 只在真机上能验，测试只验模型、滤镜串、真实导出与诚实拒绝。
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
 static class W9MultitrackTests {
  static void Require(bool ok, string name) { if (!ok) throw new Exception("W9 多轨检查失败：" + name); }
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
  static D.Color PixelAt(string file, double time, int x, int y) {
   byte[] png = StudioMedia.Frame(file, time, 640, CancellationToken.None);
   using (var ms = new MemoryStream(png))
   using (var bmp = new D.Bitmap(ms)) return bmp.GetPixel(x, y);
  }
  static string ExportDoc(EditDocument doc, string name) {
   string output = Path.Combine(Folder, name);
   StudioRenderer.Export(doc, output, new ExportOptions { PresetName = "SDR 1080p", Height = 360, Fps = 30, Codec = "h264", Crf = 18 }, (v, s) => { }, CancellationToken.None);
   return output;
  }
  static void PlainStyle(EditDocument doc) {
   doc.Style.Padding = 0; doc.Style.Frame = "none"; doc.Style.Radius = 0; doc.Style.Shadow = 0;
  }
  static bool Throws(Action action, string mustContain) {
   try { action(); } catch (Exception ex) { return mustContain == null || ex.Message.Contains(mustContain); }
   return false;
  }
  public static void Run() {
   Folder = Path.Combine(Media.Root, "bin", "w9mt-test");
   Directory.CreateDirectory(Folder);
   string log = Path.Combine(Media.Root, "bin", "w9mt-results.txt");
   LogPath = log;
   File.WriteAllText(log, "RUNNING\n");
   try {
    // 素材：4 秒红/蓝纯色 + 正弦；4 秒 440/880Hz 纯音频 wav。
    string redSrc = Path.Combine(Folder, "w9mt-red.mp4");
    RunFfmpeg("-v error -y -f lavfi -i color=c=red:size=640x360:rate=30:duration=4 -f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=4\" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(redSrc));
    string blueSrc = Path.Combine(Folder, "w9mt-blue.mp4");
    RunFfmpeg("-v error -y -f lavfi -i color=c=blue:size=640x360:rate=30:duration=4 -f lavfi -i \"sine=frequency=880:sample_rate=48000:duration=4\" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(blueSrc));
    string wav440 = Path.Combine(Folder, "w9mt-440.wav");
    RunFfmpeg("-v error -y -f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=4\" -t 4 " + Media.Q(wav440));
    string wav880 = Path.Combine(Folder, "w9mt-880.wav");
    RunFfmpeg("-v error -y -f lavfi -i \"sine=frequency=880:sample_rate=48000:duration=4\" -t 4 " + Media.Q(wav880));
    Mark("STEP 0 sources OK");
    // 1. 旧单轨加载等价：Normalize 后 1 视频轨 + 1 音频轨，时长一致，导出时长/画面与改前一致。
    var legacy = StudioMedia.Import(redSrc);
    legacy.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 }, new Cut { Start = 2, End = 4 } };
    PlainStyle(legacy);
    string legOut = ExportDoc(legacy, "w9mt-legacy.mp4");
    Require(Near(ProbeDuration(legOut), 4.0, .15), "legacy export is 4.0s (got " + ProbeDuration(legOut).ToString("0.00") + "s)");
    double legLuma = MeanLumaCenter(legOut, 1);
    var mt = EditDocument.Deserialize(legacy.Serialize());
    MultitrackDoc.Normalize(mt);
    Require(mt.VideoTracks.Count == 1 && mt.AudioTracks.Count == 1, "normalize gives 1 video + 1 audio track");
    Require(mt.VideoTracks[0].Clips.Count == 2 && Near(mt.VideoTracks[0].Clips[0].Start, 0, .01) && Near(mt.VideoTracks[0].Clips[1].Start, 2, .01), "normalize keeps clip starts 0s + 2s");
    Require(Near(mt.Length, 4.0, .01) && Near(MultitrackDoc.Duration(mt), 4.0, .01), "multitrack duration is 4.0s");
    Require(mt.Cuts.Count == 2, "legacy fallback Cuts refilled from video track 0 (2 cuts)");
    var rt = EditDocument.Deserialize(mt.Serialize());
    Require(rt.VideoTracks.Count == 1 && rt.AudioTracks.Count == 1 && rt.VideoTracks[0].Clips.Count == 2, "tracks survive save/load round-trip");
    string mtOut = ExportDoc(mt, "w9mt-normalized.mp4");
    Require(Near(ProbeDuration(mtOut), 4.0, .15), "multitrack export is 4.0s (got " + ProbeDuration(mtOut).ToString("0.00") + "s)");
    double mtLuma = MeanLumaCenter(mtOut, 1);
    Require(Near(mtLuma, legLuma, 12), "multitrack frame matches legacy frame (luma " + mtLuma.ToString("0.0") + " vs legacy " + legLuma.ToString("0.0") + ")");
    Mark("STEP 1 legacy equivalence OK");
    // 2. 双视频轨 overlay：上轨 0.5 画幅在左上，角点蓝、右下红。
    var ov = EditDocument.Deserialize(mt.Serialize());
    PlainStyle(ov);
    var top = MultitrackDoc.AddVideoTrack(ov, "蓝角");
    top.W = 0.5; top.H = 0.5; top.X = 0; top.Y = 0;
    top.Clips.Add(new MtClip { Id = "blue1", Source = blueSrc, In = 0, Out = 4, Speed = 1, Volume = 1, Start = 0 });
    string ovOut = ExportDoc(ov, "w9mt-overlay.mp4");
    Require(Near(ProbeDuration(ovOut), 4.0, .15), "overlay export is 4.0s");
    var tl = PixelAt(ovOut, 1, 10, 10);
    var br = PixelAt(ovOut, 1, 630, 350);
    Require(tl.B > 150 && tl.R < 100, "overlay top-left corner is blue (R" + tl.R + " G" + tl.G + " B" + tl.B + ")");
    Require(br.R > 150 && br.B < 100, "overlay bottom-right corner is red (R" + br.R + " G" + br.G + " B" + br.B + ")");
    Mark("STEP 2 overlay OK");
    // 3. 双音频轨 amix：两路 0.5 音量混音比单路满幅低约 3 dB；静音/独奏只留一轨（约 -6 dB）；全静音 -inf。
    var au = EditDocument.Deserialize(mt.Serialize());
    PlainStyle(au);
    au.VideoTracks[0].Clips[0].Volume = 0; au.VideoTracks[0].Clips[1].Volume = 0;
    au.AudioTracks[0].Clips.Add(new MtClip { Id = "a440", Source = wav440, In = 0, Out = 2, Speed = 1, Volume = 0.5, Start = 0 });
    var a1 = MultitrackDoc.AddAudioTrack(au, "880");
    a1.Clips.Add(new MtClip { Id = "a880", Source = wav880, In = 0, Out = 2, Speed = 1, Volume = 0.5, Start = 0 });
    var base1 = EditDocument.Deserialize(au.Serialize());
    base1.AudioTracks[1].Clips.Clear();
    base1.AudioTracks[0].Clips[0].Volume = 1;
    string baseOut = ExportDoc(base1, "w9mt-audio-base.mp4");
    double vBase = MeanVolume(baseOut, 0, 2);
    string bothOut = ExportDoc(au, "w9mt-audio-both.mp4");
    double vBoth = MeanVolume(bothOut, 0, 2);
    Require(Near(vBoth, vBase - 3, 1.5), "amix of two 0.5 tracks is base-3dB (both " + vBoth.ToString("0.0") + " dB vs base " + vBase.ToString("0.0") + " dB)");
    a1.Mute = true;
    string muteOut = ExportDoc(au, "w9mt-audio-mute.mp4");
    double vMute = MeanVolume(muteOut, 0, 2);
    Require(Near(vMute, vBase - 6, 1.5), "muted track leaves one 0.5 track (mute " + vMute.ToString("0.0") + " dB vs base " + vBase.ToString("0.0") + " dB)");
    a1.Mute = false; au.AudioTracks[0].Solo = true;
    string soloOut = ExportDoc(au, "w9mt-audio-solo.mp4");
    double vSolo = MeanVolume(soloOut, 0, 2);
    Require(Near(vSolo, vBase - 6, 1.5), "solo leaves only the solo track (solo " + vSolo.ToString("0.0") + " dB vs base " + vBase.ToString("0.0") + " dB)");
    au.AudioTracks[0].Mute = true; au.AudioTracks[0].Solo = false; a1.Mute = true;
    string silentOut = ExportDoc(au, "w9mt-audio-silent.mp4");
    double vSilent = MeanVolume(silentOut, 0, 2);
    Require(vSilent <= -90, "all audio tracks muted is digital silence (got " + vSilent.ToString("0.0") + " dB)");
    // 同轨音频重叠硬切：导出成功、时长不变。
    var ov2 = EditDocument.Deserialize(au.Serialize());
    ov2.AudioTracks[0].Mute = false; ov2.AudioTracks[1].Mute = false;
    ov2.AudioTracks[0].Clips.Add(new MtClip { Id = "a880b", Source = wav880, In = 0, Out = 2, Speed = 1, Volume = 0.5, Start = 1 });
    string ov2Out = ExportDoc(ov2, "w9mt-audio-overlap.mp4");
    Require(Near(ProbeDuration(ov2Out), 4.0, .15), "same-track audio overlap hard-cuts and exports 4.0s");
    Mark("STEP 3 amix/mute/solo OK");
    // 4. 轨间拖动改 trackId：视频片段移到音频轨再移回；锁定轨拒绝移入。
    var mv = EditDocument.Deserialize(mt.Serialize());
    MultitrackDoc.MoveClip(mv, "video", "v0", 0, "audio", "a0", 1.5);
    Require(mv.VideoTracks[0].Clips.Count == 1 && mv.AudioTracks[0].Clips.Count == 1 && Near(mv.AudioTracks[0].Clips[0].Start, 1.5, .01), "cross-track move changes trackId and start (video v0 -> audio a0 @1.5s)");
    MultitrackDoc.MoveClip(mv, "audio", "a0", 0, "video", "v0", 0);
    Require(mv.VideoTracks[0].Clips.Count == 2 && mv.AudioTracks[0].Clips.Count == 0, "move back restores 2 video clips");
    var lockTr = MultitrackDoc.AddVideoTrack(mv, "锁");
    lockTr.Locked = true;
    Require(Throws(() => MultitrackDoc.MoveClip(mv, "video", "v0", 0, "video", lockTr.Id, 0), "锁定"), "move into locked track is rejected");
    Require(mv.VideoTracks[0].Clips.Count == 2, "rejected move leaves the clip on its original track");
    Mark("STEP 4 cross-track move OK");
    // 5. 不可见轨不破坏导出：上轨隐藏后角点回到下层红色，时长不变。
    var hid = EditDocument.Deserialize(ov.Serialize());
    hid.VideoTracks[1].Visible = false;
    string hidOut = ExportDoc(hid, "w9mt-hidden.mp4");
    Require(Near(ProbeDuration(hidOut), 4.0, .15), "hidden-track export is 4.0s");
    var hidTl = PixelAt(hidOut, 1, 10, 10);
    Require(hidTl.R > 150 && hidTl.B < 100, "hidden top track shows the red track below (R" + hidTl.R + " B" + hidTl.B + ")");
    Mark("STEP 5 hidden track OK");
    // 6. 诚实拒绝：多轨上 silenceCut/textCut/remix/vocalSep/roleStems 入口拒绝；
    // 人声分离开着导出直接拒绝；校验规则（opacity/blend 冲突/重复 id/负起片/
    // transitionIn 越界）逐项拒绝，合法项目放行。
    var gd = EditDocument.Deserialize(mt.Serialize());
    Require(Throws(() => MultitrackGuard.RequireSingleTrack(gd, "一键删静音"), "暂不支持"), "silenceCut refused on multitrack");
    Require(Throws(() => MultitrackGuard.RequireSingleTrack(gd, "文字剪切"), "暂不支持"), "textCut refused on multitrack");
    Require(Throws(() => MultitrackGuard.RequireSingleTrack(gd, "Remix"), "暂不支持"), "remix refused on multitrack");
    Require(Throws(() => MultitrackGuard.RequireSingleTrack(gd, "人声分离"), "暂不支持"), "vocalSep refused on multitrack");
    Require(Throws(() => MultitrackGuard.RequireSingleTrack(gd, "分轨导出"), "暂不支持"), "roleStems refused on multitrack");
    var vs = EditDocument.Deserialize(mt.Serialize());
    vs.VocalSep.Mode = "人声"; vs.VocalSep.VocalsPath = wav440;
    Require(Throws(() => StudioRenderer.Export(vs, Path.Combine(Folder, "w9mt-vs.mp4"), new ExportOptions { PresetName = "SDR 1080p", Height = 360, Fps = 30, Codec = "h264", Crf = 18 }, (v, s) => { }, CancellationToken.None), "多轨"), "export with vocalSep enabled is refused on multitrack");
    var bad = EditDocument.Deserialize(mt.Serialize());
    bad.VideoTracks[0].Opacity = 1.5;
    Require(Throws(() => MultitrackDoc.Validate(bad), "不透明度"), "opacity > 1 rejected");
    bad = EditDocument.Deserialize(mt.Serialize());
    bad.VideoTracks[0].Blend = "multiply"; bad.VideoTracks[0].X = 10;
    Require(Throws(() => MultitrackDoc.Validate(bad), "混合模式"), "blend + offset rejected");
    bad = EditDocument.Deserialize(mt.Serialize());
    bad.AudioTracks[0].Id = "v0";
    Require(Throws(() => MultitrackDoc.Validate(bad), "重复"), "duplicate track id rejected");
    bad = EditDocument.Deserialize(mt.Serialize());
    bad.VideoTracks[0].Clips[0].Start = -1;
    Require(Throws(() => MultitrackDoc.Validate(bad), "起始时间"), "negative clip start rejected");
    bad = EditDocument.Deserialize(mt.Serialize());
    bad.VideoTracks[0].Clips[1].TransitionInType = "wipeleft"; bad.VideoTracks[0].Clips[1].TransitionInDuration = 0.5;
    Require(Throws(() => MultitrackDoc.Validate(bad), "不支持"), "wipe without same-track overlap rejected");
    bad = EditDocument.Deserialize(mt.Serialize());
    bad.VideoTracks[0].Clips[1].TransitionInType = "fade"; bad.VideoTracks[0].Clips[1].TransitionInDuration = 99;
    Require(Throws(() => MultitrackDoc.Validate(bad), "时长"), "transitionIn longer than the clip rejected");
    MultitrackDoc.Validate(EditDocument.Deserialize(mt.Serialize()));
    Mark("STEP 6 honest refusals + validation OK");
    // 7. 新建/删轨往返：加轨、改名、删非空轨拒绝、删空轨成功、序列化往返。
    var tr = EditDocument.Deserialize(mt.Serialize());
    var nv = MultitrackDoc.AddVideoTrack(tr, "新视频");
    var na = MultitrackDoc.AddAudioTrack(tr, "新音频");
    Require(tr.VideoTracks.Count == 2 && tr.AudioTracks.Count == 2, "add track gives 2 video + 2 audio tracks");
    MultitrackDoc.RenameTrack(tr, "video", nv.Id, "置顶");
    Require(nv.Name == "置顶", "rename track works");
    Require(Throws(() => MultitrackDoc.RemoveTrack(tr, "video", "v0"), "只能删空轨"), "removing a non-empty track is rejected");
    MultitrackDoc.RemoveTrack(tr, "video", nv.Id);
    MultitrackDoc.RemoveTrack(tr, "audio", na.Id);
    Require(tr.VideoTracks.Count == 1 && tr.AudioTracks.Count == 1, "removing empty tracks restores 1 + 1 tracks");
    var trRt = EditDocument.Deserialize(tr.Serialize());
    Require(trRt.VideoTracks.Count == 1 && trRt.AudioTracks.Count == 1 && trRt.VideoTracks[0].Clips.Count == 2, "track add/remove round-trips through save/load");
    Mark("STEP 7 add/remove tracks OK");
    // 8. 轨内切分/删除：1 秒处切分得两段，波纹删除跟进、非波纹删除留空隙（时长不变）。
    var sp = EditDocument.Deserialize(mt.Serialize());
    sp.VideoTracks[0].Clips.Clear();
    sp.VideoTracks[0].Clips.Add(new MtClip { Id = "full", Source = redSrc, In = 0, Out = 4, Speed = 1, Volume = 1, Start = 0 });
    int tailIdx = MultitrackDoc.SplitClipAt(sp, "video", "v0", 0, 1);
    Require(tailIdx == 1 && sp.VideoTracks[0].Clips.Count == 2 && Near(sp.VideoTracks[0].Clips[0].Out, 1, .01) && Near(sp.VideoTracks[0].Clips[1].In, 1, .01) && Near(sp.VideoTracks[0].Clips[1].Start, 1, .01), "split at 1s gives [0,1] + [1,4]");
    Require(Throws(() => MultitrackDoc.SplitClipAt(sp, "video", "v0", 0, 0.01), "中间"), "split at the clip edge is rejected");
    MultitrackDoc.DeleteClip(sp, "video", "v0", 0, false);
    Require(sp.VideoTracks[0].Clips.Count == 1 && Near(sp.VideoTracks[0].Clips[0].Start, 1, .01) && Near(MultitrackDoc.Duration(sp), 4.0, .01), "non-ripple delete leaves a gap, duration stays 4.0s");
    Require(Throws(() => MultitrackDoc.DeleteClip(sp, "video", "v0", 0, true), "至少保留一个片段"), "deleting the last clip is rejected");
    Mark("STEP 8 split/delete OK");
    File.WriteAllText(log, "PASS: legacy normalize 1+1 tracks, duration 4.0s, export luma matches legacy; dual-video overlay top-left blue bottom-right red; amix both base-3dB, mute/solo base-6dB, all-muted silence, same-track overlap hard-cut export 4.0s; cross-track move changes trackId/start, locked target rejected, clip kept; hidden track export 4.0s shows lower track; silenceCut/textCut/remix/vocalSep/roleStems refused, vocalSep export refused, opacity/blend/id/start/transitionIn validation rejected; add/rename/remove tracks round-trip; split at 1s + ripple/non-ripple delete.\n");
   } catch (Exception ex) { File.WriteAllText(log, "FAIL\n" + ex); Environment.ExitCode = 1; }
  }
 }
}
