// W9 多轨时间线·模型与纯逻辑（2026-11-19）：真多轨重写的 WPF 接线。
// 引擎（product/engine/src/multitrack.ts + filtergraph.ts + export.ts）已合进 main，
// 这里是 C# 侧的等价物——只读引擎、不改引擎 TS。
// 模型对照（字段名与语义照搬引擎 project.ts / multitrack.ts）：
// - VideoTrack[] 下往上叠（数组顺序 = 底层→顶层）；AudioTrack[] 只出音频。
// - 视频轨片段带视频 + 联动音频；音频轨片段只出音频（视频忽略）。
// - 同轨片段可重叠：后起的在上；无 transitionIn 的重叠是硬切，transitionIn
//   的重叠走 xfade/acrossfade；不重叠的 transitionIn 只支持 fade/dissolve/
//   fadeblack/fadewhite（在下层合成图上淡入），wipe/slide/circle 需要同轨重叠。
// - blend 模式轨忽略 alpha（引擎 compositeVideoTrack 的 gbrp 路径）；
//   blend 轨不能同时带偏移/缩放（无 offset stage）；不可见轨只藏视频，联动音频照播。
// - 同轨音频重叠硬切（要叠声音请分轨，amix 在轨间混）；transitionIn 只对视频有效，
//   音频在 clip start 处起（引擎 assembleTrackAudio 同款）。
// - 轨的 locked 只是 UI 提示，不影响渲染；空轨合法、什么都不出。
// 旧单轨兼容（与引擎 normalizeToTracks 同款）：Normalize() 把 Cuts 变成 1 条视频轨
// （非 cut 的 doc.Transition 变成后一片的 transitionIn、起片点提前 transitionDuration，
// doc.Transition 随后归零）+ 1 条空音频轨；Cuts 随后由 SyncLegacyCuts() 从视频轨 0
// 回填（带空隙），所以旧版读新文件时退化成单轨 v0，不静默丢轨——轨本身仍在 tracks 字段里。
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using DogSC.Windows;

namespace DogSC.Replica {
 // ---- 模型 ----
 public class MtClip {
  public string Id = "";
  public string Source = "";
  public double In; public double Out;
  public double Speed = 1; public double Volume = 1;
  // 轨内起始时间（秒，>= 0）。Duration = (Out-In)/Speed。
  public double Start;
  // 到达方式：空 = 硬切。只对视频有效（引擎 CrossTrackTransition 同款）。
  public string TransitionInType = "";
  public double TransitionInDuration;
  // 联动关时删视频留下的纯音频片段：视频黑场、音频保留（引擎 audioOnly 同款）。
  public bool AudioOnly;
  public double Duration { get { return Speed > 0 ? (Out - In) / Speed : 0; } }
  public double End { get { return Start + Duration; } }
 }
 public class MtVideoTrack {
  public string Id = ""; public string Name = "";
  public List<MtClip> Clips = new List<MtClip>();
  public double Opacity = 1; public string Blend = "normal";
  public double X; public double Y; public double W = 1; public double H = 1;
  public bool Visible = true; public bool Locked;
 }
 public class MtAudioTrack {
  public string Id = ""; public string Name = "";
  public List<MtClip> Clips = new List<MtClip>();
  public double GainDb; public double Pan; public bool Mute; public bool Solo;
 }
 // 展平后的一次出现（与引擎 FlatClip 同款顺序：视频轨在前、音频轨在后，
 // 轨内按 start 排；Global = ffmpeg 输入序号）。
 public class MtFlat {
  public MtClip Clip; public string Kind = ""; public int TrackIndex; public string TrackId = ""; public int ClipIndex; public int Global;
 }

 static class MultitrackDoc {
  public static bool HasTracks(EditDocument doc) {
   return doc != null && ((doc.VideoTracks != null && doc.VideoTracks.Count > 0) || (doc.AudioTracks != null && doc.AudioTracks.Count > 0));
  }
  static bool Finite(double n) { return EditDocument.Finite(n); }
  static string N(double v) { return Media.N(v); }

  // 旧单轨 → 1 视频轨 + 1 空音频轨（引擎 normalizeToTracks 同款，另加一条空音频轨，
  // 空轨不影响渲染；doc.Transition 非 cut 时按引擎口径变成 transitionIn + 重叠起片）。
  public static void Normalize(EditDocument doc) {
   if (doc == null) throw new Exception("没有打开的项目。");
   if (HasTracks(doc)) return;
   if (doc.Cuts == null || doc.Cuts.Count == 0) throw new Exception("单轨项目没有片段，无法转为多轨。");
   var clips = new List<MtClip>(); double t = 0;
   bool xfade = !string.IsNullOrEmpty(doc.Transition) && doc.Transition != "cut" && doc.TransitionDuration > 0;
   for (int i = 0; i < doc.Cuts.Count; i++) {
    var c = doc.Cuts[i];
    if (c.Gap) { t += c.GapDuration; continue; }
    var mc = new MtClip { Id = "c" + i, Source = doc.Source, In = c.Start, Out = c.End, Speed = c.Speed, Volume = 1, Start = t, AudioOnly = c.AudioOnly };
    if (i > 0 && xfade) { mc.TransitionInType = doc.Transition; mc.TransitionInDuration = doc.TransitionDuration; mc.Start = t - doc.TransitionDuration; }
    clips.Add(mc);
    t += c.Length;
    if (xfade) t -= doc.TransitionDuration;
   }
   if (clips.Count == 0) throw new Exception("单轨项目只有空隙片段，无法转为多轨。");
   doc.VideoTracks = new List<MtVideoTrack> { new MtVideoTrack { Id = "v0", Name = "视频 1", Clips = clips } };
   doc.AudioTracks = new List<MtAudioTrack> { new MtAudioTrack { Id = "a0", Name = "音频 1" } };
   doc.Transition = "cut"; doc.TransitionDuration = 0;
   SyncLegacyCuts(doc);
  }

