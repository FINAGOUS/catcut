// W8 收尾批·时间线高级（2026-11-18）：复合片段嵌套展开/折叠、导出队列/批量导出、
// J/L 剪辑、音画联动锁定、时间线索引搜索、三点编辑、粘贴属性、调整层、文字剪切、
// Remix（音乐自适应时长）、仅导出字幕/音乐/视频三开关。
// 模型与纯逻辑；UI 见 W8TimelineUI.cs。滤镜串与参数出处（全部是已验证的数，不是现编的）：
// - 复合片段：compound.ts（嵌套上限 2 层，子项目先渲染成中间 MP4 再当普通素材拼，
//   中间片留在 compound-d<depth>-c<clip>/render.mp4；窗口 in/out 在子项目时间线上）。
// - 导出队列：deliver.ts 的 ExportQueue（增删/排序/逐个跑，一个失败不堵后面的，
//   未知预设只坏该项不坏整队）；runExportQueue 是依赖注入，C# 版直接调 StudioRenderer.Export。
// - J/L：timeline.ts 的 validateJLClip（音频 in/out 是源秒数，可超出视频窗口但必须
//   与视频窗口重叠；只支持 1× 常速片段，不支持变速/多机位/Morph）；音频链是
//   atrim(audioIn..audioOut) + apad + atrim(视频时长)，与 filtergraph.ts 的 clipAudioChains 同款。
// - 联动锁定：timeline.ts 的 deleteClip（联动开删整段，关时只删视频留音频，
//   音频留成 audioOnly 片段——黑视频 + 音频保留）。
// - 索引搜索：timeline.ts 的 searchTimeline（片段名/源文件名/标记文字/角色名，
//   不区分大小写子串匹配，按时间线顺序返回）。
// - 三点编辑：timeline.ts 的 threePointInsert/threePointOverwrite/replaceClipSource
//   （插入点分裂开被压片段；覆盖区被替换、总时长不变；换源保留剪辑点与全部效果）。
// - 粘贴属性：timeline.ts 的 PASTEABLE_FIELDS（调色/变速/音量等走已有的 Clip 字段；
//   speedCurve 粘到 beatSpeed 片段报错拒绝）。C# 模型里调色是项目级 Grade、
//   变速是片段级 Speed，所以粘贴 = 源片段 Speed + 源项目 Grade/音频类型/降噪快照。
// - 调整层：timeline.ts 的 adjustmentLayerFilter（eq/colorbalance +
//   enable='between(t,start,end)'，探针实测：灰 128 源 + 亮度 +0.5，层内 224、层外 76）。
// - 文字剪切：textcut.ts（P0b 转写词级时间戳；删文字即删对应时间段，与删静音同一条
//   切分 + 跟随前移逻辑，复用 SilenceCut.Apply）。
// - Remix：remix.ts（按节拍循环/跳切拼贴拉长/缩短音乐，不断裂；atempo 直拉会变调所以不用；
//   复用 P1c 节拍检测 BeatDetector）。
// - 仅导出三开关：deliver.ts 的 resolveExportOnlyMode（videoOnly/audioOnly/subtitleOnly
//   三者互斥，同时开报错拒绝；P3c 实测：videoOnly 无音轨、audioOnly 无视频轨、
//   subtitleOnly 只出字幕文件不渲染视频）。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using DogSC.Windows;

