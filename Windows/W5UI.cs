// W5 检查器 UI（2026-11-18）：Whisper 自动字幕、HSL 曲线编辑器、电平表、
// 美颜/降噪、录制标记、变速（精细滑杆 + 节拍检测 + 卡点变速）。
// 控件全部复用现有检查器助手（Section/Note/Slider/Number/Toggle/Buttons/
// Choices/InspectorAction），不抄任何闭源软件的界面。
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
using System.Windows.Shapes;
using DogSC.Windows;
using Path = System.IO.Path;

namespace DogSC.Replica {
 public partial class Studio {
  // ---- W5 字段 ----
  readonly LevelMeter levelMeter = new LevelMeter();
  bool levelSubscribed;
  Rectangle levelPeakFill, levelRmsFill;
  TextBlock levelText;
  double levelLastRms = -91, levelLastPeak = -91, levelPeakHold = -91;
  string levelStatic = "";
  bool whisperRunning;
  string whisperModel = "small", whisperLang = "zh";
  CancellationTokenSource whisperCts;
  TextBlock whisperStatus;
  bool beautyBusy;
  TextBlock beautyStatus;
  double beatSlow = 0.5, beatFast = 2;
  bool beatStartSlow = true;
  BeatGrid lastBeatGrid;
  int lastBeatCut = -1;

  // ---- 1. Whisper 自动识别字幕（字幕面板）----
  void BuildWhisperSection() {
   Section("自动识别字幕（Whisper）");
   whisperStatus = UI.Text(WhisperTranscriber.DescribeBackend(), 12, "#63696D");
   whisperStatus.TextWrapping = TextWrapping.Wrap;
   whisperStatus.Margin = new Thickness(0, 0, 0, 8);
   inspector.Children.Add(whisperStatus);
   Choices("模型", whisperModel, new[] { new[] { "tiny（快，不准）", "tiny" }, new[] { "small（默认，可用）", "small" }, new[] { "medium（更准，更慢）", "medium" } }, v => whisperModel = v);
   Choices("语言", whisperLang, new[] { new[] { "中文", "zh" }, new[] { "English", "en" }, new[] { "自动", "auto" } }, v => whisperLang = v);
   inspector.Children.Add(InspectorAction("sound", whisperRunning ? "取消转写" : "开始识别（整条音轨）", () => { if (whisperRunning) { try { whisperCts.Cancel(); } catch { } } else RunWhisper(); }));
   string cli = WhisperTranscriber.FindWhisperCpp();
   if (cli != null && !File.Exists(WhisperTranscriber.WhisperCppModelPath(whisperModel))) {
    string model = whisperModel;
    inspector.Children.Add(InspectorAction("folder", "下载 " + model + " 模型（首次，约 " + (model == "tiny" ? "75 MB" : model == "small" ? "466 MB" : "1.5 GB") + "）", () => DownloadWhisperModel(model)));
   }
   Note("转写在本地跑，不走云端；small 是默认模型（P0b 实测：tiny 字错率 52.4% 不可用，small 26.2% 可用，仍需校对）。转写输出是繁体，烧录前请在字幕列表里改成简体。识别出的字幕进字幕列表，可编辑；烧录/边车开关沿用上面的设置（P3c 的 deliver 规格：烧录走 GDI+ 双语、边车 SRT/VTT/ASS）。");
  }
  async void RunWhisper() {
   if (Doc == null || whisperRunning) return;
   whisperRunning = true;
   whisperCts = new CancellationTokenSource();
   BuildInspector();
   try {
    var result = await WhisperTranscriber.TranscribeAsync(Doc.Source, whisperModel, whisperLang, s => Window.Dispatcher.Invoke(new Action(() => { if (whisperStatus != null) whisperStatus.Text = s; })), whisperCts.Token);
    Checkpoint();
    Doc.Subtitles.AddRange(result.Cues);
    Doc.Subtitles.Sort((a, b) => a.Start.CompareTo(b.Start));
    selectedSubtitle = Doc.Subtitles.Count - 1;
    Changed();
    BuildInspector();
    RefreshMediaLibrary();
    Status("已识别字幕 " + result.Cues.Count + " 条 · " + result.Backend + " · " + result.Model + "（繁体，请校对改简体）");
   }
   catch (OperationCanceledException) { Status("转写已取消。"); }
   catch (Exception ex) { Error(ex); }
   finally { whisperRunning = false; whisperCts = null; BuildInspector(); }
  }
  async void DownloadWhisperModel(string model) {
   var cts = new CancellationTokenSource();
   try {
    await WhisperTranscriber.DownloadModelAsync(model, s => Window.Dispatcher.Invoke(new Action(() => { if (whisperStatus != null) whisperStatus.Text = s; })), cts.Token);
    Status("模型已下载 · " + model);
    BuildInspector();
   }
   catch (Exception ex) { Error(ex); }
  }