  // Cuts 从视频轨 0 回填（旧版退化单轨用；重叠的轨内片段按顺序排，Cuts 的 Length
  // 之和会大于轨时长——Length 取值走 tracks，不走 Cuts，见 EditDocument.Length）。
  public static void SyncLegacyCuts(EditDocument doc) {
   if (!HasTracks(doc) || doc.VideoTracks == null || doc.VideoTracks.Count == 0) return;
   var track = doc.VideoTracks[0];
   var sorted = track.Clips.OrderBy(c => c.Start).ToList();
   var cuts = new List<Cut>(); double t = 0;
   foreach (var mc in sorted) {
    if (mc.Start > t + 0.001) cuts.Add(new Cut { Gap = true, GapDuration = mc.Start - t, Start = mc.In, End = mc.In, Speed = 1 });
    cuts.Add(new Cut { Start = mc.In, End = mc.Out, Speed = mc.Speed, AudioOnly = mc.AudioOnly });
    t = Math.Max(t, mc.End);
   }
   if (cuts.Count > 0) doc.Cuts = cuts;
  }

  public static double Duration(EditDocument doc) {
   double d = 0;
   if (doc.VideoTracks != null) foreach (var tr in doc.VideoTracks) foreach (var c in tr.Clips) d = Math.Max(d, c.End);
   if (d <= 0 && doc.AudioTracks != null) foreach (var tr in doc.AudioTracks) foreach (var c in tr.Clips) d = Math.Max(d, c.End);
   if (d <= 0 && doc.Cuts != null) { double s = 0; foreach (var c in doc.Cuts) s += c.Length; d = s; }
   return d;
  }
  public static int TotalClips(EditDocument doc) {
   int n = 0;
   if (doc.VideoTracks != null) foreach (var tr in doc.VideoTracks) n += tr.Clips.Count;
   if (doc.AudioTracks != null) foreach (var tr in doc.AudioTracks) n += tr.Clips.Count;
   return n;
  }
  public static List<MtFlat> Flatten(EditDocument doc) {
   var flat = new List<MtFlat>(); int g = 0;
   if (doc.VideoTracks != null) for (int ti = 0; ti < doc.VideoTracks.Count; ti++) {
    var sorted = doc.VideoTracks[ti].Clips.Select((c, i) => new { Clip = c, Index = i }).OrderBy(x => x.Clip.Start).ThenBy(x => x.Index).ToList();
    foreach (var x in sorted) flat.Add(new MtFlat { Clip = x.Clip, Kind = "video", TrackIndex = ti, TrackId = doc.VideoTracks[ti].Id, ClipIndex = x.Index, Global = g++ });
   }
   if (doc.AudioTracks != null) for (int ti = 0; ti < doc.AudioTracks.Count; ti++) {
    var sorted = doc.AudioTracks[ti].Clips.Select((c, i) => new { Clip = c, Index = i }).OrderBy(x => x.Clip.Start).ThenBy(x => x.Index).ToList();
    foreach (var x in sorted) flat.Add(new MtFlat { Clip = x.Clip, Kind = "audio", TrackIndex = ti, TrackId = doc.AudioTracks[ti].Id, ClipIndex = x.Index, Global = g++ });
   }
   return flat;
  }
  static MtVideoTrack FindVideo(EditDocument doc, string id) {
   if (doc.VideoTracks == null) return null;
   foreach (var tr in doc.VideoTracks) if (tr.Id == id) return tr;
   return null;
  }
  static MtAudioTrack FindAudio(EditDocument doc, string id) {
   if (doc.AudioTracks == null) return null;
   foreach (var tr in doc.AudioTracks) if (tr.Id == id) return tr;
   return null;
  }
  // 该时刻轨内在播的片段（重叠时后起的在上，与引擎同款）。
  public static MtClip ClipAt(List<MtClip> clips, double time) {
   MtClip best = null;
   if (clips == null) return null;
   foreach (var c in clips) if (time >= c.Start - 0.000001 && time < c.End && (best == null || c.Start > best.Start)) best = c;
   return best;
  }
  // 引擎 resolveAudioTrackMute 同款：任一音频轨 solo 时，未 solo 的全静音。
  public static Dictionary<string, bool> ResolveAudioMute(EditDocument doc) {
   var map = new Dictionary<string, bool>();
   if (doc.AudioTracks == null) return map;
   bool anySolo = doc.AudioTracks.Any(t => t.Solo);
   foreach (var t in doc.AudioTracks) map[t.Id] = t.Mute || (anySolo && !t.Solo);
   return map;
  }

