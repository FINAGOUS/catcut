// W8 收尾批·时间线高级 UI（2026-11-18）：时间线页（索引搜索/三点编辑/复合片段）、
// 片段页 J/L + 音画联动 + 粘贴属性、声音页文字剪切 + Remix、调色页调整层。
// 控件全部复用现有检查器助手（Section/Note/Slider/Number/Toggle/Buttons/
// InspectorAction）+ UI.Button，不抄任何闭源软件的界面。
// 诚实说明写在各面板的 Note 里；云端 runner 无真 GPU/摄像头/麦克风，
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
using DogSC.Windows;
using Path = System.IO.Path;

namespace DogSC.Replica {
 public partial class Studio {
  // ---- 时间线页（画面 tab · frameTab=="时间线"）----
  string timelineSearchText = "";
  List<TimelineHit> timelineSearchHits;
  double tpSrcIn, tpSrcOut = 1, tpAt;
  void BuildTimelineAdvancedSection() {
   Section("时间线索引搜索");
   Note("按文字搜片段/标记/字幕/角色，点结果跳到对应时间。搜的是片段名、源文件名、标记文字、字幕文本、角色名。");
   var searchBox = new TextBox { Text = timelineSearchText, FontSize = 12, Padding = new Thickness(8, 6, 8, 6), Margin = new Thickness(0, 4, 0, 4) };
   searchBox.TextChanged += (s, e) => timelineSearchText = searchBox.Text;
   inspector.Children.Add(searchBox);
   inspector.Children.Add(UI.Button("搜索", () => {
    timelineSearchHits = TimelineSearch.Search(Doc, timelineSearchText);
    Changed(); BuildInspector();
    Status(timelineSearchHits.Count == 0 ? "没有找到匹配项。" : "找到 " + timelineSearchHits.Count + " 项。");
   }));
   if (timelineSearchHits != null) {
    if (timelineSearchHits.Count == 0) Note("没有找到匹配项。");
    foreach (var hit in timelineSearchHits) {
     var h = hit;
     inspector.Children.Add(UI.Button(h.Label, () => Seek(h.Time)));
    }
   }
   Section("三点编辑");
   Note("源监视器打入出点 + 时间线打点：插入会把被压片段从打点处分裂开、后续右移；覆盖会替换打点起的一段、总时长不变。只支持 1× 常速片段。");
   Number("源入点 / 秒", tpSrcIn, v => tpSrcIn = v);
   Number("源出点 / 秒", tpSrcOut, v => tpSrcOut = v);
   Number("时间线打点 / 秒", tpAt, v => tpAt = v);
   inspector.Children.Add(UI.Button("插入到打点处", () => {
    try { Checkpoint(); ThreePoint.Insert(Doc, tpSrcIn, tpSrcOut, tpAt); Changed(); BuildInspector(); DrawTimeline(); Status("已插入。"); }
    catch (Exception ex) { Error(ex); }
   }));
   inspector.Children.Add(UI.Button("覆盖打点起的一段", () => {
    try { Checkpoint(); ThreePoint.Overwrite(Doc, tpSrcIn, tpSrcOut, tpAt); Changed(); BuildInspector(); DrawTimeline(); Status("已覆盖，总时长不变。"); }
    catch (Exception ex) { Error(ex); }
   }));
   inspector.Children.Add(UI.Button("替换素材（保留剪辑点与特效，只换源文件）…", () => {
    try {
     var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "视频文件|*.mp4;*.mov;*.mkv;*.avi|所有文件|*.*", Title = "选择替换素材" };
     if (dlg.ShowDialog() != true) return;
     Checkpoint(); ThreePoint.ReplaceSource(Doc, dlg.FileName); Changed(); BuildInspector(); DrawTimeline();
     Status("已换源，剪辑点与特效保留。");
    } catch (Exception ex) { Error(ex); }
   }));
   Section("复合片段");
   Note("一段剪好的子项目当成一个片段复用：嵌套上限 2 层（父→子→孙）。v1 单源模型里复合片段排在主片段之后、不能与主片段交错混排；渲染出的中间片（compound-d<depth>-c<index>/render.mp4）是普通 MP4，可直接打开成新项目。");
   if (Doc.CompoundClips == null) Doc.CompoundClips = new List<CompoundClip>();
   for (int i = 0; i < Doc.CompoundClips.Count; i++) {
    int idx = i; var cc = Doc.CompoundClips[idx];
    inspector.Children.Add(UI.Button((cc.Expanded ? "▼ " : "▶ ") + cc.Name + " · " + cc.In.ToString("0.00", CultureInfo.InvariantCulture) + "–" + cc.Out.ToString("0.00", CultureInfo.InvariantCulture) + "s", () => {
     Checkpoint(); cc.Expanded = !cc.Expanded; Changed(); BuildInspector();
    }));
    inspector.Children.Add(UI.Button("渲染中间片 · " + cc.Name, () => {
     try {
      var child = EditDocument.Deserialize(File.ReadAllText(cc.ProjectPath, new System.Text.UTF8Encoding(false)));
      string render = CompoundTimeline.RenderIntermediate(child, cc, idx, Path.GetDirectoryName(Doc.Source), Doc.Height, (int)Math.Round(Doc.FrameRate), CancellationToken.None);
      Status("中间片已生成 · " + render);
     } catch (Exception ex) { Error(ex); }
    }));
   }
   try {
    var children = new Dictionary<string, EditDocument>();
    foreach (var cc in Doc.CompoundClips) if (cc.Expanded && File.Exists(cc.ProjectPath) && !children.ContainsKey(cc.ProjectPath))
      children[cc.ProjectPath] = EditDocument.Deserialize(File.ReadAllText(cc.ProjectPath, new System.Text.UTF8Encoding(false)));
    foreach (var row in CompoundTimeline.Outline(Doc, children))
     Note((row.IsCompound ? "▣ " : "▸ ") + row.Label + " · " + row.Start.ToString("0.00", CultureInfo.InvariantCulture) + "–" + row.End.ToString("0.00", CultureInfo.InvariantCulture) + "s" + (row.Depth > 0 ? " · 第 " + row.Depth + " 层" : ""));
   } catch (Exception ex) { Note("大纲展开失败：" + ex.Message); }
   inspector.Children.Add(UI.Button("添加复合片段（选一个子项目文件）…", () => {
    try {
     var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "剪辑项目|*.dogscwin|所有文件|*.*", Title = "选择子项目" };
     if (dlg.ShowDialog() != true) return;
     var child = EditDocument.Deserialize(File.ReadAllText(dlg.FileName, new System.Text.UTF8Encoding(false)));
     Checkpoint();
     Doc.CompoundClips.Add(new CompoundClip { Name = Path.GetFileNameWithoutExtension(dlg.FileName), ProjectPath = dlg.FileName, In = 0, Out = child.Length, Depth = 0 });
     Changed(); BuildInspector(); Status("已添加复合片段（默认取子项目全长）。");
    } catch (Exception ex) { Error(ex); }
   }));
  }

  // ---- 片段页：J/L 剪辑 + 音画联动锁定 ----
  void BuildJlSection(Cut c) {
   Section("J/L 剪辑（音画分剪）");
   Note("音频边可单独延长/缩短：音频起点早于视频起点就是 J cut（音先入），音频终点晚于视频终点就是 L cut（音延后）。音频窗口是源秒数，只支持 1× 常速片段。");
   Number("音频起点 / 秒", c.AudioIn.HasValue ? c.AudioIn.Value : c.Start, v => { c.AudioIn = EditDocument.Clamp(v, 0, Doc.Duration); });
   Number("音频终点 / 秒", c.AudioOut.HasValue ? c.AudioOut.Value : c.End, v => { c.AudioOut = EditDocument.Clamp(v, 0, Doc.Duration); });
   inspector.Children.Add(UI.Button("清除音频窗口（回到音画同步）", () => { Checkpoint(); c.AudioIn = null; c.AudioOut = null; Changed(); BuildInspector(); }));
   Toggle("音画联动锁定", Doc.LinkSelection, v => Doc.LinkSelection = v);
   Note("联动开时删除视频片段会带上绑定的音频；关时只删视频、音频留成纯音频片段（黑视频 + 音频保留）。按住 Alt 再删可临时取反。");
  }

  // ---- 片段页：粘贴属性 ----
  ClipAttrs copiedClipAttrs;
  string copiedAttrsLabel = "";
  void BuildPasteSection(Cut c) {
   Section("粘贴属性");
   Note("把一个片段的变速 + 项目调色 + 音频处理复制到别的片段。本软件调色是项目级的，所以粘贴调色会作用于整个项目（面板写明，不假装是单片段调色）。");
   inspector.Children.Add(UI.Button("复制本片段属性", () => {
    try { copiedClipAttrs = PasteAttributes.Capture(Doc, selectedCut); copiedAttrsLabel = "已复制 · 速度 " + copiedClipAttrs.Speed.ToString("0.##", CultureInfo.InvariantCulture) + "× · 调色/音频快照"; Changed(); BuildInspector(); Status(copiedAttrsLabel); }
    catch (Exception ex) { Error(ex); }
   }));
   if (copiedClipAttrs != null) {
    Note(copiedAttrsLabel + "。");
    inspector.Children.Add(UI.Button("粘贴到本片段（变速+调色+音频）", () => {
     try { Checkpoint(); PasteAttributes.Paste(Doc, selectedCut, copiedClipAttrs, true, true, true); Changed(); BuildInspector(); Status("已粘贴属性。"); }
     catch (Exception ex) { Error(ex); }
    }));
   }
  }

  // ---- 声音页：文字剪切 ----
  List<WordItem> textCutWords = new List<WordItem>();
  string textCutWord = "";
  double textCutWordStart, textCutWordEnd;
  void BuildTextCutSection() {
   Section("文字剪切");
   Note("复用 P0b 转写词级时间戳：删文字即删对应时间段，字幕/标记跟随前移（与删静音同一条逻辑）。词表手动输入（词 + 起止时间，源时间）；转写面板暂不输出词级时间戳，等它接上后这里直接取词。");
   var wordBox = new TextBox { Text = textCutWord, FontSize = 12, Padding = new Thickness(8, 6, 8, 6), Margin = new Thickness(0, 4, 0, 4) };
   wordBox.TextChanged += (s, e) => textCutWord = wordBox.Text;
   inspector.Children.Add(wordBox);
   Number("词起始 / 秒", textCutWordStart, v => textCutWordStart = v);
   Number("词结束 / 秒", textCutWordEnd, v => textCutWordEnd = v);
   inspector.Children.Add(UI.Button("加入待删词表", () => {
    if (string.IsNullOrWhiteSpace(textCutWord) || textCutWordEnd <= textCutWordStart) { Status("词或起止时间无效。"); return; }
    textCutWords.Add(new WordItem { Text = textCutWord.Trim(), Start = textCutWordStart, End = textCutWordEnd });
    textCutWord = ""; Changed(); BuildInspector();
   }));
   if (textCutWords.Count > 0) {
    Note("待删词：" + string.Join("、", textCutWords.Select(w => w.Text + " " + w.Start.ToString("0.00", CultureInfo.InvariantCulture) + "–" + w.End.ToString("0.00", CultureInfo.InvariantCulture) + "s").ToArray()) + "。");
    inspector.Children.Add(InspectorAction("trash", "删掉这些词对应的片段", () => {
     try {
      Checkpoint();
      double removed = TextCut.Apply(Doc, textCutWords, textCutWords.Select(w => w.Text).ToList());
      textCutWords = new List<WordItem>();
      Changed(); BuildInspector(); DrawTimeline();
      Status("已按文字删掉 " + removed.ToString("0.00", CultureInfo.InvariantCulture) + " 秒。");
     } catch (Exception ex) { Error(ex); }
    }, true));
   }
  }

  // ---- 声音页：Remix ----
  BeatGrid remixGrid;
  double remixTarget = 6;
  string remixStatus = "";
  void BuildRemixSection() {
   Section("Remix（音乐自适应时长）");
   Note("按节拍把音乐拉长/缩短到指定时长，不断裂；用节拍感知的循环/跳切拼贴，atempo 直拉会变调所以不用。只认起音丰富的音乐（鼓点/弹拨），独白/环境音测不出节拍。");
   if (!string.IsNullOrEmpty(remixStatus)) Note(remixStatus);
   inspector.Children.Add(InspectorAction("sound", "检测节拍", async () => {
    if (Doc == null || string.IsNullOrEmpty(Doc.Source)) return;
    Status("正在检测节拍…");
    try {
     var grid = await Task.Run(() => Remix.DetectBeats(Doc.Source, Doc.Duration, CancellationToken.None));
     remixGrid = grid;
     remixStatus = "节拍 " + grid.Bpm.ToString("0.0", CultureInfo.InvariantCulture) + " BPM · " + grid.Beats.Count + " 个节拍点 · 置信度 " + grid.Confidence.ToString("0.00", CultureInfo.InvariantCulture) + "。";
     Changed(); BuildInspector(); Status(remixStatus);
    } catch (Exception ex) { Error(ex); }
   }));
   if (remixGrid != null) {
    Number("目标时长 / 秒", remixTarget, v => remixTarget = v);
    inspector.Children.Add(UI.Button("生成 Remix 方案并导出…", () => {
     try {
      var plan = Remix.Plan(remixGrid.Beats, Doc.Duration, remixTarget);
      var remixDoc = Remix.BuildDoc(Doc, plan);
      remixDoc.Name = Doc.Name + " · Remix " + remixTarget.ToString("0.#", CultureInfo.InvariantCulture) + "s";
      var export = new ExportWindow(this, remixDoc, preview.Source);
      export.ShowDialog();
     } catch (Exception ex) { Error(ex); }
    }));
   }
  }

  // ---- 调色页：调整层 ----
  void BuildAdjustmentLayerSection() {
   Section("调整层");
   Note("时间线上一段空白层，挂的滤镜作用于下方所有片段（导出时生效，eq/colorbalance + enable=between）。预览不显示调整层效果，以导出为准。");
   if (Doc.AdjustmentLayers == null) Doc.AdjustmentLayers = new List<AdjustmentLayer>();
   for (int i = 0; i < Doc.AdjustmentLayers.Count; i++) {
    int idx = i; var layer = Doc.AdjustmentLayers[idx];
    Note("层 " + (idx + 1) + " · " + layer.Start.ToString("0.00", CultureInfo.InvariantCulture) + "–" + layer.End.ToString("0.00", CultureInfo.InvariantCulture) + "s");
    Number("层 " + (idx + 1) + " · 亮度", layer.Brightness, v => layer.Brightness = EditDocument.Clamp(v, -1, 1));
    Number("层 " + (idx + 1) + " · 开始 / 秒", layer.Start, v => layer.Start = EditDocument.Clamp(v, 0, layer.End - 0.05));
    Number("层 " + (idx + 1) + " · 结束 / 秒", layer.End, v => layer.End = EditDocument.Clamp(v, layer.Start + 0.05, Doc.Length));
    inspector.Children.Add(UI.Button("删除层 " + (idx + 1), () => { Checkpoint(); Doc.AdjustmentLayers.RemoveAt(idx); Changed(); BuildInspector(); }));
   }
   inspector.Children.Add(UI.Button("在播放头处加一层（2 秒，亮度 +0.2）", () => {
    Checkpoint();
    double start = Math.Min(position, Math.Max(0, Doc.Length - 0.2));
    Doc.AdjustmentLayers.Add(new AdjustmentLayer { Start = start, End = Math.Min(Doc.Length, start + 2), Brightness = 0.2 });
    Changed(); BuildInspector();
   }));
  }
 }
}