namespace DogSC.Replica {
 // ---- 1. 复合片段 ----
 public class CompoundClip {
  public string Name = "复合片段"; public string ProjectPath = ""; public double In; public double Out; public int Depth; public bool Expanded;
  public double Length { get { return Out - In; } }
 }
 public class CompoundRow { public string Label = ""; public double Start; public double End; public int Depth; public bool IsCompound; public bool Expanded; }
 static class CompoundTimeline {
  public const int MaxDepth = 2;
  public static void ValidateClip(CompoundClip clip, double childDuration) {
   if (clip == null) throw new Exception("没有复合片段。");
   if (clip.Depth < 0 || clip.Depth >= MaxDepth) throw new Exception("复合片段嵌套超过 2 层上限（父→子→孙）：depth " + clip.Depth + "。");
   if (string.IsNullOrEmpty(clip.ProjectPath) || !File.Exists(clip.ProjectPath)) throw new Exception("复合片段的子项目文件缺失：" + (string.IsNullOrEmpty(clip.ProjectPath) ? "（未关联）" : clip.ProjectPath) + "。");
   if (!EditDocument.Finite(clip.In) || !EditDocument.Finite(clip.Out) || clip.In < 0 || clip.Out <= clip.In) throw new Exception("复合片段窗口无效：[" + clip.In.ToString("0.00", CultureInfo.InvariantCulture) + "," + clip.Out.ToString("0.00", CultureInfo.InvariantCulture) + "]。");
   if (clip.Out > childDuration + 0.05) throw new Exception("复合片段窗口超出子项目时长：out " + clip.Out.ToString("0.00", CultureInfo.InvariantCulture) + "s，子项目只有 " + childDuration.ToString("0.00", CultureInfo.InvariantCulture) + "s。");
  }
  public static string RenderDir(string baseDir, int depth, int index) { return Path.Combine(baseDir, "compound-d" + depth + "-c" + index); }
  // 子项目先按父项目尺寸/帧率渲染成整片，再按窗口重编码裁成 render.mp4
  // （-c copy 裁剪会落在关键帧上、窗口不准，所以这里重编码；中间片是审计留档）。
  public static string RenderIntermediate(EditDocument child, CompoundClip clip, int index, string baseDir, int height, int fps, CancellationToken token) {
   if (child == null) throw new Exception("没有子项目可渲染。");
   child.Validate();
   ValidateClip(clip, child.Length);
   string dir = RenderDir(baseDir, clip.Depth, index);
   Directory.CreateDirectory(dir);
   string full = Path.Combine(dir, "full.mp4"), render = Path.Combine(dir, "render.mp4");
   StudioRenderer.Export(child, full, ExportOptions.Sdr(height, fps), (v, s) => { }, token);
   StudioMedia.Run("-v error -y -ss " + Media.N(clip.In) + " -i " + Media.Q(full) + " -t " + Media.N(clip.Out - clip.In) + " -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac " + Media.Q(render), token);
   if (!File.Exists(render)) throw new Exception("复合片段中间片生成失败。");
   return render;
  }
  // 大纲行：主片段在前，复合片段排在主片段之后（v1 单源模型不能与主片段交错混排，
  // 面板里写明）；折叠时复合片段是一行，展开时是子项目窗口内的片段行（深度+1）。
  public static List<CompoundRow> Outline(EditDocument doc, Dictionary<string, EditDocument> children) {
   var rows = new List<CompoundRow>(); double offset = 0;
   foreach (var c in doc.Cuts) { rows.Add(new CompoundRow { Label = "片段 · " + Path.GetFileName(doc.Source), Start = offset, End = offset + c.Length, Depth = 0, IsCompound = false }); offset += c.Length; }
   if (doc.CompoundClips == null) return rows;
   foreach (var cc in doc.CompoundClips) {
    if (cc.Expanded) {
     EditDocument child = null;
     if (children != null) children.TryGetValue(cc.ProjectPath, out child);
     if (child == null) throw new Exception("展开复合片段需要先加载子项目：" + cc.Name + "。");
     if (cc.Depth >= MaxDepth - 1) throw new Exception("孙级复合片段不能再展开（嵌套上限 2 层）。");
     double co2 = 0;
     foreach (var c in child.Cuts) {
      double s = co2, e = co2 + c.Length;
      double os = Math.Max(s, cc.In), oe = Math.Min(e, cc.Out);
      if (oe > os + 0.001) rows.Add(new CompoundRow { Label = "  " + cc.Name + " · 片段", Start = offset + (os - cc.In), End = offset + (oe - cc.In), Depth = cc.Depth + 1, IsCompound = false });
      co2 = e;
     }
     offset += cc.Length;
    } else {
     rows.Add(new CompoundRow { Label = cc.Name + "（复合 · 未展开）", Start = offset, End = offset + cc.Length, Depth = cc.Depth, IsCompound = true, Expanded = false });
     offset += cc.Length;
    }
   }
   return rows;
  }
 }

