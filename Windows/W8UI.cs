// W8 收尾批 UI（2026-11-18）：节点式调色、色彩管理、镜头匹配、跟踪窗口、
// LUT 库、调色前后对比、色度键取色器、色彩示波器。
// 控件全部复用现有检查器助手（Section/Note/Slider/Toggle/Choices/
// InspectorAction）+ W5 的曲线编辑器同款做法，不抄任何闭源软件的界面。
// 诚实说明写在各面板的 Note 里；云端 runner 无真 GPU/摄像头，
// 那些交互只能在真机上验证，面板里写明，不假装验过。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using DogSC.Windows;
using Path = System.IO.Path;

namespace DogSC.Replica {
 public partial class Studio {
  // ---- W8 字段（面板本地状态，不进 project.json）----
  string lutLibCategory = "";
  string lutLibSearch = "";
  Image lutThumbImage;
  TextBlock lutThumbText;
  Image compareImage;
  string compareStillLabel = "参考帧";
  double chromaPickX = 0.5, chromaPickY = 0.5;
  double trackPointX = 0.5, trackPointY = 0.5;
  string scopeKind = "waveform";
  bool scopeFollow;
  double scopeLastTime = -1;
  Image scopeImage;
  TextBlock scopeText;

  static ColorGrade CloneGrade(ColorGrade g) {
   if (g == null) return new ColorGrade();
   var c = new ColorGrade {
    Brightness = g.Brightness, Contrast = g.Contrast, Saturation = g.Saturation,
    Temperature = g.Temperature, Tint = g.Tint,
    HslSat = (double[])g.HslSat.Clone(), HslLum = (double[])g.HslLum.Clone(),
    WheelHue = (double[])g.WheelHue.Clone(), WheelSat = (double[])g.WheelSat.Clone(),
    HslCurveSat = new List<CurvePoint>(g.HslCurveSat), HslCurveLum = new List<CurvePoint>(g.HslCurveLum),
    RgbR = new List<CurvePoint>(g.RgbR), RgbG = new List<CurvePoint>(g.RgbG),
    RgbB = new List<CurvePoint>(g.RgbB), RgbMaster = new List<CurvePoint>(g.RgbMaster)
   };
   return c;
  }
  static BitmapImage PngImage(byte[] png) {
   using (var ms = new MemoryStream(png)) {
    var img = new BitmapImage();
    img.BeginInit();
    img.StreamSource = ms;
    img.CacheOption = BitmapCacheOption.OnLoad;
    img.EndInit();
    img.Freeze();
    return img;
   }
  }
  void TextRow(string label, string initial, Action<string> commit) {
   var t = UI.Text(label, 13, "#63696D");
   t.Margin = new Thickness(0, 9, 0, 3);
   inspector.Children.Add(t);
   var box = new TextBox { Text = initial, FontSize = 13, Margin = new Thickness(0, 4, 0, 9) };
   box.LostKeyboardFocus += (s, e) => { if (box.Text != initial) { Checkpoint(); commit(box.Text); Changed(); } };
   inspector.Children.Add(box);
  }
  double SourceTimeAtPlayhead() {
   int i;
   return Doc.SourceTime(position, out i);
  }

