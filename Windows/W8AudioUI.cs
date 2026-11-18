// W8 音频高级 UI（2026-11-18）：音频修复、EQ 曲线拖动、压缩器旋钮、变声、
// 人声分离、TTS 面板、环绕声；子片段行挂在素材库“素材”分栏。
// 控件全部复用现有检查器助手（Section/Note/Slider/Toggle/Choices/
// Buttons/InspectorAction）+ W5 的 HslCurveEditor 同款 Canvas 拖拽，
// 不抄任何闭源软件的界面。诚实说明写在各面板的 Note 里；云端 runner
// 无真 GPU/摄像头/麦克风、无 Demucs/Sherpa 模型，那些交互与模型实跑
// 只能在真机上验证，面板里写明，不假装验过。
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using DogSC.Windows;

namespace DogSC.Replica {
 public partial class Studio {
  // ---- 1. 音频修复（声音 tab，音频类型面板之后）----
  void BuildRepairSection() {
   var r = Doc.Repair;
   Section("音频修复");
   Note("去咔哒声（adeclick）→ 去电流嗡鸣（高通）→ 降噪（afftdn nr=25:nf=-30，强度 100 时正好是验证过的数）。去混响 v1 不做：FFmpeg 没有去混响滤镜。修复只在导出里生效，预览只调音量。");
   Toggle("去咔哒声 / 爆音（adeclick）", r.Declick, v => r.Declick = v);
   Slider("去电流声高通截止", 0, 200, r.HumCutoffHz, " Hz", v => r.HumCutoffHz = v);
   Note("高通截止 0 = 关闭；默认 100 Hz（50 Hz 嗡鸣降 12.3 dB、440 Hz 音调不变，探针实测）。80 Hz 只降 8.8 dB，别贪低。");
   Toggle("降噪（afftdn）", r.Denoise, v => r.Denoise = v);
   if (r.Denoise) Slider("降噪强度", 0, 100, r.Strength, "", v => r.Strength = v);
   if (r.Denoise) Note("强度只缩放降噪 nr（5 + 20×强度/100）：100 时 nr=25（间隙底噪降约 17–25 dB、音调保留）；默认 nr=12:nf=-50 近乎无效，别用默认。");
  }