 // ---- 2. 导出队列 / 批量导出 ----
 public class ExportQueueItem { public string Id = ""; public string Label = ""; public EditDocument Doc; public string Output = ""; public ExportOptions Options = new ExportOptions(); }
 public class QueueItemResult { public string Id = ""; public string Status = ""; public string Error = ""; }
 static class ExportQueue {
  public static void ValidateItem(ExportQueueItem item) {
   if (item == null) throw new Exception("队列项为空。");
   if (string.IsNullOrWhiteSpace(item.Id)) throw new Exception("队列项缺少 id。");
   if (item.Doc == null) throw new Exception("队列项 " + item.Id + " 没有项目。");
   if (string.IsNullOrWhiteSpace(item.Output)) throw new Exception("队列项 " + item.Id + " 没有输出路径。");
   if (item.Options == null) item.Options = ExportOptions.Sdr(1080, 30);
   item.Options.Validate();
  }
  public static List<ExportQueueItem> Add(List<ExportQueueItem> queue, ExportQueueItem item) {
   ValidateItem(item);
   if (queue.Any(q => q.Id == item.Id)) throw new Exception("队列里已有同名项：" + item.Id + "。");
   var next = queue.ToList(); next.Add(item); return next;
  }
  public static List<ExportQueueItem> Remove(List<ExportQueueItem> queue, string id) {
   if (!queue.Any(q => q.Id == id)) throw new Exception("队列里没有这一项：" + id + "。");
   return queue.Where(q => q.Id != id).ToList();
  }
  public static List<ExportQueueItem> Move(List<ExportQueueItem> queue, string id, int toIndex) {
   int from = queue.FindIndex(q => q.Id == id);
   if (from < 0) throw new Exception("队列里没有这一项：" + id + "。");
   if (toIndex < 0 || toIndex >= queue.Count) throw new Exception("移动位置越界：" + toIndex + "（0–" + (queue.Count - 1) + "）。");
   var next = queue.ToList(); var it = next[from]; next.RemoveAt(from); next.Insert(toIndex, it); return next;
  }
  // 逐个跑；某一项失败只记失败、继续跑下一项（deliver.ts runExportQueue 同款语义）。
  // 未知预设名只坏该项：内置表与已保存预设里都没有才算未知。
  public static List<QueueItemResult> Run(List<ExportQueueItem> queue, Action<double, string> progress, CancellationToken token) {
   var results = new List<QueueItemResult>();
   if (queue == null) return results;
   foreach (var item in queue) {
    try {
     ValidateItem(item);
     string presetName = item.Options.PresetName;
     // PresetName 只是标签（Options 本身带全部数值）："自定义"与 Sdr() 的 "SDR"
     // 是合法标签；其余名字须在内置表或已保存预设里，否则只坏该项。
     if (!string.IsNullOrEmpty(presetName) && presetName != "自定义" && presetName != "SDR" && ExportPresets.Find(presetName) == null && !ExportPresetStore.List().Contains(presetName))
      throw new Exception("未知导出预设：" + presetName + "。");
     StudioRenderer.Export(item.Doc, item.Output, item.Options, (v, s) => { if (progress != null) progress(v, item.Label + " · " + s); }, token);
     results.Add(new QueueItemResult { Id = item.Id, Status = "done" });
    } catch (Exception ex) { results.Add(new QueueItemResult { Id = item.Id, Status = "failed", Error = ex.Message }); }
   }
   return results;
  }
 }

 // ---- 3. J/L 剪辑 ----
 static class JlAudio {
  public static void Validate(Cut cut, double sourceDuration) {
   if (cut == null) throw new Exception("没有片段。");
   if (!cut.AudioIn.HasValue && !cut.AudioOut.HasValue) return;
   if (cut.Gap) throw new Exception("空隙片段不能设音频窗口。");
   if (Math.Abs(cut.Speed - 1) > 0.000001) throw new Exception("J/L 音频窗口只支持 1× 常速片段（变速片段的音频链是分段 atempo，窗口对不齐）。");
   double aIn = cut.AudioIn.HasValue ? cut.AudioIn.Value : cut.Start;
   double aOut = cut.AudioOut.HasValue ? cut.AudioOut.Value : cut.End;
   if (!EditDocument.Finite(aIn) || !EditDocument.Finite(aOut) || aIn < 0 || aOut <= aIn) throw new Exception("J/L 音频窗口无效：[" + aIn.ToString("0.00", CultureInfo.InvariantCulture) + "," + aOut.ToString("0.00", CultureInfo.InvariantCulture) + "]。");
   if (aOut > sourceDuration + 0.05) throw new Exception("J/L 音频窗口超出素材时长：audioOut " + aOut.ToString("0.00", CultureInfo.InvariantCulture) + "s，素材只有 " + sourceDuration.ToString("0.00", CultureInfo.InvariantCulture) + "s。");
   if (aOut <= cut.Start || aIn >= cut.End) throw new Exception("J/L 音频窗口 [" + aIn.ToString("0.00", CultureInfo.InvariantCulture) + "," + aOut.ToString("0.00", CultureInfo.InvariantCulture) + "] 与视频窗口 [" + cut.Start.ToString("0.00", CultureInfo.InvariantCulture) + "," + cut.End.ToString("0.00", CultureInfo.InvariantCulture) + "] 没有重叠。");
  }
  public static void ValidateAll(EditDocument doc) {
   if (doc == null || doc.Cuts == null) return;
   foreach (var c in doc.Cuts) Validate(c, doc.Duration);
   if (doc.Cuts.Any(c => c.AudioIn.HasValue || c.AudioOut.HasValue)) {
    if (MulticamModel.Active(doc)) throw new Exception("J/L 音频窗口不支持多机位片段（音频一律取角度 0，窗口对不上角度文件）。");
    if (doc.MorphEnabled) throw new Exception("J/L 音频窗口不支持 Morph Cut（插值音频按视频边界算，窗口会错位）。");
   }
  }
 }