  // ---- 校验（引擎 validateMultitrackProject 照搬；失败直接抛错，不静默修） ----
  public static void Validate(EditDocument doc) {
   if (!HasTracks(doc)) return;
   if (!string.IsNullOrEmpty(doc.Transition) && doc.Transition != "cut")
    throw new Exception("多轨项目不能带非 cut 的旧式转场（渲染时会直接忽略）：请先把转场改成硬切，或回到单轨。");
   var ids = new HashSet<string>();
   string[] blends = { "normal", "multiply", "screen", "overlay", "darken", "lighten", "add" };
   if (doc.VideoTracks != null) foreach (var tr in doc.VideoTracks) {
    CheckId(tr.Id, ids, "视频轨");
    if (!Finite(tr.Opacity) || tr.Opacity < 0 || tr.Opacity > 1) throw new Exception("视频轨 \"" + tr.Id + "\"：不透明度 " + N(tr.Opacity) + " 超出 [0, 1]。");
    if (string.IsNullOrEmpty(tr.Blend)) tr.Blend = "normal";
    if (!blends.Contains(tr.Blend)) throw new Exception("视频轨 \"" + tr.Id + "\"：混合模式 \"" + tr.Blend + "\" 未知（normal/multiply/screen/overlay/darken/lighten/add）。");
    if (tr.Blend != "normal" && (Math.Abs(tr.X) > 0.000001 || Math.Abs(tr.Y) > 0.000001 || Math.Abs(tr.W - 1) > 0.000001 || Math.Abs(tr.H - 1) > 0.000001))
     throw new Exception("视频轨 \"" + tr.Id + "\"：混合模式 \"" + tr.Blend + "\" 不能同时带轨偏移/缩放（blend 路径没有 offset stage，alpha 也会被忽略）。");
    if (!Finite(tr.X) || !Finite(tr.Y)) throw new Exception("视频轨 \"" + tr.Id + "\"：偏移不是有限数。");
    if (!Finite(tr.W) || !Finite(tr.H) || tr.W <= 0 || tr.W > 1 || tr.H <= 0 || tr.H > 1) throw new Exception("视频轨 \"" + tr.Id + "\"：宽高比例须在 (0, 1] 内。");
    if (tr.Clips == null) tr.Clips = new List<MtClip>();
    CheckClips(tr.Id, tr.Clips);
   }
   if (doc.AudioTracks != null) foreach (var tr in doc.AudioTracks) {
    CheckId(tr.Id, ids, "音频轨");
    if (!Finite(tr.GainDb) || tr.GainDb < -60 || tr.GainDb > 12) throw new Exception("音频轨 \"" + tr.Id + "\"：增益 " + N(tr.GainDb) + " dB 超出 [-60, 12]。");
    if (!Finite(tr.Pan) || tr.Pan < -1 || tr.Pan > 1) throw new Exception("音频轨 \"" + tr.Id + "\"：声像 " + N(tr.Pan) + " 超出 [-1, 1]。");
    if (tr.Clips == null) tr.Clips = new List<MtClip>();
    CheckClips(tr.Id, tr.Clips);
   }
  }
  static void CheckId(string id, HashSet<string> ids, string kind) {
   if (string.IsNullOrEmpty(id)) throw new Exception(kind + "需要非空的轨 id。");
   if (ids.Contains(id)) throw new Exception("轨 id 重复：\"" + id + "\"。");
   ids.Add(id);
  }
  static void CheckClips(string trackId, List<MtClip> clips) {
   var sorted = clips.OrderBy(c => c.Start).ToList();
   double prevEnd = double.NegativeInfinity;
   string[] crossfade = { "fade", "dissolve", "fadeblack", "fadewhite" };
   string[] all = { "cut", "fade", "dissolve", "wipeleft", "wiperight", "slideleft", "circleopen", "fadeblack", "fadewhite" };
   foreach (var c in sorted) {
    if (string.IsNullOrEmpty(c.Id)) throw new Exception("轨 \"" + trackId + "\" 有片段缺少 id。");
    if (string.IsNullOrEmpty(c.Source) || !File.Exists(c.Source)) throw new Exception("轨 \"" + trackId + "\" 片段 " + c.Id + " 的素材缺失：" + (string.IsNullOrEmpty(c.Source) ? "（未关联）" : c.Source) + "。");
    if (!Finite(c.Start) || c.Start < 0) throw new Exception("轨 \"" + trackId + "\" 片段 " + c.Id + "：起始时间 " + N(c.Start) + " 必须 >= 0。");
    if (!Finite(c.In) || !Finite(c.Out) || c.Out <= c.In) throw new Exception("轨 \"" + trackId + "\" 片段 " + c.Id + "：源窗口 [" + N(c.In) + ", " + N(c.Out) + "] 无效。");
    if (!Finite(c.Speed) || c.Speed < 0.3 || c.Speed > 2) throw new Exception("轨 \"" + trackId + "\" 片段 " + c.Id + "：速度 " + N(c.Speed) + " 超出 0.3–2×。");
    if (!Finite(c.Volume) || c.Volume < 0 || c.Volume > 4) throw new Exception("轨 \"" + trackId + "\" 片段 " + c.Id + "：音量 " + N(c.Volume) + " 超出 0–4。");
    if (!(c.Duration > 0)) throw new Exception("轨 \"" + trackId + "\" 片段 " + c.Id + "：时长必须 > 0。");
    if (!string.IsNullOrEmpty(c.TransitionInType)) {
     bool overlaps = c.Start < prevEnd - 0.000000001;
     double overlap = overlaps ? prevEnd - c.Start : 0;
     string[] allowed = overlaps ? all : crossfade;
     if (!allowed.Contains(c.TransitionInType))
      throw new Exception(overlaps
       ? "轨 \"" + trackId + "\" 片段 " + c.Id + "：transitionIn 类型 \"" + c.TransitionInType + "\" 不是转场类型。"
       : "轨 \"" + trackId + "\" 片段 " + c.Id + "：transitionIn 类型 \"" + c.TransitionInType + "\" 在下层合成图上不支持（请用 fade/dissolve/fadeblack/fadewhite；wipe/slide/circle 需要同轨重叠）。");
     if (c.TransitionInType == "cut") throw new Exception("轨 \"" + trackId + "\" 片段 " + c.Id + "：transitionIn 不能是 cut（硬切请留空）。");
     double maxDur = overlaps ? Math.Min(c.Duration, overlap) : c.Duration;
     if (!Finite(c.TransitionInDuration) || c.TransitionInDuration <= 0 || c.TransitionInDuration > maxDur + 0.000000001)
      throw new Exception("轨 \"" + trackId + "\" 片段 " + c.Id + "：transitionIn 时长 " + N(c.TransitionInDuration) + " 须在 (0, " + maxDur.ToString("0.000", CultureInfo.InvariantCulture) + "] 内" + (overlaps ? "（同轨重叠长度）" : "") + "。");
    }
    prevEnd = Math.Max(prevEnd, c.End);
   }
  }

