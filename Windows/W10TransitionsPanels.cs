// W10 转场 UI（2026-11-19）：时间线接点转场——选类型、调时长、预览效果。
// 模型与纯逻辑；UI 见 W10TransitionsUI.cs；自测见 W10TransitionsTests.cs。
// 类型与参数口径全部取自引擎现有定义，不现编：
// - 9 种类型 = engine/src/project.ts 的 TransitionType：'cut' + 8 种 xfade
//   （'fade' 'dissolve' 'wipeleft' 'wiperight' 'slideleft' 'circleopen'
//   'fadeblack' 'fadewhite'；P0 已验，见 engine/test/verify-p0.mjs A/B 两节）。
// - xfade 名映射 = engine/src/filtergraph.ts 的 XFADE_TRANSITIONS（cut 没有
//   xfade 名，走 concat）；音频 = 同文件的 acrossfade 链。
// - 时长范围 0.1–5 秒 = engine/src/templates.ts 对 transitionDuration 的
//   checkNumber(0.1, 5)；xfade 时长必须小于两侧片段长度（ffmpeg xfade 要求，
//   否则渲染失败），ValidateFor 里按相邻片段长度校验。
// - 导出现状（W9 审计）：WPF 导出目前是 plain concat、转场不渲染；引擎组
//   正在并行做逐片段转场模型（视频 xfade + 音频 acrossfade）。本文件只产
//   出 TransitionSpec 形态的接点方案，与导出层解耦：ToEngineTypes /
//   ToEngineDurations 是给引擎组合入时消费的交接面，不调用引擎组还没合入
//   的内部 API，也不改 StudioRenderer / StudioMedia.Filter 的导出主链。
// - 兼容垫片：EditDocument 已有项目级单值 Transition / TransitionDuration
//   （EditorCore.cs，0–5 秒）。接点方案全相同时 SyncProjectFields 会把它
//   们写回去，老导出路径行为不变；接点方案混用时返回 false、不写回，
//   等引擎逐片段模型接手——面板里写明，不假装混用方案已能导出。
// - 预览是真转场，不是硬切：TransitionPreview 用 ffmpeg 的 xfade /
//   acrossfade 把接点前后各一段真实渲染成预览片（见 Render），中点帧
//   可用 ProbeCenterRgb 验混合；但它只是接点预览片，不是时间线实时
//   预览（WPF 预览是 CPU 合成，逐帧 xfade  scrub 不在 W10 范围内）。
// - 作用域：主时间线 Cuts 的接点（接点 i 在 Cuts[i] 与 Cuts[i+1] 之间，
//   共 Cuts.Count-1 个）。多轨 VideoTracks 的接点不在本批范围——
//   MultitrackDoc 是另一套轨模型，转场接线等引擎逐片段模型合入后再定。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using DogSC.Windows;
using D = System.Drawing;

namespace DogSC.Replica {
 // ---- 接点转场规格：与导出层解耦的交接形态 ----
 public class TransitionSpec {
  public string Type = "cut";
  public double DurationSeconds = 0.5;
  // 非 cut 接点默认开音频交叉淡化（acrossfade）；cut 时音频硬切，本开关不起作用。
  public bool AudioCrossfade = true;
 }

 static class TransitionPlan {
  public static readonly string[] Types = { "cut", "fade", "dissolve", "wipeleft", "wiperight", "slideleft", "circleopen", "fadeblack", "fadewhite" };
  // xfade 名：与 engine/src/filtergraph.ts XFADE_TRANSITIONS 逐字一致（cut 除外）。
  public static readonly Dictionary<string, string> XfadeNames = new Dictionary<string, string> {
   { "fade", "fade" }, { "dissolve", "dissolve" }, { "wipeleft", "wipeleft" },
   { "wiperight", "wiperight" }, { "slideleft", "slideleft" }, { "circleopen", "circleopen" },
   { "fadeblack", "fadeblack" }, { "fadewhite", "fadewhite" },
  };
  public const double MinDuration = 0.1;
  public const double MaxDuration = 5.0;
  public const double DefaultDuration = 0.5;