 // ---- 4. 音画联动锁定 ----
 static class TimelineLink {
  // 联动开（默认）删整段；关时只删视频、留音频（AudioOnly：黑视频 + 音频保留）；
  // Alt 键按住时临时取反。波纹关且联动开时删片段留空隙（W3 老行为不变）。
  public static void DeleteCut(EditDocument doc, int index, bool ripple, bool altHeld) {
   if (doc == null || doc.Cuts == null || index < 0 || index >= doc.Cuts.Count) throw new Exception("没有可删除的片段。");
   if (doc.Cuts.Count <= 1) throw new Exception("至少保留一个录屏片段。");
   bool linked = doc.LinkSelection ^ altHeld;
   var cut = doc.Cuts[index];
   if (!linked) {
    if (cut.Gap) throw new Exception("空隙片段没有音频可保留。");
    if (cut.AudioOnly) throw new Exception("该片段已经是纯音频（视频已移除）。");
    cut.AudioOnly = true; return;
   }
   if (cut.Gap || ripple) doc.Cuts.RemoveAt(index);
   else doc.Cuts[index] = new Cut { Gap = true, GapDuration = cut.Length, Start = cut.Start, End = cut.Start, Speed = cut.Speed };
  }
 }

 // ---- 5. 时间线索引搜索 ----
 public class TimelineHit { public string Type = ""; public string Id = ""; public double Time; public string Label = ""; }
 static class TimelineSearch {
  public static List<TimelineHit> Search(EditDocument doc, string query) {
   var hits = new List<TimelineHit>();
   if (doc == null || string.IsNullOrWhiteSpace(query)) return hits;
   string q = query.Trim().ToLowerInvariant();
   double offset = 0;
   for (int i = 0; i < doc.Cuts.Count; i++) {
    var c = doc.Cuts[i];
    string hay = (Path.GetFileName(doc.Source) + " 片段 " + (i + 1)).ToLowerInvariant();
    if (hay.Contains(q)) hits.Add(new TimelineHit { Type = "clip", Id = "片段 " + (i + 1), Time = offset, Label = "片段 " + (i + 1) + " · " + Path.GetFileName(doc.Source) + " @ " + offset.ToString("0.00", CultureInfo.InvariantCulture) + "s" });
    offset += c.Length;
   }
   if (doc.RecordingMarkers != null) foreach (var m in doc.RecordingMarkers)
     if (!string.IsNullOrEmpty(m.Label) && m.Label.ToLowerInvariant().Contains(q))
      hits.Add(new TimelineHit { Type = "marker", Id = m.Label, Time = m.Time, Label = "标记 · " + m.Label + " @ " + m.Time.ToString("0.00", CultureInfo.InvariantCulture) + "s" });
   if (doc.Subtitles != null) foreach (var s in doc.Subtitles) {
     string t = ((s.Text ?? "") + " " + (s.Text2 ?? "")).ToLowerInvariant();
     if (t.Contains(q)) hits.Add(new TimelineHit { Type = "subtitle", Id = s.Text, Time = s.Start, Label = "字幕 · " + s.Text + " @ " + s.Start.ToString("0.00", CultureInfo.InvariantCulture) + "s" });
    }
   if (doc.Mixer != null) foreach (var ch in doc.Mixer) {
     string hay = ((ch.Role ?? "") + " " + Path.GetFileName(ch.SourcePath ?? "")).ToLowerInvariant();
     if (hay.Contains(q)) hits.Add(new TimelineHit { Type = "role", Id = ch.Role, Time = ch.Start, Label = "角色 · " + ch.Role + " @ " + ch.Start.ToString("0.00", CultureInfo.InvariantCulture) + "s" });
    }
   hits.Sort((a, b) => a.Time.CompareTo(b.Time));
   return hits;
  }
 }