  // ---- 轨编辑 ----
  public static MtVideoTrack AddVideoTrack(EditDocument doc, string name) {
   if (doc.VideoTracks == null) doc.VideoTracks = new List<MtVideoTrack>();
   int k = doc.VideoTracks.Count;
   string id; do { id = "v" + k; k++; } while (FindVideo(doc, id) != null);
   var tr = new MtVideoTrack { Id = id, Name = string.IsNullOrWhiteSpace(name) ? "视频 " + (doc.VideoTracks.Count + 1) : name.Trim() };
   doc.VideoTracks.Add(tr); return tr;
  }
  public static MtAudioTrack AddAudioTrack(EditDocument doc, string name) {
   if (doc.AudioTracks == null) doc.AudioTracks = new List<MtAudioTrack>();
   int k = doc.AudioTracks.Count;
   string id; do { id = "a" + k; k++; } while (FindAudio(doc, id) != null);
   var tr = new MtAudioTrack { Id = id, Name = string.IsNullOrWhiteSpace(name) ? "音频 " + (doc.AudioTracks.Count + 1) : name.Trim() };
   doc.AudioTracks.Add(tr); return tr;
  }
  public static void RemoveTrack(EditDocument doc, string kind, string id) {
   if (kind == "video") {
    var tr = FindVideo(doc, id); if (tr == null) throw new Exception("没有这条视频轨：" + id + "。");
    if (tr.Clips.Count > 0) throw new Exception("只能删空轨：\"" + (tr.Name ?? id) + "\" 里还有 " + tr.Clips.Count + " 个片段，先移走或删除。");
    if (TotalClips(doc) == 0 && doc.VideoTracks.Count + (doc.AudioTracks == null ? 0 : doc.AudioTracks.Count) <= 1) throw new Exception("至少保留一条轨。");
    doc.VideoTracks.Remove(tr);
   } else {
    var tr = FindAudio(doc, id); if (tr == null) throw new Exception("没有这条音频轨：" + id + "。");
    if (tr.Clips.Count > 0) throw new Exception("只能删空轨：\"" + (tr.Name ?? id) + "\" 里还有 " + tr.Clips.Count + " 个片段，先移走或删除。");
    if (TotalClips(doc) == 0 && doc.VideoTracks.Count + doc.AudioTracks.Count <= 1) throw new Exception("至少保留一条轨。");
    doc.AudioTracks.Remove(tr);
   }
  }
  public static void RenameTrack(EditDocument doc, string kind, string id, string name) {
   if (string.IsNullOrWhiteSpace(name)) throw new Exception("轨名不能为空。");
   if (kind == "video") { var tr = FindVideo(doc, id); if (tr == null) throw new Exception("没有这条视频轨：" + id + "。"); tr.Name = name.Trim(); }
   else { var tr = FindAudio(doc, id); if (tr == null) throw new Exception("没有这条音频轨：" + id + "。"); tr.Name = name.Trim(); }
  }
  // 轨间拖动：改 trackId 与轨内时间。目标轨锁定拒绝；音频 → 视频要求源文件带视频轨。
  public static void MoveClip(EditDocument doc, string fromKind, string fromTrackId, int clipIndex, string toKind, string toTrackId, double newStart) {
   if (!Finite(newStart) || newStart < 0) throw new Exception("移动目标时间无效：" + N(newStart) + "s。");
   MtClip clip;
   if (fromKind == "video") {
    var from = FindVideo(doc, fromTrackId); if (from == null) throw new Exception("没有这条视频轨：" + fromTrackId + "。");
    if (clipIndex < 0 || clipIndex >= from.Clips.Count) throw new Exception("没有这个片段。");
    clip = from.Clips[clipIndex]; from.Clips.RemoveAt(clipIndex);
   } else {
    var from = FindAudio(doc, fromTrackId); if (from == null) throw new Exception("没有这条音频轨：" + fromTrackId + "。");
    if (clipIndex < 0 || clipIndex >= from.Clips.Count) throw new Exception("没有这个片段。");
    clip = from.Clips[clipIndex]; from.Clips.RemoveAt(clipIndex);
   }
   try {
    if (toKind == "video") {
     var to = FindVideo(doc, toTrackId); if (to == null) throw new Exception("没有这条视频轨：" + toTrackId + "。");
     if (to.Locked) throw new Exception("目标轨 \"" + (to.Name ?? toTrackId) + "\" 已锁定，先解锁再移动。");
     if (fromKind == "audio" && !MultitrackFilter.HasVideo(clip.Source)) throw new Exception("音频片段不能移到视频轨：源文件没有视频轨（" + clip.Source + "）。");
     clip.Start = newStart; to.Clips.Add(clip);
    } else {
     var to = FindAudio(doc, toTrackId); if (to == null) throw new Exception("没有这条音频轨：" + toTrackId + "。");
     clip.Start = newStart; to.Clips.Add(clip);
    }
   } catch {
    // 目标无效时把片段放回原轨，不丢片段。
    if (fromKind == "video") FindVideo(doc, fromTrackId).Clips.Insert(Math.Min(clipIndex, FindVideo(doc, fromTrackId).Clips.Count), clip);
    else FindAudio(doc, fromTrackId).Clips.Insert(Math.Min(clipIndex, FindAudio(doc, fromTrackId).Clips.Count), clip);
    throw;
   }
   SyncLegacyCuts(doc);
  }
  // 在 time 处切分片段（只支持 1× 常速，与三点编辑同款限制；变速片段先改回 1×）。
  public static int SplitClipAt(EditDocument doc, string kind, string trackId, int clipIndex, double time) {
   List<MtClip> clips;
   if (kind == "video") { var tr = FindVideo(doc, trackId); if (tr == null) throw new Exception("没有这条视频轨：" + trackId + "。"); clips = tr.Clips; }
   else { var tr = FindAudio(doc, trackId); if (tr == null) throw new Exception("没有这条音频轨：" + trackId + "。"); clips = tr.Clips; }
   if (clipIndex < 0 || clipIndex >= clips.Count) throw new Exception("没有这个片段。");
   var c = clips[clipIndex];
   if (Math.Abs(c.Speed - 1) > 0.000001) throw new Exception("切分不支持变速片段（请先把速度改回 1×）。");
   double local = time - c.Start;
   if (local <= 0.05 || local >= c.Duration - 0.05) throw new Exception("请将播放头放在片段中间再分割。");
   double srcT = c.In + local * c.Speed;
   var tail = new MtClip { Id = c.Id + "b", Source = c.Source, In = srcT, Out = c.Out, Speed = c.Speed, Volume = c.Volume, Start = time, AudioOnly = c.AudioOnly };
   c.Out = srcT;
   clips.Insert(clipIndex + 1, tail);
   SyncLegacyCuts(doc);
   return clipIndex + 1;
  }
  public static void DeleteClip(EditDocument doc, string kind, string trackId, int clipIndex, bool ripple) {
   if (TotalClips(doc) <= 1) throw new Exception("至少保留一个片段。");
   List<MtClip> clips;
   if (kind == "video") { var tr = FindVideo(doc, trackId); if (tr == null) throw new Exception("没有这条视频轨：" + trackId + "。"); if (tr.Locked) throw new Exception("该轨已锁定，先解锁再删除。"); clips = tr.Clips; }
   else { var tr = FindAudio(doc, trackId); if (tr == null) throw new Exception("没有这条音频轨：" + trackId + "。"); clips = tr.Clips; }
   if (clipIndex < 0 || clipIndex >= clips.Count) throw new Exception("没有这个片段。");
   var c = clips[clipIndex]; double dur = c.Duration; double start = c.Start;
   clips.RemoveAt(clipIndex);
   if (ripple) foreach (var other in clips) if (other.Start > start + 0.000001) other.Start = Math.Max(0, other.Start - dur);
   SyncLegacyCuts(doc);
  }
 }

