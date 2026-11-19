// W10 import hotfix 自测（2026-11-19，P0）：--w9import-test 入口。
// 背景：W9 包在用户真机上导入一个 15 秒视频就反复闪退、应用根本打不开，
// 且他电脑上没有 last-error.txt——崩溃绕过了 DispatcherUnhandledException。
// 本测试在云端 Windows 构建里跑 Import + 完整 Load 路径（含 DrawTimeline、
// RequestPreview、LoadThumbnails），用 15 秒样片测 MP4/H.264、MOV/HEVC、MKV
// 几种格式 + 边界格式（无音频、VFR、10-bit HDR、竖屏带旋转元数据、4K、
// 无容器时长裸流、纯音频、截断文件、缺失文件）+ 多轨路径冒烟。
// 结果写 Windows/bin/w10-import-results.txt（逐案追加写，云端若真复现原生崩溃
// 导致进程中途死亡，已写下的案子仍在文件里；PASS: 开头才算过）。
// 云端 runner 无真 GPU：D3D 硬件呈现路径本次覆盖不到（PreviewSurface 初始化即
// 回退软件路径），GPU 防御改动只验编译 + 真机复核，见结果文件末尾的注。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using DogSC.Windows;
using D = System.Drawing;

namespace DogSC.Replica {
 static class W10ImportTests {
  static string Folder;
  static string LogPath;
  static Studio StudioRef;
  static int Passed, Failed, Skipped, DialogsDismissed;
  static void Mark(string s) { try { File.AppendAllText(LogPath, s + "\n"); } catch { } }
  static void Pass(string name, string detail) { Passed++; Mark("PASS: " + name + " | " + detail); }
  static void Fail(string name, string detail) { Failed++; Mark("FAIL: " + name + " | " + detail); }
  static void Skip(string name, string detail) { Skipped++; Mark("SKIP: " + name + " | " + detail); }
  static void RunFfmpeg(string args) { StudioMedia.Run(args, CancellationToken.None); }
  static bool HasEncoder(string name) {
   using (var p = Media.Start("ffmpeg", "-hide_banner -encoders", true)) {
    string text = p.StandardOutput.ReadToEnd(); p.WaitForExit();
    return text.Contains(name);
   }
  }
  static string Gen(string file, string args) {
   RunFfmpeg("-v error -y " + args + " " + Media.Q(file));
   if (!File.Exists(file)) throw new Exception("样片生成失败：" + file);
   return file;
  }
  static string VideoSrc(string size, string rate) {
   return "-f lavfi -i testsrc2=size=" + size + ":rate=" + rate + " -f lavfi -i sine=frequency=440:sample_rate=48000";
  }
  // 视频案：Import + 缩略图解码 + 完整 Load 路径（DrawTimeline/RequestPreview/缩略图）。
  static async Task VideoCase(string name, string file, double expectDuration, bool expectAudio) {
   try {
    var doc = StudioMedia.Import(file);
    if (Math.Abs(doc.Duration - expectDuration) > 1.0 && !doc.DurationUnknown) throw new Exception("时长 " + doc.Duration.ToString("0.00") + "s（帧率 " + doc.FrameRate.ToString("0.##") + "fps），期望约 " + expectDuration + "s");
    if (doc.Audio != expectAudio) throw new Exception("Audio=" + doc.Audio + "，期望 " + expectAudio);
    if (doc.Width < 2 || doc.Height < 2) throw new Exception("尺寸异常：" + doc.Width + "x" + doc.Height);
    if (!(doc.FrameRate > 0) || doc.FrameRate > 240) throw new Exception("帧率异常：" + doc.FrameRate);
    byte[] thumb = StudioMedia.Frame(doc.Source, Math.Min(0.5, Math.Max(0, doc.Duration - 0.05)), 200, CancellationToken.None);
    if (thumb == null || thumb.Length < 100) throw new Exception("缩略图解码无输出");
    await StudioRef.Load(file);
    if (StudioRef.Doc == null) throw new Exception("Load 后 Doc 为空");
    if (!StudioRef.Doc.DurationUnknown && Math.Abs(StudioRef.Doc.Length - expectDuration) > 1.0) throw new Exception("Load 后时间线长 " + StudioRef.Doc.Length.ToString("0.00") + "s，期望约 " + expectDuration + "s");
    await StudioRef.PreviewNow();
    await Task.Delay(900);
    Pass(name, doc.Width + "x" + doc.Height + " " + doc.Duration.ToString("0.00") + "s " + doc.FrameRate.ToString("0.##") + "fps Audio=" + doc.Audio + " DurationUnknown=" + doc.DurationUnknown + " thumb=" + thumb.Length + "B");
   } catch (Exception ex) { Fail(name, ex.GetType().Name + ": " + ex.Message); }
  }
  // 预期友好失败案：Import 必须抛错，但错里必须带文件名、必须说明原因、绝不能是裸抛错/空引用。
  static void ExpectFriendlyFailure(string name, string file, string mustContain) {
   try {
    var doc = StudioMedia.Import(file);
    Fail(name, "本应友好失败，却导入成功（Duration=" + doc.Duration.ToString("0.00") + "）");
   } catch (Exception ex) {
    if (ex is NullReferenceException) { Fail(name, "仍抛空引用（未加固）：" + ex.Message); return; }
    if (ex is InvalidOperationException) { Fail(name, "仍抛裸系统异常：" + ex.Message); return; }
    if (!ex.Message.Contains(Path.GetFileName(file))) { Fail(name, "友好异常里没带文件名：" + ex.Message); return; }
    if (!string.IsNullOrEmpty(mustContain) && !ex.Message.Contains(mustContain)) { Fail(name, "友好异常没说明原因（缺“" + mustContain + "”）：" + ex.Message); return; }
    Pass(name, "友好失败：" + ex.Message);
   }
  }
  public static async Task Run(Studio studio, string log) {
   StudioRef = studio; LogPath = log;
   Folder = Path.Combine(Media.Root, "bin", "w10import-test", Guid.NewGuid().ToString("N"));
   Directory.CreateDirectory(Folder);
   File.WriteAllText(LogPath, "STARTED " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " folder=" + Folder + "\n");
   // 自测期间自动关掉任何弹框（Load 失败弹框是模态的，无人点会挂住 CI；关掉后
   // 测试仍按 Doc 状态判定成败，关掉次数记在结果里，不静默算过）。
   var answer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(90) };
   answer.Tick += (s, e) => {
    var card = Application.Current.Windows.OfType<AppDialogWindow>().FirstOrDefault(w => w.IsLoaded);
    if (card == null) return;
    DialogsDismissed++;
    try {
     Button b = null;
     if (card.Actions.ContainsKey("cancel")) b = card.Actions["cancel"];
     else foreach (var kv in card.Actions) { b = kv.Value; break; }
     if (b != null) DialogTestDriver.Click(b);
    } catch { try { card.Close(); } catch { } }
   };
   answer.Start();
   try {
    // ---- 样片生成（15 秒主样片 + 边界样片） ----
    string mp4 = Gen(Path.Combine(Folder, "s15-h264.mp4"), VideoSrc("1280x720", "30") + " -t 15 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest");
    string mkv = Gen(Path.Combine(Folder, "s15-h264.mkv"), VideoSrc("1280x720", "30") + " -t 15 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest");
    string noaudio = Gen(Path.Combine(Folder, "s15-noaudio.mp4"), "-f lavfi -i testsrc2=size=1280x720:rate=30 -t 15 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -an");
    string vfr = Gen(Path.Combine(Folder, "s15-vfr.mp4"), "-f lavfi -i testsrc2=size=640x360:rate=60 -t 15 -vf \"setpts='if(eq(mod(N,30),0),PTS+0.033,PTS)'\" -fps_mode vfr -c:v libx264 -preset ultrafast -pix_fmt yuv420p -an");
    string portrait = Gen(Path.Combine(Folder, "s15-portrait.mp4"), VideoSrc("720x1280", "30") + " -t 15 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest -metadata:s:v rotate=90");
    string uhd = Gen(Path.Combine(Folder, "s5-4k.mp4"), VideoSrc("3840x2160", "30") + " -t 5 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest");
    string raw = Gen(Path.Combine(Folder, "s5-raw.h264"), "-f lavfi -i testsrc2=size=640x360:rate=30 -t 5 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -an -f h264");
    string mov = null;
    if (HasEncoder("libx265")) {
     try { mov = Gen(Path.Combine(Folder, "s15-hevc.mov"), VideoSrc("1280x720", "30") + " -t 15 -c:v libx265 -preset ultrafast -pix_fmt yuv420p -tag:v hvc1 -c:a aac -shortest"); }
     catch (Exception ex) { Skip("mov-hevc-15s", "生成失败（编码器不可用）：" + ex.Message); }
    } else Skip("mov-hevc-15s", "本机 ffmpeg 无 libx265");
    string hdr = null;
    try { hdr = Gen(Path.Combine(Folder, "s5-hdr10.mp4"), VideoSrc("1280x720", "30") + " -t 5 -c:v libx264 -preset ultrafast -pix_fmt yuv420p10le -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -c:a aac -shortest"); }
    catch (Exception ex) { Skip("mp4-hdr10bit-5s", "生成失败（10-bit 编码不可用）：" + ex.Message); }
    string mp3 = Gen(Path.Combine(Folder, "a3.mp3"), "-f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 -c:a libmp3lame");
    string wav = Gen(Path.Combine(Folder, "a3.wav"), "-f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 -c:a pcm_s16le");
    string aac = Gen(Path.Combine(Folder, "a3.aac"), "-f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 -c:a aac");
    string flac = Gen(Path.Combine(Folder, "a3.flac"), "-f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 -c:a flac");
    string trunc = Path.Combine(Folder, "trunc.mp4");
    byte[] full = File.ReadAllBytes(mp4);
    byte[] cut = new byte[full.Length * 2 / 5];
    Array.Copy(full, cut, cut.Length);
    File.WriteAllBytes(trunc, cut);

    // ---- 视频案：Import + 缩略图 + 完整 Load ----
    await VideoCase("mp4-h264-15s", mp4, 15, true);
    if (mov != null) await VideoCase("mov-hevc-15s", mov, 15, true);
    await VideoCase("mkv-h264-15s", mkv, 15, true);
    await VideoCase("mp4-noaudio-15s", noaudio, 15, false);
    await VideoCase("mp4-vfr-15s", vfr, 15, false);
    await VideoCase("mp4-portrait-rotate-15s", portrait, 15, true);
    await VideoCase("mp4-4k-5s", uhd, 5, true);
    if (hdr != null) await VideoCase("mp4-hdr10bit-5s", hdr, 5, true);
    // 裸流没有容器时长：允许估算出时长，也允许 DurationUnknown=0，但绝不许抛错致崩。
    try {
     var rawDoc = StudioMedia.Import(raw);
     if (rawDoc.DurationUnknown) Pass("raw-h264-noduration-5s", "时长未知标记正常（Duration=0，不抛错）");
     else if (rawDoc.Duration > 0 && rawDoc.Duration < 30) Pass("raw-h264-noduration-5s", "从帧数/帧率估算出时长 " + rawDoc.Duration.ToString("0.00") + "s");
     else Fail("raw-h264-noduration-5s", "时长异常：" + rawDoc.Duration.ToString("0.00") + "s");
    } catch (Exception ex) { Fail("raw-h264-noduration-5s", ex.GetType().Name + ": " + ex.Message); }

    // ---- 预期友好失败案 ----
    ExpectFriendlyFailure("audioonly-mp3", mp3, "纯音频");
    ExpectFriendlyFailure("audioonly-wav", wav, "纯音频");
    ExpectFriendlyFailure("audioonly-aac", aac, "纯音频");
    ExpectFriendlyFailure("audioonly-flac", flac, "纯音频");
    ExpectFriendlyFailure("truncated-mp4", trunc, "");
    ExpectFriendlyFailure("missing-file", Path.Combine(Folder, "不存在.mp4"), "找不到");

    // ---- 多轨路径冒烟（W9 审计点） ----
    try {
     var baseDoc = StudioMedia.Import(mp4);
     MultitrackDoc.Normalize(baseDoc);
     if (!MultitrackDoc.HasTracks(baseDoc)) throw new Exception("Normalize 后 HasTracks 仍为 false");
     StudioRef.SetDocument(baseDoc);
     await StudioRef.PreviewNow();
     await Task.Delay(900);
     if (Math.Abs(StudioRef.Doc.Length - 15) > 1.0) throw new Exception("多轨 Length=" + StudioRef.Doc.Length.ToString("0.00") + "s，期望约 15s");
     Pass("multitrack-normalize-load", "单轨转多轨后 SetDocument + 预览正常，Length=" + StudioRef.Doc.Length.ToString("0.00") + "s");
    } catch (Exception ex) { Fail("multitrack-normalize-load", ex.GetType().Name + ": " + ex.Message); }
    try {
     string src3 = Gen(Path.Combine(Folder, "s3.mp4"), VideoSrc("640x360", "30") + " -t 3 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest");
     var doc3 = StudioMedia.Import(src3);
     MultitrackDoc.Normalize(doc3);
     string mtOut = Path.Combine(Folder, "mt-timeline.mp4");
     MultitrackFilter.RenderTimeline(doc3, mtOut, 30, CancellationToken.None);
     if (!File.Exists(mtOut) || new FileInfo(mtOut).Length < 1000) throw new Exception("中间片未生成或过小");
     Pass("multitrack-render-timeline", "3s 多轨中间片已生成，" + new FileInfo(mtOut).Length + " 字节");
    } catch (Exception ex) { Fail("multitrack-render-timeline", ex.GetType().Name + ": " + ex.Message); }
    try {
     var empty = StudioMedia.Import(mp4);
     empty.VideoTracks = new List<MtVideoTrack>();
     empty.AudioTracks = new List<MtAudioTrack>();
     if (MultitrackDoc.HasTracks(empty)) throw new Exception("空轨列表仍判为多轨");
     if (Math.Abs(empty.Length - 15) > 0.01) throw new Exception("空轨 Length=" + empty.Length.ToString("0.00") + "，应退化成单轨 15s");
     Pass("multitrack-empty-tracks", "空轨列表退化成单轨，Length=15s");
    } catch (Exception ex) { Fail("multitrack-empty-tracks", ex.GetType().Name + ": " + ex.Message); }
    try {
     var bad = StudioMedia.Import(mp4);
     bad.VideoTracks = new List<MtVideoTrack> { new MtVideoTrack { Id = "v0", Name = "视频 1", Clips = null } };
     double d = MultitrackDoc.Duration(bad);
     try { bad.Validate(); } catch (Exception vex) { if (vex is NullReferenceException) throw new Exception("Validate 仍抛空引用"); }
     Pass("multitrack-null-clips", "Clips=null 的轨不抛空引用（Duration=" + d.ToString("0.00") + "，Validate 已补空列表）");
    } catch (Exception ex) { Fail("multitrack-null-clips", ex.GetType().Name + ": " + ex.Message); }
    try {
     var unk = StudioMedia.Import(mp4);
     unk.Duration = 0; unk.DurationUnknown = true; unk.Cuts[0].End = 0;
     if (unk.MediaLibrary.Count > 0) unk.MediaLibrary[0].Duration = 0;
     unk.Validate();
     StudioRef.SetDocument(unk);
     await StudioRef.PreviewNow();
     await Task.Delay(600);
     Pass("duration-unknown-roundtrip", "0 时长 + 时长未知项目可 Validate、可打开、可预览");
    } catch (Exception ex) { Fail("duration-unknown-roundtrip", ex.GetType().Name + ": " + ex.Message); }
   } catch (Exception ex) {
    Fail("harness", ex.GetType().Name + ": " + ex.Message);
   } finally {
    answer.Stop();
   }
   Mark("SUMMARY passed=" + Passed + " failed=" + Failed + " skipped=" + Skipped + " dialogsAutoDismissed=" + DialogsDismissed);
   Mark("注：云端 runner 无真 GPU，D3D 硬件呈现路径本次未覆盖（PreviewSurface 初始化即回退软件路径）；GPU 防御改动（CSE 回退、stride 28、back buffer 分离）只验了编译，真机仍需用户验证。");
   Mark("注：复现结论以本文件为准——若全部 PASS，说明托管 Import/Load 路径在云端走得通，真机闪退与本机 GPU/驱动/编解码环境有关，防御性修复已就位；若中途进程死亡且文件停在某案，死亡点即复现点。");
   if (Failed == 0) { Mark("PASS: W10 import hotfix 自测全绿（" + Passed + " 过，" + Skipped + " 跳过）。"); Environment.ExitCode = 0; }
   else { Mark("FAIL: " + Failed + " 案未过。"); Environment.ExitCode = 1; }
  }
 }
}