 // ---- 6. 三点编辑 ----
 static class ThreePoint {
  static void CheckSource(EditDocument doc, double srcStart, double srcEnd) {
   if (!EditDocument.Finite(srcStart) || !EditDocument.Finite(srcEnd) || srcStart < 0 || srcEnd <= srcStart || srcEnd > doc.Duration + 0.05)
    throw new Exception("源入出点无效：[" + srcStart.ToString("0.00", CultureInfo.InvariantCulture) + "," + srcEnd.ToString("0.00", CultureInfo.InvariantCulture) + "]，素材只有 " + doc.Duration.ToString("0.00", CultureInfo.InvariantCulture) + "s。");
  }
  static void CheckSplittable(Cut c) {
   if (!c.Gap && Math.Abs(c.Speed - 1) > 0.000001) throw new Exception("三点编辑不支持变速片段（请先把速度改回 1×）。");
  }
  // 在片段内 localT 处切分（timeline.ts splitClipAtTime 同款：J/L 音频窗口按同一源时间切）。
  static Cut[] Split(Cut c, double localT) {
   if (localT <= 0.001 || localT >= c.Length - 0.001) return new[] { c };
   CheckSplittable(c);
   if (c.Gap) return new[] {
    new Cut { Gap = true, GapDuration = localT, Start = c.Start, End = c.Start, Speed = 1 },
    new Cut { Gap = true, GapDuration = c.Length - localT, Start = c.Start, End = c.Start, Speed = 1 } };
   double srcT = c.Start + localT * c.Speed;
   var head = new Cut { Start = c.Start, End = srcT, Speed = c.Speed, AudioIn = c.AudioIn, AudioOut = c.AudioOut.HasValue ? (double?)Math.Min(c.AudioOut.Value, srcT) : null };
   var tail = new Cut { Start = srcT, End = c.End, Speed = c.Speed, AudioIn = c.AudioIn.HasValue ? (double?)Math.Max(c.AudioIn.Value, srcT) : null, AudioOut = c.AudioOut };
   if (head.AudioIn.HasValue && head.AudioOut.HasValue && head.AudioOut.Value <= head.AudioIn.Value) head.AudioOut = null;
   if (tail.AudioIn.HasValue && tail.AudioOut.HasValue && tail.AudioOut.Value <= tail.AudioIn.Value) tail.AudioIn = null;
   return new[] { head, tail };
  }
  public static void Insert(EditDocument doc, double srcStart, double srcEnd, double atTime) {
   CheckSource(doc, srcStart, srcEnd);
   if (atTime < 0 || atTime > doc.Length + 0.001) throw new Exception("插入点超出时间线范围：" + atTime.ToString("0.00", CultureInfo.InvariantCulture) + "s（片长 " + doc.Length.ToString("0.00", CultureInfo.InvariantCulture) + "s）。");
   var fresh = new Cut { Start = srcStart, End = srcEnd, Speed = 1 };
   if (Math.Abs(atTime - doc.Length) < 0.001) { doc.Cuts.Add(fresh); return; }
   double offset = 0;
   for (int i = 0; i < doc.Cuts.Count; i++) {
    var c = doc.Cuts[i];
    if (atTime >= offset - 0.001 && atTime < offset + c.Length) {
     double local = atTime - offset;
     if (local <= 0.001) { doc.Cuts.Insert(i, fresh); return; }
     if (local >= c.Length - 0.001) { doc.Cuts.Insert(i + 1, fresh); return; }
     var parts = Split(c, local);
     doc.Cuts[i] = parts[0]; doc.Cuts.Insert(i + 1, fresh);
     if (parts.Length > 1) doc.Cuts.Insert(i + 2, parts[1]);
     return;
    }
    offset += c.Length;
   }
   doc.Cuts.Add(fresh);
  }
  public static void Overwrite(EditDocument doc, double srcStart, double srcEnd, double atTime) {
   CheckSource(doc, srcStart, srcEnd);
   double dur = srcEnd - srcStart;
   if (atTime < 0 || atTime + dur > doc.Length + 0.001) throw new Exception("覆盖区 [" + atTime.ToString("0.00", CultureInfo.InvariantCulture) + "–" + (atTime + dur).ToString("0.00", CultureInfo.InvariantCulture) + "] 超出时间线（片长 " + doc.Length.ToString("0.00", CultureInfo.InvariantCulture) + "s）。");
   var fresh = new Cut { Start = srcStart, End = srcEnd, Speed = 1 };
   double end = atTime + dur;
   var kept = new List<Cut>(); bool inserted = false;
   double offset = 0;
   foreach (var c in doc.Cuts) {
    double s = offset, e = offset + c.Length;
    if (e <= atTime + 0.001 || s >= end - 0.001) {
     if (s >= end - 0.001 && !inserted) { kept.Add(fresh); inserted = true; }
     kept.Add(c);
    } else if (s < atTime - 0.001 && e > end + 0.001) {
     var hp = Split(c, atTime - s); var tp = Split(c, end - s);
     kept.Add(hp[0]); kept.Add(fresh); inserted = true;
     if (tp.Length > 1) kept.Add(tp[1]);
    } else if (s < atTime - 0.001) {
     var hp = Split(c, atTime - s); kept.Add(hp[0]);
    } else if (e > end + 0.001) {
     if (!inserted) { kept.Add(fresh); inserted = true; }
     var tp = Split(c, end - s); if (tp.Length > 1) kept.Add(tp[1]);
    }
    offset = e;
   }
   if (!inserted) kept.Add(fresh);
   if (kept.Count == 0) throw new Exception("覆盖后时间线为空。");
   doc.Cuts = kept;
  }
  // 换源：只换源文件，保留剪辑点与全部效果（Grade/变速/字幕/标记都不动）。
  public static void ReplaceSource(EditDocument doc, string newPath) {
   if (doc == null) throw new Exception("没有打开的项目。");
   if (string.IsNullOrEmpty(newPath) || !File.Exists(newPath)) throw new Exception("找不到替换素材：" + newPath + "。");
   var nd = StudioMedia.Import(newPath);
   double maxEnd = 0;
   foreach (var c in doc.Cuts) if (!c.Gap && c.End > maxEnd) maxEnd = c.End;
   if (nd.Duration + 0.05 < maxEnd) throw new Exception("替换素材太短：只有 " + nd.Duration.ToString("0.00", CultureInfo.InvariantCulture) + "s，剪辑点最远到 " + maxEnd.ToString("0.00", CultureInfo.InvariantCulture) + "s。");
   doc.Source = nd.Source; doc.Width = nd.Width; doc.Height = nd.Height; doc.Duration = nd.Duration; doc.Audio = nd.Audio; doc.FrameRate = nd.FrameRate;
  }
 }