  // ---- 7. EQ 曲线拖动（声音 tab）----
  string eqWaveformPath = "";
  int eqSelectedBand = -1;
  void BuildEqSection() {
   var eq = Doc.Eq;
   Section("均衡器 · 曲线拖动");
   Note("横轴对数频率 20–20000 Hz，纵轴增益 -15–+15 dB；每个点是一个参量频段（Q 默认 1）。拖点移动，双击加频段（最多 5 个），右键点删除。播放时的波形走时间线波形按钮；下面是源音频的静态波形图。");
   Slider("低切（去低频隆隆声）", 0, 20000, eq.LowCutHz, " Hz", v => eq.LowCutHz = v);
   Slider("高切（去高频嘶嘶声）", 0, 20000, eq.HighCutHz, " Hz", v => eq.HighCutHz = v);
   EqCurveEditor();
   if (eq.Bands.Count > 0) {
    if (eqSelectedBand < 0 || eqSelectedBand >= eq.Bands.Count) eqSelectedBand = 0;
    var b = eq.Bands[eqSelectedBand];
    Note("选中频段 " + (eqSelectedBand + 1) + "：中心 " + b.Frequency.ToString("0", System.Globalization.CultureInfo.InvariantCulture) + " Hz · 增益 " + (b.GainDb >= 0 ? "+" : "") + b.GainDb.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + " dB · Q " + b.Width.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + "。点曲线上的点切换选中。");
    Slider("选中频段 Q 值（越窄越精准）", 0.1, 10, b.Width, "", v => b.Width = v);
   } else Note("还没有参量频段：双击曲线加一个点（默认 +0 dB，拖上去就是提升，拖下来就是衰减）。");
   inspector.Children.Add(InspectorAction("sound", "生成源音频波形图", () => GenerateEqWaveform()));
   if (!string.IsNullOrEmpty(eqWaveformPath) && File.Exists(eqWaveformPath)) {
    try {
     var img = new BitmapImage();
     img.BeginInit();
     img.UriSource = new Uri(eqWaveformPath);
     img.CacheOption = BitmapCacheOption.OnLoad;
     img.EndInit();
     inspector.Children.Add(new Image { Source = img, Width = 248, Height = 48, Stretch = Stretch.Uniform, Margin = new Thickness(0, 4, 0, 8) });
    } catch { }
   }
   inspector.Children.Add(UI.Button("重置均衡器", () => {
    Checkpoint();
    Doc.Eq = new EqSettings();
    eqSelectedBand = -1;
    Changed();
    BuildInspector();
   }));
  }
  void EqCurveEditor() {
   var points = Doc.Eq.Bands;
   const double w = 248, h = 110;
   var canvas = new Canvas { Width = w, Height = h, Cursor = Cursors.Cross, ClipToBounds = true, Margin = new Thickness(0, 4, 0, 4) };
   UI.Role(canvas, Panel.BackgroundProperty, "Well");
   inspector.Children.Add(canvas);
   Func<double, double> toX = f => EqCurveMath.FreqToX(f) * w;
   Func<double, double> toY = g => EqCurveMath.GainToY(g) * h;
   Func<double, double> fromX = px => EqCurveMath.XToFreq(px / w);
   Func<double, double> fromY = py => EqCurveMath.YToGain(py / h);
   Polyline line = null;
   var dots = new List<Ellipse>();
   int dragging = -1;
   Action draw = null;
   draw = () => {
    canvas.Children.Clear();
    dots.Clear();
    var axis = new Line { X1 = 0, X2 = w, Y1 = toY(0), Y2 = toY(0), Stroke = UI.Brush("#B9BFC3"), StrokeThickness = 1, StrokeDashArray = new DoubleCollection { 3, 3 }, IsHitTestVisible = false };
    canvas.Children.Add(axis);
    foreach (double f in new[] { 100.0, 1000.0, 10000.0 }) {
     double gx = toX(f);
     canvas.Children.Add(new Line { X1 = gx, X2 = gx, Y1 = 0, Y2 = h, Stroke = UI.Brush("#E4E8EB"), StrokeThickness = 1, IsHitTestVisible = false });
    }
    line = new Polyline { Stroke = UI.Brush("#667870"), StrokeThickness = 2, IsHitTestVisible = false };
    for (int k = 0; k <= 48; k++) {
     double f = EqCurveMath.XToFreq((double)k / 48);
     line.Points.Add(new Point(toX(f), toY(EqCurveMath.ResponseAt(f, points))));
    }
    canvas.Children.Add(line);
    for (int i = 0; i < points.Count; i++) {
     int index = i;
     var dot = new Ellipse { Width = 12, Height = 12, Fill = UI.Brush(index == eqSelectedBand ? "#667870" : "#FFFFFF"), Stroke = UI.Brush("#667870"), StrokeThickness = 2, Cursor = Cursors.Hand };
     Canvas.SetLeft(dot, toX(points[i].Frequency) - 6);
     Canvas.SetTop(dot, toY(points[i].GainDb) - 6);
     dot.MouseLeftButtonDown += (s, e) => { Checkpoint(); eqSelectedBand = index; dragging = index; canvas.CaptureMouse(); draw(); e.Handled = true; };
     dot.MouseRightButtonDown += (s, e) => {
      Checkpoint();
      points.RemoveAt(index);
      if (eqSelectedBand >= points.Count) eqSelectedBand = points.Count - 1;
      Changed();
      draw();
      BuildInspector();
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
    double f = fromX(p.X);
    double lo = dragging > 0 ? points[dragging - 1].Frequency * 1.001 : EqCurveMath.FreqMin;
    double hi = dragging < points.Count - 1 ? points[dragging + 1].Frequency / 1.001 : EqCurveMath.FreqMax;
    points[dragging].Frequency = Math.Max(lo, Math.Min(hi, f));
    points[dragging].GainDb = Math.Max(-15, Math.Min(15, fromY(p.Y)));
    // 原地更新曲线与圆点（不重建画布：重建会丢掉正在拖动的鼠标捕获）。
    if (line != null) {
     line.Points.Clear();
     for (int k = 0; k <= 48; k++) {
      double rf = EqCurveMath.XToFreq((double)k / 48);
      line.Points.Add(new Point(toX(rf), toY(EqCurveMath.ResponseAt(rf, points))));
     }
    }
    if (dragging < dots.Count) {
     Canvas.SetLeft(dots[dragging], toX(points[dragging].Frequency) - 6);
     Canvas.SetTop(dots[dragging], toY(points[dragging].GainDb) - 6);
    }
    Changed();
   };
   canvas.MouseLeftButtonDown += (s, e) => {
    if (e.OriginalSource is Ellipse) return;
    if (e.ClickCount == 2 && points.Count < 5) {
     var p = e.GetPosition(canvas);
     double f = fromX(p.X);
     int at = points.FindIndex(q => q.Frequency > f);
     if (at < 0) at = points.Count;
     Checkpoint();
     points.Insert(at, new EqBand { Frequency = f, GainDb = fromY(p.Y), Width = 1 });
     eqSelectedBand = at;
     Changed();
     BuildInspector();
     e.Handled = true;
    }
   };
   canvas.MouseMove += (s, e) => move(e);
   canvas.MouseLeftButtonUp += (s, e) => { dragging = -1; canvas.ReleaseMouseCapture(); BuildInspector(); e.Handled = true; };
   canvas.LostMouseCapture += (s, e) => dragging = -1;
  }
  async void GenerateEqWaveform() {
   if (Doc == null || string.IsNullOrEmpty(Doc.Source)) return;
   Status("正在生成波形图…");
   try {
    string outPng = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "dogsc-eq-waveform.png");
    await Task.Run(() => Waveform.Png(Doc.EffectiveSource(), outPng, 248, 48));
    eqWaveformPath = outPng;
    Changed();
    BuildInspector();
    Status("波形图已生成。");
   } catch (Exception ex) { Error(ex); }
  }

  // ---- 8. 压缩器旋钮（声音 tab）----
  double compPeakDb; bool compPeakMeasured;
  void BuildCompressorSection() {
   var c = Doc.Compressor;
   Section("压缩器");
   Note("只压主音轨自己的音频（与音乐床闪避的 sidechaincompress 是两回事）。阈值 -20 dB / 比率 4 时，响段 -9.03→-18.85 dB（压 9.8 dB）、静段不变，动态范围 20.00→10.19 dB（探针实测）。增益衰减表是静态估算（峰值已知时），不是实时表头。");
   Toggle("启用压缩器", c.Enabled, v => { c.Enabled = v; BuildInspector(); });
   if (!c.Enabled) return;
   var grid = new UniformGrid { Columns = 5, Margin = new Thickness(0, 4, 0, 4) };
   inspector.Children.Add(grid);
   Knob(grid, "阈值", -60, 0, c.ThresholdDb, " dB", v => c.ThresholdDb = v);
   Knob(grid, "比率", 1, 20, c.Ratio, ":1", v => c.Ratio = v);
   Knob(grid, "起音", 0.1, 2000, c.AttackMs, " ms", v => c.AttackMs = v);
   Knob(grid, "释放", 0.1, 9000, c.ReleaseMs, " ms", v => c.ReleaseMs = v);
   Knob(grid, "补偿", 0, 30, c.MakeupDb, " dB", v => c.MakeupDb = v);
   if (compPeakMeasured) {
    double gr = c.EstimatedReduction(compPeakDb);
    Note("峰值 " + compPeakDb.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + " dB（volumedetect 实测）→ 预计压低 " + gr.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + " dB（静态估算：超过阈值的部分按 1 - 1/比率压掉；真实衰减看导出后电平）。");
   } else Note("增益衰减表需要先测峰值。");
   inspector.Children.Add(InspectorAction("sound", "测当前音频峰值", () => MeasureCompPeak()));
  }
  void Knob(UniformGrid grid, string label, double min, double max, double value, string suffix, Action<double> set) {
   var cell = new StackPanel { Margin = new Thickness(0, 0, 4, 0) };
   grid.Children.Add(cell);
   var title = UI.Text(label, 11, "#63696D");
   title.HorizontalAlignment = HorizontalAlignment.Center;
   cell.Children.Add(title);
   var canvas = new Canvas { Width = 64, Height = 64, Cursor = Cursors.SizeNS, ClipToBounds = true, Margin = new Thickness(0, 4, 0, 0) };
   cell.Children.Add(canvas);
   var readout = UI.Text("", 11, "#63696D");
   readout.HorizontalAlignment = HorizontalAlignment.Center;
   cell.Children.Add(readout);
   var circle = new Ellipse { Width = 56, Height = 56, Fill = UI.Brush("#E4E8EB"), Stroke = UI.Brush("#667870"), StrokeThickness = 2 };
   Canvas.SetLeft(circle, 4);
   Canvas.SetTop(circle, 4);
   canvas.Children.Add(circle);
   var needle = new Line { Stroke = UI.Brush("#343638"), StrokeThickness = 2, IsHitTestVisible = false };
   canvas.Children.Add(needle);
   double cur = value;
   Action draw = null;
   draw = () => {
    double f = (cur - min) / (max - min);
    double a = (-135 + 270 * f) * Math.PI / 180;
    needle.X1 = 32; needle.Y1 = 32;
    needle.X2 = 32 + 24 * Math.Sin(a); needle.Y2 = 32 - 24 * Math.Cos(a);
    readout.Text = cur.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) + suffix;
   };
   draw();
   bool dragging = false;
   double startY = 0, startVal = 0;
   canvas.MouseLeftButtonDown += (s, e) => { Checkpoint(); dragging = true; startY = e.GetPosition(canvas).Y; startVal = cur; canvas.CaptureMouse(); e.Handled = true; };
   canvas.MouseMove += (s, e) => {
    if (!dragging) return;
    double y = e.GetPosition(canvas).Y;
    cur = Math.Max(min, Math.Min(max, startVal + (startY - y) * (max - min) / 100));
    draw();
    set(cur);
    Changed();
   };
   canvas.MouseLeftButtonUp += (s, e) => { dragging = false; canvas.ReleaseMouseCapture(); e.Handled = true; };
   canvas.LostMouseCapture += (s, e) => dragging = false;
  }
  async void MeasureCompPeak() {
   if (Doc == null || string.IsNullOrEmpty(Doc.Source)) return;
   Status("正在测峰值…");
   try {
    double peak = await Task.Run(() => AudioProbe.MaxVolume(Doc.EffectiveSource()));
    compPeakDb = peak;
    compPeakMeasured = true;
    Changed();
    BuildInspector();
    Status("峰值 " + peak.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + " dB。");
   } catch (Exception ex) { Error(ex); }
  }