  // ---- 2. HSL 曲线编辑器（画面-调色）----
  void BuildHslCurveSection() {
   var g = Doc.Grade;
   if (g.HslCurveSat == null) g.HslCurveSat = HslCurves.IdentitySat();
   if (g.HslCurveLum == null) g.HslCurveLum = HslCurves.IdentityLum();
   Section("HSL 曲线");
   HslCurveEditor("色相 – 饱和度（x = 色相 0–360°，y = 饱和度倍数，1 = 不变）", g.HslCurveSat, 0, 3, 1, () => { Checkpoint(); g.HslCurveSat = HslCurves.IdentitySat(); Changed(); BuildInspector(); });
   HslCurveEditor("色相 – 明度（x = 色相 0–360°，y = 明度增量，0 = 不变）", g.HslCurveLum, -1, 1, 0, () => { Checkpoint(); g.HslCurveLum = HslCurves.IdentityLum(); Changed(); BuildInspector(); });
   Note("曲线烤进 17³ .cube（与 HSL 分区、色轮同一条 LUT 路，预览与导出一致；color.ts 的 applyCurve：分段线性、端点外钳制）。拖点移动，双击加曲点，右键点删除（至少留 2 个点）。RGB/主曲线见下面一节（W6 接线）。");
  }
  void HslCurveEditor(string title, List<CurvePoint> points, double yLo, double yHi, double neutral, Action reset) {
   var label = UI.Text(title, 13, "#63696D");
   label.Margin = new Thickness(0, 9, 0, 3);
   inspector.Children.Add(label);
   const double w = 248, h = 110;
   var canvas = new Canvas { Width = w, Height = h, Cursor = Cursors.Cross, ClipToBounds = true, Margin = new Thickness(0, 4, 0, 4) };
   UI.Role(canvas, Panel.BackgroundProperty, "Well");
   inspector.Children.Add(canvas);
   var resetButton = UI.Button("重置这条曲线", reset);
   resetButton.FontSize = 11;
   resetButton.Padding = new Thickness(8, 3, 8, 3);
   resetButton.Margin = new Thickness(0, 0, 0, 8);
   inspector.Children.Add(resetButton);
   Func<double, double> toX = x => x * w;
   Func<double, double> toY = y => h - (y - yLo) / (yHi - yLo) * h;
   Func<double, double> fromX = px => Math.Max(0, Math.Min(1, px / w));
   Func<double, double> fromY = py => Math.Max(yLo, Math.Min(yHi, yLo + (h - py) / h * (yHi - yLo)));
   Polyline line = null;
   var dots = new List<Ellipse>();
   int dragging = -1;
   Action draw = null;
   draw = () => {
    canvas.Children.Clear();
    dots.Clear();
    var axis = new Line { X1 = 0, X2 = w, Y1 = toY(neutral), Y2 = toY(neutral), Stroke = UI.Brush("#B9BFC3"), StrokeThickness = 1, StrokeDashArray = new DoubleCollection { 3, 3 }, IsHitTestVisible = false };
    canvas.Children.Add(axis);
    for (int k = 0; k <= 4; k++) {
     double gx = w * k / 4;
     canvas.Children.Add(new Line { X1 = gx, X2 = gx, Y1 = 0, Y2 = h, Stroke = UI.Brush("#E4E8EB"), StrokeThickness = 1, IsHitTestVisible = false });
    }
    line = new Polyline { Stroke = UI.Brush("#667870"), StrokeThickness = 2, IsHitTestVisible = false };
    foreach (var p in points) line.Points.Add(new Point(toX(p.X), toY(p.Y)));
    canvas.Children.Add(line);
    for (int i = 0; i < points.Count; i++) {
     int index = i;
     var dot = new Ellipse { Width = 12, Height = 12, Fill = UI.Brush("#FFFFFF"), Stroke = UI.Brush("#667870"), StrokeThickness = 2, Cursor = Cursors.Hand };
     Canvas.SetLeft(dot, toX(points[i].X) - 6);
     Canvas.SetTop(dot, toY(points[i].Y) - 6);
     dot.MouseLeftButtonDown += (s, e) => { Checkpoint(); dragging = index; canvas.CaptureMouse(); e.Handled = true; };
     dot.MouseRightButtonDown += (s, e) => {
      if (points.Count > 2) { Checkpoint(); points.RemoveAt(index); Changed(); draw(); }
      e.Handled = true;
     };
     canvas.Children.Add(dot);
     dots.Add(dot);
    }
   };
   draw();
   Action<MouseEventArgs> move = e => {
    if (dragging < 0 || dragging >= points.Count) return;
    var p = e.GetPosition(canvas);
    double lo = dragging > 0 ? points[dragging - 1].X + 0.001 : 0;
    double hi = dragging < points.Count - 1 ? points[dragging + 1].X - 0.001 : 1;
    points[dragging].X = Math.Max(lo, Math.Min(hi, fromX(p.X)));
    points[dragging].Y = fromY(p.Y);
    line.Points[dragging] = new Point(toX(points[dragging].X), toY(points[dragging].Y));
    if (dragging < dots.Count) { Canvas.SetLeft(dots[dragging], toX(points[dragging].X) - 6); Canvas.SetTop(dots[dragging], toY(points[dragging].Y) - 6); }
    Changed();
   };
   canvas.MouseLeftButtonDown += (s, e) => {
    if (e.OriginalSource is Ellipse) return;
    if (e.ClickCount == 2 && points.Count < 8) {
     var p = e.GetPosition(canvas);
     double x = fromX(p.X);
     int at = points.FindIndex(q => q.X > x);
     if (at < 0) at = points.Count;
     Checkpoint();
     points.Insert(at, new CurvePoint { X = x, Y = fromY(p.Y) });
     Changed();
     draw();
     e.Handled = true;
    }
   };
   canvas.MouseMove += (s, e) => move(e);
   canvas.MouseLeftButtonUp += (s, e) => { dragging = -1; canvas.ReleaseMouseCapture(); e.Handled = true; };
   canvas.LostMouseCapture += (s, e) => dragging = -1;
  }