 // ---- 7. 粘贴属性 ----
 public class ClipAttrs { public double Speed = 1; public ColorGrade Grade = new ColorGrade(); public string AudioType = "无"; public double DenoiseStrength; }
 static class PasteAttributes {
  public static ClipAttrs Capture(EditDocument doc, int cutIndex) {
   if (doc == null || cutIndex < 0 || cutIndex >= doc.Cuts.Count) throw new Exception("没有可复制的片段。");
   var c = doc.Cuts[cutIndex];
   if (c.Gap) throw new Exception("空隙片段没有可复制的属性。");
   if (c.Speed < 0.5 || c.Speed > 2) throw new Exception("源片段速度超出范围（0.5–2×）。");
   var grade = EditDocument.Serializer().Deserialize<ColorGrade>(EditDocument.Serializer().Serialize(doc.Grade));
   return new ClipAttrs { Speed = c.Speed, Grade = grade, AudioType = doc.AudioType, DenoiseStrength = doc.DenoiseStrength };
  }
  public static void Paste(EditDocument targetDoc, int targetCut, ClipAttrs attrs, bool copySpeed, bool copyGrade, bool copyAudio) {
   if (targetDoc == null || attrs == null) throw new Exception("没有可粘贴的属性（先复制一个片段）。");
   if (!copySpeed && !copyGrade && !copyAudio) throw new Exception("请至少选一项要粘贴的属性。");
   if (targetCut < 0 || targetCut >= targetDoc.Cuts.Count) throw new Exception("没有粘贴目标片段。");
   if (copySpeed) {
    if (attrs.Speed < 0.5 || attrs.Speed > 2) throw new Exception("粘贴的速度超出范围（0.5–2×）。");
    targetDoc.Cuts[targetCut].Speed = attrs.Speed;
   }
   if (copyGrade) targetDoc.Grade = EditDocument.Serializer().Deserialize<ColorGrade>(EditDocument.Serializer().Serialize(attrs.Grade));
   if (copyAudio) { targetDoc.AudioType = attrs.AudioType; targetDoc.DenoiseStrength = attrs.DenoiseStrength; }
  }
 }