  public static string TypeLabel(string type) {
   switch (type) {
    case "cut": return "硬切";
    case "fade": return "淡入淡出";
    case "dissolve": return "溶解";
    case "wipeleft": return "左擦除";
    case "wiperight": return "右擦除";
    case "slideleft": return "左滑入";
    case "circleopen": return "圆形展开";
    case "fadeblack": return "闪黑";
    case "fadewhite": return "闪白";
    default: return type;
   }
  }
  public static string Describe(TransitionSpec spec) {
   if (spec == null) return "（无）";
   if (spec.Type == "cut") return "硬切";
   return TypeLabel(spec.Type) + " " + spec.DurationSeconds.ToString("0.0#", CultureInfo.InvariantCulture) + "s" + (spec.AudioCrossfade ? " · 音频交叉淡化" : " · 音频硬切");
  }
  public static int JunctionCount(EditDocument doc) {
   if (doc == null || doc.Cuts == null || doc.Cuts.Count < 2) return 0;
   return doc.Cuts.Count - 1;
  }
  // 接点在时间线上的时刻（= Cuts[i] 的结束时刻）。
  public static double JunctionTime(EditDocument doc, int junction) {
   if (doc == null || doc.Cuts == null || junction < 0 || junction >= JunctionCount(doc)) throw new Exception("没有这个接点。");
   double t = 0;
   for (int i = 0; i <= junction; i++) t += doc.Cuts[i].Length;
   return t;
  }
  // 规格自身校验（不依赖接点位置）：类型必须在 9 种之内；非 cut 时长
  // 0.1–5 秒（引擎 templates.ts 口径）；cut 的时长被忽略，允许 0–5。
  public static void ValidateSpec(TransitionSpec spec) {
   if (spec == null) throw new Exception("转场规格为空。");
   if (!Types.Contains(spec.Type)) throw new Exception("转场类型无效：" + spec.Type + "（应为 cut / fade / dissolve / wipeleft / wiperight / slideleft / circleopen / fadeblack / fadewhite 之一）。");
   if (!EditDocument.Finite(spec.DurationSeconds)) throw new Exception("转场时长无效。");
   if (spec.Type == "cut") {
    if (spec.DurationSeconds < 0 || spec.DurationSeconds > MaxDuration) throw new Exception("硬切的转场时长超出范围（0–5 秒）。");
   } else if (spec.DurationSeconds < MinDuration || spec.DurationSeconds > MaxDuration) throw new Exception("转场时长超出范围（0.1–5 秒）。");
  }
  // 接点校验：除自身校验外，非 cut 的时长还必须小于两侧片段长度
  // （ffmpeg xfade 的硬性要求；等于也不行，留 0.01 秒余量）。
  public static void ValidateFor(EditDocument doc, int junction) {
   if (doc == null) throw new Exception("没有打开的项目。");
   var plan = Ensure(doc);
   if (junction < 0 || junction >= plan.Count) throw new Exception("没有这个接点。");
   var spec = plan[junction];
   ValidateSpec(spec);
   if (spec.Type != "cut") {
    double left = doc.Cuts[junction].Length, right = doc.Cuts[junction + 1].Length;
    double shortest = Math.Min(left, right);
    if (spec.DurationSeconds >= shortest - 0.01) throw new Exception("接点 " + (junction + 1) + " 的转场时长 " + spec.DurationSeconds.ToString("0.00", CultureInfo.InvariantCulture) + "s 不小于两侧最短片段 " + shortest.ToString("0.00", CultureInfo.InvariantCulture) + "s（xfade 时长必须小于两侧片段长度）。");
   }
  }
  // 全项目规格校验：只验已有的规格条目（范围 + 接点长度），不验条数——
  // 剪辑增删后条数会暂时对不上，由 Ensure 在使用前补齐/裁掉；条数不对
  // 不能让老项目打不开，所以这里不抛条数错误（交接时 ToEngine* 会抛）。
  public static void ValidateSpecs(EditDocument doc) {
   if (doc == null || doc.JunctionTransitions == null) return;
   foreach (var spec in doc.JunctionTransitions) ValidateSpec(spec);
   for (int j = 0; j < Math.Min(doc.JunctionTransitions.Count, JunctionCount(doc)); j++) ValidateFor(doc, j);
  }
  // 取用前先对齐条数：缺了按项目级 Transition/TransitionDuration 补
  // （老项目没有接点方案时默认全是项目级转场），多了裁掉。
  public static List<TransitionSpec> Ensure(EditDocument doc) {
   if (doc == null) throw new Exception("没有打开的项目。");
   if (doc.JunctionTransitions == null) doc.JunctionTransitions = new List<TransitionSpec>();
   int want = JunctionCount(doc);
   string fallbackType = Types.Contains(doc.Transition) ? doc.Transition : "cut";
   double fallbackDuration = (doc.TransitionDuration >= MinDuration && doc.TransitionDuration <= MaxDuration) ? doc.TransitionDuration : DefaultDuration;
   while (doc.JunctionTransitions.Count < want) doc.JunctionTransitions.Add(new TransitionSpec { Type = fallbackType, DurationSeconds = fallbackDuration, AudioCrossfade = true });
   while (doc.JunctionTransitions.Count > want) doc.JunctionTransitions.RemoveAt(doc.JunctionTransitions.Count - 1);
   return doc.JunctionTransitions;
  }
  public static void SetAll(EditDocument doc, string type, double durationSeconds) {
   var plan = Ensure(doc);
   var probe = new TransitionSpec { Type = type, DurationSeconds = durationSeconds };
   ValidateSpec(probe);
   foreach (var spec in plan) { spec.Type = type; spec.DurationSeconds = durationSeconds; }
  }
  // ---- 导出层交接面（引擎组逐片段模型消费；不调用引擎内部 API） ----
  // 接点类型串：与 engine/src/project.ts 的 TransitionType[] 逐字一致，
  // 顺序与 transitions[i] 在 clips[i]/clips[i+1] 之间一致。条数不对直接抛。
  public static string[] ToEngineTypes(EditDocument doc) {
   var plan = Ensure(doc);
   if (plan.Count != JunctionCount(doc)) throw new Exception("接点转场条数与片段数对不上（先同步接点方案）。");
   foreach (var spec in plan) ValidateSpec(spec);
   return plan.Select(s => s.Type).ToArray();
  }
  public static double[] ToEngineDurations(EditDocument doc) {
   var plan = Ensure(doc);
   if (plan.Count != JunctionCount(doc)) throw new Exception("接点转场条数与片段数对不上（先同步接点方案）。");
   for (int j = 0; j < plan.Count; j++) ValidateFor(doc, j);
   return plan.Select(s => s.Type == "cut" ? 0 : s.DurationSeconds).ToArray();
  }
  // 全部非 cut 接点共用同一时长时返回该时长，否则返回 null
  // （当前引擎是项目级单值 transitionDuration，混用时长没有单值可填）。
  public static double? UniformDuration(EditDocument doc) {
   var plan = Ensure(doc);
   double? shared = null;
   foreach (var spec in plan) {
    if (spec.Type == "cut") continue;
    if (shared == null) shared = spec.DurationSeconds;
    else if (Math.Abs(shared.Value - spec.DurationSeconds) > 0.000001) return null;
   }
   return shared;
  }
  // 兼容垫片：接点方案全相同时写回项目级 Transition/TransitionDuration，
  // 老的单值导出路径行为不变；混用时返回 false、不写回。
  public static bool SyncProjectFields(EditDocument doc) {
   var plan = Ensure(doc);
   if (plan.Count == 0) return true;
   string first = plan[0].Type;
   if (!plan.All(s => s.Type == first)) return false;
   if (UniformDuration(doc) == null && plan.Any(s => s.Type != "cut")) return false;
   doc.Transition = first;
   doc.TransitionDuration = first == "cut" ? 0 : UniformDuration(doc).Value;
   return true;
  }
 }