 // ---- 诚实拒绝：引擎没有 track-aware 实现的功能 ----
 static class MultitrackGuard {
  // export.ts applyTimelinePrep 同款：多轨项目带这些直接拒绝，不静默出未处理的时间线。
  public static void RequireSingleTrack(EditDocument doc, string op) {
   if (MultitrackDoc.HasTracks(doc))
    throw new Exception("“" + op + "”暂不支持多轨项目：引擎还没有 track-aware 实现。请先回到单轨时间线再用，或把处理好的结果当作新素材导入音频轨。");
  }
  // 导出前检查（EditDocument 上实际存得了的旗）：人声分离是项目级开关；
  // 一键删静音 / 文字剪切 / Remix 不存项目，只在界面入口禁用（见 EditorApp 声音页）。
  public static void CheckExport(EditDocument doc) {
   if (MultitrackDoc.HasTracks(doc) && doc.VocalSep != null && doc.VocalSep.Mode != "关")
    throw new Exception("人声分离暂不支持多轨项目：引擎还没有 track-aware 实现。请先关掉人声分离，或回到单轨再分离。");
  }
 }

 // ---- 多轨合成滤镜图（C# 桥接：照引擎 filtergraph.ts 逐轨组装后 overlay/blend、
 // 音频 amix 的结构拼 ffmpeg 参数，不另发明图结构） ----
 static class MultitrackFilter {
  static string N(double v) { return Media.N(v); }
  public static bool HasAudio(string path) {
   try { Media.AudioChannels(path); return true; } catch { return false; }
  }
  public static bool HasVideo(string path) {
   try {
    using (var p = Media.Start("ffprobe", "-v error -select_streams v:0 -show_entries stream=codec_type -of csv=p=0 " + Media.Q(path), true)) {
     string text = p.StandardOutput.ReadToEnd(); p.WaitForExit();
     return p.ExitCode == 0 && text.Trim() == "video";
    }
   } catch { return false; }
  }
  static string XfadeName(string type) {
   switch (type) {
    case "fade": return "fade"; case "dissolve": return "dissolve";
    case "wipeleft": return "wipeleft"; case "wiperight": return "wiperight";
    case "slideleft": return "slideleft"; case "circleopen": return "circleopen";
    case "fadeblack": return "fadeblack"; case "fadewhite": return "fadewhite";
    default: throw new Exception("未知的转场类型：" + type + "。");
   }
  }
  static string BlendName(string blend) {
   switch (blend) {
    case "multiply": return "multiply"; case "screen": return "screen";
    case "overlay": return "overlay"; case "darken": return "darken";
    case "lighten": return "lighten"; case "add": return "addition";
    default: throw new Exception("未知的混合模式：" + blend + "。");
   }
  }
  // roles.ts panGains 同款：lg = min(1, 1-pan)，rg = min(1, 1+pan)。
  static void PanGains(double pan, out double lg, out double rg) { lg = Math.Min(1, 1 - pan); rg = Math.Min(1, 1 + pan); }

