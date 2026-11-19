// W10 转场 UI（2026-11-19）：时间线页的接点转场区——选接点、选类型、
// 调时长、音频交叉淡化开关、应用到全部接点、渲染接点预览片。
// 控件全部复用现有检查器助手（Section/Note/Slider/Toggle/Buttons/
// UI.Button），不抄任何闭源软件的界面。
// 诚实说明写在面板的 Note 里：预览片是 ffmpeg xfade/acrossfade 真实
// 渲染的接点短片（不是硬切、不是示意图），但只是接点预览，不是时间线
// 实时 scrub；导出目前仍是 plain concat（W9 审计结论），接点转场要等
// 引擎组逐片段模型合入后才会在导出里渲染——本面板只把 TransitionSpec
// 接点方案存进项目文件，并把统一方案同步回项目级 Transition 字段。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows.Controls;
using DogSC.Windows;
using Path = System.IO.Path;

namespace DogSC.Replica {
 public partial class Studio {
  int selectedTransitionJunction;
  string transitionPreviewNote = "";
  void BuildTransitionsSection() {
   Section("转场（片段接点）");
   Note("每个接点（两片段之间）可单独设转场：9 种类型与引擎 P0 口径一致（硬切 + 8 种 xfade：淡入淡出/溶解/左擦除/右擦除/左滑入/圆形展开/闪黑/闪白）。时长 0.1–5 秒，且必须小于两侧片段长度。");
   Note("预览是真转场：点“渲染预览”会用 ffmpeg 的 xfade + acrossfade 把接点前后各 1 秒真实渲染成预览片（不是硬切示意图），中点帧的混合情况会写在下面。导出目前仍是 plain concat，转场要等引擎组逐片段模型合入后才渲染；统一方案会自动同步回项目级转场字段，混用方案只存在接点方案里。");
   int count = TransitionPlan.JunctionCount(Doc);
   if (count == 0) { Note("只有一个片段，没有接点可设转场。先分割出两个以上片段。"); return; }
   var plan = TransitionPlan.Ensure(Doc);
   if (selectedTransitionJunction < 0 || selectedTransitionJunction >= count) selectedTransitionJunction = 0;
   for (int j = 0; j < count; j++) {
    int idx = j; var spec = plan[idx];
    double at = TransitionPlan.JunctionTime(Doc, idx);
    inspector.Children.Add(UI.Button((idx == selectedTransitionJunction ? "● " : "○ ") + "接点 " + (idx + 1) + " · 片段 " + (idx + 1) + " → 片段 " + (idx + 2) + " @ " + at.ToString("0.00", CultureInfo.InvariantCulture) + "s · " + TransitionPlan.Describe(spec), () => {
     selectedTransitionJunction = idx; transitionPreviewNote = ""; Changed(); BuildInspector();
    }));
   }
   var current = plan[selectedTransitionJunction];
   var cutA = Doc.Cuts[selectedTransitionJunction]; var cutB = Doc.Cuts[selectedTransitionJunction + 1];
   double shortest = Math.Min(cutA.Length, cutB.Length);
   Section("接点 " + (selectedTransitionJunction + 1) + " · " + TransitionPlan.Describe(current));
   var labels = TransitionPlan.Types.Select(t => TransitionPlan.TypeLabel(t)).ToArray();
   Buttons(labels, TransitionPlan.TypeLabel(current.Type), v => {
    Checkpoint();
    current.Type = TransitionPlan.Types[Array.IndexOf(labels, v)];
    if (current.Type != "cut" && (current.DurationSeconds < TransitionPlan.MinDuration || current.DurationSeconds > TransitionPlan.MaxDuration)) current.DurationSeconds = TransitionPlan.DefaultDuration;
    TransitionPlan.SyncProjectFields(Doc);
    Changed(); BuildInspector();
   });
   if (current.Type == "cut") {
    Note("硬切不占时长：前后片段直接拼接，时长设置不起作用，音频也是硬切。");
   } else {
    double maxDur = Math.Min(TransitionPlan.MaxDuration, shortest - 0.02);
    if (maxDur < TransitionPlan.MinDuration) {
     Note("两侧最短片段只有 " + shortest.ToString("0.00", CultureInfo.InvariantCulture) + "s，短于转场最小时长 0.1 秒，这个接点做不了转场（先把片段拉长，或改成硬切）。");
    } else {
     Slider("转场时长", TransitionPlan.MinDuration, maxDur, Math.Min(current.DurationSeconds, maxDur), " 秒", v => {
      Checkpoint(); current.DurationSeconds = Math.Round(v, 2); TransitionPlan.SyncProjectFields(Doc); Changed();
     });
     Note("总片长会缩短转场时长：非硬切接点前后片段各重叠这段时间（引擎 projectDuration 口径）。");
    }
    Toggle("音频交叉淡化（acrossfade）", current.AudioCrossfade, v => { Checkpoint(); current.AudioCrossfade = v; Changed(); });
    if (!current.AudioCrossfade) Note("音频交叉淡化关时，视频仍按所选类型过渡，音频在接点处硬切。");
   }
   inspector.Children.Add(UI.Button("应用到全部接点（" + TransitionPlan.Describe(current) + "）", () => {
    try { Checkpoint(); TransitionPlan.SetAll(Doc, current.Type, current.DurationSeconds); foreach (var s in TransitionPlan.Ensure(Doc)) s.AudioCrossfade = current.AudioCrossfade; TransitionPlan.SyncProjectFields(Doc); Changed(); BuildInspector(); Status("已应用到全部 " + count + " 个接点。"); }
    catch (Exception ex) { Error(ex); }
   }));
   inspector.Children.Add(UI.Button("恢复成项目统一转场（" + TransitionPlan.TypeLabel(TransitionPlan.Types.Contains(Doc.Transition) ? Doc.Transition : "cut") + "）", () => {
    try {
     Checkpoint();
     string t = TransitionPlan.Types.Contains(Doc.Transition) ? Doc.Transition : "cut";
     double d = (Doc.TransitionDuration >= TransitionPlan.MinDuration && Doc.TransitionDuration <= TransitionPlan.MaxDuration) ? Doc.TransitionDuration : TransitionPlan.DefaultDuration;
     TransitionPlan.SetAll(Doc, t, d); TransitionPlan.SyncProjectFields(Doc); Changed(); BuildInspector(); Status("已恢复成项目统一转场。");
    } catch (Exception ex) { Error(ex); }
   }));
   inspector.Children.Add(UI.Button("定位到这个接点", () => { Seek(TransitionPlan.JunctionTime(Doc, selectedTransitionJunction)); }));
   inspector.Children.Add(UI.Button("渲染这个接点的预览片", () => {
    try {
     string folder = Path.Combine(Media.Root, "bin", "transition-preview");
     string file = TransitionPreview.RenderPreviewForJunction(Doc, selectedTransitionJunction, folder, CancellationToken.None);
     var spec = TransitionPlan.Ensure(Doc)[selectedTransitionJunction];
     double total = Media.Duration(file);
     string verdict;
     if (spec.Type == "cut") {
      verdict = "硬切预览 · 全长 " + total.ToString("0.00", CultureInfo.InvariantCulture) + "s，接点处直接换画面。";
     } else {
      double span = Math.Max(spec.DurationSeconds, 1.0);
      double mid = span - spec.DurationSeconds / 2;
      var rgb = TransitionPreview.ProbeCenterRgb(file, mid);
      double luma = (rgb[0] + rgb[1] + rgb[2]) / 3.0;
      string midNote = (spec.Type == "fadeblack") ? (luma < 40 ? "中点帧已接近全黑（亮度 " + luma.ToString("0") + "）" : "中点帧亮度 " + luma.ToString("0") + "，未见闪黑")
       : (spec.Type == "fadewhite") ? (luma > 180 ? "中点帧已接近全白（亮度 " + luma.ToString("0") + "）" : "中点帧亮度 " + luma.ToString("0") + "，未见闪白")
       : "中点帧中心 RGB " + rgb[0].ToString("0") + "/" + rgb[1].ToString("0") + "/" + rgb[2].ToString("0");
      verdict = "预览片全长 " + total.ToString("0.00", CultureInfo.InvariantCulture) + "s · " + midNote + "。";
     }
     transitionPreviewNote = file + "\n" + verdict;
     Changed(); BuildInspector(); Status("转场预览片已生成。");
    } catch (Exception ex) { Error(ex); }
   }));
   if (!string.IsNullOrEmpty(transitionPreviewNote)) Note("上次预览：\n" + transitionPreviewNote);
  }
 }
}
