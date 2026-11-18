// W8 收尾批 · 调色高级（2026-11-18）：节点式调色、色彩管理、镜头匹配、
// 跟踪窗口、LUT 库、调色前后对比、色度键取色器、色彩示波器实时显示。
// 模型与纯逻辑；UI 见 W8UI.cs。C# 原生实现，TS 引擎只作规格/参照
// （路线与 W3/W5/W6/W7 相同：便携包无 node，C# 直接 shell 调 ffmpeg、
// 照抄已验证的滤镜串）。
//
// 规格出处（参数逐一照抄，出处写在各节注释里）：
// - 节点图：p3g.ts 的 GradeNode/GradeNodeGraph/bakeGradeNodes——串联按
//   拓扑顺序烤进一张 17³ LUT，并联按 blend+opacity 逐网格点混合，蒙版
//   节点单独烤一张 LUT + 一张 PNG，蒙版节点在主烤里读作恒等。两条探针
//   教训照抄：①蒙版节点必须直连输出（或就是输出），不能读另一个蒙版
//   节点（读了就报错，不静默压平）；②节点调色只含 LUT 参数（白平衡/
//   HSL 分区/色轮/HSL 曲线/RGB·主曲线，color.ts 的 applyAdvancedColorToRgb
//   本来就不含亮度/对比度/饱和度——那是 eq 阶段的），节点里亮度/对比度/
//   饱和度非默认值直接拒绝，不近似烤。
// - 色彩管理：p3g.ts 的 buildTransferLut/inputColorConversion——S-Log3
//   用 Sony 官方曲线烤 LUT（锚点 18% 灰→420/1023、90% 白→598/1023），
//   S-Gamut3.Cine 色域矩阵不含，只转传输曲线；log100/HLG 走 zscale，
//   输入必须先 setparams 打标签（裸 zscale 报 "no path between
//   colorspaces"，探针已证实）；PQ 走 Hable tonemap。
// - 镜头匹配：p3g.ts 的 histogramMatchMaps/buildColorMatchLut——CDF 映射
//   后在目标不同灰度级之间线性插值、范围外取平（裸 CDF 阶跃会被 17³ LUT
//   三线性插值抹平：固色目标 100→200 直接烤出来是 52，探针证实后已修）。
// - 跟踪窗口：p3g.ts 的 TrackedWindow/buildTrackedWindowMaskBuffer——
//   形状蒙版 + 跨帧追踪（trackCenterAt：已知点之间线性插值，丢帧点停在
//   上一个已知位置，不编造），遮罩视频 5fps。C# 侧没有自动主体追踪器
//   （P3b 追踪是 TS 引擎的），跟踪点由用户在播放头处打点；自动追踪待
//   后续批次。
// - LUT 库：p3g.ts 的 LutLibraryEntry/filterLutLibrary/toggleLutFavorite/
//   generateLutThumbnail——分类/收藏/搜索 + 悬停预览缩略图（缩略图就是
//   lut3d 直接渲染再缩小，与直接烤 LUT 的帧一致）。
// - 前后对比：p3g.ts 的 renderComparisonFrame/saveReferenceStill/
//   loadReferenceStill——分屏/擦除是 standalone ffmpeg（split/crop/
//   hstack），参考帧 PNG + JSON sidecar 存取往返，sidecar 篡改拒绝加载。
// - 色度键：filtergraph.ts 的 applyChromaStage——chromakey + despill，
//   similarity 默认 0.1（实测 0.01 完全不抠，绿区变黑）；despill 类型按
//   键色走（蓝占优才 blue，其余 green）。
// - 示波器：scopes.ts 的 analyzeRgbFrame——Rec.709 亮度、RGB Parade、
//   矢量示波器（圆均值主色相，灰帧主色相为 null）、高光/阴影裁切
//   （三通道都 >250 才算爆、都 <5 才算死黑）；数字是源头，图只是视图。
//
// 导出接线：未开 W8 高级调色时 Chain() 与 Grade.VideoFilter() 逐字一致，
// 老项目行为零变化。开高级调色后调色链 = 输入转换 LUT → 镜头匹配 LUT →
// 节点终烤/线性调色 LUT → LUT 库应用 LUT → 输出转换 LUT，全部是 lut3d。
// 蒙版节点/跟踪窗口/色度键走 filter_complex 解码器（W8ColourExport），
// 合成写法复用 W5 美颜已验证的 split → 分支 lut3d → yuva420p →
// alphamerge → overlay 回原图，不另发明合成路。
// 诚实记录：云端 runner 无真 GPU，--w8colour-test 只验纯逻辑 + 合成素材
// 实测 + 解码器图真实跑帧；面板交互与监视器视觉仍等他电脑实测。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using DogSC.Windows;

namespace DogSC.Replica {
 // ---- 1. 节点式调色（p3g.ts GradeNode/GradeNodeGraph）----
 public class GradeNodeMask {
  public string Shape = "ellipse"; public double X = 0.5; public double Y = 0.5;
  public double W = 0.3; public double H = 0.3; public double Feather = 0.02;
 }
 public class GradeNode {
  public string Id = "";
  public ColorGrade Adjust = new ColorGrade();
  public List<string> Inputs = new List<string>();
  public string Blend = "normal"; public double Opacity = 1;
  public GradeNodeMask Mask;
 }
 public class GradeNodeGraph {
  public List<GradeNode> Nodes = new List<GradeNode>();
  public string Output = "";
 }
 public class MaskedStageBake {
  public string Id; public double[] Grid; public string Blend; public double Opacity; public GradeNodeMask Mask;
 }
 public class BakedGraph {
  public double[] Final; public List<MaskedStageBake> Masked = new List<MaskedStageBake>();
 }