  public static List<string> InputFiles(EditDocument doc) {
   var files = new List<string>();
   foreach (var f in MultitrackDoc.Flatten(doc)) files.Add(f.Clip.Source);
   return files;
  }
  // 拼 filter_complex；hasAudio = 是否有任何真实音频（全无音频时图里仍有 [aout]
  // 静音源，调用方按 hasAudio 决定最终映不映射音频）。
  public static string BuildFilterComplex(EditDocument doc, int width, int height, int fps, out bool hasAudio) {
   MultitrackDoc.Validate(doc);
   double projDur = MultitrackDoc.Duration(doc);
   var flat = MultitrackDoc.Flatten(doc);
   var byKey = new Dictionary<string, MtFlat>();
   foreach (var f in flat) byKey[f.Kind + ":" + f.TrackIndex + ":" + f.ClipIndex] = f;
   var chains = new List<string>();
   hasAudio = false;
   var audioReal = new Dictionary<int, bool>();
   // ---- 每片段链 ----
   foreach (var f in flat) {
    var c = f.Clip; int g = f.Global;
    if (f.Kind == "video") {
     chains.Add("[" + g + ":v]trim=start=" + N(c.In) + ":end=" + N(c.Out) + ",setpts=(PTS-STARTPTS)/" + N(c.Speed) +
      ",scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease,pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2,fps=" + fps + ",format=yuva420p[v" + g + "]");
    }
    bool real = HasAudio(c.Source);
    audioReal[g] = real;
    if (real) hasAudio = true;
    if (!real) {
     chains.Add("anullsrc=r=48000:cl=stereo:d=" + N(c.Duration) + "[a" + g + "]");
    } else {
     var parts = new List<string>();
     parts.Add("[" + g + ":a]atrim=start=" + N(c.In) + ":end=" + N(c.Out) + ",asetpts=PTS-STARTPTS," + SilenceCut.AtempoChain(c.Speed));
     if (Math.Abs(c.Volume - 1) > 0.000001) parts.Add("volume=" + N(c.Volume));
     parts.Add("aresample=48000");
     int ch = 1;
     try { ch = Media.AudioChannels(c.Source); } catch { ch = 2; }
     if (ch == 1) parts.Add("pan=stereo|c0=c0|c1=c0");
     chains.Add(string.Join(",", parts.ToArray()) + "[a" + g + "]");
    }
   }
   // ---- 视频：逐轨组装后 overlay/blend 到黑画布 ----
   string videoOut;
   var visibleVideo = new List<int>();
   if (doc.VideoTracks != null) for (int ti = 0; ti < doc.VideoTracks.Count; ti++) {
    var tr = doc.VideoTracks[ti];
    if (tr.Visible == false) {
     foreach (var c in tr.Clips) { MtFlat f; if (byKey.TryGetValue("video:" + ti + ":" + tr.Clips.IndexOf(c), out f)) chains.Add("[v" + f.Global + "]nullsink"); }
    } else visibleVideo.Add(ti);
   }
   if (visibleVideo.Count == 0) {
    chains.Add("color=c=black:s=" + width + "x" + height + ":r=" + fps + ":d=" + N(projDur) + "[vout]");
    videoOut = "[vout]";
   } else {
    chains.Add("color=c=black:s=" + width + "x" + height + ":r=" + fps + ":d=" + N(projDur) + "[w9base]");
    string baseLabel = "[w9base]";
    foreach (int ti in visibleVideo) {
     var tr = doc.VideoTracks[ti];
     string label = AssembleVideoTrack(chains, doc, tr, ti, byKey, projDur, width, height, fps);
     double opacity = tr.Opacity;
     string blend = string.IsNullOrEmpty(tr.Blend) ? "normal" : tr.Blend;
     if (opacity < 1) { chains.Add(label + "colorchannelmixer=aa=" + N(opacity) + "[w9o" + ti + "]"); label = "[w9o" + ti + "]"; }
     double wFrac = tr.W == 0 ? 1 : tr.W, hFrac = tr.H == 0 ? 1 : tr.H;
     if (Math.Abs(wFrac - 1) > 0.000001 || Math.Abs(hFrac - 1) > 0.000001) {
      int sw = Math.Max(1, (int)Math.Round(width * wFrac)), sh = Math.Max(1, (int)Math.Round(height * hFrac));
      chains.Add(label + "scale=" + sw + ":" + sh + "[w9s" + ti + "]"); label = "[w9s" + ti + "]";
     }
     if (blend == "normal") {
      chains.Add(baseLabel + label + "overlay=x=" + N(tr.X) + ":y=" + N(tr.Y) + ":eof_action=pass[w9v" + ti + "]");
     } else {
      chains.Add(baseLabel + "format=gbrp[w9bg" + ti + "]");
      chains.Add(label + "format=gbrp[w9cg" + ti + "]");
      chains.Add("[w9bg" + ti + "][w9cg" + ti + "]blend=all_mode=" + BlendName(blend) + "[w9bl" + ti + "]");
      chains.Add("[w9bl" + ti + "]format=yuva420p[w9v" + ti + "]");
     }
     baseLabel = "[w9v" + ti + "]";
    }
    chains.Add(baseLabel + "format=yuv420p[vout]");
    videoOut = "[vout]";
   }
   // ---- 音频：逐轨组装后 amix ----
   var trackAudio = new List<string>();
   var muteMap = MultitrackDoc.ResolveAudioMute(doc);
   if (doc.VideoTracks != null) for (int ti = 0; ti < doc.VideoTracks.Count; ti++)
    trackAudio.Add(AssembleTrackAudio(chains, doc.VideoTracks[ti].Clips, "video", ti, byKey, projDur, null));
   if (doc.AudioTracks != null) for (int ti = 0; ti < doc.AudioTracks.Count; ti++) {
    var tr = doc.AudioTracks[ti];
    bool muted; if (!muteMap.TryGetValue(tr.Id, out muted)) muted = false;
    trackAudio.Add(AssembleTrackAudio(chains, tr.Clips, "audio", ti, byKey, projDur, new TrackOpts { GainDb = tr.GainDb, Pan = tr.Pan, Muted = muted }));
   }
   trackAudio = trackAudio.Where(l => l != null).ToList();
   string audioOut;
   if (trackAudio.Count == 0) { chains.Add("anullsrc=r=48000:cl=stereo:d=" + N(projDur) + "[aout]"); audioOut = "[aout]"; }
   else if (trackAudio.Count == 1) { chains.Add(trackAudio[0] + "anull[aout]"); audioOut = "[aout]"; }
   else { chains.Add(string.Join("", trackAudio.ToArray()) + "amix=inputs=" + trackAudio.Count + ":duration=first:normalize=0[aout]"); audioOut = "[aout]"; }
   if (videoOut != "[vout]" || audioOut != "[aout]") throw new Exception("多轨滤镜图组装失败。");
   return string.Join(";", chains.ToArray());
  }
  class TrackOpts { public double GainDb; public double Pan; public bool Muted; }
  // 单条视频轨的时间线（引擎 assembleVideoTrackTimeline 同款：concat/xfade/硬切 trim，
  // 空隙透明黑；不重叠的 transitionIn 在片段链上先淡入）。
  static string AssembleVideoTrack(List<string> chains, EditDocument doc, MtVideoTrack track, int ti, Dictionary<string, MtFlat> byKey, double projDur, int width, int height, int fps) {
   var sorted = track.Clips.Select((c, i) => new { Clip = c, Index = i }).OrderBy(x => x.Clip.Start).ThenBy(x => x.Index).ToList();
   Func<double, string, string> gap = (dur, tag) => {
    chains.Add("color=c=black@0:s=" + width + "x" + height + ":r=" + fps + ":d=" + N(dur) + ",format=yuva420p[" + tag + "]");
    return "[" + tag + "]";
   };
   if (sorted.Count == 0) return gap(projDur, "w9tr" + ti);
   string acc = ""; double accEnd = double.NegativeInfinity;
   for (int k = 0; k < sorted.Count; k++) {
    var clip = sorted[k].Clip; int clipIndex = sorted[k].Index;
    MtFlat f; if (!byKey.TryGetValue("video:" + ti + ":" + clipIndex, out f)) throw new Exception("视频轨 \"" + track.Id + "\" 片段 " + clip.Id + " 未展平。");
    int g = f.Global; double dur = clip.Duration; double start = clip.Start;
    string label = "[v" + g + "]";
    bool overlaps = start < accEnd - 0.000000001;
    string tr = clip.TransitionInType;
    if (!string.IsNullOrEmpty(tr) && !overlaps) {
     if (tr == "fadeblack" || tr == "fadewhite") {
      string color = tr == "fadeblack" ? "black" : "white";
      chains.Add(label + "fade=t=in:st=0:d=" + N(clip.TransitionInDuration) + ":color=" + color + "[w9f" + g + "]");
     } else {
      chains.Add(label + "geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='p(X,Y)*min(1,max(0,T/" + N(clip.TransitionInDuration) + "))'[w9f" + g + "]");
     }
     label = "[w9f" + g + "]";
    }
    if (k == 0) {
     if (start > 0.000000001) { string gapL = gap(start, "w9gap" + g); chains.Add(gapL + label + "concat=n=2:v=1:a=0[w9acc" + ti + "_" + k + "]"); acc = "[w9acc" + ti + "_" + k + "]"; }
     else acc = label;
    } else if (!overlaps) {
     double gapDur = start - accEnd;
     if (gapDur > 0.000000001) { string gapL = gap(gapDur, "w9gap" + g); chains.Add(acc + gapL + label + "concat=n=3:v=1:a=0[w9acc" + ti + "_" + k + "]"); }
     else chains.Add(acc + label + "concat=n=2:v=1:a=0[w9acc" + ti + "_" + k + "]");
     acc = "[w9acc" + ti + "_" + k + "]";
    } else {
     double overlap = accEnd - start;
     if (!string.IsNullOrEmpty(tr)) {
      double d = Math.Min(clip.TransitionInDuration, overlap);
      chains.Add(acc + label + "xfade=transition=" + XfadeName(tr) + ":duration=" + N(d) + ":offset=" + N(start) + "[w9acc" + ti + "_" + k + "]");
     } else {
      chains.Add(acc + "trim=start=0:end=" + N(start) + ",setpts=PTS-STARTPTS[w9tr" + ti + "_" + k + "]");
      chains.Add("[w9tr" + ti + "_" + k + "]" + label + "concat=n=2:v=1:a=0[w9acc" + ti + "_" + k + "]");
     }
     acc = "[w9acc" + ti + "_" + k + "]";
    }
    accEnd = start + dur;
   }
   if (projDur - accEnd > 0.000000001) {
    string tail = gap(projDur - accEnd, "w9tail" + ti);
    chains.Add(acc + tail + "concat=n=2:v=1:a=0[w9t" + ti + "]"); acc = "[w9t" + ti + "]";
   }
   return acc;
  }
  // 单条轨的音频（引擎 assembleTrackAudio 同款：静音空隙、concat、重叠 acrossfade/硬切，
  // 尾部 apad 到片长；音频轨再叠加整轨 gain/pan/mute）。
  static string AssembleTrackAudio(List<string> chains, List<MtClip> clips, string kind, int ti, Dictionary<string, MtFlat> byKey, double projDur, TrackOpts opts) {
   var sorted = clips.Select((c, i) => new { Clip = c, Index = i }).OrderBy(x => x.Clip.Start).ThenBy(x => x.Index).ToList();
   if (sorted.Count == 0) return null;
   Func<double, string, string> gap = (dur, tag) => {
    chains.Add("anullsrc=r=48000:cl=stereo:d=" + N(dur) + "[" + tag + "]");
    return "[" + tag + "]";
   };
   string acc = ""; double accEnd = double.NegativeInfinity;
   for (int k = 0; k < sorted.Count; k++) {
    var clip = sorted[k].Clip; int clipIndex = sorted[k].Index;
    MtFlat f; if (!byKey.TryGetValue(kind + ":" + ti + ":" + clipIndex, out f)) throw new Exception(kind + "轨 " + ti + " 片段 " + clip.Id + " 未展平。");
    int g = f.Global; double dur = clip.Duration; double start = clip.Start;
    string label = "[a" + g + "]";
    bool overlaps = start < accEnd - 0.000000001;
    string tr = clip.TransitionInType;
    if (k == 0) {
     if (start > 0.000000001) { string gapL = gap(start, "w9agap" + g); chains.Add(gapL + label + "concat=n=2:v=0:a=1[w9aacc" + kind + ti + "_" + k + "]"); acc = "[w9aacc" + kind + ti + "_" + k + "]"; }
     else acc = label;
    } else if (!overlaps) {
     double gapDur = start - accEnd;
     if (gapDur > 0.000000001) { string gapL = gap(gapDur, "w9agap" + g); chains.Add(acc + gapL + label + "concat=n=3:v=0:a=1[w9aacc" + kind + ti + "_" + k + "]"); }
     else chains.Add(acc + label + "concat=n=2:v=0:a=1[w9aacc" + kind + ti + "_" + k + "]");
     acc = "[w9aacc" + kind + ti + "_" + k + "]";
    } else {
     double overlap = accEnd - start;
     if (!string.IsNullOrEmpty(tr)) {
      double d = Math.Min(clip.TransitionInDuration, overlap);
      chains.Add(acc + "atrim=start=0:end=" + N(start + d) + ",asetpts=PTS-STARTPTS[w9atr" + kind + ti + "_" + k + "]");
      chains.Add("[w9atr" + kind + ti + "_" + k + "]" + label + "acrossfade=d=" + N(d) + "[w9aacc" + kind + ti + "_" + k + "]");
     } else {
      chains.Add(acc + "atrim=start=0:end=" + N(start) + ",asetpts=PTS-STARTPTS[w9atr" + kind + ti + "_" + k + "]");
      chains.Add("[w9atr" + kind + ti + "_" + k + "]" + label + "concat=n=2:v=0:a=1[w9aacc" + kind + ti + "_" + k + "]");
     }
     acc = "[w9aacc" + kind + ti + "_" + k + "]";
    }
    accEnd = start + dur;
   }
   chains.Add(acc + "apad=whole_dur=" + N(projDur) + "[w9atail" + kind + ti + "]");
   string outLabel = "[w9atail" + kind + ti + "]";
   if (opts != null) {
    if (opts.Muted) { chains.Add(outLabel + "volume=0[w9t" + kind + ti + "]"); outLabel = "[w9t" + kind + ti + "]"; }
    else {
     var parts = new List<string>();
     if (Math.Abs(opts.GainDb) > 0.000001) parts.Add("volume=" + N(opts.GainDb) + "dB");
     if (Math.Abs(opts.Pan) > 0.000001) {
      double lg, rg; PanGains(opts.Pan, out lg, out rg);
      parts.Add("pan=stereo|c0=" + N(lg) + "*c0|c1=" + N(rg) + "*c1");
     }
     if (parts.Count > 0) { chains.Add(outLabel + string.Join(",", parts.ToArray()) + "[w9t" + kind + ti + "]"); outLabel = "[w9t" + kind + ti + "]"; }
    }
   }
   return outLabel;
  }
  // 把多轨时间线渲染成一条中间片（导出与播放共用）；返回是否有真实音频。
  public static bool RenderTimeline(EditDocument doc, string output, int fps, CancellationToken token) {
   bool hasAudio;
   string filter = BuildFilterComplex(doc, doc.Width, doc.Height, fps, out hasAudio);
   var inputs = new StringBuilder();
   foreach (var f in InputFiles(doc)) inputs.Append("-i " + Media.Q(f) + " ");
   StudioMedia.Run("-v error -y " + inputs + "-filter_complex " + Media.Q(filter) +
    " -map [vout] -map [aout] -c:v libx264 -preset ultrafast -crf 16 -pix_fmt yuv420p -r " + fps + " -c:a aac -t " + N(MultitrackDoc.Duration(doc)) + " " + Media.Q(output), token);
   if (!File.Exists(output)) throw new Exception("多轨时间线中间片生成失败。");
   return hasAudio;
  }
 }

