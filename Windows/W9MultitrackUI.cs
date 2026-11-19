// W9 多轨时间线·WPF 界面（2026-11-19）：时间线多轨区 + 检查器多轨面板。
// 模型与纯逻辑见 W9MultitrackPanels.cs；这里只画界面、接事件。
// 轨头在左列 TimelineLabels 里（与 AddEffectTracks 同款列）；轨内片段可跨轨拖动
// （改 trackId 与轨内时间，见 MultitrackDoc.MoveClip）；选中/切分/删除走 EditorApp
// 的 Split/Delete（多轨时分流到 MultitrackDoc）。
// 诚实说明（面板里直接写明，不藏）：预览是 CPU 合成，GPU 预览未接多轨；
// 美颜遮罩在多轨预览里不生效；同轨音频重叠硬切；transitionIn 只对视频有效；
// blend 轨忽略 alpha、不能带偏移/缩放；一键删静音/文字剪切/Remix/人声分离/
// 分轨导出（roleStems）在多轨上禁用（引擎无 track-aware 实现）。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using DogSC.Windows;

namespace DogSC.Replica {
 public partial class Studio {
  string mtSelKind; string mtSelTrack; int mtSelClip = -1;
  class MtLaneGeom { public string Kind = ""; public string TrackId = ""; public double Y0; public double Y1; }
  List<MtLaneGeom> mtLanes = new List<MtLaneGeom>();
  bool MtHasSelection() {
   return MultitrackDoc.HasTracks(Doc) && mtSelClip >= 0 && !string.IsNullOrEmpty(mtSelTrack) && !string.IsNullOrEmpty(mtSelKind);
  }
  void MtClearSelection() { mtSelKind = null; mtSelTrack = null; mtSelClip = -1; }
  void MtSelect(string kind, string trackId, int clipIndex) {
   mtSelKind = kind; mtSelTrack = trackId; mtSelClip = clipIndex;
   selectedCut = -1; selectedZoom = -1; selectedOverlay = -1; selectedScreen = -1;
  }