 // ---- 接点预览：把接点前后各一段用 ffmpeg 真实渲染成预览片 ----
 // 视频：cut 走 concat；其余走 xfade（引擎 XFADE_TRANSITIONS 同款名）。
 // 音频：cut 走 concat；其余走 acrossfade（与 xfade 同一时长/偏移）。
 // 预览片是接点附近的短片段（RenderPreviewForJunction 各取至多 1 秒），
 // 不是整条时间线；两路输入都要求带音频（无音频的素材预览会直接报错，
 // 不静默出无声片）。
 static class TransitionPreview {
  public static string Render(TransitionSpec spec, string pathA, double inA, double outA, string pathB, double inB, double outB, string outPath, CancellationToken token) {
   if (spec == null) throw new Exception("没有转场规格可预览。");
   TransitionPlan.ValidateSpec(spec);
   if (string.IsNullOrEmpty(pathA) || !File.Exists(pathA)) throw new Exception("预览素材 A 缺失：" + pathA + "。");
   if (string.IsNullOrEmpty(pathB) || !File.Exists(pathB)) throw new Exception("预览素材 B 缺失：" + pathB + "。");
   double lenA = outA - inA, lenB = outB - inB;
   if (!EditDocument.Finite(lenA) || !EditDocument.Finite(lenB) || lenA <= 0 || lenB <= 0) throw new Exception("预览窗口无效。");
   double d = spec.Type == "cut" ? 0 : spec.DurationSeconds;
   if (spec.Type != "cut" && d >= Math.Min(lenA, lenB) - 0.01) throw new Exception("预览转场时长 " + d.ToString("0.00", CultureInfo.InvariantCulture) + "s 不小于两侧预览窗口最短边（xfade 时长必须小于两侧片段长度）。");
   string dir = Path.GetDirectoryName(outPath);
   if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
   // 两路先 trim + fps/scale/format 统一（xfade 要求同帧率同尺寸同格式）。
   string vA = "[0:v]trim=start=" + Media.N(inA) + ":end=" + Media.N(outA) + ",setpts=PTS-STARTPTS,fps=30,scale=640:360,format=yuv420p[v0]";
   string vB = "[1:v]trim=start=" + Media.N(inB) + ":end=" + Media.N(outB) + ",setpts=PTS-STARTPTS,fps=30,scale=640:360,format=yuv420p[v1]";
   string aA = "[0:a]atrim=start=" + Media.N(inA) + ":end=" + Media.N(outA) + ",asetpts=PTS-STARTPTS[a0]";
   string aB = "[1:a]atrim=start=" + Media.N(inB) + ":end=" + Media.N(outB) + ",asetpts=PTS-STARTPTS[a1]";
   string join;
   if (spec.Type == "cut") {
    join = "[v0][v1]concat=n=2:v=1:a=0[vout];[a0][a1]concat=n=2:v=0:a=1[aout]";
   } else {
    double offset = lenA - d;
    join = "[v0][v1]xfade=transition=" + TransitionPlan.XfadeNames[spec.Type] + ":duration=" + Media.N(d) + ":offset=" + Media.N(offset) + "[vout];"
     + (spec.AudioCrossfade
      ? "[a0][a1]acrossfade=d=" + Media.N(d) + "[aout]"
      : "[a0][a1]concat=n=2:v=0:a=1[aout]");
   }
   string fc = vA + ";" + vB + ";" + aA + ";" + aB + ";" + join;
   StudioMedia.Run("-v error -y -i " + Media.Q(pathA) + " -i " + Media.Q(pathB) + " -filter_complex " + Media.Q(fc) + " -map [vout] -map [aout] -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -movflags +faststart " + Media.Q(outPath), token);
   if (!File.Exists(outPath)) throw new Exception("转场预览片生成失败。");
   return outPath;
  }
  // 接点预览窗口：A 取接点前至多 1 秒（不少于转场时长），B 取接点后至多 1 秒。
  public static string RenderPreviewForJunction(EditDocument doc, int junction, string folder, CancellationToken token) {
   if (doc == null) throw new Exception("没有打开的项目。");
   var plan = TransitionPlan.Ensure(doc);
   if (junction < 0 || junction >= plan.Count) throw new Exception("没有这个接点。");
   var spec = plan[junction];
   TransitionPlan.ValidateFor(doc, junction);
   var cutA = doc.Cuts[junction]; var cutB = doc.Cuts[junction + 1];
   double span = Math.Max(spec.Type == "cut" ? 0.5 : spec.DurationSeconds, 1.0);
   double inA = Math.Max(cutA.Start, cutA.End - span), outA = cutA.End;
   double inB = cutB.Start, outB = Math.Min(cutB.End, cutB.Start + span);
   Directory.CreateDirectory(folder);
   string outPath = Path.Combine(folder, "transition-j" + (junction + 1) + "-" + spec.Type + ".mp4");
   return Render(spec, doc.Source, inA, outA, doc.Source, inB, outB, outPath, token);
  }
  // 预览片中心像素平均 RGB（64×64 中心块、每 4 像素采样），供 UI 与自测
  // 判断中点帧是不是两路画面的混合（溶解中点红蓝都应明显大于 0）。
  public static double[] ProbeCenterRgb(string file, double time) {
   byte[] png = StudioMedia.Frame(file, time, 640, CancellationToken.None);
   using (var ms = new MemoryStream(png))
   using (var bmp = new D.Bitmap(ms)) {
    double r = 0, g = 0, b = 0; int n = 0;
    for (int y = bmp.Height / 2 - 32; y < bmp.Height / 2 + 32; y += 4)
     for (int x = bmp.Width / 2 - 32; x < bmp.Width / 2 + 32; x += 4) {
      var c = bmp.GetPixel(x, y);
      r += c.R; g += c.G; b += c.B; n++;
     }
    return new[] { r / n, g / n, b / n };
   }
  }
  public static double ProbeCenterLuma(string file, double time) {
   var rgb = ProbeCenterRgb(file, time);
   return (rgb[0] + rgb[1] + rgb[2]) / 3.0;
  }
 }
}
