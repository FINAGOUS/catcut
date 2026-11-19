using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;

namespace DogSC.Replica {
 // W9 扫尾审计（2026-11-19）：对照 W7 审计表 10 类 + M4 清单逐行核代码后的补漏。
 // 审计结论：W7 的 10 类里除多轨时间线（另一组在重写）与要他账号的两项（直接发布/
 // 审阅链接）外，其余均已由 W3–W8 接上（逐项核对表见 m2-build-log W9 段）；
 // 本文件只补审计中抓到的 4 个便宜小项——
 //  (1) 仅视频导出：模型（ExportOnly.Resolve）/导出（EditorCore -an）/队列/摘要都
 //      支持 OnlyMode="video"，只差导出窗口没有"仅视频"按钮（W9OnlyMode.TagFor
 //      给按钮高亮用，见 EditorPolishWindows.cs）。
 //  (2) 音乐床预览从头播放：Play() 里 musicPlayer.Position 恒为零（W3 已知限制）；
 //      W9MusicBed 按播放头在床内取模（床循环播放，播完 MediaEnded 从头续，
 //      取模后对齐不变）。
 //  (3) LUT 临时文件累积：调色每换一个值就烤一个 catcut-lut-<hash>.cube，从不删
 //      （W3 已知限制）；W9LutCleanup 在启动时删 7 天前的旧文件，不碰本次启动后
 //      新烤的文件（导出进行中的 LUT 不受影响）。
 //  (4) 观察文件夹只有手动扫描：W9WatchFolder 用 FileSystemWatcher + 2 秒防抖，
 //      新文件只列进观察文件夹区、不自动导入（沿用 W8"不自动吞文件"策略）。
 // 不碰：多轨时间线、插件宿主、静音 0.3x 压缩、美颜+调色修复、脚本转视频 TTS/
 // 节拍、引擎 TS（见汇报"发现但未做"）。

 // ---- 1. 音乐床预览对齐（W3 已知限制的修复）----
 static class W9MusicBed {
  // 播放头在床内的偏移（床循环）：65 秒处播 30 秒的床 → 从 5 秒处起播。
  public static double StartOffsetSeconds(double playheadSeconds, double bedDurationSeconds) {
   if (bedDurationSeconds <= 0 || playheadSeconds <= 0) return 0;
   double off = playheadSeconds % bedDurationSeconds;
   if (off < 0) off += bedDurationSeconds;
   return off;
  }
 }

 // ---- 2. 仅导出模式 → 导出窗口按钮高亮 ----
 static class W9OnlyMode {
  // subtitle 是复选框，kinds 高亮仍留在"视频成片"（与 W8 行为一致）。
  public static string TagFor(string mode) {
   if (mode == "video") return "仅视频";
   if (mode == "audio") return "仅音频";
   return "视频成片";
  }
 }

 // ---- 3. LUT 临时文件清理（W3 已知限制的修复）----
 static class W9LutCleanup {
  // 三种前缀：W3 调色链（FeaturePanels.ColorLut.PathFor）与 W8 高级调色链
  //（W8ColourPanels 的 CubePathForGrid / 镜头匹配 LUT）。只删文件，不动 W8 文件。
  static readonly string[] Patterns = { "catcut-lut-*.cube", "catcut-w8-*.cube", "catcut-w8-match-*.cube" };
  public static int CleanupDefault() { return CleanupStaleTemps(Path.GetTempPath(), 7); }
  public static int CleanupStaleTemps(string tempDir, int maxAgeDays) {
   int deleted = 0;
   if (string.IsNullOrEmpty(tempDir) || !Directory.Exists(tempDir)) return 0;
   DateTime cutoff = DateTime.UtcNow.AddDays(-Math.Max(0, maxAgeDays));
   foreach (string pattern in Patterns) {
    string[] files;
    try { files = Directory.GetFiles(tempDir, pattern); } catch { continue; }
    foreach (string f in files) {
     try {
      if (File.GetLastWriteTimeUtc(f) < cutoff) { File.Delete(f); deleted++; }
     } catch { }
    }
   }
   return deleted;
  }
 }

 // ---- 4. 观察文件夹后台监看（W8 只做了手动扫描）----
 static class W9WatchFolder {
  // 扩展名表与 W8EffectsPanels.WatchFolder.MediaExtensions 同步。
  static readonly string[] MediaExtensions = { ".mp4", ".mov", ".mkv", ".webm", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".png", ".jpg", ".jpeg", ".bmp" };
  static FileSystemWatcher watcher;
  static System.Timers.Timer debounce;
  static readonly object gate = new object();
  static HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  static List<string> pending = new List<string>();
  static Action<List<string>> callback;
  static string folder;
  public static bool Running { get { return watcher != null; } }
  public static string Folder { get { return folder; } }
  public static bool IsMedia(string path) {
   string ext = Path.GetExtension(path);
   if (string.IsNullOrEmpty(ext)) return false;
   return MediaExtensions.Contains(ext.ToLowerInvariant());
  }
  // 启动时把文件夹里已有的媒体文件记进 seen——只报启动后新到的文件，
  // 不把旧文件反复报出来（手动"扫描新增素材"仍负责补报旧文件）。
  public static void Start(string watchFolder, Action<List<string>> onNewFiles) {
   Stop();
   if (string.IsNullOrEmpty(watchFolder) || !Directory.Exists(watchFolder)) return;
   folder = watchFolder;
   callback = onNewFiles;
   lock (gate) {
    seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    pending = new List<string>();
    foreach (string f in Directory.GetFiles(watchFolder)) if (IsMedia(f)) seen.Add(Path.GetFullPath(f));
   }
   watcher = new FileSystemWatcher(watchFolder) { NotifyFilter = NotifyFilters.FileName, IncludeSubdirectories = false };
   watcher.Created += OnFileEvent;
   watcher.Renamed += OnFileEvent;
   watcher.EnableRaisingEvents = true;
   debounce = new System.Timers.Timer(2000) { AutoReset = false };
   debounce.Elapsed += delegate { Flush(); };
  }
  static void OnFileEvent(object sender, FileSystemEventArgs e) {
   string full;
   try { full = Path.GetFullPath(e.FullPath); } catch { return; }
   if (!IsMedia(full)) return;
   lock (gate) {
    if (seen.Contains(full) || pending.Contains(full)) return;
    pending.Add(full);
   }
   try { if (debounce != null) { debounce.Stop(); debounce.Start(); } } catch { }
  }
  static void Flush() {
   List<string> found;
   lock (gate) {
    found = new List<string>(pending);
    pending.Clear();
    foreach (string f in found) seen.Add(f);
   }
   if (found.Count == 0) return;
   var cb = callback;
   if (cb == null) return;
   try { cb(found); } catch { }
  }
  public static void Stop() {
   try { if (debounce != null) { debounce.Stop(); debounce.Dispose(); } } catch { }
   debounce = null;
   try { if (watcher != null) { watcher.EnableRaisingEvents = false; watcher.Dispose(); } } catch { }
   watcher = null;
   callback = null;
   folder = null;
  }
 }
}