  // ---- 3. 变声（声音 tab）----
  void BuildVoiceChangeSection() {
   var v = Doc.VoiceChange;
   Section("变声");
   Note("基础变声走 asetrate + atempo（LGPL）：变调后用 atempo 把时长补回来，时长不变。高质量变声走 rubberband 是 GPL，LGPL 包里没有，发版前换方案；这里不装 rubberband、不假装有。");
   Choices("变声类型", v.Kind, VoiceChangeSettings.Kinds.Select(k => new[] { k, k }).ToArray(), val => { v.Kind = val; BuildInspector(); });
   if (v.Kind == "变调") {
    Slider("变调半音", -12, 12, v.Semitones, " 半音", val => v.Semitones = Math.Round(val));
    Note("+12 半音 = 高八度（440 Hz→880 Hz，时长误差 0.018 秒，探针实测）；-12 半音 = 低八度。0 半音等于没变。");
   } else if (v.Kind != "无") {
    Note("混响是四抽头小房间（60/90/120/180 ms）；回声是单抽头 250 ms（aecho 是前馈延迟，只有一声回声，不是无限反馈）；合唱 / 震音 / 颤音用默认参数。");
   }
  }

  // ---- 2. 人声分离（声音 tab）----
  bool vocalSepBusy;
  string vocalSepStatus = "";
  void BuildVocalSepSection() {
   var s = Doc.VocalSep;
   Section("人声分离");
   Note("本地 Demucs（MIT）跑分离，输出人声与伴奏两轨；模型权重首次运行下载约 400 MB，不随包分发，发版前须核实权重许可。分离是 CPU 慢活：4 秒片约 26 秒，长文件要几分钟。模型缺失时诚实报错，不返回空音轨。");
   if (!Doc.Audio) { Note("当前素材没有音轨，分离不可用。"); return; }
   Choices("导出时用哪一轨", s.Mode, VocalSepSettings.Modes.Select(m => new[] { m == "关" ? "关（用原音轨）" : m == "人声" ? "只留人声" : "只留伴奏", m }).ToArray(), val => { s.Mode = val; BuildInspector(); });
   Choices("Demucs 模型", s.Model, VocalSepSettings.Models.Select(m => new[] { m, m }).ToArray(), val => s.Model = val);
   if (!string.IsNullOrEmpty(s.VocalsPath)) Note("人声轨：" + System.IO.Path.GetFileName(s.VocalsPath) + "\n伴奏轨：" + System.IO.Path.GetFileName(s.AccompPath));
   if (!string.IsNullOrEmpty(vocalSepStatus)) Note(vocalSepStatus);
   inspector.Children.Add(InspectorAction("sound", vocalSepBusy ? "正在分离…" : "开始分离", () => { if (!vocalSepBusy) RunVocalSep(); }));
   if (!string.IsNullOrEmpty(s.VocalsPath) && File.Exists(s.VocalsPath)) {
    inspector.Children.Add(InspectorAction("plus", "人声轨加入混音（作旁白轨，不循环）", () => AddStemToMixer(s.VocalsPath)));
    inspector.Children.Add(InspectorAction("plus", "伴奏轨加入混音（作旁白轨，不循环）", () => AddStemToMixer(s.AccompPath)));
    Note("“导出时用哪一轨”只支持单片段直接导出；多段项目请用上面两个按钮把音轨加进混音轨再导出。");
   }
  }
  void AddStemToMixer(string path) {
   if (Doc == null || string.IsNullOrEmpty(path) || !File.Exists(path)) return;
   Checkpoint();
   Doc.Mixer.Add(new MixerChannel { Role = "旁白", GainDb = 0, Pan = 0, SourcePath = path, Start = 0 });
   Changed();
   BuildInspector();
   RefreshMediaLibrary();
   Status("已加入混音：" + System.IO.Path.GetFileName(path));
  }
  async void RunVocalSep() {
   if (Doc == null || string.IsNullOrEmpty(Doc.Source)) return;
   vocalSepBusy = true;
   vocalSepStatus = "";
   BuildInspector();
   Status("正在分离人声（CPU 慢活，请耐心等）…");
   try {
    string dir = System.IO.Path.GetDirectoryName(FilePath ?? Doc.Source);
    string outDir = System.IO.Path.Combine(dir, Doc.Name + "-vocalsep");
    string model = Doc.VocalSep.Model;
    string source = Doc.Source;
    var stems = await Task.Run(() => VocalSep.Separate(source, model, outDir));
    Checkpoint();
    Doc.VocalSep.VocalsPath = stems[0];
    Doc.VocalSep.AccompPath = stems[1];
    if (Doc.VocalSep.Mode == "关") Doc.VocalSep.Mode = "人声";
    vocalSepStatus = "分离完成：人声 / 伴奏两轨已生成。导出时选“只留人声”或“只留伴奏”即用对应音轨。";
    Changed();
    BuildInspector();
    Status("人声分离完成。");
   } catch (Exception ex) {
    vocalSepStatus = "分离失败：" + ex.Message;
    BuildInspector();
    Error(ex);
   } finally { vocalSepBusy = false; BuildInspector(); }
  }

