// W8 收尾批 UI（2026-11-18）：效果与媒体 14 项的检查器面板。
// 控件全部复用现有检查器助手（Section/Note/Slider/Toggle/Choices/
// Number/Buttons/InspectorAction）+ W7 同款 TextBox，不抄任何闭源软件的界面。
// 诚实说明写在各面板的 Note 里；云端 runner 无真 GPU/摄像头/麦克风，
// 那些交互只能在真机上验证，面板里写明，不假装验过。
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using DogSC.Windows;

namespace DogSC.Replica {
 public partial class Studio {
  // ---- 3. 模板商店（画面-调色，预设之后）----
  void BuildTemplateSection() {
   Section("模板商店 · 本地包");
   Note("4 个内置模板（照抄 engine/templates/*.json）。只做本地包，不接版权音乐库。模板只改调色预设 + 字幕样式，转场与淡入淡出只记在项目上——C# 导出管线没有转场渲染，套了 dissolve 也不会出溶解，别当真。");
   foreach (var t in TemplateStore.BuiltIn()) {
    var template = t;
    inspector.Children.Add(InspectorAction("presets", "套用 · " + template.Label, () => {
     if (Doc == null) return;
     try {
      Checkpoint();
      TemplateStore.Apply(Doc, template.Id);
      Changed();
      BuildInspector();
      Status("已套用模板 · " + template.Label + "（转场 " + template.Transition + " 仅记录，未渲染）。");
     } catch (Exception ex) { Error(ex); }
    }));
    Note(template.Label + "：" + template.Description);
   }
   if (!string.IsNullOrEmpty(Doc.TemplateId)) Note("当前模板：" + Doc.TemplateId + "。");
  }

  // ---- 1. 防抖开关（运镜 tab，闪白/Morph 之后）----
  void BuildStabilizeSection() {
   Section("视频防抖");
   Toggle("启用防抖（导出时生效）", Doc.StabilizeEnabled, v => { Doc.StabilizeEnabled = v; BuildInspector(); });
   if (!Doc.StabilizeEnabled) { Note("防抖只在导出时做（先防抖、再跟踪、再解码）。关着不花时间。"); return; }
   Choices("防抖方法", Doc.StabilizeMethod, new[] { new[] { "vidstab（两遍，效果好，GPL）", "vidstab" }, new[] { "deshake（单遍，LGPL 安全，Y 向无改善）", "deshake" } }, v => Doc.StabilizeMethod = v);
   bool hasVidstab = Stabilizer.HasVidstab();
   Note(hasVidstab ? "当前 FFmpeg 含 vidstab，可以走两遍。" : "当前 FFmpeg 不含 vidstab（LGPL 构建不含 vidstabdetect/vidstabtransform）。选 vidstab 会在导出时诚实报错；先用 deshake，或换 GPL 构建的 FFmpeg。");
   if (Doc.StabilizeMethod == "vidstab") {
    Number("平滑（0–1000）", Doc.StabilizeSmoothing, v => Doc.StabilizeSmoothing = EditDocument.Clamp(v, 0, 1000));
    Number("缩放补偿", Doc.StabilizeZoom, v => Doc.StabilizeZoom = EditDocument.Clamp(v, -100, 100));
    Slider("抖动灵敏度", 1, 10, Doc.StabilizeShakiness, "", v => Doc.StabilizeShakiness = (int)Math.Round(v));
    Slider("检测精度", 1, 15, Doc.StabilizeAccuracy, "", v => Doc.StabilizeAccuracy = (int)Math.Round(v));
    Note("引擎 P1b 实测：去趋势抖动中位数约 41–50%（基线 8.07 → 3.30–3.42），单次导出仍有 ±1 摆动（vidstabdetect 本身非确定性）。");
   } else {
    Number("横向搜索", Doc.DeshakeRx, v => Doc.DeshakeRx = (int)EditDocument.Clamp(v, 0, 64));
    Number("纵向搜索", Doc.DeshakeRy, v => Doc.DeshakeRy = (int)EditDocument.Clamp(v, 0, 64));
    Note("deshake 实测：X 改善约 26%、Y 无改善（反而略升）。LGPL 安全备选，不是 vidstab 的平替。");
   }
  }