 // ---- 8. 调整层 ----
 public class AdjustmentLayer {
  public double Start; public double End;
  public double Brightness; public double Contrast = 1; public double Saturation = 1; public double Temperature;
  public bool HasEffect { get { return Math.Abs(Brightness) > 0.000001 || Math.Abs(Contrast - 1) > 0.000001 || Math.Abs(Saturation - 1) > 0.000001 || Math.Abs(Temperature) > 0.000001; } }
 }
 static class AdjustmentLayerFilter {
  public static void Validate(AdjustmentLayer layer, double length) {
   if (layer == null) throw new Exception("没有调整层。");
   if (!EditDocument.Finite(layer.Start) || !EditDocument.Finite(layer.End) || layer.Start < 0 || layer.End <= layer.Start || layer.End > length + 0.05)
    throw new Exception("调整层范围无效：[" + layer.Start.ToString("0.00", CultureInfo.InvariantCulture) + "," + layer.End.ToString("0.00", CultureInfo.InvariantCulture) + "]，片长 " + length.ToString("0.00", CultureInfo.InvariantCulture) + "s。");
   if (!layer.HasEffect) throw new Exception("调整层没有设置任何效果（亮度/对比度/饱和度/色温至少改一项）。");
   if (layer.Brightness < -1 || layer.Brightness > 1 || layer.Contrast < 0 || layer.Contrast > 2 || layer.Saturation < 0 || layer.Saturation > 2 || layer.Temperature < -1 || layer.Temperature > 1)
    throw new Exception("调整层参数超出范围（亮度 ±1、对比度/饱和度 0–2、色温 ±1）。");
  }
  // 拼进解码 vf（时间线时间 t，与 timeline.ts 的 adjustmentLayerFilter 同款：
  // eq/colorbalance + enable='between(t,start,end)'，只作用于该时间段）。
  public static string Build(EditDocument doc) {
   if (doc == null || doc.AdjustmentLayers == null || doc.AdjustmentLayers.Count == 0) return "";
   var sb = new StringBuilder();
   foreach (var layer in doc.AdjustmentLayers) {
    Validate(layer, doc.Length);
    var eq = new List<string>();
    if (Math.Abs(layer.Brightness) > 0.000001) eq.Add("brightness=" + Media.N(layer.Brightness));
    if (Math.Abs(layer.Contrast - 1) > 0.000001) eq.Add("contrast=" + Media.N(layer.Contrast));
    if (Math.Abs(layer.Saturation - 1) > 0.000001) eq.Add("saturation=" + Media.N(layer.Saturation));
    string enable = ":enable='between(t," + Media.N(layer.Start) + "," + Media.N(layer.End) + ")'";
    if (eq.Count > 0) sb.Append(",eq=" + string.Join(":", eq.ToArray()) + enable);
    if (Math.Abs(layer.Temperature) > 0.000001) sb.Append(",colorbalance=rs=" + Media.N(layer.Temperature) + ":gs=0:bs=" + Media.N(-layer.Temperature) + enable);
   }
   return sb.ToString();
  }
 }

 // ---- 9. 文字剪切 ----
 public class WordItem { public string Text = ""; public double Start; public double End; }
 static class TextCut {
  public static bool HasWordTimestamps(List<WordItem> words) {
   if (words == null || words.Count == 0) return false;
   foreach (var w in words) if (w == null || string.IsNullOrWhiteSpace(w.Text) || !EditDocument.Finite(w.Start) || !EditDocument.Finite(w.End) || w.End <= w.Start) return false;
   return true;
  }
  // 删文字即删对应时间段（源时间）；切分 + 字幕/标记跟随前移复用 SilenceCut.Apply。
  public static double Apply(EditDocument doc, List<WordItem> words, List<string> deleteWords) {
   if (doc == null) throw new Exception("没有打开的项目。");
   if (!HasWordTimestamps(words)) throw new Exception("词级时间戳不完整：每个词都必须有起止时间（P0b 转写输出）。");
   if (deleteWords == null || deleteWords.Count == 0) throw new Exception("没有要删的词。");
   var spans = new List<SilenceCut.Span>();
   foreach (var w in words) {
    foreach (var d in deleteWords)
     if (string.Equals(w.Text.Trim(), d.Trim(), StringComparison.OrdinalIgnoreCase)) { spans.Add(new SilenceCut.Span { Start = w.Start, End = w.End }); break; }
   }
   if (spans.Count == 0) throw new Exception("要删的词在转写里不存在。");
   spans.Sort((a, b) => a.Start.CompareTo(b.Start));
   var merged = new List<SilenceCut.Span>();
   foreach (var s in spans) {
    if (merged.Count > 0 && s.Start <= merged[merged.Count - 1].End + 0.05) merged[merged.Count - 1].End = Math.Max(merged[merged.Count - 1].End, s.End);
    else merged.Add(new SilenceCut.Span { Start = s.Start, End = s.End });
   }
   return SilenceCut.Apply(doc, merged);
  }
 }