  // ---- 1. 节点式调色（画面-调色，预设之后）----
  void BuildNodeGraphSection() {
   Section("节点式调色");
   bool active = W8ColourFilters.NodeGraphActive(Doc);
   Note("调色从线性栈改成串并联节点图：每节点独立混合模式 + 不透明度，蒙版节点单独烤一张 LUT + 一张 PNG。节点只烤 LUT 参数（白平衡/HSL/色轮/曲线）；亮度/对比度/饱和度请用主调色。蒙版节点必须直连输出、不能读另一个蒙版节点（引擎探针教训，违规直接报错，不静默压平）。");
   Toggle("启用节点图（替代线性调色）", active, v => {
    Checkpoint();
    if (v) {
     if (Doc.GradeNodes == null) Doc.GradeNodes = new GradeNodeGraph { Nodes = new List<GradeNode> { new GradeNode { Id = "n1", Adjust = new ColorGrade() } }, Output = "n1" };
    } else Doc.GradeNodes = null;
    Changed(); BuildInspector();
   });
   if (!active) return;
   var graph = Doc.GradeNodes;
   foreach (var node in graph.Nodes.ToList()) {
    var n = node;
    Section("节点 " + n.Id + (graph.Output == n.Id ? " · 输出" : ""));
    Choices("混合模式", string.IsNullOrEmpty(n.Blend) ? "normal" : n.Blend, new[] { new[] { "正常", "normal" }, new[] { "正片叠底", "multiply" }, new[] { "滤色", "screen" }, new[] { "叠加", "overlay" } }, v => { n.Blend = v; Changed(); });
    Slider("不透明度", 0, 1, n.Opacity, "", v => { n.Opacity = v; Changed(); });
    Slider("色温", -1, 1, n.Adjust.Temperature, "", v => { n.Adjust.Temperature = v; Changed(); });
    Slider("色调", -1, 1, n.Adjust.Tint, "", v => { n.Adjust.Tint = v; Changed(); });
    Toggle("蒙版（只作用在形状内）", n.Mask != null, v => {
     Checkpoint();
     n.Mask = v ? new GradeNodeMask() : null;
     Changed(); BuildInspector();
    });
    if (n.Mask != null) {
     var m = n.Mask;
     Choices("蒙版形状", m.Shape, new[] { new[] { "矩形", "rect" }, new[] { "椭圆", "ellipse" }, new[] { "圆", "circle" } }, v => { m.Shape = v; Changed(); BuildInspector(); });
     Slider("蒙版中心 X", 0, 1, m.X, "", v => { m.X = v; Changed(); });
     Slider("蒙版中心 Y", 0, 1, m.Y, "", v => { m.Y = v; Changed(); });
     Slider("蒙版宽", 0.05, 1, m.W, "", v => { m.W = v; Changed(); });
     Slider("蒙版高", 0.05, 1, m.H, "", v => { m.H = v; Changed(); });
     Slider("蒙版羽化", 0, 0.25, m.Feather, "", v => { m.Feather = v; Changed(); });
    }
    inspector.Children.Add(UI.Button("复制主调色进此节点", () => { Checkpoint(); n.Adjust = CloneGrade(Doc.Grade); Changed(); BuildInspector(); Status("已把主调色复制进节点 " + n.Id + "。"); }));
    if (graph.Output != n.Id) inspector.Children.Add(UI.Button("设为输出节点", () => { Checkpoint(); graph.Output = n.Id; Changed(); BuildInspector(); }));
    inspector.Children.Add(InspectorAction("trash", "删除节点 " + n.Id, () => {
     if (graph.Nodes.Count <= 1) { Error(new Exception("节点图至少留一个节点。")); return; }
     Checkpoint();
     graph.Nodes.Remove(n);
     foreach (var other in graph.Nodes) if (other.Inputs != null) other.Inputs.RemoveAll(id => id == n.Id);
     if (graph.Output == n.Id) graph.Output = graph.Nodes[0].Id;
     Changed(); BuildInspector();
    }, true));
   }
   inspector.Children.Add(InspectorAction("plus", "添加节点（串在当前输出之后）", () => {
    Checkpoint();
    int k = 1;
    while (graph.Nodes.Any(n => n.Id == "n" + k)) k++;
    string id = "n" + k;
    graph.Nodes.Add(new GradeNode { Id = id, Adjust = new ColorGrade(), Inputs = new List<string> { graph.Output } });
    graph.Output = id;
    Changed(); BuildInspector();
   }));
   inspector.Children.Add(UI.Button("重置节点图", () => { Checkpoint(); Doc.GradeNodes = new GradeNodeGraph { Nodes = new List<GradeNode> { new GradeNode { Id = "n1", Adjust = new ColorGrade() } }, Output = "n1" }; Changed(); BuildInspector(); }));
   Note("节点内 HSL 分区/色轮/曲线用“复制主调色进此节点”带进来（先在主调色页调好，再复制）。节点图开时主调色必须保持原片，否则导出报错。");
  }