  // ---- 4. TTS 面板（声音 tab）----
  bool ttsBusy;
  string ttsStatus = "";
  TextBox ttsTextBox;
  void BuildTtsSection() {
   var t = Doc.Tts;
   Section("文本朗读 TTS 配音");
   Note("本地 Sherpa-ONNX VITS（Apache 2.0）+ 开源音色，不走云端；v1 只有一个音色（aishell3 女声）。模型约 30 MB，缺失时诚实报错，不返回静音冒充语音。生成后成音频片段，按起始时间混进时间线。");
   ttsTextBox = new TextBox { Text = t.Text, AcceptsReturn = true, MinHeight = 60, TextWrapping = TextWrapping.Wrap, FontSize = 13, Margin = new Thickness(0, 4, 0, 9) };
   ttsTextBox.LostFocus += (s, e) => { t.Text = ttsTextBox.Text; Changed(); };
   inspector.Children.Add(ttsTextBox);
   Choices("音色", t.Voice, TtsSettings.Voices.Select(v => new[] { v, v }).ToArray(), val => t.Voice = val);
   Slider("语速", 0.5, 2, t.Speed, "×", val => t.Speed = val);
   Number("起始时间 / 秒", t.Start, val => t.Start = EditDocument.Clamp(val, 0, Doc.Length));
   Slider("增益", -30, 12, t.GainDb, " dB", val => t.GainDb = val);
   if (!string.IsNullOrEmpty(t.WavPath)) Note("旁白音频：" + System.IO.Path.GetFileName(t.WavPath) + "（从 " + UI.Time(t.Start) + " 起混入，导出时生效）。");
   if (!string.IsNullOrEmpty(ttsStatus)) Note(ttsStatus);
   inspector.Children.Add(InspectorAction("sound", ttsBusy ? "正在合成…" : "生成旁白", () => { if (!ttsBusy) RunTts(); }));
   if (t.HasAudio) inspector.Children.Add(InspectorAction("trash", "清除旁白", () => { Checkpoint(); t.WavPath = ""; ttsStatus = ""; Changed(); BuildInspector(); }, true));
  }
  async void RunTts() {
   if (Doc == null) return;
   string text = ttsTextBox != null ? ttsTextBox.Text : Doc.Tts.Text;
   try { new TtsSettings().ValidateText(text); } catch (Exception ex) { Error(ex); return; }
   ttsBusy = true;
   ttsStatus = "";
   BuildInspector();
   Status("正在合成旁白…");
   try {
    string dir = System.IO.Path.GetDirectoryName(FilePath ?? Doc.Source);
    string outWav = System.IO.Path.Combine(dir, Doc.Name + "-旁白.wav");
    double speed = Doc.Tts.Speed;
    double duration = await Task.Run(() => TtsSynth.Synthesize(text, speed, outWav));
    Checkpoint();
    Doc.Tts.Text = text;
    Doc.Tts.WavPath = outWav;
    ttsStatus = "旁白已生成：" + duration.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture) + " 秒（约 " + (text.Length > 0 ? (duration / text.Length).ToString("0.00", System.Globalization.CultureInfo.InvariantCulture) : "0") + " 秒/字），从 " + UI.Time(Doc.Tts.Start) + " 起混入。";
    Changed();
    BuildInspector();
    Status("旁白已生成。");
   } catch (Exception ex) {
    ttsStatus = "合成失败：" + ex.Message;
    BuildInspector();
    Error(ex);
   } finally { ttsBusy = false; BuildInspector(); }
  }