 // ---- 多轨预览：CPU 合成（逐轨取帧、按透明度/位置叠加，z 序下→上） ----
 // GPU 预览路径未接多轨（IsGpuEligible 对多轨返回 false）；界面上写明是 CPU 合成。
 static class MultitrackPreview {
  public static byte[] FrameBytes(EditDocument doc, double time, CancellationToken token, string colorVf) {
   using (var bmp = Frame(doc, time, token, colorVf)) using (var ms = new MemoryStream()) {
    bmp.Save(ms, ImageFormat.Png);
    return ms.ToArray();
   }
  }
  public static Bitmap Frame(EditDocument doc, double time, CancellationToken token, string colorVf) {
   int w = Math.Min(doc.Width, 1280); w -= w % 2;
   int h = Math.Max(2, (int)Math.Round((double)w * doc.Height / doc.Width / 2) * 2);
   var canvas = new Bitmap(w, h, PixelFormat.Format32bppArgb);
   using (var g = Graphics.FromImage(canvas)) {
    g.Clear(Color.Black);
    if (doc.VideoTracks == null) return canvas;
    foreach (var tr in doc.VideoTracks) {
     if (tr.Visible == false) continue;
     var clip = MultitrackDoc.ClipAt(tr.Clips, time);
     if (clip == null) continue;
     double tw = w * (tr.W == 0 ? 1 : tr.W), th = h * (tr.H == 0 ? 1 : tr.H);
     var dest = new RectangleF((float)tr.X * w / doc.Width, (float)tr.Y * h / doc.Height, (float)tw, (float)th);
     if (clip.AudioOnly) {
      using (var black = new SolidBrush(Color.Black)) g.FillRectangle(black, dest);
      continue;
     }
     double srcTime = clip.In + (time - clip.Start) * clip.Speed;
     srcTime = Math.Max(0, Math.Min(srcTime, Math.Max(0, doc.Duration - 0.03)));
     byte[] bytes;
     try { bytes = StudioMedia.Frame(clip.Source, srcTime, w, token, colorVf ?? ""); }
     catch { continue; }
     using (var ms = new MemoryStream(bytes)) using (var frame = new Bitmap(ms)) {
      double opacity = tr.Opacity;
      if (Math.Abs(opacity - 1) > 0.000001) {
       using (var attrs = new ImageAttributes()) {
        var matrix = new ColorMatrix(); matrix.Matrix33 = (float)opacity; attrs.SetColorMatrix(matrix);
        g.DrawImage(frame, Rectangle.Round(dest), 0, 0, frame.Width, frame.Height, GraphicsUnit.Pixel, attrs);
       }
      } else {
       g.DrawImage(frame, dest, new RectangleF(0, 0, frame.Width, frame.Height), GraphicsUnit.Pixel);
      }
     }
    }
   }
   return canvas;
  }
 }
}