 // ---- 10. Remix（音乐自适应时长） ----
 public class RemixSegment { public double SourceStart; public double SourceEnd; public double Length { get { return SourceEnd - SourceStart; } } }
 public class RemixPlan { public List<RemixSegment> Segments = new List<RemixSegment>(); public double TargetDuration; public double Bpm; public double Total { get { double t = 0; foreach (var s in Segments) t += s.Length; return t; } } }
 static class Remix {
  // 按节拍循环/跳切拼贴：小节 = 相邻节拍之间（尾巴够半拍也算一段），
  // 按顺序循环取小节、最后一段截到正好填满目标时长；全程不改速（不用 atempo）。
  public static RemixPlan Plan(List<double> beats, double sourceDuration, double targetDuration) {
   if (beats == null || beats.Count < 2) throw new Exception("Remix 需要至少 2 个节拍点（先检测节拍）。");
   if (targetDuration <= 0) throw new Exception("目标时长必须大于 0。");
   if (sourceDuration <= 0) throw new Exception("源音乐时长无效。");
   var sorted = beats.ToList(); sorted.Sort();
   for (int i = 1; i < sorted.Count; i++) if (sorted[i] <= sorted[i - 1] + 0.001) throw new Exception("节拍点必须递增。");
   if (sorted[0] < -0.001 || sorted[sorted.Count - 1] > sourceDuration + 0.001) throw new Exception("节拍点超出源音乐范围。");
   var bars = new List<RemixSegment>();
   for (int i = 0; i + 1 < sorted.Count; i++) { double len = sorted[i + 1] - sorted[i]; if (len >= 0.1) bars.Add(new RemixSegment { SourceStart = sorted[i], SourceEnd = sorted[i + 1] }); }
   double last = sorted[sorted.Count - 1];
   if (sourceDuration - last >= 0.25) bars.Add(new RemixSegment { SourceStart = last, SourceEnd = sourceDuration });
   if (bars.Count == 0) throw new Exception("节拍间隔太短，拼不出小节。");
   var lens = bars.Select(b => b.Length).OrderBy(v => v).ToList();
   double period = lens[lens.Count / 2];
   var plan = new RemixPlan { TargetDuration = targetDuration, Bpm = period > 0 ? 60 / period : 0 };
   double filled = 0; int bi = 0;
   while (filled < targetDuration - 0.001) {
    var bar = bars[bi % bars.Count]; bi++;
    double need = targetDuration - filled;
    if (bar.Length <= need + 0.001) { plan.Segments.Add(new RemixSegment { SourceStart = bar.SourceStart, SourceEnd = bar.SourceEnd }); filled += bar.Length; }
    else { plan.Segments.Add(new RemixSegment { SourceStart = bar.SourceStart, SourceEnd = bar.SourceStart + need }); filled = targetDuration; }
   }
   return plan;
  }
  // 方案落成新项目：片段全是 1× 常速源范围（不改速 = 不变调）；字幕/标记/缩放/
  // 贴图/多机位切换/闪白节拍都是旧时间线时间，Remix 后全部失效，直接清空。
  public static EditDocument BuildDoc(EditDocument doc, RemixPlan plan) {
   if (doc == null || plan == null || plan.Segments.Count == 0) throw new Exception("没有 Remix 方案可导出。");
   var nd = EditDocument.Deserialize(doc.Serialize());
   nd.Cuts = plan.Segments.Select(s => new Cut { Start = s.SourceStart, End = s.SourceEnd, Speed = 1 }).ToList();
   nd.Subtitles = new List<SubtitleCue>(); nd.RecordingMarkers = new List<RecordingMarker>();
   nd.Zooms = new List<Zoom>(); nd.Overlays = new List<OverlayClip>();
   nd.MulticamSwitches = new List<MulticamSwitch>(); nd.FlashBeats = new List<double>();
   nd.AdjustmentLayers = new List<AdjustmentLayer>(); nd.CompoundClips = new List<CompoundClip>();
   nd.MorphEnabled = false;
   return nd;
  }
  public static BeatGrid DetectBeats(string file, double duration, CancellationToken token) {
   var grid = BeatDetector.Detect(file, 0, duration, token);
   if (grid == null || grid.Beats == null || grid.Beats.Count < 2) throw new Exception("没有检测到节拍（只认起音丰富的音乐，独白/环境音置信度低）。");
   return grid;
  }
 }

 // ---- 11. 仅导出字幕/音乐/视频三开关 ----
 static class ExportOnly {
  public static string Resolve(bool videoOnly, bool audioOnly, bool subtitleOnly) {
   int n = (videoOnly ? 1 : 0) + (audioOnly ? 1 : 0) + (subtitleOnly ? 1 : 0);
   if (n > 1) throw new Exception("仅导出开关互斥：只能同时开一个（视频/音频/字幕）。");
   if (videoOnly) return "video"; if (audioOnly) return "audio"; if (subtitleOnly) return "subtitle"; return "none";
  }
 }
}