  // ---- 5. 环绕声（声音 tab）----
  void BuildSurroundSection() {
   Section("环绕声");
   Note("立体声混音末尾一次 pan 上混，不是真环绕混音：中置 = 左右声平均，后环 = 左右声直通，低频声道（LFE）是静音（立体声上混没有低频特效内容，编一个是假的）。各角色声像定位不在 v1。");
   Buttons(Surround.Layouts, Doc.SurroundLayout, v => { Checkpoint(); Doc.SurroundLayout = v; Changed(); BuildInspector(); });
   Choices("音频编码器", Doc.SurroundCodec, new[] { new[] { "自动（5.1 用 AC-3，7.1 / 立体声用 AAC）", "自动" }, new[] { "AAC", "aac" }, new[] { "AC-3", "ac3" } }, v => { Doc.SurroundCodec = v; BuildInspector(); });
   if (Doc.SurroundLayout == "5.1") Note("5.1 导出：AC-3、384k、6 声道；ffprobe 读回 channel_layout 5.1(side)（FFmpeg 8 起的命名，声道顺序仍是 FL FR FC LFE BL BR）。");
   if (Doc.SurroundLayout == "7.1") Note("7.1 导出：AAC、448k、8 声道；AC-3 装不下 7.1（会静默下混到 5.1），所以 7.1 不能选 AC-3。");
  }