  // ---- 4. 场景切分面板（运镜 tab，防抖之后）----
  double sceneThreshold = 0.4;
  List<double> detectedScenes;
  string sceneStatus = "";
  void BuildSceneCutSection() {
   Section("场景切分");
   Note("用 FFmpeg select='gt(scene,阈值)' 找硬切，切点进时间线。只认硬切，溶解不检测。");
   Choices("检测阈值", sceneThreshold.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture), new[] { new[] { "0.3（更敏感）", "0.3" }, new[] { "0.4", "0.4" }, new[] { "0.5（只认大变化）", "0.5" } }, v => { sceneThreshold = double.Parse(v, System.Globalization.CultureInfo.InvariantCulture); });
   if (detectedScenes != null) {
    Note("已找到 " + detectedScenes.Count + " 个切点：" + string.Join("、", detectedScenes.Select(s => s.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture) + "s").ToArray()) + "。");
   } else if (!string.IsNullOrEmpty(sceneStatus)) {
    Note(sceneStatus);
   }
   inspector.Children.Add(InspectorAction("cut", "检测场景切点", async () => {
    if (Doc == null || string.IsNullOrEmpty(Doc.Source)) return;
    Status("正在检测场景切点…");
    try {
     double threshold = sceneThreshold;
     var cuts = await Task.Run(() => SceneCut.Detect(Doc.Source, threshold, CancellationToken.None));
     detectedScenes = cuts;
     sceneStatus = cuts.Count == 0 ? "没有找到硬切点（阈值 " + threshold.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + "）。" : "";
     Changed();
     BuildInspector();
     Status(cuts.Count == 0 ? "没有找到切点。" : "找到 " + cuts.Count + " 个切点。");
    } catch (Exception ex) { Error(ex); }
   }));
   if (detectedScenes != null && detectedScenes.Count > 0) {
    inspector.Children.Add(InspectorAction("cut", "切点进时间线（劈开 " + detectedScenes.Count + " 处）", () => {
     if (Doc == null) return;
     try {
      Checkpoint();
      int n = SceneCut.Apply(Doc, detectedScenes);
      detectedScenes = null;
      sceneStatus = "已按切点劈成 " + n + " 个片段。";
      Changed();
      BuildInspector();
      DrawTimeline();
      Status("已按切点劈成 " + n + " 个片段。");
     } catch (Exception ex) { Error(ex); }
    }, true));
   }
  }

  // ---- 2. 人像抠像背景选择（美颜 tab，美颜之后）----
  void BuildPortraitBgSection() {
   Section("人像抠像 · 背景选择");
   Toggle("启用人像抠像背景（导出时生效）", Doc.PortraitEnabled, v => { Doc.PortraitEnabled = v; BuildInspector(); });
   if (!Doc.PortraitEnabled) { Note("抠像用 P1e 的 MediaPipe 人像分割（ONNX 本地跑），背景可换虚化/纯色/图片。关着不花时间。"); return; }
   if (Doc.BeautyEnabled) Note("美颜正开着：抠像背景与美颜不能同开（共用同一张人像遮罩管线），导出会报错。先关一个。");
   Choices("背景", Doc.PortraitBgMode, new[] { new[] { "原背景", "original" }, new[] { "虚化原背景", "blur" }, new[] { "纯色", "color" }, new[] { "图片", "image" } }, v => { Doc.PortraitBgMode = v; BuildInspector(); });
   if (Doc.PortraitBgMode == "blur") Slider("虚化强度", 0, 30, Doc.PortraitBgBlur, "", v => Doc.PortraitBgBlur = v);
   if (Doc.PortraitBgMode == "color") {
    Choices("纯色", Doc.PortraitBgColor, new[] { new[] { "红", "#FF0000" }, new[] { "绿", "#00FF00" }, new[] { "蓝", "#0000FF" }, new[] { "白", "#FFFFFF" }, new[] { "黑", "#000000" } }, v => Doc.PortraitBgColor = v);
    var hex = new TextBox { Text = Doc.PortraitBgColor, FontSize = 13, Margin = new Thickness(0, 4, 0, 9) };
    hex.LostKeyboardFocus += (s, e) => { try { KeyOutline.ParseColor(hex.Text); Checkpoint(); Doc.PortraitBgColor = hex.Text.Trim(); Changed(); } catch (Exception ex) { Error(ex); hex.Text = Doc.PortraitBgColor; } };
    inspector.Children.Add(hex);
   }
   if (Doc.PortraitBgMode == "image") {
    Note(string.IsNullOrEmpty(Doc.PortraitBgImage) ? "还没有背景图片。" : "背景图片：" + Doc.PortraitBgImage);
    inspector.Children.Add(InspectorAction("folder", "选择背景图片…", () => {
     var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "图片|*.png;*.jpg;*.jpeg;*.bmp" };
     if (dlg.ShowDialog(Window) != true) return;
     Checkpoint();
     Doc.PortraitBgImage = dlg.FileName;
     Changed();
     BuildInspector();
    }));
   }
   Slider("边缘羽化", 0, 10, Doc.PortraitEdgeFeather, "", v => Doc.PortraitEdgeFeather = v);
   Note("需要系统 Python + onnxruntime + numpy，模型（MediaPipe Selfie Segmentation，Apache 2.0）随包分发；缺了导出时报清楚缺什么。遮罩从拼好的时间线重算（较慢，一次），保留全部人物。");
  }

  // ---- 7. 抠像描边（美颜 tab，抠像背景之后）----
  void BuildOutlineSection() {
   Section("抠像描边");
   Toggle("人像边缘加描边", Doc.OutlineEnabled, v => { Doc.OutlineEnabled = v; BuildInspector(); });
   if (!Doc.OutlineEnabled) { Note("在抠出的人像边缘加描边（颜色/粗细可调）。只在抠像背景开着时生效。"); return; }
   if (!Doc.PortraitEnabled) Note("抠像背景没开：描边现在不生效，先开上面的“人像抠像背景”。");
   Choices("描边颜色", Doc.OutlineColor, new[] { new[] { "白", "#FFFFFF" }, new[] { "红", "#FF0000" }, new[] { "绿", "#00FF00" }, new[] { "蓝", "#0000FF" }, new[] { "黄", "#FFFF00" }, new[] { "黑", "#000000" } }, v => Doc.OutlineColor = v);
   Slider("描边粗细", 1, 10, Doc.OutlineWidth, " px", v => Doc.OutlineWidth = (int)Math.Round(v));
   Note("描边画在抠像的 alpha 边缘上（dilation 长大一圈再减去原遮罩），1 px 约长一圈。");
  }

  // ---- 5. 对象跟踪（贴图 tab）----
  void BuildObjectTrackSection() {
   Section("对象跟踪");
   Toggle("启用对象跟踪（导出时生效）", Doc.ObjectTrackEnabled, v => { Doc.ObjectTrackEnabled = v; BuildInspector(); });
   if (!Doc.ObjectTrackEnabled) { Note("框选目标后跨帧追踪，贴纸/文字/马赛克跟住走。复用主体追踪，目标改成你框选的任意物体。"); return; }
   Choices("跟踪方法", Doc.ObjectTrackMethod, new[] { new[] { "颜色（跟住这个颜色）", "color" }, new[] { "模板（跟住框里的东西）", "template" } }, v => { Doc.ObjectTrackMethod = v; BuildInspector(); });
   if (Doc.ObjectTrackMethod == "color") {
    Choices("目标颜色", Doc.ObjectTrackColor, new[] { new[] { "白", "#FFFFFF" }, new[] { "红", "#FF0000" }, new[] { "绿", "#00FF00" }, new[] { "蓝", "#0000FF" }, new[] { "黑", "#000000" } }, v => Doc.ObjectTrackColor = v);
    Slider("颜色容差", 0, 442, Doc.ObjectTrackTolerance, "", v => Doc.ObjectTrackTolerance = v);
   } else {
    Note("模板跟踪用首帧框里的画面作模板：框的中心是起点。框的位置在下面四个数里改（画面比例 0–1）。");
    Number("框左 X", Doc.TrackBoxX, v => Doc.TrackBoxX = EditDocument.Clamp(v, 0, 1));
    Number("框上 Y", Doc.TrackBoxY, v => Doc.TrackBoxY = EditDocument.Clamp(v, 0, 1));
    Number("框宽", Doc.TrackBoxW, v => Doc.TrackBoxW = EditDocument.Clamp(v, 0.01, 1));
    Number("框高", Doc.TrackBoxH, v => Doc.TrackBoxH = EditDocument.Clamp(v, 0.01, 1));
   }
   var sticker = new TextBox { Text = Doc.ObjectTrackSticker, FontSize = 13, Margin = new Thickness(0, 4, 0, 9) };
   sticker.LostKeyboardFocus += (s, e) => { Checkpoint(); Doc.ObjectTrackSticker = sticker.Text; Changed(); };
   inspector.Children.Add(UI.Text("跟随文字（可空，跟住目标走）", 12, "#63696D"));
   inspector.Children.Add(sticker);
   Slider("马赛克大小", 0, 0.5, Doc.ObjectTrackMosaic, "", v => Doc.ObjectTrackMosaic = v);
   Note("跟随文字和马赛克至少要开一个，否则跟了也没东西可看。跟丢的帧停在上一位置，不编造。5 fps 采样跟踪，快速移动会有 0.2 秒的台阶感。");
  }

  // ---- 6. 克隆（贴图 tab）----
  double cloneDuration = 2;
  void BuildCloneSection() {
   Section("克隆 · 分身特效");
   Toggle("启用克隆（渲染分身片段）", Doc.CloneEnabled, v => { Doc.CloneEnabled = v; BuildInspector(); });
   Note("同一素材复制多路 + 固定位置拼合，同屏多个人物。第 1 路是基准（偏移 0），后面每路从更晚的源时间取同一段。");
   Buttons(new[] { "2 路", "4 路" }, Doc.CloneLanes == 4 ? "4 路" : "2 路", v => { Checkpoint(); Doc.CloneLanes = v == "4 路" ? 4 : 2; Doc.CloneLayout = Doc.CloneLanes == 4 ? "grid" : "horizontal"; Changed(); BuildInspector(); });
   if (Doc.CloneLanes == 2) Buttons(new[] { "左右", "上下" }, Doc.CloneLayout == "grid" ? "上下" : "左右", v => { Checkpoint(); Doc.CloneLayout = v == "上下" ? "grid" : "horizontal"; Changed(); BuildInspector(); });
   var offsets = new TextBox { Text = Doc.CloneOffsets, FontSize = 13, Margin = new Thickness(0, 4, 0, 9) };
   offsets.LostKeyboardFocus += (s, e) => { try { Checkpoint(); Doc.CloneOffsets = offsets.Text; CloneEffect.Validate(Doc); Changed(); } catch (Exception ex) { Error(ex); offsets.Text = Doc.CloneOffsets; } };
   inspector.Children.Add(UI.Text("每路时间偏移 / 秒（逗号分隔，第 1 个必须是 0）", 12, "#63696D"));
   inspector.Children.Add(offsets);
   Number("分身片段时长 / 秒", cloneDuration, v => cloneDuration = EditDocument.Clamp(v, 0.5, 60));
   inspector.Children.Add(InspectorAction("plus", "渲染分身片段", async () => {
    if (Doc == null || string.IsNullOrEmpty(Doc.Source)) return;
    Status("正在渲染分身片段…");
    try {
     string output = Path.Combine(Path.GetDirectoryName(Doc.Source), Path.GetFileNameWithoutExtension(Doc.Source) + ".clone.mp4");
     double duration = cloneDuration;
     await Task.Run(() => CloneEffect.Render(Doc.Source, Doc, duration, output, CancellationToken.None));
     Status("分身片段已生成 · " + output);
    } catch (Exception ex) { Error(ex); }
   }));
   Note("克隆是渲染动作（生成一个新文件），不改时间线。4 路必须用 grid（2x2）。");
  }

  // ---- 9. 脚本转视频（贴图 tab）----
  string scriptText = "";
  double scriptLineDuration = 3;
  List<string> scriptImages = new List<string>();
  void BuildScriptVideoSection() {
   Section("脚本转视频");
   Note("脚本或图片+文字自动组装成片：每行一段静帧 + 文字烧录 + .srt 边车。不含云端生成画面；旁白 TTS 未接（P3f TTS 待接），现在是静音，行时长由你定；音乐卡点不做。脚本不随项目保存。");
   var script = new TextBox { Text = scriptText, AcceptsReturn = true, MinHeight = 66, TextWrapping = TextWrapping.Wrap, FontSize = 13, Margin = new Thickness(0, 4, 0, 9) };
   script.LostKeyboardFocus += (s, e) => { scriptText = script.Text; };
   inspector.Children.Add(UI.Text("脚本（每行一段）", 12, "#63696D"));
   inspector.Children.Add(script);
   Number("每行时长 / 秒", scriptLineDuration, v => scriptLineDuration = EditDocument.Clamp(v, 0.5, 60));
   Note(scriptImages.Count == 0 ? "还没有配图：每行没有图时用纯色静帧。" : "已配图 " + scriptImages.Count + " 张（按行顺序用，多余的行用纯色）。");
   inspector.Children.Add(InspectorAction("folder", "为各行配图…（多选，按顺序）", () => {
    var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "图片|*.png;*.jpg;*.jpeg;*.bmp", Multiselect = true };
    if (dlg.ShowDialog(Window) != true) return;
    scriptImages = dlg.FileNames.ToList();
    BuildInspector();
   }));
   inspector.Children.Add(InspectorAction("plus", "组装成片", async () => {
    if (Doc == null) return;
    Status("正在组装成片…");
    try {
     var lines = scriptText.Split(new[] { '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries).Select(t => t.Trim()).Where(t => t.Length > 0)
      .Select((t, i) => new AutoVideoLine { Text = t, Image = i < scriptImages.Count ? scriptImages[i] : "", Duration = scriptLineDuration }).ToList();
     string dir = string.IsNullOrEmpty(FilePath) ? Path.GetDirectoryName(Doc.Source) : Path.GetDirectoryName(FilePath);
     string output = Path.Combine(dir, (string.IsNullOrEmpty(Doc.Name) ? "脚本成片" : Doc.Name) + "-脚本成片.mp4");
     await Task.Run(() => AutoVideo.Build(lines, Doc.TemplateId, output, CancellationToken.None));
     Status("脚本成片已生成 · " + output + "（.srt 边车在同目录）。");
    } catch (Exception ex) { Error(ex); }
   }));
   if (!string.IsNullOrEmpty(Doc.TemplateId)) Note("成片会套当前模板：" + Doc.TemplateId + "。");
  }

  // ---- 12. 优化媒体（代理 tab，磁盘管理之后）----
  void BuildOptimizedSection() {
   Section("优化媒体 · DNxHR 中间片");
   Toggle("启用优化媒体（预览用中间片）", Doc.OptimizedEnabled, v => { Doc.OptimizedEnabled = v; BuildInspector(); });
   Choices("DNxHR 规格", Doc.OptimizedProfile, new[] { new[] { "HQ（10-bit 4:2:2，默认）", "dnxhr_hq" }, new[] { "SQ", "dnxhr_sq" }, new[] { "LB（最小）", "dnxhr_lb" } }, v => Doc.OptimizedProfile = v);
   bool has = !string.IsNullOrEmpty(Doc.OptimizedPath) && File.Exists(Doc.OptimizedPath);
   Note(has ? "优化媒体：" + Doc.OptimizedPath + "\n时长 " + Media.Duration(Doc.OptimizedPath).ToString("0.00") + "s（原片 " + Doc.Duration.ToString("0.00") + "s）" : "尚未生成优化媒体。");
   inspector.Children.Add(InspectorAction("plus", has ? "重新生成优化媒体" : "生成优化媒体", async () => {
    if (Doc == null || string.IsNullOrEmpty(Doc.Source)) return;
    Status("正在生成 DNxHR 中间片…");
    try {
     string path = OptimizedMedia.PathFor(Doc.Source);
     string profile = Doc.OptimizedProfile;
     var info = await Task.Run(() => OptimizedMedia.Generate(Doc.Source, path, profile, CancellationToken.None));
     Checkpoint();
     Doc.OptimizedPath = info.File;
     Doc.OptimizedEnabled = true;
     Changed();
     BuildInspector();
     RefreshMediaLibrary();
     Status("优化媒体已生成 · " + info.Width + "x" + info.Height + " " + info.Profile + "。");
    } catch (Exception ex) { Error(ex); }
   }));
   if (has) inspector.Children.Add(InspectorAction("trash", "删除优化媒体文件", () => {
    try { File.Delete(Doc.OptimizedPath); } catch (Exception ex) { Error(ex); return; }
    Checkpoint();
    Doc.OptimizedPath = "";
    Doc.OptimizedEnabled = false;
    Changed();
    BuildInspector();
    RefreshMediaLibrary();
   }, true));
   Note("优化媒体是全分辨率帧内中间片（dnxhd 编码器，LGPL），调色/抠像时解码便宜。导出始终用原片（relink），优化媒体缺失是硬错、不静默回退。");
  }

  // ---- 13/14. 观察文件夹 + 导入收录（代理 tab，优化媒体之后）----
  List<string> watchFound;
  void BuildWatchFolderSection() {
   Section("观察文件夹 · 导入收录");
   Note("监看文件夹：新增素材自动列出来，点确认才导入（不自动吞文件）。导入时可选复制到项目媒体文件夹，或转码成中间片（与优化媒体共用转码管线）。");
   Note(string.IsNullOrEmpty(Doc.WatchFolder) ? "还没有监看文件夹。" : "监看：" + Doc.WatchFolder);
   inspector.Children.Add(InspectorAction("folder", "选择监看文件夹…", () => {
    var dlg = new System.Windows.Forms.FolderBrowserDialog { Description = "选择要监看的文件夹" };
    if (dlg.ShowDialog() != System.Windows.Forms.DialogResult.OK) return;
    Checkpoint();
    Doc.WatchFolder = dlg.SelectedPath;
    Changed();
    BuildInspector();
   }));
   Choices("导入时转码", Doc.IngestTranscode, new[] { new[] { "只复制", "none" }, new[] { "转码成 DNxHR 中间片", "dnxhr" }, new[] { "转码成 720p 代理", "proxy" } }, v => Doc.IngestTranscode = v);
   inspector.Children.Add(InspectorAction("plus", "扫描新增素材", () => {
    if (Doc == null || string.IsNullOrEmpty(Doc.WatchFolder)) return;
    try {
     watchFound = WatchFolder.Scan(Doc.WatchFolder, new List<string> { Doc.Source });
     BuildInspector();
     Status(watchFound.Count == 0 ? "没有新增素材。" : "找到新增素材 " + watchFound.Count + " 个。");
    } catch (Exception ex) { Error(ex); }
   }));
   if (watchFound != null && watchFound.Count > 0) {
    Note("新增 " + watchFound.Count + " 个：\n" + string.Join("\n", watchFound.Select(f => Path.GetFileName(f)).ToArray()));
    inspector.Children.Add(InspectorAction("plus", "全部导入（" + watchFound.Count + " 个）", async () => {
     if (Doc == null) return;
     Status("正在导入…");
     try {
      string projectDir = string.IsNullOrEmpty(FilePath) ? Path.GetDirectoryName(Doc.Source) : Path.GetDirectoryName(FilePath);
      string transcode = Doc.IngestTranscode;
      var files = watchFound.ToList();
      int n = 0;
      foreach (string f in files) { string file = f; await Task.Run(() => Ingest.IngestFile(file, projectDir, transcode, CancellationToken.None)); n++; }
      watchFound = null;
      BuildInspector();
      RefreshMediaLibrary();
      Status("已导入 " + n + " 个素材到项目媒体文件夹。");
     } catch (Exception ex) { Error(ex); }
    }));
   }
   inspector.Children.Add(InspectorAction("folder", "导入单个文件…", () => {
    var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "媒体文件|*.mp4;*.mov;*.mkv;*.webm;*.mp3;*.wav;*.m4a;*.aac;*.png;*.jpg;*.jpeg;*.bmp" };
    if (dlg.ShowDialog(Window) != true) return;
    try {
     string projectDir = string.IsNullOrEmpty(FilePath) ? Path.GetDirectoryName(Doc.Source) : Path.GetDirectoryName(FilePath);
     var result = Ingest.IngestFile(dlg.FileName, projectDir, Doc.IngestTranscode, CancellationToken.None);
     Status("已导入 · " + result.File + (result.Transcoded == null ? "" : "（转码：" + result.Transcoded + "）"));
    } catch (Exception ex) { Error(ex); }
   }));
  }

  // ---- 10. 元数据面板（备份 tab）----
  void BuildMetadataSection() {
   Section("素材元数据");
   Note("场景/场次/关键词/备注存在项目文件里（project.json），ALE 导出供跨软件交接。");
   var md = Doc.Metadata ?? new ClipMetadata();
   if (Doc.Metadata == null) Doc.Metadata = md;
   var scene = new TextBox { Text = md.Scene, FontSize = 13, Margin = new Thickness(0, 4, 0, 9) };
   scene.LostKeyboardFocus += (s, e) => { Checkpoint(); md.Scene = scene.Text; Changed(); };
   inspector.Children.Add(UI.Text("场景", 12, "#63696D"));
   inspector.Children.Add(scene);
   var take = new TextBox { Text = md.Take, FontSize = 13, Margin = new Thickness(0, 4, 0, 9) };
   take.LostKeyboardFocus += (s, e) => { Checkpoint(); md.Take = take.Text; Changed(); };
   inspector.Children.Add(UI.Text("场次", 12, "#63696D"));
   inspector.Children.Add(take);
   var keywords = new TextBox { Text = string.Join(";", (md.Keywords ?? new List<string>()).ToArray()), FontSize = 13, Margin = new Thickness(0, 4, 0, 9) };
   keywords.LostKeyboardFocus += (s, e) => { Checkpoint(); md.Keywords = keywords.Text.Split(new[] { ';', ',', '，' }, StringSplitOptions.RemoveEmptyEntries).Select(k => k.Trim()).Where(k => k.Length > 0).ToList(); Changed(); };
   inspector.Children.Add(UI.Text("关键词（分号分隔）", 12, "#63696D"));
   inspector.Children.Add(keywords);
   var notes = new TextBox { Text = md.Notes, AcceptsReturn = true, MinHeight = 44, TextWrapping = TextWrapping.Wrap, FontSize = 13, Margin = new Thickness(0, 4, 0, 9) };
   notes.LostKeyboardFocus += (s, e) => { Checkpoint(); md.Notes = notes.Text; Changed(); };
   inspector.Children.Add(UI.Text("备注", 12, "#63696D"));
   inspector.Children.Add(notes);
   inspector.Children.Add(InspectorAction("export", "导出 ALE（跨软件交接）", () => {
    if (Doc == null) return;
    try {
     var dlg = new Microsoft.Win32.SaveFileDialog { Filter = "ALE 文件|*.ale", FileName = Doc.Name + ".ale" };
     if (dlg.ShowDialog(Window) != true) return;
     File.WriteAllText(dlg.FileName, AleExport.ToAle(Doc), new UTF8Encoding(false));
     Status("ALE 已导出 · " + dlg.FileName);
    } catch (Exception ex) { Error(ex); }
   }));
  }

  // ---- 11. 归档/重链接（备份 tab，元数据之后）----
  void BuildArchiveSection() {
   Section("归档 / 重链接");
   Note("归档：源文件（+ 代理/优化媒体/多机位角度）+ 项目打包到一个文件夹，路径改写成相对路径，文件夹能独立打开。源文件缺失时拒绝归档（带洞的归档不如不归档）。");
   inspector.Children.Add(InspectorAction("folder", "归档项目到文件夹…", () => {
    if (Doc == null) return;
    try {
     var dlg = new System.Windows.Forms.FolderBrowserDialog { Description = "选择归档目标文件夹" };
     if (dlg.ShowDialog() != System.Windows.Forms.DialogResult.OK) return;
     var result = MediaArchive.Archive(Doc, FilePath, dlg.SelectedPath);
     Status("已归档 " + result.Copied.Count + " 个文件 · " + result.ProjectFile);
    } catch (Exception ex) { Error(ex); }
   }));
   Note("重链接：主素材丢了时，按文件名在文件夹里找，时长与原片差 ±0.1 秒才认；同名出现两个不猜，手动选。");
   inspector.Children.Add(InspectorAction("folder", "重链接丢失的素材…", () => {
    if (Doc == null) return;
    try {
     var dlg = new System.Windows.Forms.FolderBrowserDialog { Description = "选择素材所在的文件夹" };
     if (dlg.ShowDialog() != System.Windows.Forms.DialogResult.OK) return;
     Checkpoint();
     string report = MediaArchive.Relink(Doc, dlg.SelectedPath);
     Changed();
     BuildInspector();
     Status(string.IsNullOrEmpty(report) ? "没有丢失的素材。" : report);
    } catch (Exception ex) { Error(ex); }
   }));
  }

  // ---- 8. AI 放大（代理 tab 补充说明，开关放在导出窗口逻辑里说明）----
  void BuildUpscaleSection() {
   Section("AI 放大 · 导出时可选");
   Toggle("导出时 AI 放大", Doc.UpscaleEnabled, v => { Doc.UpscaleEnabled = v; BuildInspector(); });
   Choices("放大到", Doc.UpscaleTarget, new[] { new[] { "1080p", "1080p" }, new[] { "4K", "4K" } }, v => Doc.UpscaleTarget = v);
   string problem = Upscaler.CheckAvailable(Doc.UpscaleModel);
   Note(problem ?? "模型已就绪（Real-ESRGAN 类 ONNX，本地跑）。");
   Note("只在导出时跑：对已渲染好的成片逐帧超分，慢（1080p 约 90 ms/帧量级，60 秒片要几分钟）。模型许可发版前再核；模型缺失时导出直接报错，绝不用普通放大冒充。目标必须大于成片尺寸，否则拒绝。");
  }
 }
}