 static class GradeNodeGraphOps {
  public static readonly string[] BlendModes = new[] { "normal", "multiply", "screen", "overlay" };
  const int Size = 17;
  static double Clamp01(double v) { return Math.Max(0, Math.Min(1, v)); }
  static int Idx(int ri, int gi, int bi) { return ((bi * Size + gi) * Size + ri) * 3; }
  public static double[] IdentityGrid() {
   var g = new double[Size * Size * Size * 3];
   for (int bi = 0; bi < Size; bi++) for (int gi = 0; gi < Size; gi++) for (int ri = 0; ri < Size; ri++) {
    int i = Idx(ri, gi, bi);
    g[i] = (double)ri / (Size - 1); g[i + 1] = (double)gi / (Size - 1); g[i + 2] = (double)bi / (Size - 1);
   }
   return g;
  }
  // 节点调色只含 LUT 参数：亮度/对比度/饱和度在 color.ts 的
  // applyAdvancedColorToRgb 里本来就没有，节点里出现非默认值就是建模错。
  public static void CheckAdjust(ColorGrade adjust, string id) {
   if (adjust == null) throw new Exception("调色节点 " + id + " 没有调色参数。");
   if (Math.Abs(adjust.Brightness) > .000001 || Math.Abs(adjust.Contrast - 1) > .000001 || Math.Abs(adjust.Saturation - 1) > .000001)
    throw new Exception("调色节点 " + id + " 的亮度/对比度/饱和度请用主调色调（节点只烤 LUT 参数：白平衡/HSL/色轮/曲线）。");
  }
  // Kahn 拓扑排序（与 p3g.ts 的 topoSortGradeNodes 一致）：成环、悬空输入、
  // 缺失输出节点都报错。队列按节点列出顺序进，烘焙结果确定。
  public static List<GradeNode> TopoSort(GradeNodeGraph graph) {
   var byId = new Dictionary<string, GradeNode>();
   foreach (var n in graph.Nodes) byId[n.Id] = n;
   if (!byId.ContainsKey(graph.Output)) throw new Exception("节点图的输出节点不存在：" + graph.Output + "。");
   var indegree = new Dictionary<string, int>();
   var dependents = new Dictionary<string, List<string>>();
   foreach (var n in graph.Nodes) {
    var inputs = n.Inputs == null || n.Inputs.Count == 0 ? new List<string> { "input" } : n.Inputs;
    var deps = inputs.Where(x => x != "input").ToList();
    foreach (var d in deps) if (!byId.ContainsKey(d)) throw new Exception("调色节点 " + n.Id + " 的输入不存在：" + d + "。");
    indegree[n.Id] = deps.Count;
    foreach (var d in deps) {
     if (!dependents.ContainsKey(d)) dependents[d] = new List<string>();
     dependents[d].Add(n.Id);
    }
   }
   var queue = new Queue<string>(graph.Nodes.Where(n => indegree[n.Id] == 0).Select(n => n.Id));
   var order = new List<GradeNode>();
   while (queue.Count > 0) {
    var id = queue.Dequeue();
    order.Add(byId[id]);
    if (!dependents.ContainsKey(id)) continue;
    foreach (var dep in dependents[id]) {
     indegree[dep]--;
     if (indegree[dep] == 0) queue.Enqueue(dep);
    }
   }
   if (order.Count != graph.Nodes.Count) throw new Exception("节点图里有环，无法确定烘焙顺序。");
   return order;
  }
  public static void Validate(GradeNodeGraph graph) {
   if (graph == null) return;
   if (graph.Nodes == null || graph.Nodes.Count == 0) throw new Exception("节点图没有节点。");
   var ids = new HashSet<string>();
   foreach (var n in graph.Nodes) {
    if (string.IsNullOrWhiteSpace(n.Id)) throw new Exception("调色节点缺 id。");
    if (!ids.Add(n.Id)) throw new Exception("调色节点 id 重复：" + n.Id + "。");
    CheckAdjust(n.Adjust, n.Id);
    if (!string.IsNullOrEmpty(n.Blend) && !BlendModes.Contains(n.Blend)) throw new Exception("调色节点 " + n.Id + " 的混合模式无效：" + n.Blend + "。");
    if (!EditDocument.Finite(n.Opacity) || n.Opacity < 0 || n.Opacity > 1) throw new Exception("调色节点 " + n.Id + " 的不透明度超出 0–1。");
    if (n.Mask != null) GradeNodeMaskOps.Validate(n.Mask, n.Id);
   }
   var order = TopoSort(graph);
   var masked = new HashSet<string>(graph.Nodes.Where(n => n.Mask != null).Select(n => n.Id));
   if (masked.Count > 0) {
    // 先查“蒙版节点读另一个蒙版节点”（更深的那条错优先报，与 p3g.ts 一致）。
    foreach (var m in masked) {
     var node = graph.Nodes.First(n => n.Id == m);
     foreach (var inp in node.Inputs == null || node.Inputs.Count == 0 ? new List<string> { "input" } : node.Inputs)
      if (masked.Contains(inp)) throw new Exception("蒙版节点 " + m + " 不能读另一个蒙版节点 " + inp + "（蒙版不能叠蒙版）。");
    }
    var outputNode = graph.Nodes.First(n => n.Id == graph.Output);
    var outputInputs = new HashSet<string>(outputNode.Inputs == null || outputNode.Inputs.Count == 0 ? new List<string> { "input" } : outputNode.Inputs);
    foreach (var m in masked)
     if (m != graph.Output && !outputInputs.Contains(m)) throw new Exception("蒙版节点 " + m + " 必须直连输出（蒙版分支烤不成一张 LUT，不能藏在图中间）。");
   }
  }
  // blendLuts 的 C# 版：base 与 over 逐网格点按模式混合，再按 opacity 插值。
  public static double[] BlendGrids(double[] bas, double[] over, string mode, double opacity) {
   if (bas.Length != over.Length) throw new Exception("要混合的两张 LUT 尺寸不一致。");
   if (opacity < 0 || opacity > 1) throw new Exception("混合不透明度超出 0–1：" + Media.N(opacity) + "。");
   var data = new double[bas.Length];
   for (int i = 0; i < data.Length; i++) {
    double b = bas[i], o = over[i], v;
    switch (mode) {
     case "multiply": v = b * o; break;
     case "screen": v = 1 - (1 - b) * (1 - o); break;
     case "overlay": v = b < 0.5 ? 2 * b * o : 1 - 2 * (1 - b) * (1 - o); break;
     default: v = o; break;
    }
    data[i] = b + (v - b) * opacity;
   }
   return data;
  }
  public static double[] ApplyAdjustToGrid(double[] grid, ColorGrade adjust) {
   var data = new double[grid.Length];
   for (int i = 0; i < data.Length; i += 3) {
    var rgb = ColorLut.Apply(adjust, grid[i], grid[i + 1], grid[i + 2]);
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2];
   }
   return data;
  }
  // bakeGradeNodes 的 C# 版：多输入按列出顺序以本节点 blend+opacity 折叠，
  // 再贴本节点调色；蒙版节点在主烤里读作恒等，单独再烤一份。
  public static BakedGraph Bake(GradeNodeGraph graph) {
   Validate(graph);
   var order = TopoSort(graph);
   var maskedIds = new HashSet<string>(graph.Nodes.Where(n => n.Mask != null).Select(n => n.Id));
   var luts = new Dictionary<string, double[]>();
   var identity = IdentityGrid();
   foreach (var node in order) {
    var inputs = node.Inputs == null || node.Inputs.Count == 0 ? new List<string> { "input" } : node.Inputs;
    double[] acc;
    if (inputs.Count == 0) acc = identity;
    else {
     acc = inputs[0] == "input" ? identity : luts[inputs[0]];
     for (int k = 1; k < inputs.Count; k++) {
      var next = inputs[k] == "input" ? identity : luts[inputs[k]];
      acc = BlendGrids(acc, next, string.IsNullOrEmpty(node.Blend) ? "normal" : node.Blend, node.Opacity);
     }
    }
    luts[node.Id] = maskedIds.Contains(node.Id) ? identity : ApplyAdjustToGrid(acc, node.Adjust ?? new ColorGrade());
   }
   var baked = new BakedGraph { Final = luts[graph.Output] };
   foreach (var node in graph.Nodes) {
    if (node.Mask == null) continue;
    var inputs = node.Inputs == null || node.Inputs.Count == 0 ? new List<string> { "input" } : node.Inputs;
    double[] acc;
    if (inputs.Count == 0) acc = identity;
    else {
     acc = inputs[0] == "input" ? identity : luts[inputs[0]];
     for (int k = 1; k < inputs.Count; k++) {
      var next = inputs[k] == "input" ? identity : luts[inputs[k]];
      acc = BlendGrids(acc, next, string.IsNullOrEmpty(node.Blend) ? "normal" : node.Blend, node.Opacity);
     }
    }
    baked.Masked.Add(new MaskedStageBake { Id = node.Id, Grid = ApplyAdjustToGrid(acc, node.Adjust ?? new ColorGrade()), Blend = string.IsNullOrEmpty(node.Blend) ? "normal" : node.Blend, Opacity = node.Opacity, Mask = node.Mask });
   }
   return baked;
  }
  public static string Key(GradeNodeGraph graph) {
   var sb = new StringBuilder();
   sb.Append(graph.Output).Append("|");
   foreach (var n in graph.Nodes) {
    sb.Append(n.Id).Append(":").Append(n.Adjust == null ? "" : n.Adjust.Key()).Append(":")
      .Append(string.Join(",", (n.Inputs ?? new List<string>()).ToArray())).Append(":")
      .Append(n.Blend).Append(":").Append(Media.N(n.Opacity)).Append(";");
    if (n.Mask != null) sb.Append("mask=").Append(n.Mask.Shape).Append(",").Append(Media.N(n.Mask.X)).Append(",").Append(Media.N(n.Mask.Y)).Append(",").Append(Media.N(n.Mask.W)).Append(",").Append(Media.N(n.Mask.H)).Append(",").Append(Media.N(n.Mask.Feather)).Append(";");
   }
   return sb.ToString();
  }
  public static string CubePathForGrid(double[] grid, string key, string prefix) {
   string hash;
   using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(key))).Replace("-", "").ToLowerInvariant().Substring(0, 16);
   string path = Path.Combine(Path.GetTempPath(), "catcut-w8-" + prefix + "-" + hash + ".cube");
   if (!File.Exists(path)) File.WriteAllText(path, LutCube.GridToText(grid, Size, "CatCut W8 colour"), new UTF8Encoding(false));
   return path;
  }
  // 网格点查值（测试用：按最近网格点取，不做三线性插值，与 LUT 烤值一致）。
  public static double[] Sample(double[] grid, double r, double g, double b) {
   int ri = (int)Math.Round(Clamp01(r) * (Size - 1)), gi = (int)Math.Round(Clamp01(g) * (Size - 1)), bi = (int)Math.Round(Clamp01(b) * (Size - 1));
   int i = Idx(ri, gi, bi);
   return new[] { grid[i], grid[i + 1], grid[i + 2] };
  }
 }

 // 节点蒙版的形状 + 羽化（mask.ts 的 shapeSdf 同款语义：矩形圆角 0，
 // 圆直径 = 宽；羽化是相对画面短边的比例，默认 0.02）。
 static class GradeNodeMaskOps {
  public static void Validate(GradeNodeMask mask, string id) {
   if (mask.Shape != "rect" && mask.Shape != "ellipse" && mask.Shape != "circle") throw new Exception("调色节点 " + id + " 的蒙版形状无效：" + mask.Shape + "（rect/ellipse/circle）。");
   if (!EditDocument.Finite(mask.X) || !EditDocument.Finite(mask.Y) || mask.X < 0 || mask.X > 1 || mask.Y < 0 || mask.Y > 1) throw new Exception("调色节点 " + id + " 的蒙版中心超出 0–1。");
   if (!EditDocument.Finite(mask.W) || !EditDocument.Finite(mask.H) || mask.W <= 0 || mask.W > 1 || mask.H <= 0 || mask.H > 1) throw new Exception("调色节点 " + id + " 的蒙版尺寸超出 (0, 1]。");
   if (!EditDocument.Finite(mask.Feather) || mask.Feather < 0 || mask.Feather > 0.25) throw new Exception("调色节点 " + id + " 的蒙版羽化超出 0–0.25。");
  }
  // 带符号距离（像素）：<=0 在形状内。羽化带内 smoothstep 过渡。
  static double Sdf(GradeNodeMask mask, double px, double py, int w, int h) {
   double cx = mask.X * w, cy = mask.Y * h;
   double hw = mask.W * w / 2, hh = mask.H * h / 2;
   if (mask.Shape == "circle") {
    double r = hw;
    return Math.Sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy)) - r;
   }
   if (mask.Shape == "ellipse") {
    double rx = hw, ry = hh;
    double dx = (px - cx) / rx, dy = (py - cy) / ry;
    return (Math.Sqrt(dx * dx + dy * dy) - 1) * Math.Min(rx, ry);
   }
   double qx = Math.Abs(px - cx) - hw, qy = Math.Abs(py - cy) - hh;
   double ox = Math.Max(qx, 0), oy = Math.Max(qy, 0);
   return Math.Sqrt(ox * ox + oy * oy) + Math.Min(Math.Max(qx, qy), 0);
  }
  public static double AlphaAt(GradeNodeMask mask, double px, double py, int w, int h) {
   double featherPx = Math.Max(0.5, mask.Feather * Math.Min(w, h));
   double d = Sdf(mask, px, py, w, h);
   if (d <= -featherPx) return 1;
   if (d >= featherPx) return 0;
   double t = (d + featherPx) / (2 * featherPx);
   t = Math.Max(0, Math.Min(1, t));
   return 1 - t * t * (3 - 2 * t);
  }
  // 灰度 RGB 的 PNG（R=G=B=蒙版值，A=255）：alphamerge 前要过 format=gray，
  // 灰度走亮度通道，alpha 里的值是取不到的，所以蒙版必须画在 RGB 里。
  public static byte[] RenderPng(GradeNodeMask mask, int width, int height) {
   var bytes = new byte[width * height * 4];
   for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
    int v = (int)Math.Round(AlphaAt(mask, x + 0.5, y + 0.5, width, height) * 255);
    int i = (y * width + x) * 4;
    bytes[i] = (byte)v; bytes[i + 1] = (byte)v; bytes[i + 2] = (byte)v; bytes[i + 3] = 255;
   }
   using (var bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
    var rect = new Rectangle(0, 0, width, height);
    var data = bmp.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    try { Marshal.Copy(bytes, 0, data.Scan0, bytes.Length); }
    finally { bmp.UnlockBits(data); }
    using (var ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); return ms.ToArray(); }
   }
  }
 }

 // ---- .cube 解析/写出（p3g.ts 的 parseCube/lutToCube 同款：只认
 // LUT_3D_SIZE 2–64、DOMAIN 0–1、数据行数 = size³、值 0–1）----
 public class ParsedCube { public int Size; public double[] Grid; }
 static class LutCube {
  public static ParsedCube Parse(string text, string what) {
   if (string.IsNullOrWhiteSpace(text)) throw new Exception(what + "：LUT 文件是空的。");
   int size = -1;
   var values = new List<double>();
   foreach (string raw in text.Replace("\r\n", "\n").Split('\n')) {
    string line = raw.Trim();
    if (line.Length == 0 || line.StartsWith("#") || line.StartsWith("TITLE", StringComparison.OrdinalIgnoreCase)) continue;
    if (line.StartsWith("LUT_3D_SIZE", StringComparison.OrdinalIgnoreCase)) {
     var parts = line.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
     if (parts.Length < 2 || !int.TryParse(parts[1], out size)) throw new Exception(what + "：LUT_3D_SIZE 无法解析。");
     continue;
    }
    if (line.StartsWith("DOMAIN_MIN", StringComparison.OrdinalIgnoreCase)) {
     var p = line.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
     if (p.Length < 4 || p[1] != "0.0" || p[2] != "0.0" || p[3] != "0.0") throw new Exception(what + "：只支持 DOMAIN_MIN 0 0 0。");
     continue;
    }
    if (line.StartsWith("DOMAIN_MAX", StringComparison.OrdinalIgnoreCase)) {
     var p = line.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
     if (p.Length < 4 || p[1] != "1.0" || p[2] != "1.0" || p[3] != "1.0") throw new Exception(what + "：只支持 DOMAIN_MAX 1 1 1。");
     continue;
    }
    var nums = line.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
    if (nums.Length != 3) throw new Exception(what + "：LUT 数据行必须是 3 个数：" + line + "。");
    foreach (var n in nums) {
     double v;
     if (!double.TryParse(n, NumberStyles.Float, CultureInfo.InvariantCulture, out v) || v < 0 || v > 1) throw new Exception(what + "：LUT 值超出 0–1：" + n + "。");
     values.Add(v);
    }
   }
   if (size < 2 || size > 64) throw new Exception(what + "：LUT_3D_SIZE " + size + " 超出 2–64。");
   if (values.Count != size * size * size * 3) throw new Exception(what + "：LUT 数据行数不对（应为 " + (size * size * size) + " 行，实得 " + (values.Count / 3) + " 行）。");
   return new ParsedCube { Size = size, Grid = values.ToArray() };
  }
  public static ParsedCube ParseFile(string path) {
   if (string.IsNullOrEmpty(path) || !File.Exists(path)) throw new Exception("找不到 LUT 文件：" + path + "。");
   try { return Parse(File.ReadAllText(path, new UTF8Encoding(false)), "LUT " + Path.GetFileName(path)); }
   catch (Exception ex) { throw new Exception("LUT 文件损坏（不是有效 .cube）：" + Path.GetFileName(path) + "。" + ex.Message); }
  }
  public static string GridToText(double[] grid, int size, string title) {
   var sb = new StringBuilder();
   sb.Append("TITLE \"" + title + "\"\nLUT_3D_SIZE " + size + "\nDOMAIN_MIN 0.0 0.0 0.0\nDOMAIN_MAX 1.0 1.0 1.0\n");
   for (int i = 0; i < grid.Length; i += 3)
    sb.Append(grid[i].ToString("F6", CultureInfo.InvariantCulture)).Append(" ").Append(grid[i + 1].ToString("F6", CultureInfo.InvariantCulture)).Append(" ").Append(grid[i + 2].ToString("F6", CultureInfo.InvariantCulture)).Append("\n");
   return sb.ToString();
  }
 }

 // ---- 2. 色彩管理（p3g.ts buildTransferLut/inputColorConversion）----
 public class InputConversion { public string Filter; public string LutFrom; public string LutTo; public bool HasLut { get { return LutFrom != null; } } }
 static class ColourMgmt {
  public static readonly string[] InputSpaces = new[] { "rec709", "srgb", "slog3", "log100", "hlg", "pq" };
  public static readonly string[] WorkingSpaces = new[] { "rec709", "srgb" };
  // Sony S-Log3 官方曲线（p3g.ts 逐行照抄）：18% 灰→420/1023、90% 白→598/1023。
  public static double Slog3Decode(double v) {
   double cv = v * 1023;
   if (cv < 171.2102946929) return ((cv - 95) * 0.01125) / (171.2102946929 - 95);
   return Math.Pow(10, (cv - 420) / 261.5) * 0.19 - 0.01;
  }
  public static double Slog3Encode(double l) {
   if (l < 0.01125) return (l * (171.2102946929 - 95) / 0.01125 + 95) / 1023;
   return (420 + 261.5 * Math.Log10((l + 0.01) / 0.19)) / 1023;
  }
  public static double Rec709Oetf(double l) { return l < 0.018 ? 4.5 * l : 1.099 * Math.Pow(l, 0.45) - 0.099; }
  public static double Rec709OetfInv(double v) { return v < 0.081 ? v / 4.5 : Math.Pow((v + 0.099) / 1.099, 1 / 0.45); }
  public static double SrgbOetf(double l) { return l <= 0.0031308 ? 12.92 * l : 1.055 * Math.Pow(l, 1 / 2.4) - 0.055; }
  public static double SrgbOetfInv(double v) { return v <= 0.04045 ? v / 12.92 : Math.Pow((v + 0.055) / 1.055, 2.4); }
  static double ToLinear(string space, double v) {
   if (space == "rec709") return Rec709OetfInv(v);
   if (space == "srgb") return SrgbOetfInv(v);
   return Slog3Decode(v);
  }
  static double FromLinear(string space, double l) {
   if (space == "rec709") return Rec709Oetf(Math.Max(0, l));
   if (space == "srgb") return SrgbOetf(Math.Max(0, l));
   return Slog3Encode(Math.Max(0, l));
  }
  // 只转传输曲线（两端同一组 BT.709 原色），色域矩阵不含——与 p3g.ts 一致。
  public static double[] BuildTransferLut(string from, string to, int size = 17) {
   if (size < 2 || size > 64) throw new Exception("色彩转换 LUT 尺寸 " + size + " 超出 2–64。");
   var data = new double[size * size * size * 3];
   int i = 0;
   for (int bi = 0; bi < size; bi++) for (int gi = 0; gi < size; gi++) for (int ri = 0; ri < size; ri++) {
    data[i++] = Math.Max(0, Math.Min(1, FromLinear(to, ToLinear(from, (double)ri / (size - 1)))));
    data[i++] = Math.Max(0, Math.Min(1, FromLinear(to, ToLinear(from, (double)gi / (size - 1)))));
    data[i++] = Math.Max(0, Math.Min(1, FromLinear(to, ToLinear(from, (double)bi / (size - 1)))));
   }
   return data;
  }
  public static string TransferLutPath(string from, string to) {
   return GradeNodeGraphOps.CubePathForGrid(BuildTransferLut(from, to), from + "-to-" + to, "xfer");
  }
  // 每片段输入 → 时间线工作空间。zscale 路：输入先 setparams 打标签，
  // 再 zscale（裸 zscale 报 "no path between colorspaces"，探针已证实）。
  // PQ 走 P3c 的 Hable tonemap（PQ→SDR 必须 tonemap，不能直转）。
  public static InputConversion InputConversionFor(string inputSpace, string working) {
   string wt = working == "srgb" ? "iec61966-2-1" : "bt709";
   switch (inputSpace) {
    case "rec709": return working == "srgb" ? new InputConversion { LutFrom = "rec709", LutTo = "srgb" } : new InputConversion();
    case "srgb": return working == "srgb" ? new InputConversion() : new InputConversion { LutFrom = "srgb", LutTo = "rec709" };
    case "slog3": return new InputConversion { LutFrom = "slog3", LutTo = working };
    case "log100": return new InputConversion { Filter = "setparams=color_primaries=bt709:color_trc=log100:colorspace=bt709,zscale=p=bt709:t=" + wt + ":m=bt709:range=tv,format=yuv420p" };
    case "hlg": return new InputConversion { Filter = "setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc,zscale=p=bt709:t=" + wt + ":m=bt709:range=tv,format=yuv420p" };
    case "pq": {
     string f = "zscale=pin=bt2020:min=bt2020nc:tin=smpte2084:rangein=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable,format=yuv420p";
     return working == "srgb" ? new InputConversion { Filter = f, LutFrom = "rec709", LutTo = "srgb" } : new InputConversion { Filter = f };
    }
    default: throw new Exception("未知的输入色彩空间：" + inputSpace + "（应为 rec709/srgb/slog3/log100/hlg/pq）。");
   }
  }
  // 输出空间标签（setparams 写法，ffprobe 可验 sRGB 的 color_transfer=
  // iec61966-2-1）：C# 导出走 rawvideo 管线进编码器，标签贴不到编码器上，
  // 这里只烤传输 LUT，面板写明该限制。
  public static string OutputColorTag(string space) {
   if (space == "srgb") return "setparams=color_trc=iec61966-2-1:color_primaries=bt709:colorspace=bt709";
   return "setparams=color_trc=bt709:color_primaries=bt709:colorspace=bt709";
  }
  public static void ValidateSpaces(string input, string working, string output) {
   if (!string.IsNullOrEmpty(input) && !InputSpaces.Contains(input)) throw new Exception("输入色彩空间无效：" + input + "。");
   if (!string.IsNullOrEmpty(working) && !WorkingSpaces.Contains(working)) throw new Exception("工作色彩空间无效：" + working + "（只能是 rec709/srgb）。");
   if (!string.IsNullOrEmpty(output) && !WorkingSpaces.Contains(output)) throw new Exception("输出色彩空间无效：" + output + "（只能是 rec709/srgb）。");
  }
 }

 // ---- 3. 镜头匹配（p3g.ts histogramMatchMaps/buildColorMatchLut）----
 public class ColourMatch { public string ReferenceFrame = ""; public double Strength = 1; }
 static class ColourMatchOps {
  public static void Validate(ColourMatch match) {
   if (match == null) return;
   if (string.IsNullOrWhiteSpace(match.ReferenceFrame)) throw new Exception("镜头匹配没有选参考帧。");
   if (!File.Exists(match.ReferenceFrame)) throw new Exception("镜头匹配的参考帧缺失：" + match.ReferenceFrame + "。");
   if (!EditDocument.Finite(match.Strength) || match.Strength < 0 || match.Strength > 1) throw new Exception("镜头匹配强度超出 0–1。");
  }
  // 一帧解码成 RGB24 原始字节（与 BeatDetector.DecodeAudioMono 同款读法）。
  public static byte[] DecodeFrameRgb24(string file, double time, int width, int height, CancellationToken token) {
   if (string.IsNullOrEmpty(file) || !File.Exists(file)) throw new Exception("找不到要解码的帧：" + file + "。");
   using (var p = Media.Start("ffmpeg", "-v error -ss " + Media.N(Math.Max(0, time)) + " -i " + Media.Q(file) + " -vf scale=" + width + ":" + height + " -frames:v 1 -f rawvideo -pix_fmt rgb24 -", true))
   using (token.Register(() => { try { if (!p.HasExited) p.Kill(); } catch { } })) {
    var errors = p.StandardError.ReadToEndAsync();
    using (var ms = new MemoryStream()) {
     p.StandardOutput.BaseStream.CopyTo(ms); p.WaitForExit(); token.ThrowIfCancellationRequested();
     if (p.ExitCode != 0) throw new Exception("解码帧失败：" + errors.Result);
     byte[] bytes = ms.ToArray();
     if (bytes.Length < width * height * 3) throw new Exception("解码帧不完整（" + bytes.Length + " 字节）。");
     var outp = new byte[width * height * 3];
     Array.Copy(bytes, outp, outp.Length);
     return outp;
    }
   }
  }
  public static uint[][] ChannelHistograms(byte[] pixels) {
   var h = new uint[][] { new uint[256], new uint[256], new uint[256] };
   for (int i = 0; i + 2 < pixels.Length; i += 3) { h[0][pixels[i]]++; h[1][pixels[i + 1]]++; h[2][pixels[i + 2]]++; }
   return h;
  }
  static double[] Cdf(uint[] hist) {
   var outp = new double[256];
   double total = 0;
   for (int i = 0; i < 256; i++) total += hist[i];
   double acc = 0;
   for (int i = 0; i < 256; i++) { acc += hist[i]; outp[i] = total > 0 ? acc / total : (double)i / 255; }
   return outp;
  }
  // 直方图匹配映射：每个目标灰度级取 CDF 刚够到它的最小参考灰度级，
  // 再在目标不同灰度级之间线性插值、范围外取平（裸 CDF 阶跃会被 17³
  // LUT 三线性插值抹平，探针证实：固色 100→200 直接烤出来是 52）。
  public static byte[][] HistogramMatchMaps(uint[][] refHist, uint[][] tgtHist) {
   var maps = new byte[][] { new byte[256], new byte[256], new byte[256] };
   for (int c = 0; c < 3; c++) {
    var rc = Cdf(refHist[c]);
    var tc = Cdf(tgtHist[c]);
    var levels = new List<int>();
    var matched = new List<int>();
    for (int v = 0; v < 256; v++) {
     if (tgtHist[c][v] == 0) continue;
     int r = 0;
     while (r < 255 && rc[r] < tc[v]) r++;
     levels.Add(v); matched.Add(r);
    }
    if (levels.Count == 0) { for (int v = 0; v < 256; v++) maps[c][v] = (byte)v; continue; }
    for (int v = 0; v < 256; v++) {
     if (v <= levels[0]) { maps[c][v] = (byte)matched[0]; continue; }
     if (v >= levels[levels.Count - 1]) { maps[c][v] = (byte)matched[matched.Count - 1]; continue; }
     int k = 0;
     while (k < levels.Count - 2 && levels[k + 1] < v) k++;
     int v0 = levels[k], v1 = levels[k + 1], m0 = matched[k], m1 = matched[k + 1];
     maps[c][v] = (byte)(v1 == v0 ? m0 : Math.Round(m0 + (double)(m1 - m0) * (v - v0) / (v1 - v0)));
    }
   }
   return maps;
  }
  public static double[] BuildMatchGrid(byte[] refPixels, byte[] tgtPixels, double strength, int size = 17) {
   if (strength < 0 || strength > 1) throw new Exception("镜头匹配强度超出 0–1：" + Media.N(strength) + "。");
   var maps = HistogramMatchMaps(ChannelHistograms(refPixels), ChannelHistograms(tgtPixels));
   var data = new double[size * size * size * 3];
   int i = 0;
   for (int bi = 0; bi < size; bi++) for (int gi = 0; gi < size; gi++) for (int ri = 0; ri < size; ri++) {
    double r0 = (double)ri / (size - 1), g0 = (double)gi / (size - 1), b0 = (double)bi / (size - 1);
    double rm = maps[0][(int)Math.Round(r0 * 255)] / 255.0, gm = maps[1][(int)Math.Round(g0 * 255)] / 255.0, bm = maps[2][(int)Math.Round(b0 * 255)] / 255.0;
    data[i++] = r0 + (rm - r0) * strength;
    data[i++] = g0 + (gm - g0) * strength;
    data[i++] = b0 + (bm - b0) * strength;
   }
   return data;
  }
  public static double[] BuildMatchGridFromFiles(string refFile, string tgtFile, double tgtTime, double strength, CancellationToken token) {
   var refPx = DecodeFrameRgb24(refFile, 0, 160, 90, token);
   var tgtPx = DecodeFrameRgb24(tgtFile, tgtTime, 160, 90, token);
   return BuildMatchGrid(refPx, tgtPx, strength);
  }
  public static string MatchLutPath(string refFile, string tgtFile, double tgtTime, double strength, CancellationToken token) {
   string key = refFile + "|" + tgtFile + "|" + Media.N(tgtTime) + "|" + Media.N(strength) + "|" + File.GetLastWriteTimeUtc(refFile).Ticks + "|" + File.GetLastWriteTimeUtc(tgtFile).Ticks;
   string hash;
   using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(key))).Replace("-", "").ToLowerInvariant().Substring(0, 16);
   string path = Path.Combine(Path.GetTempPath(), "catcut-w8-match-" + hash + ".cube");
   if (!File.Exists(path)) {
    var grid = BuildMatchGridFromFiles(refFile, tgtFile, tgtTime, strength, token);
    File.WriteAllText(path, LutCube.GridToText(grid, 17, "CatCut colour match"), new UTF8Encoding(false));
   }
   return path;
  }
 }

 // ---- 4. 跟踪窗口（p3g.ts TrackedWindow/buildTrackedWindowMaskBuffer）----
 public class ColourTrackPoint { public double Time; public double X; public double Y; public bool Lost; }
 public class TrackedWindow {
  public string Shape = "ellipse"; public double W = 0.3; public double H = 0.3;
  public ColorGrade Adjust = new ColorGrade();
  public List<ColourTrackPoint> Track = new List<ColourTrackPoint>();
  public double SampleFps = 5;
 }
 static class TrackedWindowOps {
  public static void Validate(TrackedWindow tw) {
   if (tw == null) return;
   if (tw.Shape != "rect" && tw.Shape != "ellipse" && tw.Shape != "circle") throw new Exception("跟踪窗口形状无效：" + tw.Shape + "（rect/ellipse/circle）。");
   if (!EditDocument.Finite(tw.W) || !EditDocument.Finite(tw.H) || tw.W <= 0 || tw.W > 1 || tw.H <= 0 || tw.H > 1) throw new Exception("跟踪窗口尺寸超出 (0, 1]。");
   GradeNodeGraphOps.CheckAdjust(tw.Adjust, "跟踪窗口");
   if (tw.Track == null || tw.Track.Count == 0) throw new Exception("跟踪窗口没有跟踪点（至少打一个点）。");
   if (!tw.Track.Any(p => !p.Lost)) throw new Exception("跟踪窗口的跟踪点全丢了（至少留一个定位点）。");
   foreach (var p in tw.Track)
    if (!EditDocument.Finite(p.Time) || p.Time < 0 || !EditDocument.Finite(p.X) || !EditDocument.Finite(p.Y) || p.X < 0 || p.X > 1 || p.Y < 0 || p.Y > 1)
     throw new Exception("跟踪窗口的跟踪点超出范围（时间 ≥0、位置 0–1）。");
   if (!EditDocument.Finite(tw.SampleFps) || tw.SampleFps < 1 || tw.SampleFps > 30) throw new Exception("跟踪窗口采样帧率超出 1–30fps。");
  }
  // trackCenterAt 的 C# 版：已知点之间线性插值；丢帧点停在上一个已知
  // 位置，不编造；时间在首尾之外取端点。
  public static ColourTrackPoint CenterAt(List<ColourTrackPoint> track, double t) {
   var known = track.Where(p => !p.Lost).OrderBy(p => p.Time).ToList();
   if (known.Count == 0) return null;
   if (t <= known[0].Time) return known[0];
   var last = known[known.Count - 1];
   if (t >= last.Time) return last;
   for (int i = 0; i + 1 < known.Count; i++) {
    var a = known[i]; var b = known[i + 1];
    if (t >= a.Time && t <= b.Time) {
     double k = b.Time == a.Time ? 0 : (t - a.Time) / (b.Time - a.Time);
     return new ColourTrackPoint { Time = t, X = a.X + (b.X - a.X) * k, Y = a.Y + (b.Y - a.Y) * k };
    }
   }
   return last;
  }
  // 灰度遮罩视频缓冲：白窗口在黑底上，中心跟轨迹走（与 p3g.ts 一致，
  // 只是 C# 侧遮罩按 320×180 烘，图里再放大到导出尺寸，省内存）。
  public static byte[] BuildMaskBuffer(TrackedWindow tw, int width, int height, double duration) {
   double sampleFps = tw.SampleFps;
   int nF = Math.Max(1, (int)Math.Ceiling(duration * sampleFps));
   var buf = new byte[width * height * nF];
   for (int f = 0; f < nF; f++) {
    double t = f / sampleFps;
    var c = CenterAt(tw.Track, t) ?? new ColourTrackPoint { X = 0.5, Y = 0.5 };
    double cx = c.X * width, cy = c.Y * height;
    double hw = tw.W * width / 2, hh = tw.H * height / 2;
    for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
     bool inside;
     if (tw.Shape == "rect") inside = Math.Abs(x + 0.5 - cx) <= hw && Math.Abs(y + 0.5 - cy) <= hh;
     else {
      double rx = hw, ry = tw.Shape == "circle" ? hw : hh;
      double dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      inside = dx * dx + dy * dy <= 1;
     }
     buf[f * width * height + y * width + x] = (byte)(inside ? 255 : 0);
    }
   }
   return buf;
  }
  public static string EncodeMaskVideo(byte[] buf, int width, int height, double fps, string outPath, CancellationToken token) {
   string raw = outPath + ".raw";
   File.WriteAllBytes(raw, buf);
   try {
    StudioMedia.Run("-v error -f rawvideo -pix_fmt gray -s " + width + "x" + height + " -r " + Media.N(fps) + " -i " + Media.Q(raw) + " -c:v libx264 -pix_fmt yuv420p -y " + Media.Q(outPath), token);
   } finally { try { if (File.Exists(raw)) File.Delete(raw); } catch { } }
   return outPath;
  }
 }

 // ---- 5. LUT 库（p3g.ts LutLibraryEntry/filterLutLibrary/toggleLutFavorite/
 // generateLutThumbnail）----
 public class LutLibraryEntry {
  public string Id = ""; public string Name = ""; public string Category = "";
  public string File = ""; public bool Favorite; public List<string> Tags = new List<string>();
 }
 static class LutLibrary {
  public static readonly string[] Categories = new[] { "film", "teal-orange", "bw", "log", "其他" };
  public static string Dir(string dir = null) {
   if (!string.IsNullOrEmpty(dir)) return dir;
   return Path.Combine(AppIdentity.AppDataDir, "lut-library");
  }
  public static string StorePath(string dir = null) { return Path.Combine(Dir(dir), "library.json"); }
  public static List<LutLibraryEntry> Load(string dir = null) {
   string path = StorePath(dir);
   if (!File.Exists(path)) return new List<LutLibraryEntry>();
   try {
    var lib = EditDocument.Serializer().Deserialize<List<LutLibraryEntry>>(File.ReadAllText(path, new UTF8Encoding(false)));
    return lib ?? new List<LutLibraryEntry>();
   } catch { throw new Exception("LUT 库文件损坏（不是有效 JSON）：" + path + "。"); }
  }
  public static void Save(List<LutLibraryEntry> lib, string dir = null) {
   string d = Dir(dir);
   Directory.CreateDirectory(d);
   File.WriteAllText(StorePath(dir), EditDocument.Serializer().Serialize(lib ?? new List<LutLibraryEntry>()), new UTF8Encoding(false));
  }
  public static void ValidateEntry(LutLibraryEntry e) {
   if (e == null) throw new Exception("LUT 库条目是空的。");
   if (string.IsNullOrWhiteSpace(e.Id)) throw new Exception("LUT 库条目缺 id。");
   if (string.IsNullOrWhiteSpace(e.Name)) throw new Exception("LUT 库条目 " + e.Id + " 缺名字。");
   if (string.IsNullOrWhiteSpace(e.Category)) throw new Exception("LUT 库条目 " + e.Id + " 缺分类。");
   if (string.IsNullOrWhiteSpace(e.File)) throw new Exception("LUT 库条目 " + e.Id + " 缺文件。");
   if (!File.Exists(e.File)) throw new Exception("LUT 库条目 " + e.Id + " 的文件缺失：" + e.File + "。");
   LutCube.ParseFile(e.File);
  }
  public static List<LutLibraryEntry> Add(List<LutLibraryEntry> lib, LutLibraryEntry e) {
   ValidateEntry(e);
   if (lib.Any(x => x.Id == e.Id)) throw new Exception("LUT 库里已有同名条目：" + e.Id + "。");
   var next = lib.ToList();
   next.Add(e);
   return next;
  }
  public static List<LutLibraryEntry> Remove(List<LutLibraryEntry> lib, string id) {
   if (!lib.Any(e => e.Id == id)) throw new Exception("LUT 库里没有条目：" + id + "。");
   return lib.Where(e => e.Id != id).ToList();
  }
  public static List<LutLibraryEntry> ToggleFavorite(List<LutLibraryEntry> lib, string id) {
   if (!lib.Any(e => e.Id == id)) throw new Exception("LUT 库里没有条目：" + id + "。");
   return lib.Select(e => e.Id == id ? new LutLibraryEntry { Id = e.Id, Name = e.Name, Category = e.Category, File = e.File, Favorite = !e.Favorite, Tags = e.Tags } : e).ToList();
  }
  public static List<LutLibraryEntry> Filter(List<LutLibraryEntry> lib, string category, bool? favorite, string search) {
   return lib.Where(e => {
    if (!string.IsNullOrEmpty(category) && e.Category != category) return false;
    if (favorite.HasValue && e.Favorite != favorite.Value) return false;
    if (!string.IsNullOrEmpty(search)) {
     string q = search.ToLowerInvariant();
     string hay = (e.Name + " " + e.Category + " " + string.Join(" ", (e.Tags ?? new List<string>()).ToArray())).ToLowerInvariant();
     if (!hay.Contains(q)) return false;
    }
    return true;
   }).ToList();
  }
  public static List<string> LibraryCategories(List<LutLibraryEntry> lib) {
   return lib.Select(e => e.Category).Distinct().OrderBy(c => c).ToList();
  }
  // 悬停预览缩略图：lut3d 直接渲染一帧再缩小，与直接烤 LUT 的帧一致。
  public static string Thumbnail(string lutPath, string frameFile, double time, string outDir) {
   LutCube.ParseFile(lutPath);
   if (string.IsNullOrEmpty(frameFile) || !File.Exists(frameFile)) throw new Exception("生成 LUT 缩略图没有可用的帧来源。");
   Directory.CreateDirectory(outDir);
   string hash;
   using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(lutPath + "|" + frameFile + "|" + Media.N(time)))).Replace("-", "").ToLowerInvariant().Substring(0, 16);
   string png = Path.Combine(outDir, "lut-thumb-" + hash + ".png");
   if (!File.Exists(png)) {
    StudioMedia.Run("-v error -ss " + Media.N(Math.Max(0, time)) + " -i " + Media.Q(frameFile) + " -vf " + Media.Q(ColorLut.Lut3dFilter(lutPath) + ",scale=160:90") + " -frames:v 1 -y " + Media.Q(png), CancellationToken.None);
    if (!File.Exists(png)) throw new Exception("LUT 缩略图没有生成。");
   }
   return png;
  }
 }

 // ---- 6. 调色前后对比 + 参考静帧库（p3g.ts renderComparisonFrame/
 // saveReferenceStill/loadReferenceStill/listReferenceStills）----
 public class ReferenceStill {
  public string File = ""; public double Time; public string Label = "";
  public string Source = ""; public int Width; public int Height; public string Note = "";
 }
 static class CompareOps {
  // PNG 没有 duration，StudioMedia.Import 解析不了；这里只探宽高。
  public static int[] ProbeSize(string file) {
   using (var p = Media.Start("ffprobe", "-v error -select_streams v:0 -show_entries stream=width,height -of default=noprint_wrappers=1 " + Media.Q(file), true)) {
    var err = p.StandardError.ReadToEndAsync();
    string text = p.StandardOutput.ReadToEnd();
    p.WaitForExit();
    if (p.ExitCode != 0) throw new Exception("ffprobe 失败：" + err.Result);
    int w = -1, h = -1;
    foreach (string raw in text.Split('\n')) {
     string line = raw.Trim();
     if (line.StartsWith("width=", StringComparison.Ordinal)) int.TryParse(line.Substring(6), out w);
     if (line.StartsWith("height=", StringComparison.Ordinal)) int.TryParse(line.Substring(7), out h);
    }
    if (w < 1 || h < 1) throw new Exception("探不到图片尺寸：" + file + "。");
    return new[] { w, h };
   }
  }
  public static void RenderComparisonFrame(string source, string lutPath, string outPng, string mode, double wipe, double ss, int width, int height, CancellationToken token) {
   if (mode != "split" && mode != "wipe") throw new Exception("对比模式无效：" + mode + "（split/wipe）。");
   if (wipe <= 0 || wipe >= 1) throw new Exception("擦除位置超出 (0, 1)：" + Media.N(wipe) + "。");
   if (string.IsNullOrEmpty(source) || !File.Exists(source)) throw new Exception("对比帧的源文件缺失：" + source + "。");
   if (!string.IsNullOrEmpty(lutPath)) LutCube.ParseFile(lutPath);
   int leftW = Math.Max(2, (int)Math.Round(width * wipe));
   int rightW = Math.Max(2, width - leftW);
   string bgFilter = string.IsNullOrEmpty(lutPath) ? "null" : ColorLut.Lut3dFilter(lutPath);
   string fc = "[0:v]split[a][b];[b]" + bgFilter + "[bg];[a]crop=" + leftW + ":" + height + ":0:0[l];[bg]crop=" + rightW + ":" + height + ":" + leftW + ":0[r];[l][r]hstack,format=yuv420p[vout]";
   StudioMedia.Run("-v error -ss " + Media.N(Math.Max(0, ss)) + " -i " + Media.Q(source) + " -filter_complex " + Media.Q(fc) + " -map [vout] -frames:v 1 -y " + Media.Q(outPng), token);
   if (!File.Exists(outPng)) throw new Exception("对比帧没有生成。");
  }
  public static ReferenceStill SaveReferenceStill(string source, double time, string outPng, string label, string note, CancellationToken token) {
   if (string.IsNullOrEmpty(source) || !File.Exists(source)) throw new Exception("存参考帧的源文件缺失：" + source + "。");
   if (!EditDocument.Finite(time) || time < 0) throw new Exception("参考帧时间无效：" + Media.N(time) + "。");
   if (string.IsNullOrWhiteSpace(label)) throw new Exception("参考帧要有个名字。");
   StudioMedia.Run("-v error -ss " + Media.N(time) + " -i " + Media.Q(source) + " -frames:v 1 -y " + Media.Q(outPng), token);
   var size = ProbeSize(outPng);
   var still = new ReferenceStill { File = Path.GetFullPath(outPng), Time = time, Label = label, Source = Path.GetFullPath(source), Width = size[0], Height = size[1], Note = note ?? "" };
   File.WriteAllText(outPng + ".json", EditDocument.Serializer().Serialize(still), new UTF8Encoding(false));
   return still;
  }
  public static ReferenceStill LoadReferenceStill(string pngPath) {
   if (string.IsNullOrEmpty(pngPath) || !File.Exists(pngPath)) throw new Exception("参考帧图片缺失：" + pngPath + "。");
   string sidecar = pngPath + ".json";
   if (!File.Exists(sidecar)) throw new Exception("参考帧没有 sidecar（" + sidecar + "），拒绝加载。");
   ReferenceStill still;
   try { still = EditDocument.Serializer().Deserialize<ReferenceStill>(File.ReadAllText(sidecar, new UTF8Encoding(false))); }
   catch { throw new Exception("参考帧 sidecar 损坏，拒绝加载：" + sidecar + "。"); }
   if (still == null) throw new Exception("参考帧 sidecar 是空的：" + sidecar + "。");
   var size = ProbeSize(pngPath);
   if (size[0] != still.Width || size[1] != still.Height) throw new Exception("参考帧图片是 " + size[0] + "x" + size[1] + "，sidecar 写的是 " + still.Width + "x" + still.Height + "（被改过），拒绝加载。");
   if (still.File != Path.GetFullPath(pngPath)) throw new Exception("参考帧 sidecar 里的路径与图片不符，拒绝加载。");
   return still;
  }
  public static List<string> ListReferenceStills(string dir) {
   if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return new List<string>();
   return Directory.GetFiles(dir, "*.png").Where(f => File.Exists(f + ".json")).OrderBy(f => f).ToList();
  }
  public static string StillsDir(string dir = null) {
   if (!string.IsNullOrEmpty(dir)) return dir;
   return Path.Combine(AppIdentity.AppDataDir, "reference-stills");
  }
 }

 // ---- 7. 色度键取色器（filtergraph.ts applyChromaStage/validateChromaKey）----
 public class ChromaKey {
  public string Color = "0x00ff00"; public double Similarity = 0.1; public double Blend;
  public bool Despill = true; public string BackgroundColor = "0x000000"; public string BackgroundSource = "";
 }
 static class ChromaKeyOps {
  public static void Validate(ChromaKey key) {
   if (key == null) return;
   ParseColor(key.Color, "键色");
   if (!EditDocument.Finite(key.Similarity) || key.Similarity <= 0 || key.Similarity > 1) throw new Exception("色度键容差超出 (0, 1]：" + Media.N(key.Similarity) + "（默认 0.1，0.01 实测完全不抠）。");
   if (!EditDocument.Finite(key.Blend) || key.Blend < 0 || key.Blend > 1) throw new Exception("色度键羽化超出 0–1。");
   if (!string.IsNullOrEmpty(key.BackgroundColor) && !string.IsNullOrEmpty(key.BackgroundSource)) throw new Exception("色度键背景只能二选一：纯色或文件，不能同时给。");
   if (!string.IsNullOrEmpty(key.BackgroundColor)) ParseColor(key.BackgroundColor, "背景色");
   if (!string.IsNullOrEmpty(key.BackgroundSource) && !File.Exists(key.BackgroundSource)) throw new Exception("色度键背景文件缺失：" + key.BackgroundSource + "。");
  }
  // 键色写法：0xRRGGBB / #RRGGBB / RRGGBB / green / blue / red（ffmpeg 原生认）。
  public static int[] ParseColor(string color, string what) {
   if (string.IsNullOrWhiteSpace(color)) throw new Exception(what + "是空的。");
   string c = color.Trim().ToLowerInvariant();
   if (c == "green") return new[] { 0, 128, 0 };
   if (c == "blue") return new[] { 0, 0, 255 };
   if (c == "red") return new[] { 255, 0, 0 };
   if (c == "black") return new[] { 0, 0, 0 };
   if (c == "white") return new[] { 255, 255, 255 };
   string hex = c.StartsWith("0x") ? c.Substring(2) : c.StartsWith("#") ? c.Substring(1) : c;
   if (hex.Length != 6) throw new Exception(what + "格式不对：" + color + "（用 0xRRGGBB）。");
   try {
    int v = int.Parse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
    return new[] { (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff };
   } catch { throw new Exception(what + "格式不对：" + color + "（用 0xRRGGBB）。"); }
  }
  public static string ToHex(int r, int g, int b) {
   return "0x" + r.ToString("X2") + g.ToString("X2") + b.ToString("X2");
  }
  // despillType 的 C# 版：明确写 blue、或蓝通道占优，才是 blue，其余 green。
  public static string DespillType(string color) {
   string c = (color ?? "").Trim().ToLowerInvariant();
   if (c == "blue" || c == "0x0000ff" || c == "#0000ff") return "blue";
   string hex = c.StartsWith("0x") ? c.Substring(2) : c.StartsWith("#") ? c.Substring(1) : c;
   if (hex.Length == 6) {
    int v;
    if (int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v)) {
     int r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
     if (b > r && b > g) return "blue";
    }
   }
   return "green";
  }
  public static string FilterFragment(ChromaKey key) {
   Validate(key);
   string f = "format=yuva420p,chromakey=color=" + key.Color + ":similarity=" + Media.N(key.Similarity) + ":blend=" + Media.N(key.Blend);
   if (key.Despill) f += ",despill=type=" + DespillType(key.Color);
   return f;
  }
  // 在帧上按相对坐标取色（监视器点击取色的坐标版：x/y 0–1，取该点像素）。
  public static string SamplePixel(string file, double time, double xFrac, double yFrac, CancellationToken token) {
   if (xFrac < 0 || xFrac > 1 || yFrac < 0 || yFrac > 1) throw new Exception("取色点超出画面（x/y 0–1）。");
   var rgb = ColourMatchOps.DecodeFrameRgb24(file, time, 320, 180, token);
   int x = Math.Min(319, Math.Max(0, (int)Math.Round(xFrac * 320)));
   int y = Math.Min(179, Math.Max(0, (int)Math.Round(yFrac * 180)));
   int i = (y * 320 + x) * 3;
   return ToHex(rgb[i], rgb[i + 1], rgb[i + 2]);
  }
 }

 // ---- 8. 色彩示波器（scopes.ts analyzeRgbFrame：数字是源头，图只是视图）----
 public class ChannelStats { public double Mean; public int Min; public int Max; public int PeakBin; public int P99; }
 public class ScopeResult {
  public string File = ""; public double Time; public int Width; public int Height;
  public double LumaMean; public int LumaMin; public int LumaMax; public int[] LumaHistogram = new int[256];
  public ChannelStats R = new ChannelStats(); public ChannelStats G = new ChannelStats(); public ChannelStats B = new ChannelStats();
  public double SaturationMean; public double? DominantHue; public int[] HueHistogram = new int[12];
  public double HighlightClip; public double ShadowClip;
 }
 static class ScopeAnalysis {
  static ChannelStats Stats(int[] hist, int n) {
   double sum = 0; int min = 255, max = 0, peakBin = 0, peakCount = -1;
   for (int v = 0; v < 256; v++) {
    int c = hist[v];
    sum += v * c;
    if (c > 0) { if (v < min) min = v; if (v > max) max = v; }
    if (c > peakCount) { peakCount = c; peakBin = v; }
   }
   int cum = 0, p99 = 255;
   for (int v = 0; v < 256; v++) { cum += hist[v]; if (cum >= 0.99 * n) { p99 = v; break; } }
   return new ChannelStats { Mean = sum / n, Min = min, Max = max, PeakBin = peakBin, P99 = p99 };
  }
  // scopes.ts 的 analyzeRgbFrame 逐行照抄：Rec.709 亮度、圆均值主色相
  // （灰帧为 null）、高光/阴影裁切（三通道都 >250 / 都 <5 才算）。
  public static ScopeResult AnalyzeRgbFrame(byte[] buf, int width, int height, string file, double time) {
   int n = width * height;
   if (buf.Length < n * 3) throw new Exception("示波器帧缓冲不够（" + buf.Length + " 字节，画面要 " + (n * 3) + " 字节）。");
   var histR = new int[256]; var histG = new int[256]; var histB = new int[256]; var histY = new int[256]; var hueHist = new int[12];
   double lumaSum = 0, satSum = 0, hx = 0, hy = 0;
   int lumaMin = 255, lumaMax = 0, huePixels = 0, highlight = 0, shadow = 0;
   for (int i = 0; i < n; i++) {
    int r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];
    histR[r]++; histG[g]++; histB[b]++;
    double y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    int yi = (int)Math.Round(y);
    histY[yi]++;
    lumaSum += y;
    if (yi < lumaMin) lumaMin = yi;
    if (yi > lumaMax) lumaMax = yi;
    int mx = Math.Max(r, Math.Max(g, b)), mn = Math.Min(r, Math.Min(g, b));
    double sat = mx == 0 ? 0 : (double)(mx - mn) / mx;
    satSum += sat;
    if (sat > 0.05 && mx > 13) {
     double d = mx - mn, h;
     if (mx == r) h = ((g - b) / d) % 6;
     else if (mx == g) h = (b - r) / d + 2;
     else h = (r - g) / d + 4;
     h *= 60;
     if (h < 0) h += 360;
     hx += Math.Cos(h * Math.PI / 180); hy += Math.Sin(h * Math.PI / 180);
     huePixels++;
     hueHist[Math.Min(11, (int)Math.Floor(h / 30))]++;
    }
    if (mn > 250) highlight++;
    if (mx < 5) shadow++;
   }
   var res = new ScopeResult {
    File = file, Time = time, Width = width, Height = height,
    LumaMean = lumaSum / n, LumaMin = lumaMin, LumaMax = lumaMax, LumaHistogram = histY,
    R = Stats(histR, n), G = Stats(histG, n), B = Stats(histB, n),
    SaturationMean = satSum / n, HueHistogram = hueHist,
    HighlightClip = (double)highlight / n, ShadowClip = (double)shadow / n
   };
   if (res.SaturationMean >= 0.02 && huePixels > 0) {
    double hue = Math.Atan2(hy, hx) * 180 / Math.PI;
    res.DominantHue = hue < 0 ? hue + 360 : hue;
   }
   return res;
  }
  public static ScopeResult SampleFrame(string file, double time, int width, int height, CancellationToken token) {
   var rgb = ColourMatchOps.DecodeFrameRgb24(file, time, width, height, token);
   return AnalyzeRgbFrame(rgb, width, height, file, time);
  }
  // 自绘示波器图（320×180 PNG）：波形按列取亮度 min–max 画竖线；
  // 矢量按像素色相/饱和度打点，带 25/50/75/100% 饱和度圆环。
  public static byte[] DrawScopePng(byte[] rgb, int width, int height, string kind, int outW, int outH) {
   using (var bmp = new Bitmap(outW, outH, PixelFormat.Format32bppArgb)) {
    using (var g = Graphics.FromImage(bmp)) {
     g.Clear(Color.FromArgb(255, 16, 18, 20));
     if (kind == "waveform") {
      using (var gridPen = new Pen(Color.FromArgb(255, 60, 64, 68))) {
       for (int k = 1; k < 4; k++) { int y = outH * k / 4; g.DrawLine(gridPen, 0, y, outW, y); }
      }
      for (int x = 0; x < outW; x++) {
       int sx0 = x * width / outW, sx1 = Math.Max(sx0 + 1, (x + 1) * width / outW);
       double mn = 255, mx = 0;
       for (int sx = sx0; sx < sx1 && sx < width; sx++) for (int y = 0; y < height; y += 2) {
        int i = (y * width + sx) * 3;
        double l = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
        if (l < mn) mn = l; if (l > mx) mx = l;
       }
       if (mx < mn) continue;
       int y0 = outH - 1 - (int)Math.Round(mx / 255 * (outH - 1));
       int y1 = outH - 1 - (int)Math.Round(mn / 255 * (outH - 1));
       using (var pen = new Pen(Color.FromArgb(255, 220, 220, 220))) g.DrawLine(pen, x, y0, x, Math.Max(y0, y1));
      }
     } else {
      double cx = outW / 2.0, cy = outH / 2.0, r = Math.Min(outW, outH) / 2.0 - 4;
      using (var gridPen = new Pen(Color.FromArgb(255, 60, 64, 68))) {
       foreach (double f in new[] { 0.25, 0.5, 0.75, 1.0 }) g.DrawEllipse(gridPen, (float)(cx - r * f), (float)(cy - r * f), (float)(2 * r * f), (float)(2 * r * f));
       g.DrawLine(gridPen, (float)(cx - r), (float)cy, (float)(cx + r), (float)cy);
       g.DrawLine(gridPen, (float)cx, (float)(cy - r), (float)cx, (float)(cy + r));
      }
      int step = Math.Max(1, (width * height) / 20000);
      for (int i = 0; i < width * height; i += step) {
       int rr = rgb[i * 3], gg = rgb[i * 3 + 1], bb = rgb[i * 3 + 2];
       int mx = Math.Max(rr, Math.Max(gg, bb)), mn = Math.Min(rr, Math.Min(gg, bb));
       if (mx == 0) continue;
       double sat = (double)(mx - mn) / mx;
       if (sat < 0.02) continue;
       var hsl = ColorLut.RgbToHsl(rr / 255.0, gg / 255.0, bb / 255.0);
       double a = hsl[0] * Math.PI / 180;
       int px = (int)Math.Round(cx + Math.Cos(a) * sat * r);
       int py = (int)Math.Round(cy - Math.Sin(a) * sat * r);
       if (px < 0 || px >= outW || py < 0 || py >= outH) continue;
       bmp.SetPixel(px, py, Color.FromArgb(255, rr, gg, bb));
      }
     }
    }
    using (var ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); return ms.ToArray(); }
   }
  }
 }

 // ---- 调色链组装 + 校验（EditorCore/EditorApp 的接线点）----
 static class W8ColourFilters {
  public static bool NodeGraphActive(EditDocument doc) { return doc.GradeNodes != null && doc.GradeNodes.Nodes != null && doc.GradeNodes.Nodes.Count > 0; }
  public static bool MatchActive(EditDocument doc) { return doc.Match != null && !string.IsNullOrWhiteSpace(doc.Match.ReferenceFrame); }
  public static bool TrackedWindowActive(EditDocument doc) { return doc.TrackedWin != null; }
  public static bool ChromaActive(EditDocument doc) { return doc.Chroma != null; }
  public static bool ColourMgmtActive(EditDocument doc) {
   return (doc.InputSpace != null && doc.InputSpace != "rec709") || (doc.WorkingSpace != null && doc.WorkingSpace != "rec709") || (doc.OutputSpace != null && doc.OutputSpace != "rec709");
  }
  public static bool LutApplied(EditDocument doc) { return !string.IsNullOrEmpty(doc.AppliedLutPath); }
  public static bool AnyAdvanced(EditDocument doc) {
   return NodeGraphActive(doc) || MatchActive(doc) || TrackedWindowActive(doc) || ChromaActive(doc) || ColourMgmtActive(doc) || LutApplied(doc);
  }
  // 蒙版节点/跟踪窗口/色度键要走 filter_complex 解码器（-vf 链装不下
  // alphamerge/chromakey 合成）；其余高级调色只加 lut3d，走 -vf 链。
  public static bool NeedsComplexDecoder(EditDocument doc) {
   if (TrackedWindowActive(doc) || ChromaActive(doc)) return true;
   if (NodeGraphActive(doc)) foreach (var n in doc.GradeNodes.Nodes) if (n.Mask != null) return true;
   return false;
  }
  static string StripComma(string vf) { return string.IsNullOrEmpty(vf) ? "" : vf.StartsWith(",") ? vf.Substring(1) : vf; }
  // 完整调色链（以逗号开头，拼在 scale=... 之后，与 Grade.VideoFilter()
  // 的用法一致）。顺序：输入转换 → 镜头匹配 → 节点终烤/线性调色 →
  // LUT 库应用 → 输出转换；色度键只在预览 -vf 路以透明近似追加
  // （导出走 filter_complex 合成背景，见 W8ColourExport）。
  public static string Chain(EditDocument doc, bool includeChromaVf = false) {
   bool chroma = includeChromaVf && ChromaActive(doc);
   if (!AnyAdvanced(doc) && !chroma) return doc.Grade.VideoFilter();
   var segs = new List<string>();
   string input = string.IsNullOrEmpty(doc.InputSpace) ? "rec709" : doc.InputSpace;
   string working = string.IsNullOrEmpty(doc.WorkingSpace) ? "rec709" : doc.WorkingSpace;
   string output = string.IsNullOrEmpty(doc.OutputSpace) ? "rec709" : doc.OutputSpace;
   var conv = ColourMgmt.InputConversionFor(input, working);
   if (!string.IsNullOrEmpty(conv.Filter)) segs.Add(conv.Filter);
   string inputLut = conv.HasLut ? ColourMgmt.TransferLutPath(conv.LutFrom, conv.LutTo) : null;
   string matchLut = null;
   if (MatchActive(doc)) {
    double tgtTime = 0;
    foreach (var c in doc.Cuts) if (!c.Gap) { tgtTime = c.Start; break; }
    matchLut = ColourMatchOps.MatchLutPath(doc.Match.ReferenceFrame, doc.Source, tgtTime, doc.Match.Strength, CancellationToken.None);
   }
   string outputLut = working != output ? ColourMgmt.TransferLutPath(working, output) : null;
   string libLut = LutApplied(doc) ? doc.AppliedLutPath : null;
   if (NodeGraphActive(doc)) {
    var baked = GradeNodeGraphOps.Bake(doc.GradeNodes);
    segs.Add("format=rgb24");
    if (inputLut != null) segs.Add(ColorLut.Lut3dFilter(inputLut));
    if (matchLut != null) segs.Add(ColorLut.Lut3dFilter(matchLut));
    segs.Add(ColorLut.Lut3dFilter(GradeNodeGraphOps.CubePathForGrid(baked.Final, GradeNodeGraphOps.Key(doc.GradeNodes), "nodes")));
    if (libLut != null) segs.Add(ColorLut.Lut3dFilter(libLut));
    if (outputLut != null) segs.Add(ColorLut.Lut3dFilter(outputLut));
   } else {
    string vf = doc.Grade.VideoFilter();
    if (vf.Contains("format=rgb24")) {
     int at = vf.IndexOf("format=rgb24", StringComparison.Ordinal);
     string head = StripComma(vf.Substring(0, at));
     string tail = vf.Substring(at + "format=rgb24".Length);
     if (head.Length > 0) segs.Add(head);
     segs.Add("format=rgb24");
     if (inputLut != null) segs.Add(ColorLut.Lut3dFilter(inputLut));
     if (matchLut != null) segs.Add(ColorLut.Lut3dFilter(matchLut));
     if (tail.Length > 0) segs.Add(StripComma(tail));
     if (libLut != null) segs.Add(ColorLut.Lut3dFilter(libLut));
     if (outputLut != null) segs.Add(ColorLut.Lut3dFilter(outputLut));
    } else {
     if (vf.Length > 0) segs.Add(StripComma(vf));
     if (inputLut != null || matchLut != null || libLut != null || outputLut != null) {
      segs.Add("format=rgb24");
      if (inputLut != null) segs.Add(ColorLut.Lut3dFilter(inputLut));
      if (matchLut != null) segs.Add(ColorLut.Lut3dFilter(matchLut));
      if (libLut != null) segs.Add(ColorLut.Lut3dFilter(libLut));
      if (outputLut != null) segs.Add(ColorLut.Lut3dFilter(outputLut));
     }
    }
   }
   if (chroma) foreach (string f in ChromaKeyOps.FilterFragment(doc.Chroma).Split(',')) segs.Add(f);
   if (segs.Count == 0) return "";
   return "," + string.Join(",", segs.ToArray());
  }
  // 供 filter_complex 里用：去掉开头的逗号。
  public static string ChainForGraph(EditDocument doc) { return StripComma(Chain(doc, false)); }
  public static void Validate(EditDocument doc) {
   ColourMgmt.ValidateSpaces(doc.InputSpace, doc.WorkingSpace, doc.OutputSpace);
   if (NodeGraphActive(doc)) {
    GradeNodeGraphOps.Validate(doc.GradeNodes);
    if (!doc.Grade.IsIdentity()) throw new Exception("节点图与线性调色不能混用（p3g.ts 的规则）：开了节点图就以节点图为准，请先重置主调色。");
   }
   ColourMatchOps.Validate(doc.Match);
   TrackedWindowOps.Validate(doc.TrackedWin);
   if (LutApplied(doc)) LutCube.ParseFile(doc.AppliedLutPath);
   ChromaKeyOps.Validate(doc.Chroma);
   if (!string.IsNullOrEmpty(doc.CompareMode) && doc.CompareMode != "split" && doc.CompareMode != "wipe") throw new Exception("对比模式无效：" + doc.CompareMode + "。");
   if (!EditDocument.Finite(doc.CompareWipe) || doc.CompareWipe <= 0 || doc.CompareWipe >= 1) throw new Exception("对比擦除位置超出 (0, 1)。");
   // 美颜遮罩路径只走线性调色（W5Media.MaskedFilterComplex 里拼的是
   // GradeChain）：与 W8 高级调色同开时导出直接报错，不静默丢调色。
   if (doc.BeautyEnabled && (NodeGraphActive(doc) || MatchActive(doc) || TrackedWindowActive(doc) || ChromaActive(doc) || ColourMgmtActive(doc) || LutApplied(doc)))
    throw new Exception("美颜与高级调色（节点图/镜头匹配/跟踪窗口/色度键/色彩管理/LUT 库）不能同时开：美颜遮罩路径只走线性调色。请先关美颜，或关高级调色。");
  }
 }

 // ---- 导出用的 filter_complex 解码器（蒙版节点/跟踪窗口/色度键）----
 public class MaskedStagePrep { public string LutPath; public string MaskLabel; }
 public class StagePrep {
  public List<string> ExtraInputs = new List<string>();
  public List<MaskedStagePrep> MaskedStages = new List<MaskedStagePrep>();
  public string TrackedLutPath; public string TrackedMaskLabel;
  public string ChromaBgLabel; public int NextInput = 1;
  public string Graph = "";
 }
 static class W8ColourExport {
  // 烘好各蒙版阶段的 LUT + 蒙版文件（节点蒙版 PNG、跟踪窗口遮罩视频），
  // 登记额外输入（编号从 1 起，0 是主源）。mask 视频/图片不同步长：
  // 节点蒙版是静态 PNG（-loop 1），跟踪窗口是 5fps 视频。
  public static StagePrep Prepare(EditDocument doc, string workDir, int dw, int dh, double fps, CancellationToken token) {
   var prep = new StagePrep();
   if (W8ColourFilters.NodeGraphActive(doc)) {
    var baked = GradeNodeGraphOps.Bake(doc.GradeNodes);
    int k = 0;
    foreach (var stage in baked.Masked) {
     string lut = Path.Combine(workDir, "node-" + stage.Id + ".cube");
     File.WriteAllText(lut, LutCube.GridToText(stage.Grid, 17, "CatCut node " + stage.Id), new UTF8Encoding(false));
     string png = Path.Combine(workDir, "node-" + stage.Id + "-mask.png");
     File.WriteAllBytes(png, GradeNodeMaskOps.RenderPng(stage.Mask, dw, dh));
     prep.ExtraInputs.Add("-loop 1 -t " + Media.N(doc.Length) + " -i " + Media.Q(png));
     prep.MaskedStages.Add(new MaskedStagePrep { LutPath = lut, MaskLabel = "m" + k });
     k++;
     prep.NextInput++;
    }
   }
   if (W8ColourFilters.TrackedWindowActive(doc)) {
    var tw = doc.TrackedWin;
    var grid = GradeNodeGraphOps.ApplyAdjustToGrid(GradeNodeGraphOps.IdentityGrid(), tw.Adjust ?? new ColorGrade());
    string lut = Path.Combine(workDir, "trackwin.cube");
    File.WriteAllText(lut, LutCube.GridToText(grid, 17, "CatCut tracked window"), new UTF8Encoding(false));
    prep.TrackedLutPath = lut;
    var buf = TrackedWindowOps.BuildMaskBuffer(tw, 320, 180, doc.Length);
    string maskVideo = Path.Combine(workDir, "trackwin-mask.mp4");
    TrackedWindowOps.EncodeMaskVideo(buf, 320, 180, tw.SampleFps, maskVideo, token);
    prep.ExtraInputs.Add("-i " + Media.Q(maskVideo));
    prep.TrackedMaskLabel = "mtw";
    prep.NextInput++;
   }
   if (W8ColourFilters.ChromaActive(doc)) {
    var key = doc.Chroma;
    if (!string.IsNullOrEmpty(key.BackgroundSource)) {
     string ext = Path.GetExtension(key.BackgroundSource).ToLowerInvariant();
     bool image = ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".bmp";
     prep.ExtraInputs.Add(image ? "-loop 1 -t " + Media.N(doc.Length) + " -i " + Media.Q(key.BackgroundSource) : "-stream_loop -1 -i " + Media.Q(key.BackgroundSource));
     prep.ChromaBgLabel = "cbg";
     prep.NextInput++;
    }
   }
   return prep;
  }
  // 图结构（标签逐个推进，[b0] 是调色后的底图）：
  // [0:v]<base>format=yuv420p[b0]；每蒙版阶段：split → 分支 lut3d →
  // yuva420p → alphamerge（灰度遮罩）→ overlay 回底图（W5 美颜同款）；
  // 色度键最后：yuva420p + chromakey + despill → overlay 到背景上。
  public static string BuildGraph(EditDocument doc, StagePrep prep, int dw, int dh, double fps, string basePrefix, string effectVf) {
   var sb = new StringBuilder();
   string chain = W8ColourFilters.ChainForGraph(doc);
   string eff = string.IsNullOrEmpty(effectVf) ? "" : (effectVf.StartsWith(",") ? effectVf : "," + effectVf);
   sb.Append("[0:v]").Append(basePrefix).Append("scale=").Append(dw).Append(":").Append(dh);
   if (chain.Length > 0) sb.Append(",").Append(chain);
   if (eff.Length > 0) sb.Append(eff);
   sb.Append(",format=yuv420p[b0];");
   int inputIdx = 1;
   int stageNo = 0;
   foreach (var stage in prep.MaskedStages) {
    sb.Append("[").Append(inputIdx).Append(":v]fps=fps=").Append(Media.N(fps)).Append(",scale=").Append(dw).Append(":").Append(dh).Append(",format=gray[").Append(stage.MaskLabel).Append("];");
    inputIdx++;
    string cur = "b" + stageNo, next = "b" + (stageNo + 1);
    sb.Append("[").Append(cur).Append("]split[bs").Append(stageNo).Append("][bg").Append(stageNo).Append("];");
    sb.Append("[bg").Append(stageNo).Append("]format=rgb24,").Append(ColorLut.Lut3dFilter(stage.LutPath)).Append(",format=yuva420p[bc").Append(stageNo).Append("];");
    sb.Append("[bc").Append(stageNo).Append("][").Append(stage.MaskLabel).Append("]alphamerge[bm").Append(stageNo).Append("];");
    sb.Append("[bs").Append(stageNo).Append("][bm").Append(stageNo).Append("]overlay=0:0,format=yuv420p[").Append(next).Append("];");
    stageNo++;
   }
   string curLabel = "b" + stageNo;
   if (prep.TrackedLutPath != null) {
    sb.Append("[").Append(inputIdx).Append(":v]fps=fps=").Append(Media.N(fps)).Append(",scale=").Append(dw).Append(":").Append(dh).Append(",format=gray,gblur=sigma=1.5[").Append(prep.TrackedMaskLabel).Append("];");
    inputIdx++;
    string next = "b" + (stageNo + 1);
    sb.Append("[").Append(curLabel).Append("]split[bs").Append(stageNo).Append("][bg").Append(stageNo).Append("];");
    sb.Append("[bg").Append(stageNo).Append("]format=rgb24,").Append(ColorLut.Lut3dFilter(prep.TrackedLutPath)).Append(",format=yuva420p[bc").Append(stageNo).Append("];");
    sb.Append("[bc").Append(stageNo).Append("][").Append(prep.TrackedMaskLabel).Append("]alphamerge[bm").Append(stageNo).Append("];");
    sb.Append("[bs").Append(stageNo).Append("][bm").Append(stageNo).Append("]overlay=0:0,format=yuv420p[").Append(next).Append("];");
    curLabel = next;
    stageNo++;
   }
   if (W8ColourFilters.ChromaActive(doc)) {
    var key = doc.Chroma;
    bool bgFromFile = prep.ChromaBgLabel != null;
    string bgLabel = bgFromFile ? prep.ChromaBgLabel : "cbg";
    if (bgFromFile) {
     sb.Append("[").Append(inputIdx).Append(":v]fps=fps=").Append(Media.N(fps)).Append(",scale=").Append(dw).Append(":").Append(dh).Append(",format=yuv420p[").Append(bgLabel).Append("];");
     inputIdx++;
    } else {
     string bgColor = string.IsNullOrEmpty(key.BackgroundColor) ? "0x000000" : key.BackgroundColor;
     sb.Append("color=c=").Append(bgColor).Append(":s=").Append(dw).Append("x").Append(dh).Append(":r=").Append(Media.N(fps)).Append(":d=").Append(Media.N(doc.Length)).Append("[").Append(bgLabel).Append("];");
    }
    sb.Append("[").Append(curLabel).Append("]").Append(ChromaKeyOps.FilterFragment(key)).Append("[ckfg];");
    sb.Append("[").Append(bgLabel).Append("][ckfg]overlay=0:0,format=yuv420p[out];");
   } else {
    sb.Append("[").Append(curLabel).Append("]format=yuv420p[out];");
   }
   return sb.ToString();
  }
  // 导出解码器的完整 ffmpeg 参数（-map [out]，bgra 原始帧进 GDI+ 渲染）。
  // frames>0 时只解 N 帧（测试用）。
  public static string DecoderArgs(EditDocument doc, StagePrep prep, string media, string selection, int dw, int dh, double fps, string basePrefix, string effectVf, int frames = 0) {
   prep.Graph = BuildGraph(doc, prep, dw, dh, fps, basePrefix, effectVf);
   var sb = new StringBuilder();
   sb.Append("-v error ").Append(selection).Append("-i ").Append(Media.Q(media)).Append(" ");
   foreach (var extra in prep.ExtraInputs) sb.Append(extra).Append(" ");
   sb.Append("-filter_complex ").Append(Media.Q(prep.Graph)).Append(" -map [out] -an ");
   if (frames > 0) sb.Append("-frames:v ").Append(frames).Append(" ");
   sb.Append("-pix_fmt bgra -f rawvideo pipe:1");
   return sb.ToString();
  }
 }
}