  // ---- 6. 子片段行（素材库“素材”分栏，见 FeaturePanelsUI.RefreshMediaLibrary）----
  void AddSubclipRows(StackPanel panel) {
   var subs = Doc.MediaLibrary == null ? new List<MediaLibraryItem>() : Doc.MediaLibrary.Where(i => i.IsSubclip).ToList();
   foreach (var item in subs.ToList()) {
    var sub = item;
    var row = MediaRow("子片段 · " + sub.Name, UI.Time(sub.In) + " – " + UI.Time(sub.Out) + "（" + UI.Time(sub.Duration) + "）", "");
    MediaRowButton(row, "加入时间线", () => {
     Checkpoint();
     Doc.Cuts.Add(Subclips.ToCut(sub));
     Changed();
     BuildInspector();
     DrawTimeline();
     Status("子片段已加入时间线末尾：" + sub.Name);
    });
    MediaRowButton(row, "删除", () => {
     Checkpoint();
     Doc.MediaLibrary.Remove(sub);
     Changed();
     BuildInspector();
     RefreshMediaLibrary();
    });
    panel.Children.Add(row);
   }
   panel.Children.Add(InspectorAction("plus", "用当前片段建子片段", () => CreateSubclipFromCut()));
  }
  void CreateSubclipFromCut() {
   if (Doc == null || Doc.Cuts.Count == 0) return;
   int i = selectedCut >= 0 && selectedCut < Doc.Cuts.Count ? selectedCut : 0;
   var c = Doc.Cuts[i];
   if (c.Gap) { Status("空隙没有源时间，不能建子片段。"); return; }
   try {
    Checkpoint();
    var sub = Subclips.Create(Doc.MediaLibrary, "m1", "sc-" + Guid.NewGuid().ToString("N").Substring(0, 6), System.IO.Path.GetFileNameWithoutExtension(Doc.Source) + " 子片段", c.Start, c.End);
    Doc.MediaLibrary.Add(sub);
    Changed();
    BuildInspector();
    RefreshMediaLibrary();
    Status("子片段已建：" + sub.Name + "（只存引用，不复制文件）。");
   } catch (Exception ex) { Error(ex); }
  }
 }
}