  // ---- 时间线多轨区（DrawTimeline 在多轨时分流到这里） ----
  void DrawMultitrackTimeline(double px, double width, double step) {
   var labels = Find<StackPanel>("TimelineLabels");
   labels.Children.Clear();
   mtLanes.Clear();
   timeline.Children.Clear();
   timeline.Width = width;
   double y = 34;
   // 标尺（与单轨 DrawTimeline 同款）。
   for (double t = 0; t < Doc.Length; t += step) {
    var text = UI.Text(UI.Time(t), 10, "#8C9498"); Canvas.SetLeft(text, t * px + 3); Canvas.SetTop(text, 5); timeline.Children.Add(text);
    timeline.Children.Add(new Line { X1 = t * px, X2 = t * px, Y1 = 24, Y2 = 170, Stroke = UI.Brush(dark ? "#2D3135" : "#F0F1F2"), StrokeThickness = 1 });
   }
   if (Doc.Length <= 0) { var ph = UI.Text("时长未知 · 时间线暂不可用", 10, "#8C9498"); Canvas.SetLeft(ph, 3); Canvas.SetTop(ph, 5); timeline.Children.Add(ph); }
   Action<string, double> labelRow = (text, h) => {
    var label = UI.Text(text, 11, dark ? "#DCE0E0" : "#545D62");
    label.VerticalAlignment = VerticalAlignment.Center;
    var row = new Border { Height = h, Child = label };
    labels.Children.Add(row);
   };
   labelRow("轨道", 34);
   // 视频轨：数组顺序下→上，画的时候顶轨在最上。
   var videoTracks = Doc.VideoTracks.ToList();
   videoTracks.Reverse();
   foreach (var tr in videoTracks) {
    if (tr == null) continue;
    double laneY = y;
    labelRow((tr.Name ?? tr.Id) + (tr.Visible == false ? " · 隐藏" : "") + (tr.Locked ? " · 锁定" : ""), 56);
    mtLanes.Add(new MtLaneGeom { Kind = "video", TrackId = tr.Id, Y0 = laneY, Y1 = laneY + 56 });
    DrawMtClips(tr.Clips, "video", tr.Id, laneY, 48, px, dark ? "#3A4A44" : "#D8DEDB");
    y += 56;
   }
   if (Doc.AudioTracks != null) foreach (var tr in Doc.AudioTracks) {
    if (tr == null) continue;
    double laneY = y;
    string state = (tr.Mute ? " · 静音" : "") + (tr.Solo ? " · 独奏" : "");
    labelRow((tr.Name ?? tr.Id) + state, 36);
    mtLanes.Add(new MtLaneGeom { Kind = "audio", TrackId = tr.Id, Y0 = laneY, Y1 = laneY + 36 });
    DrawMtClips(tr.Clips, "audio", tr.Id, laneY, 28, px, dark ? "#374859" : "#D3DFEF");
    y += 36;
   }
   // 录制标记（红线 + 标签，与单轨同款简化版）。
   if (Doc.RecordingMarkers != null) foreach (var m in Doc.RecordingMarkers) {
    var mark = m;
    timeline.Children.Add(new Line { X1 = mark.Time * px, X2 = mark.Time * px, Y1 = 24, Y2 = y, Stroke = UI.Brush("#DE5E57"), StrokeThickness = 1.5, IsHitTestVisible = false });
    var tag = new Border { Background = UI.Brush("#AADE5E57"), CornerRadius = new CornerRadius(4), Padding = new Thickness(5, 2, 5, 2), Child = UI.Text(mark.Label, 10, "#FFFFFF"), Cursor = Cursors.Hand };
    Canvas.SetLeft(tag, mark.Time * px + 3); Canvas.SetTop(tag, 24); timeline.Children.Add(tag);
    tag.MouseLeftButtonDown += (s, e) => { Seek(mark.Time); e.Handled = true; };
   }
   timeline.Height = y + 8;
   foreach (var gridLine in timeline.Children.OfType<Line>()) gridLine.Y2 = timeline.Height - 8;
   playhead = new Line { X1 = 0, X2 = 0, Y1 = 20, Y2 = timeline.Height - 9, Stroke = UI.Brush(dark ? "#F3F5F4" : "#34393B"), StrokeThickness = 1.2, IsHitTestVisible = false };
   head = new Ellipse { Width = 6, Height = 6, Fill = playhead.Stroke, IsHitTestVisible = false };
   Canvas.SetTop(head, 19); timeline.Children.Add(playhead); timeline.Children.Add(head);
   snapLine = new Line { X1 = 0, X2 = 0, Y1 = 20, Y2 = timeline.Height - 9, Stroke = UI.Brush("#DE5E57"), StrokeThickness = 1.5, IsHitTestVisible = false, Visibility = Visibility.Collapsed };
   timeline.Children.Add(snapLine);
   DrawPlayhead();
   timeline.MouseLeftButtonDown -= TimelineSeek; timeline.MouseLeftButtonDown += TimelineSeek;
  }
  void DrawMtClips(List<MtClip> clips, string kind, string trackId, double laneY, double boxH, double px, string color) {
   if (clips == null) return;
   for (int i = 0; i < clips.Count; i++) {
    int clipIndex = i;
    var clip = clips[i];
    if (clip == null) continue;
    var box = new Border {
     Width = Math.Max(4, clip.Duration * px - 3), Height = boxH, CornerRadius = new CornerRadius(7),
     BorderThickness = new Thickness(MtHasSelection() && mtSelKind == kind && mtSelTrack == trackId && mtSelClip == clipIndex ? 2 : 1),
     BorderBrush = UI.Brush(MtHasSelection() && mtSelKind == kind && mtSelTrack == trackId && mtSelClip == clipIndex ? "#667870" : "#D2D7D8"),
     Background = UI.Brush(clip.AudioOnly ? (dark ? "#3A3E41" : "#8B9093") : color),
     ClipToBounds = true, Cursor = Cursors.SizeAll
    };
    var label = new TextBlock {
     Text = System.IO.Path.GetFileName(clip.Source) + " · " + UI.Time(clip.Duration) + (string.IsNullOrEmpty(clip.TransitionInType) ? "" : " · " + clip.TransitionInType),
     FontSize = 10, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center,
     TextTrimming = TextTrimming.CharacterEllipsis, Foreground = UI.Brush(dark ? "#E0ECE6" : "#405B54")
    };
    box.Child = label;
    Canvas.SetLeft(box, clip.Start * px); Canvas.SetTop(box, laneY + 4);
    timeline.Children.Add(box);
    // 点选 + 跨轨拖动（拖动改 trackId 与轨内时间；不动则当点选 + 跳到该点）。
    double downX = 0, downY = 0, origStart = 0; bool moving = false, edited = false;
    box.MouseLeftButtonDown += (s, e) => {
     MtSelect(kind, trackId, clipIndex);
     tab = "画面"; frameTab = "时间线"; BuildRail(); BuildInspector();
     downX = e.GetPosition(timeline).X; downY = e.GetPosition(timeline).Y; origStart = clip.Start;
     moving = true; edited = false; box.CaptureMouse(); e.Handled = true;
    };
    box.MouseMove += (s, e) => {
     if (!moving) return;
     double curX = e.GetPosition(timeline).X, curY = e.GetPosition(timeline).Y;
     double delta = (curX - downX) / px;
     if (Math.Abs(delta) < .015 && Math.Abs(curY - downY) < 3 && !edited) return;
     if (!edited) { Checkpoint(); edited = true; }
     if (snap) delta = SnapDelta(origStart, delta);
     double ns = EditDocument.Clamp(origStart + delta, 0, Math.Max(0, Doc.Length));
     Canvas.SetLeft(box, ns * px);
     var lane = MtLaneAt(curY);
     if (lane != null) Canvas.SetTop(box, lane.Y0 + 4);
     RefreshPreview();
    };
    box.MouseLeftButtonUp += (s, e) => {
     moving = false; box.ReleaseMouseCapture(); HideSnapLine();
     if (!edited) {
      double t = clip.Start + Math.Max(0, (e.GetPosition(box).X) / px);
      Seek(Math.Min(t, Math.Max(0, Doc.Length - .001)));
      DrawTimeline();
      e.Handled = true; return;
     }
     try {
      double curX = e.GetPosition(timeline).X, curY = e.GetPosition(timeline).Y;
      double delta = (curX - downX) / px;
      if (snap) delta = SnapDelta(origStart, delta);
      double ns = EditDocument.Clamp(origStart + delta, 0, Math.Max(0, Doc.Length));
      var lane = MtLaneAt(curY);
      string toKind = lane == null ? kind : lane.Kind;
      string toTrack = lane == null ? trackId : lane.TrackId;
      // 注意：MoveClip 按 clipIndex 取片段；拖动期间索引不变（只改了显示位置）。
      MultitrackDoc.MoveClip(Doc, kind, trackId, clipIndex, toKind, toTrack, ns);
      Changed(); BuildInspector();
     } catch (Exception ex) { Error(ex); DrawTimeline(); }
     e.Handled = true;
    };
   }
  }
  MtLaneGeom MtLaneAt(double y) {
   foreach (var lane in mtLanes) if (y >= lane.Y0 && y < lane.Y1) return lane;
   return mtLanes.Count > 0 ? mtLanes[mtLanes.Count - 1] : null;
  }