  // ---- 2. 色彩管理 ----
  void BuildColourMgmtSection() {
   Section("色彩管理");
   Choices("输入色彩空间", string.IsNullOrEmpty(Doc.InputSpace) ? "rec709" : Doc.InputSpace, new[] { new[] { "Rec.709", "rec709" }, new[] { "sRGB", "srgb" }, new[] { "S-Log3", "slog3" }, new[] { "log100", "log100" }, new[] { "HLG", "hlg" }, new[] { "PQ", "pq" } }, v => { Doc.InputSpace = v; Changed(); BuildInspector(); });
   Choices("时间线工作空间", string.IsNullOrEmpty(Doc.WorkingSpace) ? "rec709" : Doc.WorkingSpace, new[] { new[] { "Rec.709", "rec709" }, new[] { "sRGB", "srgb" } }, v => { Doc.WorkingSpace = v; Changed(); BuildInspector(); });
   Choices("输出色彩空间", string.IsNullOrEmpty(Doc.OutputSpace) ? "rec709" : Doc.OutputSpace, new[] { new[] { "Rec.709", "rec709" }, new[] { "sRGB", "srgb" } }, v => { Doc.OutputSpace = v; Changed(); BuildInspector(); });
   Note("每片段设输入空间，时间线统一工作空间，输出再转目标空间。log 输入需要官方 log→Rec.709 LUT：S-Log3 用 Sony 官方曲线烤（18% 灰 420/1023、90% 白 598/1023），S-Gamut3.Cine 色域矩阵不含，只转传输曲线；log100/HLG 走 zscale（先 setparams 打标签，裸 zscale 报 no path）；PQ 走 Hable tonemap。输出 sRGB 只烤传输 LUT，元数据标签贴不到编码器上（导出走 rawvideo 管线），成片色彩以 LUT 为准。");
  }

  // ---- 3. 镜头匹配 ----
  void BuildColourMatchSection() {
   Section("镜头匹配");
   bool has = W8ColourFilters.MatchActive(Doc);
   Note(has ? "参考帧：" + Path.GetFileName(Doc.Match.ReferenceFrame) + " · 强度 " + Doc.Match.Strength.ToString("0.00", CultureInfo.InvariantCulture) : "还没有参考帧。以参考帧的直方图/均值校正当前镜头，烤进一张 LUT（强度 0 = 恒等）。");
   inspector.Children.Add(InspectorAction("folder", "选择参考帧…（图片/视频首帧）", () => {
    var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "图片或视频|*.png;*.jpg;*.jpeg;*.mp4;*.mov;*.mkv|所有文件|*.*" };
    if (dlg.ShowDialog(Window) != true) return;
    try { Checkpoint(); Doc.Match = new ColourMatch { ReferenceFrame = Path.GetFullPath(dlg.FileName), Strength = Doc.Match == null ? 1 : Doc.Match.Strength }; Changed(); BuildInspector(); Status("已选参考帧 · " + Path.GetFileName(dlg.FileName)); } catch (Exception ex) { Error(ex); }
   }));
   inspector.Children.Add(InspectorAction("plus", "用当前帧作参考帧", () => {
    if (Doc == null || string.IsNullOrEmpty(Doc.Source)) return;
    try {
     var png = StudioMedia.Frame(Doc.Source, SourceTimeAtPlayhead(), 320, CancellationToken.None);
     string path = Path.Combine(Path.GetTempPath(), "catcut-match-ref.png");
     File.WriteAllBytes(path, png);
     Checkpoint(); Doc.Match = new ColourMatch { ReferenceFrame = path, Strength = Doc.Match == null ? 1 : Doc.Match.Strength }; Changed(); BuildInspector(); Status("已用当前帧作参考帧。");
    } catch (Exception ex) { Error(ex); }
   }));
   if (has) {
    Slider("匹配强度", 0, 1, Doc.Match.Strength, "", v => { Doc.Match.Strength = v; Changed(); });
    inspector.Children.Add(InspectorAction("trash", "清除镜头匹配", () => { Checkpoint(); Doc.Match = null; Changed(); BuildInspector(); }, true));
   }
   Note("直方图 CDF 映射后在目标不同灰度级之间线性插值、范围外取平（裸 CDF 阶跃会被 17³ LUT 三线性插值抹平，探针证实后已修；固色目标 100→200 不会再烤成 52）。");
  }