  // ---- 3. 电平表（混音台）----
  void BuildLevelMeterSection() {
   Section("电平表");
   levelPeakHold = -91;
   if (!levelSubscribed) {
    levelSubscribed = true;
    levelMeter.Updated += OnLevelUpdate;
   }
   var grid = new Grid { Margin = new Thickness(0, 4, 0, 4) };
   grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(34) });
   grid.ColumnDefinitions.Add(new ColumnDefinition());
   var peakLabel = UI.Text("峰值", 12, "#63696D");
   peakLabel.VerticalAlignment = VerticalAlignment.Center;
   grid.Children.Add(peakLabel);
   var peakTrack = new Border { Height = 12, CornerRadius = new CornerRadius(6), Background = UI.Brush("#E8EAEC") };
   Grid.SetColumn(peakTrack, 1);
   grid.Children.Add(peakTrack);
   levelPeakFill = new Rectangle { Height = 12, Width = 0, RadiusX = 6, RadiusY = 6, Fill = UI.Brush("#DE5E57"), HorizontalAlignment = HorizontalAlignment.Left };
   Grid.SetColumn(levelPeakFill, 1);
   grid.Children.Add(levelPeakFill);
   inspector.Children.Add(grid);
   var grid2 = new Grid { Margin = new Thickness(0, 4, 0, 4) };
   grid2.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(34) });
   grid2.ColumnDefinitions.Add(new ColumnDefinition());
   var rmsLabel = UI.Text("RMS", 12, "#63696D");
   rmsLabel.VerticalAlignment = VerticalAlignment.Center;
   grid2.Children.Add(rmsLabel);
   var rmsTrack = new Border { Height = 12, CornerRadius = new CornerRadius(6), Background = UI.Brush("#E8EAEC") };
   Grid.SetColumn(rmsTrack, 1);
   grid2.Children.Add(rmsTrack);
   levelRmsFill = new Rectangle { Height = 12, Width = 0, RadiusX = 6, RadiusY = 6, Fill = UI.Brush("#667870"), HorizontalAlignment = HorizontalAlignment.Left };
   Grid.SetColumn(levelRmsFill, 1);
   grid2.Children.Add(levelRmsFill);
   inspector.Children.Add(grid2);
   levelText = UI.Text("峰值 — dB · RMS — dB（播放时实时跟随）", 12, "#63696D");
   levelText.Margin = new Thickness(0, 4, 0, 4);
   inspector.Children.Add(levelText);
   inspector.Children.Add(InspectorAction("sound", "分析当前片段电平", () => AnalyzeLevels()));
   if (!string.IsNullOrEmpty(levelStatic)) Note(levelStatic);
   Note("播放时电平表实时跟随（ffmpeg astats，-re  pacing，近似同步；静音底 -91 dB）。分析用 volumedetect（平均/峰值）。");
  }
  static double DbFrac(double db) { return Math.Max(0, Math.Min(1, (db + 60) / 60)); }
  void OnLevelUpdate(double t, double rms, double peak) {
   levelLastRms = rms;
   levelLastPeak = peak;
   if (peak > levelPeakHold) levelPeakHold = peak;
   Window.Dispatcher.Invoke(new Action(() => {
    if (levelPeakFill == null || levelRmsFill == null || levelText == null) return;
    levelPeakFill.Width = 232 * DbFrac(peak);
    levelRmsFill.Width = 232 * DbFrac(rms);
    levelText.Text = "峰值 " + peak.ToString("0.0", CultureInfo.InvariantCulture) + " dB · RMS " + rms.ToString("0.0", CultureInfo.InvariantCulture) + " dB" + (levelPeakHold > -90 ? " · 峰值保持 " + levelPeakHold.ToString("0.0", CultureInfo.InvariantCulture) + " dB" : "");
   }));
  }
  async void AnalyzeLevels() {
   if (Doc == null) return;
   double from = 0, dur = Doc.Length;
   if (selectedCut >= 0 && selectedCut < Doc.Cuts.Count && !Doc.Cuts[selectedCut].Gap) { from = Doc.Cuts[selectedCut].Start; dur = Doc.Cuts[selectedCut].End - Doc.Cuts[selectedCut].Start; }
   if (!Doc.Audio) { Status("当前素材没有音轨，无法分析电平。"); return; }
   string source = Doc.Source;
   Status("正在分析电平…");
   try {
    var result = await Task.Run(() => LevelMeter.Analyze(source, from, dur, CancellationToken.None));
    levelStatic = "静态分析（" + UI.Time(from) + "–" + UI.Time(from + dur) + "）：平均 " + result.Item1.ToString("0.0", CultureInfo.InvariantCulture) + " dB · 峰值 " + result.Item2.ToString("0.0", CultureInfo.InvariantCulture) + " dB。";
    BuildInspector();
    Status(levelStatic);
   }
   catch (Exception ex) { Error(ex); }
  }

  // ---- 4. 美颜 / 降噪（新检查器 tab）----
  void BuildBeautyInspector() {
   Section("视频降噪");
   Slider("降噪强度", 0, 100, Doc.DenoiseStrength, "", v => Doc.DenoiseStrength = v);
   Note("FFmpeg hqdn3d 时空降噪（引擎 P3d 映射：强度 50 → hqdn3d=4.00:3.00:5.00:4.00；强度 100 时噪点灰帧 HF 10.56→6.37、亮度不变）。整条时间线统一强度（引擎是逐片段；C# 解码时作用于已拼好的时间线）。预览与导出一致。");
   Section("美颜（人像限定）");
   Toggle("启用美颜", Doc.BeautyEnabled, v => { Doc.BeautyEnabled = v; BuildInspector(); });
   Slider("美颜强度", 0, 100, Doc.BeautyStrength, "", v => Doc.BeautyStrength = v);
   Buttons(new[] { "单人", "多人" }, Doc.BeautyMode == "multi" ? "多人" : "单人", v => { Checkpoint(); Doc.BeautyMode = v == "多人" ? "multi" : "single"; Changed(); BuildInspector(); });
   Slider("边缘羽化", 0, 5, Doc.BeautyEdgeFeather, "", v => Doc.BeautyEdgeFeather = v);
   string mask = Doc.BeautyMaskPath;
   bool hasMask = !string.IsNullOrEmpty(mask) && File.Exists(mask);
   beautyStatus = UI.Text(hasMask ? ("人像遮罩：" + mask + (BeautyMask.IsStale(Doc.Source, mask) ? "\n源文件比遮罩新，遮罩可能过期，建议重新生成。" : "")) : "还没有人像遮罩。美颜只作用于人物（遮罩限定），无遮罩时开启会报错——与引擎一致，遮罩缺失是硬错。", 12, "#63696D");
   beautyStatus.TextWrapping = TextWrapping.Wrap;
   beautyStatus.Margin = new Thickness(0, 0, 0, 8);
   inspector.Children.Add(beautyStatus);
   inspector.Children.Add(InspectorAction("camera", beautyBusy ? "正在生成遮罩…" : "生成遮罩（ONNX 人像分割）", () => { if (!beautyBusy) GenerateBeautyMask(); }));
   inspector.Children.Add(InspectorAction("folder", "选择已有遮罩文件…", () => PickBeautyMask()));
   if (hasMask) inspector.Children.Add(InspectorAction("trash", "清除遮罩并关闭美颜", () => { Checkpoint(); Doc.BeautyMaskPath = ""; Doc.BeautyEnabled = false; Changed(); BuildInspector(); }, true));
   Note("遮罩生成需要系统 Python + onnxruntime + numpy（pip install onnxruntime numpy）；模型（MediaPipe Selfie Segmentation，Apache 2.0）随包分发。美颜链与引擎一致：hqdn3d + 轻微提亮 + unsharp 0.1，遮罩外不动。多机位/变速片段下不可用（引擎 v1 限制）。导出时若时间线含空隙/多片段，会按当前时间线重算遮罩（较慢，一次）。");
   BuildPortraitBgSection();BuildOutlineSection();
  }
  async void GenerateBeautyMask() {
   if (Doc == null || beautyBusy) return;
   beautyBusy = true;
   BuildInspector();
   try {
    string path = await BeautyMask.GenerateAsync(Doc.Source, Doc.BeautyMode, s => Window.Dispatcher.Invoke(new Action(() => { if (beautyStatus != null) beautyStatus.Text = s; })), CancellationToken.None);
    Checkpoint();
    Doc.BeautyMaskPath = path;
    Changed();
    BuildInspector();
    Status("人像遮罩已生成 · " + path);
   }
   catch (Exception ex) { Error(ex); }
   finally { beautyBusy = false; BuildInspector(); }
  }
  void PickBeautyMask() {
   if (Doc == null) return;
   var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "遮罩视频|*.mp4;*.mov;*.mkv|所有文件|*.*" };
   if (dlg.ShowDialog(Window) != true) return;
   Checkpoint();
   Doc.BeautyMaskPath = Path.GetFullPath(dlg.FileName);
   Changed();
   BuildInspector();
   Status("已关联人像遮罩 · " + Doc.BeautyMaskPath);
  }

  // ---- 5. 录制标记（新检查器 tab）----
  void BuildMarkerInspector() {
   Section("录制标记（" + Doc.RecordingMarkers.Count + " 个）");
   if (Doc.RecordingMarkers.Count == 0) { Note("还没有标记。录制时点浮条上的“标记”按钮打点，也可在这里手动添加。"); }
   foreach (var m in Doc.RecordingMarkers.ToList()) {
    var marker = m;
    var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 3, 0, 3) };
    var jump = UI.Button(UI.Time(marker.Time) + "  " + (string.IsNullOrEmpty(marker.Label) ? "标记" : marker.Label), () => Seek(marker.Time));
    jump.FontSize = 12;
    jump.HorizontalContentAlignment = HorizontalAlignment.Left;
    jump.MinWidth = 170;
    row.Children.Add(jump);
    var del = UI.Button("删除", () => { Checkpoint(); Doc.RecordingMarkers.Remove(marker); Changed(); BuildInspector(); DrawTimeline(); });
    del.FontSize = 11;
    del.Padding = new Thickness(8, 3, 8, 3);
    del.Margin = new Thickness(6, 0, 0, 0);
    row.Children.Add(del);
    inspector.Children.Add(row);
   }
   inspector.Children.Add(InspectorAction("plus", "在播放头处添加标记", () => {
    Checkpoint();
    Doc.RecordingMarkers.Add(new RecordingMarker { Time = position, Label = "标记 " + (Doc.RecordingMarkers.Count + 1) });
    Doc.RecordingMarkers.Sort((a, b) => a.Time.CompareTo(b.Time));
    Changed();
    BuildInspector();
    DrawTimeline();
   }));
   Note("标记在时间线上画红线，点击可跳转。导出成片时不写入章节（引擎 P3e 支持 ffmetadata 章节，WPF 导出未接）。");
  }

  // ---- 6. 变速（选中片段的检查器里）----
  void BuildSpeedSection(Cut c) {
   Section("播放速度");
   Slider("播放速度（精细）", .5, 2, c.Speed, "×", v => { c.Speed = v; Doc.GenerateZooms(); });
   Section("卡点变速");
   string beatInfo = lastBeatGrid == null || lastBeatCut != selectedCut
    ? "尚未检测节拍。先点“检测节拍”（只认起音丰富的音频，如鼓点；人声独白置信度低）。"
    : "上次检测：" + lastBeatGrid.Bpm.ToString("0.0", CultureInfo.InvariantCulture) + " BPM · " + lastBeatGrid.Beats.Count + " 拍 · 置信度 " + lastBeatGrid.Confidence.ToString("0.00", CultureInfo.InvariantCulture) + "。";
   Note(beatInfo);
   inspector.Children.Add(InspectorAction("sound", "检测节拍", () => DetectBeats()));
   Slider("慢速", .25, 1, beatSlow, "×", v => beatSlow = v);
   Slider("快速", 1, 4, beatFast, "×", v => beatFast = v);
   Buttons(new[] { "慢起", "快起" }, beatStartSlow ? "慢起" : "快起", v => beatStartSlow = v == "慢起");
   if (lastBeatGrid != null && lastBeatCut == selectedCut && lastBeatGrid.Beats.Count > 0) {
    inspector.Children.Add(InspectorAction("cut", "应用卡点变速（按节拍切分，慢/快交替）", () => ApplyBeatSplit()));
   }
   Note("卡点变速以切分片段实现：每拍一切，慢/快交替（默认 0.5×/2×，与引擎 beatSpeed 同速），输出时长与引擎一致；切完可逐段再调速度。变速片段下多机位不可用。");
  }
  async void DetectBeats() {
   if (Doc == null || selectedCut < 0 || selectedCut >= Doc.Cuts.Count) return;
   var cut = Doc.Cuts[selectedCut];
   if (cut.Gap) { Status("空隙片段不能检测节拍。"); return; }
   if (!Doc.Audio) { Status("当前素材没有音轨，无法检测节拍。"); return; }
   int index = selectedCut;
   Status("正在检测节拍…");
   try {
    var grid = await Task.Run(() => BeatDetector.Detect(Doc.Source, cut.Start, cut.End - cut.Start, CancellationToken.None));
    lastBeatGrid = grid;
    lastBeatCut = index;
    BuildInspector();
    Status(grid.Beats.Count == 0 ? "未检测到节拍（置信度 0；音频可能缺少起音）。" : "节拍检测完成：" + grid.Bpm.ToString("0.0", CultureInfo.InvariantCulture) + " BPM · " + grid.Beats.Count + " 拍 · 置信度 " + grid.Confidence.ToString("0.00", CultureInfo.InvariantCulture));
   }
   catch (Exception ex) { Error(ex); }
  }
  void ApplyBeatSplit() {
   if (Doc == null || lastBeatGrid == null || lastBeatCut != selectedCut) return;
   try {
    Checkpoint();
    int n = BeatDetector.ApplyBeatSplit(Doc, selectedCut, lastBeatGrid.Beats, beatSlow, beatFast, beatStartSlow, 0.5);
    selectedCut = -1;
    lastBeatGrid = null;
    lastBeatCut = -1;
    Changed();
    BuildInspector();
    DrawTimeline();
    Status("已按节拍切成 " + n + " 段（慢 " + beatSlow.ToString("0.##", CultureInfo.InvariantCulture) + "× / 快 " + beatFast.ToString("0.##", CultureInfo.InvariantCulture) + "× 交替）。");
   }
   catch (Exception ex) { Error(ex); }
  }
 }

 // 系统声音混音设置对话框（录制浮条的系统声音按钮用）。
 static class SystemAudioDialog {
  public static Tuple<string, double> Show(Window owner, string currentDevice, double currentVolume) {
   var dlg = new Window { Owner = owner, Title = "系统声音混音", Width = 480, Height = 380, WindowStartupLocation = WindowStartupLocation.CenterOwner, ResizeMode = ResizeMode.NoResize, FontFamily = owner.FontFamily, FontSize = 12 };
   dlg.Resources = owner.Resources;
   var root = new StackPanel { Margin = new Thickness(20) };
   dlg.Content = root;
   root.Children.Add(UI.Text("系统声音（立体声混音）", 15));
   var titleNote = UI.Text("把电脑正在放的声音（视频、音乐、会议）和麦克风一起录进去。", 12, "#63696D");
   titleNote.Margin = new Thickness(0, 6, 0, 12);
   titleNote.TextWrapping = TextWrapping.Wrap;
   root.Children.Add(titleNote);
   var combo = new ComboBox { FontSize = 13, Margin = new Thickness(0, 0, 0, 12) };
   var candidates = CameraDevices.SystemAudioCandidates();
   var comboDevices = new List<string> { "" };
   combo.Items.Add("关闭系统声音");
   foreach (string name in candidates) { combo.Items.Add(name); comboDevices.Add(name); }
   int currentIndex = string.IsNullOrEmpty(currentDevice) ? 0 : comboDevices.IndexOf(currentDevice);
   if (currentIndex < 0) { combo.Items.Add(currentDevice + "（当前已选，但本次检测未找到）"); comboDevices.Add(currentDevice); currentIndex = comboDevices.Count - 1; }
   combo.SelectedIndex = currentIndex;
   root.Children.Add(combo);
   var volLabel = UI.Text("系统声音音量", 12, "#63696D");
   root.Children.Add(volLabel);
   var slider = new Slider { Minimum = 0, Maximum = 100, Value = currentVolume * 100, Margin = new Thickness(0, 6, 0, 4) };
   root.Children.Add(slider);
   var volText = UI.Text(((int)(currentVolume * 100)) + "%", 12, "#63696D");
   slider.ValueChanged += (s, e) => volText.Text = ((int)slider.Value) + "%";
   root.Children.Add(volText);
   var survey = UI.Text(CameraDevices.Survey(), 11, "#63696D");
   survey.TextWrapping = TextWrapping.Wrap;
   survey.Margin = new Thickness(0, 12, 0, 12);
   root.Children.Add(survey);
   var note = UI.Text("没找到立体声混音？在 Windows 设置 → 声音 → 输入里启用“立体声混音”（部分声卡/驱动没有这路输入，那就没有系统声音可录——这是声卡驱动决定的，不是软件问题；虚拟声卡是另一条路，本批不接）。", 11, "#63696D");
   note.TextWrapping = TextWrapping.Wrap;
   root.Children.Add(note);
   var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 16, 0, 0) };
   var ok = UI.Button("确定", () => { dlg.DialogResult = true; dlg.Close(); });
   ok.Padding = new Thickness(18, 6, 18, 6);
   ok.Margin = new Thickness(0, 0, 8, 0);
   var cancel = UI.Button("取消", () => { dlg.DialogResult = false; dlg.Close(); });
   cancel.Padding = new Thickness(18, 6, 18, 6);
   buttons.Children.Add(ok);
   buttons.Children.Add(cancel);
   root.Children.Add(buttons);
   if (dlg.ShowDialog() != true) return null;
   return Tuple.Create(comboDevices[combo.SelectedIndex], slider.Value / 100);
  }
 }
}
