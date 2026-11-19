using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using DogSC.Windows;

namespace DogSC.Replica {
 // W9 sweep 自测（--w9sweep-test）：结果写 Windows/bin/w9sweep-results.txt
 //（PASS: 开头才算过）。本地 Linux 跑不了 WPF，验证全靠云端构建。
 // 覆盖 W9 补的 4 项：仅视频导出回归、音乐床对齐、LUT 清理、观察文件夹监看。
 static class W9SweepTests {
  static void Require(bool ok, string name) { if (!ok) throw new Exception("W9 检查失败：" + name); }
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

  public static void Run() {
   Folder = Path.Combine(Media.Root, "bin", "w9sweep-test");
   Directory.CreateDirectory(Folder);
   string log = Path.Combine(Media.Root, "bin", "w9sweep-results.txt");
   LogPath = log;
   File.WriteAllText(log, "RUNNING\n");
   try {
    // STEP 1：LUT 临时文件清理——只删 7 天前的旧文件，新文件与无关文件不动，
    // 不存在的目录返回 0 不抛错。
    string lutDir = Path.Combine(Folder, "lut-tmp");
    Directory.CreateDirectory(lutDir);
    string oldLut = Path.Combine(lutDir, "catcut-lut-old.cube");
    string newLut = Path.Combine(lutDir, "catcut-lut-new.cube");
    string oldMatch = Path.Combine(lutDir, "catcut-w8-match-old.cube");
    string keep = Path.Combine(lutDir, "keep.txt");
    File.WriteAllText(oldLut, "old");
    File.WriteAllText(newLut, "new");
    File.WriteAllText(oldMatch, "old-match");
    File.WriteAllText(keep, "keep");
    File.SetLastWriteTimeUtc(oldLut, DateTime.UtcNow.AddDays(-10));
    File.SetLastWriteTimeUtc(oldMatch, DateTime.UtcNow.AddDays(-10));
    File.SetLastWriteTimeUtc(keep, DateTime.UtcNow.AddDays(-10));
    int cleaned = W9LutCleanup.CleanupStaleTemps(lutDir, 7);
    Require(cleaned == 2 && !File.Exists(oldLut) && !File.Exists(oldMatch) && File.Exists(newLut) && File.Exists(keep),
     "LUT cleanup deletes 2 stale files, keeps fresh + unrelated (got " + cleaned + ")");
    Require(W9LutCleanup.CleanupStaleTemps(Path.Combine(Folder, "no-such-dir"), 7) == 0, "LUT cleanup on a missing dir returns 0");
    Mark("STEP 1 LUT cleanup OK");

    // STEP 2：音乐床预览对齐——播放头在床内取模。
    Require(Near(W9MusicBed.StartOffsetSeconds(65, 30), 5, 1e-9) && Near(W9MusicBed.StartOffsetSeconds(0, 30), 0, 1e-9)
     && Near(W9MusicBed.StartOffsetSeconds(30, 30), 0, 1e-9) && Near(W9MusicBed.StartOffsetSeconds(90.5, 30), 0.5, 1e-9)
     && Near(W9MusicBed.StartOffsetSeconds(12.5, 0), 0, 1e-9) && Near(W9MusicBed.StartOffsetSeconds(-3, 30), 0, 1e-9),
     "music bed offset 65/30=5, 0/30=0, 30/30=0, 90.5/30=0.5, no-bed/negative=0");
    Mark("STEP 2 music bed offset OK");

    // STEP 3：仅导出模式——Resolve 三开关 + 互斥 + 按钮高亮映射。
    Require(ExportOnly.Resolve(true, false, false) == "video" && ExportOnly.Resolve(false, true, false) == "audio"
     && ExportOnly.Resolve(false, false, true) == "subtitle" && ExportOnly.Resolve(false, false, false) == "none",
     "ExportOnly.Resolve maps video/audio/subtitle/none");
    bool threw = false;
    try { ExportOnly.Resolve(true, true, false); } catch { threw = true; }
    Require(threw, "ExportOnly.Resolve rejects two switches at once");
    Require(W9OnlyMode.TagFor("video") == "仅视频" && W9OnlyMode.TagFor("audio") == "仅音频"
     && W9OnlyMode.TagFor("none") == "视频成片" && W9OnlyMode.TagFor("subtitle") == "视频成片",
     "W9OnlyMode.TagFor maps video/audio/none/subtitle to button tags");
    Mark("STEP 3 export-only resolve + tags OK");

    // STEP 4：观察文件夹后台监看——启动前已有的文件不报，启动后新建的媒体文件报，
    // 非媒体文件不报；同一文件只报一次。
    string watchDir = Path.Combine(Folder, "watch");
    Directory.CreateDirectory(watchDir);
    File.WriteAllText(Path.Combine(watchDir, "old.mp4"), "pre-existing");
    var found = new List<string>();
    var signal = new ManualResetEventSlim(false);
    W9WatchFolder.Start(watchDir, files => { lock (found) { found.AddRange(files); } signal.Set(); });
    try {
     Require(W9WatchFolder.Running && string.Equals(W9WatchFolder.Folder, watchDir, StringComparison.OrdinalIgnoreCase),
      "watch folder watcher is running on the set folder");
     File.WriteAllText(Path.Combine(watchDir, "new.mp4"), "x");
     File.WriteAllText(Path.Combine(watchDir, "note.txt"), "x");
     File.WriteAllText(Path.Combine(watchDir, "new.wav"), "x");
     bool got = signal.Wait(TimeSpan.FromSeconds(10));
     Require(got, "watch folder watcher fires within 10s of new files");
     lock (found) {
      Require(found.Any(f => f.EndsWith("new.mp4", StringComparison.OrdinalIgnoreCase))
       && found.Any(f => f.EndsWith("new.wav", StringComparison.OrdinalIgnoreCase))
       && !found.Any(f => f.EndsWith("note.txt", StringComparison.OrdinalIgnoreCase))
       && !found.Any(f => f.EndsWith("old.mp4", StringComparison.OrdinalIgnoreCase)),
       "watcher reports new.mp4 + new.wav, ignores note.txt + pre-existing old.mp4 (got " + string.Join(",", found.ToArray()) + ")");
      Require(found.Count == found.Distinct(StringComparer.OrdinalIgnoreCase).Count(), "watcher reports each file once");
     }
    } finally { W9WatchFolder.Stop(); }
    Require(!W9WatchFolder.Running, "watch folder watcher stops");
    Mark("STEP 4 watch folder auto-scan OK");

    // STEP 5：仅视频导出回归（新暴露的"仅视频"按钮走的同一条路）——有视频轨、
    // 无音频轨、时长 2.0 秒。
    string srcA = Path.Combine(Folder, "w9-src.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=2 -f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=2\" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(srcA));
    var voDoc = StudioMedia.Import(srcA);
    voDoc.Cuts = new List<Cut> { new Cut { Start = 0, End = 2 } };
    string voOut = Path.Combine(Folder, "vo-out.mp4");
    StudioRenderer.Export(voDoc, voOut, new ExportOptions { PresetName = "test", Height = 360, Fps = 30, Codec = "h264", Crf = 18, OnlyMode = "video" }, (v, s) => { }, CancellationToken.None);
    Require(HasStream(voOut, "video") && !HasStream(voOut, "audio") && Math.Abs(ProbeDuration(voOut) - 2) < 0.15,
     "video-only export has video, no audio, 2.0s");
    Mark("STEP 5 video-only export OK");

    File.WriteAllText(log, "PASS: LUT cleanup deletes 2 stale (10d) files, keeps fresh + unrelated, missing dir returns 0; music bed offset 65/30=5, 30/30=0, 90.5/30=0.5, no-bed/negative=0; ExportOnly resolve video/audio/subtitle/none + mutual exclusion + TagFor video/audio/none/subtitle; watch folder reports new.mp4 + new.wav within 10s, ignores note.txt + pre-existing old.mp4, each file once, stops cleanly; video-only export has video, no audio, 2.0s.\n");
   }
   catch (Exception ex) { File.AppendAllText(log, "FAIL\n" + ex + "\n"); Mark("FAIL: " + ex.Message); Environment.ExitCode = 1; }
  }
 }
}
