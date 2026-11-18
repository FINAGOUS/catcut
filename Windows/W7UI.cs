// W7 收尾批 UI（2026-11-18）：色轮三区可拖拽圆盘、时间线一键删静音。
// 控件全部复用现有检查器助手（Section/Note/Slider/Toggle/Choices/
// InspectorAction）+ W5 的 HslCurveEditor 同款 Canvas 拖拽，不抄任何闭源软件的界面。
// 诚实说明写在各面板的 Note 里；云端 runner 无真 GPU/摄像头/麦克风，
// 那些交互只能在真机上验证，面板里写明，不假装验过。
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
using D = System.Drawing;

namespace DogSC.Replica {
 public partial class Studio {
  // ---- 1. 色轮三区可拖拽圆盘（画面-调色，滑杆之后）----
  // 圆盘只是滑杆的另一种输入：角度=色相偏移、半径=饱和度倍数，模型不变
  // （WheelHue/WheelSat，烤进同一张 17³ LUT）。去饱和（<1×）圆盘表达不了，
  // 仍用上面的滑杆；圆盘中心=不变，向外=饱和度提高。
  static BitmapImage wheelDisc;
  static BitmapImage WheelDiscImage() {
   if (wheelDisc != null) return wheelDisc;
   const int size = 120;
   double cx = size / 2.0, cy = size / 2.0, r = size / 2.0 - 2;
   using (var bmp = new D.Bitmap(size, size, D.Imaging.PixelFormat.Format32bppArgb)) {
    for (int y = 0; y < size; y++) for (int x = 0; x < size; x++) {
     double dx = x - cx + 0.5, dy = y - cy + 0.5;
     double len = Math.Sqrt(dx * dx + dy * dy);
     if (len > r) { bmp.SetPixel(x, y, D.Color.FromArgb(0, 0, 0, 0)); continue; }
     double hue = Math.Atan2(-dy, dx) * 180 / Math.PI;
     if (hue < 0) hue += 360;
     var rgb = ColorLut.HslToRgb(hue, len / r, 0.5);
     bmp.SetPixel(x, y, D.Color.FromArgb(255, (int)(rgb[0] * 255), (int)(rgb[1] * 255), (int)(rgb[2] * 255)));
    }
    using (var ms = new MemoryStream()) {
     bmp.Save(ms, D.Imaging.ImageFormat.Png);
     ms.Position = 0;
     var img = new BitmapImage();
     img.BeginInit();
     img.StreamSource = ms;
     img.CacheOption = BitmapCacheOption.OnLoad;
     img.EndInit();
     img.Freeze();
     wheelDisc = img;
     return img;
    }
   }
  }
  void BuildColorWheelSection() {
   var g = Doc.Grade;
   Section("色轮三区 · 圆盘拖动");
   Note("圆盘中心=不变；向外拖=饱和度提高（中心 1×、边缘 3×），角度=色相偏移。去饱和（<1×）圆盘做不了，用上面的滑杆。拖动后预览与导出都走同一张 LUT。");
   var row = new UniformGrid { Columns = 3, Margin = new Thickness(0, 4, 0, 4) };
   inspector.Children.Add(row);
   for (int z = 0; z < 3; z++) {
    int zone = z;
    var cell = new StackPanel { Margin = new Thickness(0, 0, 6, 0) };
    row.Children.Add(cell);
    var title = UI.Text(ColorGrade.WheelZoneNames[zone], 12);
    title.HorizontalAlignment = HorizontalAlignment.Center;
    cell.Children.Add(title);
    const double pad = 132, img = 120, off = 6, radius = 58;
    var canvas = new Canvas { Width = pad, Height = pad, Cursor = Cursors.Cross, ClipToBounds = true, Margin = new Thickness(0, 4, 0, 4) };
    var disc = new Image { Source = WheelDiscImage(), Width = img, Height = img, IsHitTestVisible = false };
    Canvas.SetLeft(disc, off);
    Canvas.SetTop(disc, off);
    canvas.Children.Add(disc);
    var thumb = new Ellipse { Width = 14, Height = 14, Fill = UI.Brush("#FFFFFF"), Stroke = UI.Brush("#343638"), StrokeThickness = 2, IsHitTestVisible = false };
    canvas.Children.Add(thumb);
    var readout = UI.Text("", 11, "#63696D");
    readout.HorizontalAlignment = HorizontalAlignment.Center;
    cell.Children.Add(canvas);
    cell.Children.Add(readout);
    Action draw = null;
    draw = () => {
     double hue = g.WheelHue[zone], sat = g.WheelSat[zone];
     double dx, dy;
     WheelMath.ToPoint(hue, sat, radius, out dx, out dy);
     Canvas.SetLeft(thumb, off + img / 2 + dx - 7);
     Canvas.SetTop(thumb, off + img / 2 + dy - 7);
     readout.Text = "色相 " + (hue >= 0 ? "+" : "") + hue.ToString("0", System.Globalization.CultureInfo.InvariantCulture) + "° · 饱和度 " + sat.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + "×";
    };
    draw();
    bool dragging = false;
    Action<MouseEventArgs> move = e => {
     if (!dragging) return;
     var p = e.GetPosition(canvas);
     double hue, sat;
     WheelMath.FromPoint(p.X - (off + img / 2), p.Y - (off + img / 2), radius, out hue, out sat);
     g.WheelHue[zone] = hue;
     g.WheelSat[zone] = sat;
     draw();
     Changed();
    };
    canvas.MouseLeftButtonDown += (s, e) => { Checkpoint(); dragging = true; canvas.CaptureMouse(); move(e); e.Handled = true; };
    canvas.MouseMove += (s, e) => move(e);
    canvas.MouseLeftButtonUp += (s, e) => { dragging = false; canvas.ReleaseMouseCapture(); e.Handled = true; };
    canvas.LostMouseCapture += (s, e) => dragging = false;
   }
   inspector.Children.Add(UI.Button("重置三个色轮", () => {
    Checkpoint();
    for (int z = 0; z < 3; z++) { g.WheelHue[z] = 0; g.WheelSat[z] = 1; }
    Changed();
    BuildInspector();
   }));
  }