  // ---- 检查器：画面 → 时间线页的多轨区 ----
  void BuildMultitrackSection() {
   Section("多轨时间线");
   if (!MultitrackDoc.HasTracks(Doc)) {
    Note("当前是单轨时间线。转为多轨后，时间线按轨分层：视频轨下往上叠、音频轨混音；片段可跨轨拖动。旧单轨项目转为 1 条视频轨 + 1 条音频轨，时长与画面与改前一致。");
    inspector.Children.Add(UI.Button("转为多轨时间线", () => {
     try { Checkpoint(); MultitrackDoc.Normalize(Doc); Changed(); BuildInspector(); DrawTimeline(); Status("已转为多轨：1 视频轨 + 1 音频轨。"); }
     catch (Exception ex) { Error(ex); }
    }));
    return;
   }
   int vc = Doc.VideoTracks == null ? 0 : Doc.VideoTracks.Count;
   int ac = Doc.AudioTracks == null ? 0 : Doc.AudioTracks.Count;
   Note("多轨：" + vc + " 视频轨 + " + ac + " 音频轨 · 片长 " + UI.Time(Doc.Length) + "。预览是 CPU 合成（逐轨取帧、按透明度/位置叠加），GPU 预览未接多轨；美颜遮罩在多轨预览里不生效，导出时美颜/降噪/高级调色作用于合成后的时间线。");
   inspector.Children.Add(UI.Button("＋ 新建视频轨", () => { try { Checkpoint(); MultitrackDoc.AddVideoTrack(Doc, ""); Changed(); BuildInspector(); DrawTimeline(); } catch (Exception ex) { Error(ex); } }));
   inspector.Children.Add(UI.Button("＋ 新建音频轨", () => { try { Checkpoint(); MultitrackDoc.AddAudioTrack(Doc, ""); Changed(); BuildInspector(); DrawTimeline(); } catch (Exception ex) { Error(ex); } }));
   if (Doc.VideoTracks != null) foreach (var tr in Doc.VideoTracks.ToList()) {
    var vtr = tr;
    Section((vtr.Name ?? vtr.Id) + "（视频轨 · " + vtr.Clips.Count + " 个片段）");
    Toggle("可见（隐藏只藏视频，联动音频照播）", vtr.Visible, v => vtr.Visible = v);
    Toggle("锁定（锁定时不能移入/删片段）", vtr.Locked, v => vtr.Locked = v);
    Slider("轨不透明度", 0, 1, vtr.Opacity, "", v => vtr.Opacity = v);
    Buttons(new[] { "normal", "multiply", "screen", "overlay", "darken", "lighten", "add" }, string.IsNullOrEmpty(vtr.Blend) ? "normal" : vtr.Blend, v => { Checkpoint(); vtr.Blend = v; Changed(); BuildInspector(); });
    Note("混合模式轨忽略 alpha，且不能同时带轨偏移/缩放（引擎限制）。");
    inspector.Children.Add(UI.Button("改名：" + (vtr.Name ?? vtr.Id), () => {
     string name = AppDialogs.Rename(Window, vtr.Name ?? vtr.Id);
     if (name == null) return;
     try { Checkpoint(); MultitrackDoc.RenameTrack(Doc, "video", vtr.Id, name); Changed(); BuildInspector(); DrawTimeline(); } catch (Exception ex) { Error(ex); }
    }));
    inspector.Children.Add(UI.Button("删除空轨：" + (vtr.Name ?? vtr.Id), () => {
     try { Checkpoint(); MultitrackDoc.RemoveTrack(Doc, "video", vtr.Id); Changed(); BuildInspector(); DrawTimeline(); } catch (Exception ex) { Error(ex); }
    }));
   }
   if (Doc.AudioTracks != null) foreach (var tr in Doc.AudioTracks.ToList()) {
    var atr = tr;
    Section((atr.Name ?? atr.Id) + "（音频轨 · " + atr.Clips.Count + " 个片段）");
    Toggle("静音", atr.Mute, v => atr.Mute = v);
    Toggle("独奏（任一轨独奏时，未独奏的音频轨全静音）", atr.Solo, v => atr.Solo = v);
    Slider("轨增益 / dB", -60, 12, atr.GainDb, "", v => atr.GainDb = v);
    Slider("声像（-1 左 · +1 右）", -1, 1, atr.Pan, "", v => atr.Pan = v);
    inspector.Children.Add(UI.Button("改名：" + (atr.Name ?? atr.Id), () => {
     string name = AppDialogs.Rename(Window, atr.Name ?? atr.Id);
     if (name == null) return;
     try { Checkpoint(); MultitrackDoc.RenameTrack(Doc, "audio", atr.Id, name); Changed(); BuildInspector(); DrawTimeline(); } catch (Exception ex) { Error(ex); }
    }));
    inspector.Children.Add(UI.Button("删除空轨：" + (atr.Name ?? atr.Id), () => {
     try { Checkpoint(); MultitrackDoc.RemoveTrack(Doc, "audio", atr.Id); Changed(); BuildInspector(); DrawTimeline(); } catch (Exception ex) { Error(ex); }
    }));
   }
   Note("暂不支持：一键删静音 / 文字剪切 / Remix / 人声分离 / 分轨导出（roleStems）——引擎没有 track-aware 实现，入口已禁用，导出前也会拒绝。同轨音频重叠是硬切（要叠声音请分轨）；transitionIn 只对视频有效。");
  }
  // 选中的多轨片段（只在画面页显示；切其他页时按该页内容走）。
  void BuildMultitrackClipSection() {
   List<MtClip> clips = null;
   if (mtSelKind == "video") { foreach (var tr in Doc.VideoTracks) if (tr.Id == mtSelTrack) clips = tr.Clips; }
   else if (Doc.AudioTracks != null) { foreach (var tr in Doc.AudioTracks) if (tr.Id == mtSelTrack) clips = tr.Clips; }
   if (clips == null || mtSelClip < 0 || mtSelClip >= clips.Count) { MtClearSelection(); return; }
   var c = clips[mtSelClip];
   Section("多轨片段 · " + System.IO.Path.GetFileName(c.Source));
   Number("轨内起点 / 秒", c.Start, v => { c.Start = EditDocument.Clamp(v, 0, Math.Max(0, Doc.Length)); MultitrackDoc.SyncLegacyCuts(Doc); });
   Number("素材起点 / 秒", c.In, v => { c.In = EditDocument.Clamp(v, 0, c.Out - .05); MultitrackDoc.SyncLegacyCuts(Doc); });
   Number("素材终点 / 秒", c.Out, v => { c.Out = EditDocument.Clamp(v, c.In + .05, Doc.Duration); MultitrackDoc.SyncLegacyCuts(Doc); });
   Note("速度 " + c.Speed.ToString("0.0", CultureInfo.InvariantCulture) + "× · 音量 " + c.Volume.ToString("0.00", CultureInfo.InvariantCulture) + " · 时长 " + UI.Time(c.Duration) + "。拖动片段可跨轨移动；切分请把播放头放在片段中间再按分割。");
   if (Doc.VideoTracks != null) foreach (var tr in Doc.VideoTracks) {
    if (mtSelKind == "video" && tr.Id == mtSelTrack) continue;
    var target = tr;
    inspector.Children.Add(UI.Button("移到视频轨：" + (target.Name ?? target.Id), () => {
     try { Checkpoint(); MultitrackDoc.MoveClip(Doc, mtSelKind, mtSelTrack, mtSelClip, "video", target.Id, c.Start); MtSelect("video", target.Id, target.Clips.Count - 1); Changed(); BuildInspector(); DrawTimeline(); }
     catch (Exception ex) { Error(ex); }
    }));
   }
   if (Doc.AudioTracks != null) foreach (var tr in Doc.AudioTracks) {
    if (mtSelKind == "audio" && tr.Id == mtSelTrack) continue;
    var target = tr;
    inspector.Children.Add(UI.Button("移到音频轨：" + (target.Name ?? target.Id), () => {
     try { Checkpoint(); MultitrackDoc.MoveClip(Doc, mtSelKind, mtSelTrack, mtSelClip, "audio", target.Id, c.Start); MtSelect("audio", target.Id, target.Clips.Count - 1); Changed(); BuildInspector(); DrawTimeline(); }
     catch (Exception ex) { Error(ex); }
    }));
   }
   inspector.Children.Add(UI.Button("删除片段（波纹：同轨后续跟进）", () => {
    try { Checkpoint(); MultitrackDoc.DeleteClip(Doc, mtSelKind, mtSelTrack, mtSelClip, true); MtClearSelection(); Changed(); BuildInspector(); DrawTimeline(); }
    catch (Exception ex) { Error(ex); }
   }));
   inspector.Children.Add(UI.Button("删除片段（留空隙）", () => {
    try { Checkpoint(); MultitrackDoc.DeleteClip(Doc, mtSelKind, mtSelTrack, mtSelClip, false); MtClearSelection(); Changed(); BuildInspector(); DrawTimeline(); }
    catch (Exception ex) { Error(ex); }
   }));
   inspector.Children.Add(UI.Button("返回画面设置", () => { MtClearSelection(); tab = "画面"; BuildInspector(); }));
  }
 }
}