  // ---- 4. 跟踪窗口 ----
  void BuildTrackedWindowSection() {
   Section("跟踪窗口");
   bool active = W8ColourFilters.TrackedWindowActive(Doc);
   Note("形状蒙版加跨帧追踪，窗口内单独调色，窗口外不变；与 P1 的静态形状蒙版互补。C# 侧没有自动主体追踪器，跟踪点由你在播放头处打点、线性插值；丢帧点停在上一个已知位置，不编造。遮罩视频 320×180 @5fps，导出时生成；监视器播放不实时显示窗口，只在导出见。");
   Toggle("启用跟踪窗口", active, v => {
    Checkpoint();
    Doc.TrackedWin = v ? new TrackedWindow { Track = new List<TrackPoint> { new TrackPoint { Time = 0, X = 0.5, Y = 0.5 } } } : null;
    Changed(); BuildInspector();
   });
   if (!active) return;
   var tw = Doc.TrackedWin;
   Choices("窗口形状", tw.Shape, new[] { new[] { "矩形", "rect" }, new[] { "椭圆", "ellipse" }, new[] { "圆", "circle" } }, v => { tw.Shape = v; Changed(); });
   Slider("窗口宽", 0.05, 1, tw.W, "", v => { tw.W = v; Changed(); });
   Slider("窗口高", 0.05, 1, tw.H, "", v => { tw.H = v; Changed(); });
   Slider("窗口内 · 色温", -1, 1, tw.Adjust.Temperature, "", v => { tw.Adjust.Temperature = v; Changed(); });
   Slider("窗口内 · 色调", -1, 1, tw.Adjust.Tint, "", v => { tw.Adjust.Tint = v; Changed(); });
   inspector.Children.Add(UI.Button("复制主调色进窗口", () => { Checkpoint(); tw.Adjust = CloneGrade(Doc.Grade); Changed(); BuildInspector(); }));
   Choices("遮罩采样帧率", tw.SampleFps.ToString("0", CultureInfo.InvariantCulture), new[] { new[] { "1 fps", "1" }, new[] { "5 fps（默认）", "5" }, new[] { "10 fps", "10" } }, v => { tw.SampleFps = double.Parse(v, CultureInfo.InvariantCulture); Changed(); });
   Section("跟踪点（" + tw.Track.Count + " 个）");
   foreach (var p in tw.Track.ToList()) {
    var point = p;
    var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 3, 0, 3) };
    var jump = UI.Button(UI.Time(point.Time) + " → (" + point.X.ToString("0.00", CultureInfo.InvariantCulture) + ", " + point.Y.ToString("0.00", CultureInfo.InvariantCulture) + ")" + (point.Lost ? " · 丢帧" : ""), () => Seek(point.Time));
    jump.FontSize = 12; jump.HorizontalContentAlignment = HorizontalAlignment.Left; jump.MinWidth = 190;
    row.Children.Add(jump);
    var del = UI.Button("删除", () => { if (tw.Track.Count <= 1) { Error(new Exception("至少留一个跟踪点。")); return; } Checkpoint(); tw.Track.Remove(point); Changed(); BuildInspector(); });
    del.FontSize = 11; del.Padding = new Thickness(8, 3, 8, 3); del.Margin = new Thickness(6, 0, 0, 0);
    row.Children.Add(del);
    inspector.Children.Add(row);
   }
   Slider("打点位置 X", 0, 1, trackPointX, "", v => trackPointX = v);
   Slider("打点位置 Y", 0, 1, trackPointY, "", v => trackPointY = v);
   inspector.Children.Add(InspectorAction("plus", "在播放头打跟踪点", () => {
    Checkpoint();
    tw.Track.Add(new TrackPoint { Time = position, X = trackPointX, Y = trackPointY });
    tw.Track.Sort((a, b) => a.Time.CompareTo(b.Time));
    Changed(); BuildInspector(); Status("已在 " + UI.Time(position) + " 打跟踪点。");
   }));
  }

  // ---- 5. LUT 库 ----
  void BuildLutLibrarySection() {
   Section("LUT 库");
   List<LutLibraryEntry> lib;
   try { lib = LutLibrary.Load(); } catch (Exception ex) { Note("LUT 库文件损坏：" + ex.Message); return; }
   var cats = LutLibrary.LibraryCategories(lib);
   var catOptions = new List<string[]> { new[] { "全部", "" } };
   foreach (var c in cats) catOptions.Add(new[] { c, c });
   Choices("分类", lutLibCategory, catOptions.ToArray(), v => { lutLibCategory = v; BuildInspector(); });
   TextRow("搜索（名字/分类/标签）", lutLibSearch, v => { lutLibSearch = v; BuildInspector(); });
   inspector.Children.Add(InspectorAction("folder", "导入 .cube 进库…", () => {
    var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "LUT 文件|*.cube|所有文件|*.*" };
    if (dlg.ShowDialog(Window) != true) return;
    try {
     string id = Path.GetFileNameWithoutExtension(dlg.FileName);
     var next = LutLibrary.Add(LutLibrary.Load(), new LutLibraryEntry { Id = id, Name = id, Category = "其他", File = Path.GetFullPath(dlg.FileName) });
     LutLibrary.Save(next);
     Changed(); BuildInspector(); RefreshMediaLibrary(); Status("已导入 LUT · " + id);
    } catch (Exception ex) { Error(ex); }
   }));
   var shown = LutLibrary.Filter(lib, lutLibCategory, null, lutLibSearch);
   if (shown.Count == 0) { Note("库里还没有符合条件的 LUT。先导入 .cube（P2a 的导入只认文件，库界面在这里）。"); }
   foreach (var e in shown) {
    var entry = e;
    var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 3, 0, 3) };
    var apply = UI.Button((entry.Favorite ? "★ " : "") + entry.Name + " · " + entry.Category, () => {
     try { Checkpoint(); LutCube.ParseFile(entry.File); Doc.AppliedLutPath = entry.File; Changed(); BuildInspector(); Status("已应用 LUT · " + entry.Name); } catch (Exception ex) { Error(ex); }
    });
    apply.FontSize = 12; apply.HorizontalContentAlignment = HorizontalAlignment.Left; apply.MinWidth = 190;
    apply.MouseEnter += (s, ev) => ShowLutThumb(entry);
    row.Children.Add(apply);
    var fav = UI.Button(entry.Favorite ? "取消收藏" : "收藏", () => { try { LutLibrary.Save(LutLibrary.ToggleFavorite(LutLibrary.Load(), entry.Id)); BuildInspector(); } catch (Exception ex) { Error(ex); } });
    fav.FontSize = 11; fav.Padding = new Thickness(8, 3, 8, 3); fav.Margin = new Thickness(6, 0, 0, 0);
    row.Children.Add(fav);
    var del = UI.Button("移除", () => { try { LutLibrary.Save(LutLibrary.Remove(LutLibrary.Load(), entry.Id)); if (Doc.AppliedLutPath == entry.File) { Checkpoint(); Doc.AppliedLutPath = ""; Changed(); } BuildInspector(); } catch (Exception ex) { Error(ex); } });
    del.FontSize = 11; del.Padding = new Thickness(8, 3, 8, 3); del.Margin = new Thickness(6, 0, 0, 0);
    row.Children.Add(del);
    inspector.Children.Add(row);
   }
   if (!string.IsNullOrEmpty(Doc.AppliedLutPath)) {
    Note("当前应用：" + Path.GetFileName(Doc.AppliedLutPath));
    inspector.Children.Add(InspectorAction("trash", "取消应用 LUT", () => { Checkpoint(); Doc.AppliedLutPath = ""; Changed(); BuildInspector(); }, true));
   }
   lutThumbText = UI.Text("把鼠标悬停在 LUT 上看缩略图（160×90，lut3d 直接渲染）。", 11, "#63696D");
   lutThumbText.TextWrapping = TextWrapping.Wrap;
   inspector.Children.Add(lutThumbText);
   lutThumbImage = new Image { MaxWidth = 320, Margin = new Thickness(0, 4, 0, 4), Visibility = Visibility.Collapsed };
   inspector.Children.Add(lutThumbImage);
   Note("LUT 按分类/收藏管理；坏 LUT、重复 id、缺失文件在入库时就拒绝，不等导出才报错。");
  }
  void ShowLutThumb(LutLibraryEntry entry) {
   if (Doc == null || string.IsNullOrEmpty(Doc.Source) || lutThumbImage == null) return;
   try {
    string png = LutLibrary.Thumbnail(entry.File, Doc.Source, SourceTimeAtPlayhead(), Path.Combine(Path.GetTempPath(), "catcut-lut-thumbs"));
    lutThumbImage.Source = PngImage(File.ReadAllBytes(png));
    lutThumbImage.Visibility = Visibility.Visible;
    if (lutThumbText != null) lutThumbText.Text = entry.Name + " · " + entry.Category + "（悬停预览）";
   } catch { }
  }

  // ---- 6. 调色前后对比 + 参考帧 ----
  void BuildCompareSection() {
   Section("调色前后对比");
   Choices("对比方式", string.IsNullOrEmpty(Doc.CompareMode) ? "split" : Doc.CompareMode, new[] { new[] { "分屏（左原片 / 右调色后）", "split" }, new[] { "擦除（拖动分界线）", "wipe" } }, v => { Doc.CompareMode = v; Changed(); BuildInspector(); });
   if ((string.IsNullOrEmpty(Doc.CompareMode) ? "split" : Doc.CompareMode) == "wipe") Slider("擦除位置", 0.05, 0.95, Doc.CompareWipe <= 0 ? 0.5 : Doc.CompareWipe, "", v => { Doc.CompareWipe = v; Changed(); });
   inspector.Children.Add(InspectorAction("plus", "生成对比帧（当前播放头）", () => {
    if (Doc == null || string.IsNullOrEmpty(Doc.Source)) return;
    try {
     string lut = CurrentGradeLutPath();
     string png = Path.Combine(Path.GetTempPath(), "catcut-compare.png");
     string mode = string.IsNullOrEmpty(Doc.CompareMode) ? "split" : Doc.CompareMode;
     double wipe = Doc.CompareWipe <= 0 ? 0.5 : Doc.CompareWipe;
     CompareOps.RenderComparisonFrame(Doc.Source, lut, png, mode, wipe, SourceTimeAtPlayhead(), Doc.Width, Doc.Height, CancellationToken.None);
     compareImage.Source = PngImage(File.ReadAllBytes(png));
     compareImage.Visibility = Visibility.Visible;
     Status("对比帧已生成 · " + mode + (lut == null ? "（当前无调色，左右都是原片）" : ""));
    } catch (Exception ex) { Error(ex); }
   }));
   compareImage = new Image { MaxWidth = 320, Margin = new Thickness(0, 4, 0, 4), Visibility = Visibility.Collapsed };
   inspector.Children.Add(compareImage);
   TextRow("参考帧名字", compareStillLabel, v => compareStillLabel = v);
   inspector.Children.Add(InspectorAction("plus", "存当前帧进参考帧库", () => {
    if (Doc == null || string.IsNullOrEmpty(Doc.Source)) return;
    try {
     string dir = CompareOps.StillsDir();
     Directory.CreateDirectory(dir);
     string png = Path.Combine(dir, "still-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture) + ".png");
     var still = CompareOps.SaveReferenceStill(Doc.Source, SourceTimeAtPlayhead(), png, compareStillLabel, "", CancellationToken.None);
     BuildInspector(); Status("参考帧已存 · " + still.Label + "（" + still.Width + "x" + still.Height + "）");
    } catch (Exception ex) { Error(ex); }
   }));
   foreach (var stillPath in CompareOps.ListReferenceStills(CompareOps.StillsDir())) {
    var sp = stillPath;
    ReferenceStill still;
    try { still = CompareOps.LoadReferenceStill(sp); } catch { continue; }
    var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 3, 0, 3) };
    var jump = UI.Button(still.Label + " · " + UI.Time(still.Time), () => Seek(still.Time));
    jump.FontSize = 12; jump.HorizontalContentAlignment = HorizontalAlignment.Left; jump.MinWidth = 190;
    row.Children.Add(jump);
    var del = UI.Button("删除", () => { try { File.Delete(sp); File.Delete(sp + ".json"); BuildInspector(); } catch (Exception ex) { Error(ex); } });
    del.FontSize = 11; del.Padding = new Thickness(8, 3, 8, 3); del.Margin = new Thickness(6, 0, 0, 0);
    row.Children.Add(del);
    inspector.Children.Add(row);
   }
   Note("对比帧是 standalone ffmpeg 渲染的静帧（左原片、右调色后），不是监视器实时分屏；参考帧 PNG + JSON sidecar 存取，sidecar 被改过就拒绝加载。");
  }
  string CurrentGradeLutPath() {
   if (W8ColourFilters.NodeGraphActive(Doc)) {
    var baked = GradeNodeGraphOps.Bake(Doc.GradeNodes);
    return GradeNodeGraphOps.CubePathForGrid(baked.Final, GradeNodeGraphOps.Key(Doc.GradeNodes), "nodes");
   }
   if (Doc.Grade.NeedsLut()) return ColorLut.PathFor(Doc.Grade);
   return null;
  }

  // ---- 7. 色度键取色器 ----
  void BuildChromaKeySection() {
   Section("色度键取色器");
   bool active = W8ColourFilters.ChromaActive(Doc);
   Note("监视器上点一下取色做键色（v1 用坐标取色：在帧上定位置取色，效果等同点击）。复用 P1 已验证的 chromakey（similarity 默认 0.1，0.01 实测完全不抠）。监视器播放时键色以透明近似显示，导出按背景合成；只在 GPL 8.1.2 构建上验证，LGPL 待 M2 复核。");
   Toggle("启用色度键", active, v => {
    Checkpoint();
    Doc.Chroma = v ? new ChromaKey() : null;
    Changed(); BuildInspector();
   });
   if (!active) return;
   var key = Doc.Chroma;
   Note("当前键色：" + key.Color + " · 容差 " + key.Similarity.ToString("0.00", CultureInfo.InvariantCulture));
   inspector.Children.Add(UI.Button("绿幕", () => { Checkpoint(); key.Color = "0x00ff00"; Changed(); BuildInspector(); }));
   inspector.Children.Add(UI.Button("蓝幕", () => { Checkpoint(); key.Color = "0x0000ff"; Changed(); BuildInspector(); }));
   Slider("取色点 X", 0, 1, chromaPickX, "", v => chromaPickX = v);
   Slider("取色点 Y", 0, 1, chromaPickY, "", v => chromaPickY = v);
   inspector.Children.Add(InspectorAction("plus", "从该点取色", () => {
    if (Doc == null || string.IsNullOrEmpty(Doc.Source)) return;
    try {
     string hex = ChromaKeyOps.SamplePixel(Doc.Source, SourceTimeAtPlayhead(), chromaPickX, chromaPickY, CancellationToken.None);
     Checkpoint(); key.Color = hex; Changed(); BuildInspector(); Status("键色已取 · " + hex);
    } catch (Exception ex) { Error(ex); }
   }));
   Slider("容差（越大抠得越狠）", 0.01, 1, key.Similarity, "", v => { key.Similarity = v; Changed(); });
   Slider("边缘羽化", 0, 1, key.Blend, "", v => { key.Blend = v; Changed(); });
   Toggle("去色边（despill）", key.Despill, v => { key.Despill = v; Changed(); });
   Choices("抠掉后显示", string.IsNullOrEmpty(key.BackgroundSource) ? "black" : "file", new[] { new[] { "黑色", "black" }, new[] { "背景文件…", "file" } }, v => {
    if (v == "black") { key.BackgroundSource = ""; key.BackgroundColor = "0x000000"; }
    else {
     var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "图片或视频|*.png;*.jpg;*.jpeg;*.mp4;*.mov|所有文件|*.*" };
     if (dlg.ShowDialog(Window) != true) return;
     key.BackgroundSource = Path.GetFullPath(dlg.FileName); key.BackgroundColor = "";
    }
    Changed(); BuildInspector();
   });
   if (!string.IsNullOrEmpty(key.BackgroundSource)) Note("背景文件：" + Path.GetFileName(key.BackgroundSource) + "（循环铺满全片）。");
  }

  // ---- 8. 色彩示波器实时显示 ----
  void BuildScopesSection() {
   Section("色彩示波器");
   Choices("示波器", scopeKind, new[] { new[] { "波形", "waveform" }, new[] { "矢量", "vectorscope" } }, v => { scopeKind = v; RefreshScope(); });
   Toggle("跟随播放头（切播放头后重采样）", scopeFollow, v => { scopeFollow = v; if (v) RefreshScope(); });
   inspector.Children.Add(InspectorAction("plus", "刷新示波器（当前播放头）", () => RefreshScope()));
   scopeText = UI.Text("还没有采样。点“刷新示波器”，或打开“跟随播放头”后切播放头。", 12, "#63696D");
   scopeText.TextWrapping = TextWrapping.Wrap;
   inspector.Children.Add(scopeText);
   scopeImage = new Image { MaxWidth = 320, Margin = new Thickness(0, 4, 0, 4), Visibility = Visibility.Collapsed };
   inspector.Children.Add(scopeImage);
   Note("波形/矢量示波器实时跟随播放：采样帧 + 自绘（数字是源头，图只是视图；Rec.709 亮度、圆均值主色相、灰帧主色相为 null、三通道都 >250 才算爆）。播放中逐帧跟随需监视器管线改动，v1 是播放头移动/刷新时重采样。P2a 的示波器只给数字不给图，实时显示是新接的监视器功能。");
   if (scopeFollow && Doc != null && Math.Abs(position - scopeLastTime) > 0.25) RefreshScope();
  }
  async void RefreshScope() {
   if (Doc == null || string.IsNullOrEmpty(Doc.Source) || scopeImage == null) return;
   double time = position;
   string source = Doc.EffectiveSource();
   double sourceTime = SourceTimeAtPlayhead();
   try {
    var sampled = await Task.Run(() => {
     var rgb = ColourMatchOps.DecodeFrameRgb24(source, sourceTime, 160, 90, CancellationToken.None);
     var res = ScopeAnalysis.AnalyzeRgbFrame(rgb, 160, 90, source, sourceTime);
     var png = ScopeAnalysis.DrawScopePng(rgb, 160, 90, scopeKind, 320, 180);
     return Tuple.Create(res, png);
    });
    scopeLastTime = time;
    var res = sampled.Item1;
    scopeImage.Source = PngImage(sampled.Item2);
    scopeImage.Visibility = Visibility.Visible;
    if (scopeText != null) scopeText.Text = "亮度均值 " + res.LumaMean.ToString("0.0", CultureInfo.InvariantCulture) + " · 饱和度均值 " + res.SaturationMean.ToString("0.00", CultureInfo.InvariantCulture) + " · 主色相 " + (res.DominantHue.HasValue ? res.DominantHue.Value.ToString("0", CultureInfo.InvariantCulture) + "°" : "无（灰帧）") + " · 高光裁切 " + (res.HighlightClip * 100).ToString("0", CultureInfo.InvariantCulture) + "% · 阴影裁切 " + (res.ShadowClip * 100).ToString("0", CultureInfo.InvariantCulture) + "%";
   } catch (Exception ex) { if (scopeText != null) scopeText.Text = "示波器采样失败：" + ex.Message; }
  }
 }
}