  // ---- 2. 一键删静音（声音 tab，音频类型面板之后）----
  double silenceThresholdDb = -40;
  List<SilenceCut.Span> detectedSilence;
  string silenceStatus = "";
  void BuildSilenceCutSection() {
   Section("一键删静音");
   Note("用 silencedetect 找静音段（源时间），抠掉后字幕/标记/缩放/贴图跟随前移。卡点闪白的节拍是源时间，删静音后会错位——删完需重新检测节拍。片尾静音不删（不影响成片）。");
   Choices("静音阈值", silenceThresholdDb.ToString("0", System.Globalization.CultureInfo.InvariantCulture), new[] { new[] { "-50 dB（更敏感）", "-50" }, new[] { "-40 dB", "-40" }, new[] { "-30 dB（只删真静音）", "-30" } }, v => { silenceThresholdDb = double.Parse(v, System.Globalization.CultureInfo.InvariantCulture); });
   if (detectedSilence != null) {
    double total = detectedSilence.Sum(s => s.Length);
    Note("已找到 " + detectedSilence.Count + " 段静音，共 " + total.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture) + " 秒：" + string.Join("、", detectedSilence.Select(s => s.Start.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + "–" + s.End.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + "s").ToArray()) + "。");
   } else if (!string.IsNullOrEmpty(silenceStatus)) {
    Note(silenceStatus);
   }
   inspector.Children.Add(InspectorAction("sound", "检测静音段", async () => {
    if (Doc == null || string.IsNullOrEmpty(Doc.Source)) return;
    Status("正在检测静音…");
    try {
     var spans = await Task.Run(() => SilenceCut.Detect(Doc.Source, silenceThresholdDb, 0.5, CancellationToken.None));
     detectedSilence = spans;
     silenceStatus = spans.Count == 0 ? "没有找到 ≥0.5 秒的静音段（阈值 " + silenceThresholdDb.ToString("0", System.Globalization.CultureInfo.InvariantCulture) + " dB）。" : "";
     Changed();
     BuildInspector();
     Status(spans.Count == 0 ? "没有找到静音段。" : "找到 " + spans.Count + " 段静音，共 " + spans.Sum(s => s.Length).ToString("0.00", System.Globalization.CultureInfo.InvariantCulture) + " 秒。");
    } catch (Exception ex) { Error(ex); }
   }));
   if (detectedSilence != null && detectedSilence.Count > 0) {
    inspector.Children.Add(InspectorAction("trash", "删掉这 " + detectedSilence.Count + " 段静音", () => {
     if (Doc == null) return;
     try {
      Checkpoint();
      double removed = SilenceCut.Apply(Doc, detectedSilence);
      detectedSilence = null;
      silenceStatus = "已删静音 " + removed.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture) + " 秒。卡点闪白如在用，请重新检测节拍。";
      Changed();
      BuildInspector();
      DrawTimeline();
      Status("已删静音 " + removed.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture) + " 秒。");
     } catch (Exception ex) { Error(ex); }
    }, true));
   }
  }
 }
}
