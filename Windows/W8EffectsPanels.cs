// W8 收尾批：效果与媒体（2026-11-18，第 4 组）。
// 模型与纯逻辑；UI 见 W8EffectsUI.cs。滤镜串与参数出处（全部是已验证的数，不是现编的）：
// - 防抖：stabilize.ts——vidstab 两遍（detect 写 .trf 再 transform，
//   smoothing=15、optalgo=0、shakiness=5、accuracy=15，引擎 P1b 实测
//   去趋势抖动中位数 3.30–3.42 / 基线 8.07，约 41–50%）；deshake 单遍
//   rx=16:ry=16:edge=mirror（引擎实测 X 改善约 26%、Y 无改善）。
//   libvidstab 是 GPL 库，BtbN LGPL 构建不含 vidstabdetect/vidstabtransform，
//   缺失时诚实报错，不静默改走 deshake。
// - 人像抠像背景：portrait.ts——P1e 抠像（MediaPipe Selfie Segmentation，
//   447,658 字节，Apache 2.0）+ 背景链（虚化 gblur / 纯色 geq / 图片 / 原背景），
//   与绿幕共享“前景 alphamerge + overlay 到背景”的复合方式；
//   遮罩复用 W5 的 BeautyMask.GenerateSync（同一模型、同一脚本）。
// - 模板商店：templates.ts——4 个内置 JSON 模板（talking-clean、vlog-film、
//   beat-energetic、interview-duo），10 种坏模板拒绝；只做本地包，
//   不接版权音乐库。C# 侧只应用模板里已有的字段（调色预设 + 字幕样式 +
//   转场/淡入淡出记录）；转场本身 C# 导出管线不渲染（无 xfade），面板写明。
// - 场景切分：smartcut.ts——select='gt(scene,0.4)' + showinfo 读 pts_time，
//   探针：6 秒红/亮绿/蓝硬切片，阈值 0.3/0.4/0.5 都返回 [2.0, 4.0]；
//   只认硬切，溶解不检测（面板写明）。
// - 对象跟踪：p3g.ts——颜色质心（5 fps 采样，质量 <0.5% 判丢失、停在上一
//   点不编造）与 NCC 模板匹配（框选任意物体）；贴纸/文字/马赛克跟住走。
// - 克隆：p3g.ts——同一素材复制多路 + 固定遮罩分屏拼合（hstack/xstack），
//   lanes 2 或 4、offsets[0]=0 且严格递增、4 路必须 grid。
// - 抠像描边：p3g.ts——在 P1e 抠像的 alpha 上描边，dilation 一遍约长 1 px
//   （探针：r=30 圆盘 2809 → 3049 白像素，3 遍 → 3553）。
// - AI 放大：p3g.ts——ONNX 超分（Real-ESRGAN 类）本地跑；只做导出时可选，
//   慢（面板写明），模型许可发版前再核，模型缺失诚实报错，绝不用
//   lanczos 冒充 AI 放大。
// - 脚本转视频：p3g.ts——脚本/图片+文字自动组装成片（模板 P1d + TTS +
//   自动卡点拼起来）；C# v1 不含云端生成画面，按行时长拼片、文字烧录
//   为字幕 + .srt 边车。W9 接了 TTS 配音（P3f 同款 Sherpa-ONNX 调用链，
//   每段文案合成一段、按段对齐、不足 apad 垫满、超长 atrim 截断，模型
//   缺失诚实报错不伪造静音）与音乐卡点（BeatDetector 检节拍网格，段
//   边界向前贴 0.35 秒内的最近节拍点；无音乐/检不出节拍退化为等长分段）。
// - 元数据/归档/重链接/观察文件夹/导入收录：medialib.ts——clip 元数据
//   （场景/场次/关键词/备注）进 project.json，ALE 文本导出；归档打包 +
//   素材丢失重链接（同名 + 时长 ±0.1 秒，歧义不猜）；监看文件夹按
//   basename 找新增素材；导入时复制到项目媒体文件夹或转码成中间片。
// - 优化媒体：optimized.ts——DNxHR 中间片（FFmpeg dnxhd 编码器，LGPL），
//   默认 dnxhr_hq、yuv422p、音频 PCM；导出始终用原片（relink），
//   优化媒体只做预览，缺失是硬错、不静默回退。
// 代理铁律与 W3–W7 一致：导出始终用原片，代理/优化媒体只做预览。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using DogSC.Windows;

namespace DogSC.Replica {
 // 滤镜参数里的文件路径：FFmpeg 滤镜解析器里反斜杠是转义符，
// 路径里的 C:\work 会被吃掉反斜杠；统一写正斜杠 + 单引号。
 static class W8Paths {
  // 滤镜串里的路径：反斜杠改正斜杠，冒号必须转义成 \: ——ffmpeg 的
  // 滤镜解析器在选项层按冒号切分，单引号拦不住盘符冒号（D:），
  // 云端 run 42 实测：result='D:/...trf' 直接报 No option name；
  // 本地复现确认 \: 可行。Windows CRT 只在双引号前处理反斜杠，
  // 所以 \: 能原样到达 ffmpeg 再被还原成冒号。
  public static string FilterPath(string path) {
   return "'" + path.Replace("\\", "/").Replace(":", "\\:").Replace("'", "\\'") + "'";
  }
  // 非滤镜串里的路径（concat 清单 file '...'）：冒号不用转义，
  // 转了反而找不到文件；只做单引号包裹 + 正斜杠。
  public static string QuotedPath(string path) {
   return "'" + path.Replace("\\", "/").Replace("'", "\\'") + "'";
  }
  public static string CodecOf(string file) {
   using (var p = Media.Start("ffprobe", "-v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 " + Media.Q(file), true)) {
    var err = p.StandardError.ReadToEndAsync();
    string text = p.StandardOutput.ReadToEnd();
    p.WaitForExit();
    if (p.ExitCode != 0) throw new Exception("读视频编码失败：" + err.Result);
    return text.Trim();
   }
  }
 }

 // ---- 1. 防抖开关（stabilize.ts）----
 static class Stabilizer {
  public static void Validate(EditDocument doc) {
   if (!doc.StabilizeEnabled) return;
   if (doc.StabilizeMethod != "vidstab" && doc.StabilizeMethod != "deshake")
    throw new Exception("防抖方法无效：" + doc.StabilizeMethod + "（vidstab / deshake）。");
   if (!EditDocument.Finite(doc.StabilizeSmoothing) || doc.StabilizeSmoothing < 0 || doc.StabilizeSmoothing > 1000)
    throw new Exception("防抖平滑无效：" + doc.StabilizeSmoothing + "（0–1000）。");
   if (!EditDocument.Finite(doc.StabilizeZoom) || doc.StabilizeZoom < -100 || doc.StabilizeZoom > 100)
    throw new Exception("防抖缩放无效：" + doc.StabilizeZoom + "（-100–100）。");
   if (doc.StabilizeShakiness < 1 || doc.StabilizeShakiness > 10)
    throw new Exception("防抖 shakiness 无效：" + doc.StabilizeShakiness + "（1–10）。");
   if (doc.StabilizeAccuracy < 1 || doc.StabilizeAccuracy > 15)
    throw new Exception("防抖 accuracy 无效：" + doc.StabilizeAccuracy + "（1–15）。");
   if (doc.DeshakeRx < 0 || doc.DeshakeRx > 64 || doc.DeshakeRy < 0 || doc.DeshakeRy > 64)
    throw new Exception("deshake 搜索范围无效：" + doc.DeshakeRx + "/" + doc.DeshakeRy + "（0–64）。");
  }
  public static string VidstabTransformFilter(string trfPath, EditDocument doc) {
   string s = "vidstabtransform=input=" + W8Paths.FilterPath(trfPath) + ":smoothing=" + Media.N(doc.StabilizeSmoothing) + ":optalgo=0";
   if (doc.StabilizeZoom != 0) s += ":zoom=" + Media.N(doc.StabilizeZoom);
   return s;
  }
  public static string DeshakeFilter(EditDocument doc) {
   return "deshake=rx=" + doc.DeshakeRx + ":ry=" + doc.DeshakeRy + ":edge=3";
  }
  public static bool HasVidstab() {
   try {
    using (var p = Media.Start("ffmpeg", "-filters", true)) {
     var err = p.StandardError.ReadToEndAsync();
     string text = p.StandardOutput.ReadToEnd();
     p.WaitForExit();
     if (p.ExitCode != 0) return false;
     return text.Contains("vidstabtransform");
    }
   } catch { return false; }
  }
  // 对整个文件做防抖，返回防抖后的文件（音频原样复制）。调用方是导出：
  // 时间线已拼好的 timeline.mp4 或直接路径的源文件都走这里。
  public static string StabilizeFile(string source, EditDocument doc, string workDir, CancellationToken token) {
   Validate(doc);
   if (!File.Exists(source)) throw new Exception("找不到要防抖的素材：" + source + "。");
   string output = Path.Combine(workDir, "stabilized.mp4");
   if (doc.StabilizeMethod == "deshake") {
    StudioMedia.Run("-v error -y -i " + Media.Q(source) + " -vf " + DeshakeFilter(doc) + " -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p -c:a copy " + Media.Q(output), token);
   } else {
    if (!HasVidstab())
     throw new Exception("当前 FFmpeg 不含 vidstab（vidstabdetect/vidstabtransform 是 GPL 库，LGPL 构建不含）。改用 deshake（Y 向无改善，面板已写明），或换 GPL 构建的 FFmpeg。");
    string trf = Path.Combine(workDir, "stab.trf");
    StudioMedia.Run("-v error -y -i " + Media.Q(source) + " -vf vidstabdetect=result=" + W8Paths.FilterPath(trf) + ":shakiness=" + doc.StabilizeShakiness + ":accuracy=" + doc.StabilizeAccuracy + " -f null -", token);
    if (!File.Exists(trf)) throw new Exception("防抖检测没有生成 .trf 文件。");
    StudioMedia.Run("-v error -y -i " + Media.Q(source) + " -vf " + VidstabTransformFilter(trf, doc) + " -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p -c:a copy " + Media.Q(output), token);
   }
   double d = Media.Duration(output), s = Media.Duration(source);
   if (Math.Abs(d - s) > .1) throw new Exception("防抖后时长与原片不符：防抖 " + d.ToString("0.00") + "s，原片 " + s.ToString("0.00") + "s。");
   return output;
  }
 }

 // ---- 2. 人像抠像背景选择（portrait.ts）----
 // 背景模式：original（原背景，什么都不做）/ blur（原背景虚化）/
 // color（纯色）/ image（图片）。color 与 image 不能并存（portrait.ts
 // 同款规则：background 要么 color 要么 source）。
 static class PortraitBackground {
  public static void Validate(EditDocument doc) {
   if (!doc.PortraitEnabled) return;
   if (doc.PortraitBgMode != "original" && doc.PortraitBgMode != "blur" && doc.PortraitBgMode != "color" && doc.PortraitBgMode != "image")
    throw new Exception("抠像背景模式无效：" + doc.PortraitBgMode + "。");
   if (doc.PortraitBgMode == "color") KeyOutline.ParseColor(doc.PortraitBgColor);
   if (doc.PortraitBgMode == "image" && (string.IsNullOrEmpty(doc.PortraitBgImage) || !File.Exists(doc.PortraitBgImage)))
    throw new Exception("抠像背景图片缺失：" + (string.IsNullOrEmpty(doc.PortraitBgImage) ? "（未选择）" : doc.PortraitBgImage) + "。");
   if (!EditDocument.Finite(doc.PortraitBgBlur) || doc.PortraitBgBlur < 0 || doc.PortraitBgBlur > 30)
    throw new Exception("背景虚化无效：" + doc.PortraitBgBlur + "（0–30）。");
   if (!EditDocument.Finite(doc.PortraitEdgeFeather) || doc.PortraitEdgeFeather < 0 || doc.PortraitEdgeFeather > 10)
    throw new Exception("抠像边缘羽化无效：" + doc.PortraitEdgeFeather + "（0–10）。");
  }
  // 复合图串（输入：[0:v] 画面、[1:v] 遮罩视频、[2:v] 背景图片仅 image 模式）。
  // videoFilters 是 [0:v] 之后、split 之前的链（如 scale=… + 降噪），与
  // W5Media.MaskedFilterComplex 的用法一致；gradeFilters 是调色链
  // （W5Effects.GradeChain，不带开头的逗号）。
  public static string FilterComplex(string videoFilters, double fps, int w, int h, EditDocument doc, string gradeFilters) {
   Validate(doc);
   var sb = new StringBuilder();
   sb.Append("[0:v]").Append(videoFilters).Append("[v0];");
   string blur = doc.PortraitEdgeFeather > 0 ? ",gblur=sigma=" + Media.N(doc.PortraitEdgeFeather) : "";
   sb.Append("[1:v]fps=fps=").Append(Media.N(fps)).Append(",scale=").Append(w).Append(":").Append(h).Append(",format=gray").Append(blur).Append("[m];");
   // 背景链：blur 用原画虚化；color 用 geq 把整帧写成纯色（color 源在
   // filter_complex 里要另给时长，geq 没有这个问题）；image 用第二输入。
   // [v0] 要分给前景、背景、描边上色三路，先 split（标签只能被消费一次，
   // split 的每路输出也都必须被消费，image 模式没有背景路就不分 vbg）。
   int splitN = doc.OutlineEnabled ? 3 : 2;
   string fgSrc = "[vfg]";
   if (doc.PortraitBgMode == "blur") {
    sb.Append("[v0]split=").Append(splitN).Append("[vfg][vbg]").Append(doc.OutlineEnabled ? "[voc];" : ";");
    sb.Append("[vbg]gblur=sigma=").Append(Media.N(doc.PortraitBgBlur)).Append("[bg];");
   } else if (doc.PortraitBgMode == "color") {
    int[] rgb = KeyOutline.ParseColor(doc.PortraitBgColor);
    sb.Append("[v0]split=").Append(splitN).Append("[vfg][vbg]").Append(doc.OutlineEnabled ? "[voc];" : ";");
    sb.Append("[vbg]geq=r=").Append(rgb[0]).Append(":g=").Append(rgb[1]).Append(":b=").Append(rgb[2]).Append("[bg];");
   } else if (doc.PortraitBgMode == "image") {
    if (doc.OutlineEnabled) sb.Append("[v0]split=2[vfg][voc];");
    else fgSrc = "[v0]";
    sb.Append("[2:v]scale=").Append(w).Append(":").Append(h).Append(",fps=fps=").Append(Media.N(fps)).Append("[bg];");
   } else {
    // original：背景就是原画本身，前景直接盖上去。
    sb.Append("[v0]split=").Append(splitN).Append("[vfg][vbg]").Append(doc.OutlineEnabled ? "[voc];" : ";");
    sb.Append("[vbg]format=yuv420p[bg];");
   }
   sb.Append(fgSrc).Append("format=yuva420p[vfgf];");
   sb.Append("[vfgf][m]alphamerge[fg];");
   string bg = "[bg]";
   if (doc.OutlineEnabled) {
    // 描边（第 7 项）：dilation 长大的遮罩减去原遮罩 = 边缘环，
    // 环上色后先盖到背景上，再盖前景。
    sb.Append("[m]").Append(KeyOutline.DilationFilter(doc.OutlineWidth)).Append("[md];");
    sb.Append("[md][m]blend=all_mode=difference[ring];");
    int[] oc = KeyOutline.ParseColor(doc.OutlineColor);
    sb.Append("[voc]geq=r=").Append(oc[0]).Append(":g=").Append(oc[1]).Append(":b=").Append(oc[2]).Append("[oc];");
    sb.Append("[oc][ring]alphamerge[ol];");
    sb.Append("[bg][ol]overlay=0:0[bg2];");
    bg = "[bg2]";
   }
   sb.Append(bg).Append("[fg]overlay=0:0,format=yuv420p[vb2];");
   Finish(sb, gradeFilters);
   return sb.ToString();
  }
  static void Finish(StringBuilder sb, string gradeFilters) {
   if (string.IsNullOrEmpty(gradeFilters)) sb.Append("[vb2]format=yuv420p[out];");
   else sb.Append("[vb2]").Append(gradeFilters).Append("[out];");
  }
 }

 // ---- 7. 抠像描边（p3g.ts）----
 static class KeyOutline {
  static readonly Dictionary<string, int[]> Named = new Dictionary<string, int[]> {
   { "red", new[] { 255, 0, 0 } }, { "green", new[] { 0, 255, 0 } }, { "blue", new[] { 0, 0, 255 } },
   { "white", new[] { 255, 255, 255 } }, { "black", new[] { 0, 0, 0 } }, { "yellow", new[] { 255, 255, 0 } },
   { "cyan", new[] { 0, 255, 255 } }, { "magenta", new[] { 255, 0, 255 } }
  };
  public static int[] ParseColor(string color) {
   if (string.IsNullOrWhiteSpace(color)) throw new Exception("描边/背景颜色为空（用 #rrggbb 或 red/green/blue/white/black/yellow/cyan/magenta）。");
   string c = color.Trim().ToLowerInvariant();
   int[] named;
   if (Named.TryGetValue(c, out named)) return named;
   if (c.Length == 7 && c[0] == '#') {
    try {
     int v = int.Parse(c.Substring(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
     return new[] { (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff };
    } catch { }
   }
   throw new Exception("未知的颜色 \"" + color + "\"（用 #rrggbb 或 red/green/blue/white/black/yellow/cyan/magenta）。");
  }
  public static void Validate(EditDocument doc) {
   if (!doc.OutlineEnabled) return;
   ParseColor(doc.OutlineColor);
   if (doc.OutlineWidth < 1 || doc.OutlineWidth > 10)
    throw new Exception("描边粗细无效：" + doc.OutlineWidth + "（1–10 px）。");
  }
  // dilation 一遍约长 1 px（引擎探针：r=30 圆盘 2809 → 3049 白像素，
  // 3 遍 → 3553），串 width 遍就是描边粗细。
  public static string DilationFilter(int width) {
   return string.Join(",", Enumerable.Repeat("dilation=threshold0=255", width).ToArray());
  }
 }

 // ---- 3. 模板商店（templates.ts，本地包）----
 public class W8Template {
  public string Id; public string Label; public string Description;
  public string Transition = "cut"; public double TransitionDuration;
  public string TextStylePreset; public string ColorPreset; public string MaskShape;
  public double AudioFadeIn; public double AudioFadeOut;
 }
 static class TemplateStore {
  // 4 个内置模板，值照抄 engine/templates/*.json（id/label/描述/
  // 转场/预设名/淡入淡出）；C# 侧只应用调色预设 + 字幕样式 + 转场记录。
  public static List<W8Template> BuiltIn() {
   return new List<W8Template> {
    new W8Template { Id = "talking-clean", Label = "口播·干净", Description = "口播干净款：硬切、下三分之一字幕、轻推近、首尾各 0.3 秒淡入淡出。什么都不抢戏，话本身是主角。", Transition = "cut", TextStylePreset = "lowerThird", AudioFadeIn = 0.3, AudioFadeOut = 0.3 },
    new W8Template { Id = "vlog-film", Label = "vlog·胶片", Description = "vlog 胶片感：溶解转场 0.8 秒、暖色、大标题字幕、首尾 0.5 秒淡入淡出。适合旅行与日常记录。", Transition = "dissolve", TransitionDuration = 0.8, TextStylePreset = "title", ColorPreset = "warm", AudioFadeIn = 0.5, AudioFadeOut = 0.5 },
    new W8Template { Id = "beat-energetic", Label = "卡点·动感", Description = "卡点动感款：硬切、中央强调大字、冷色、每个节拍推近到 1.2。需要先检出节拍（BeatGrid）才能套用。", Transition = "cut", TextStylePreset = "emphasis", ColorPreset = "cool", AudioFadeIn = 0.1, AudioFadeOut = 0.3 },
    new W8Template { Id = "interview-duo", Label = "访谈·双人", Description = "访谈双人款：淡入淡出转场 0.6 秒、冷色、下三分之一字幕、轻推近、首尾 0.5 秒淡入淡出。稳，不抢话。", Transition = "fade", TransitionDuration = 0.6, TextStylePreset = "lowerThird", ColorPreset = "cool", AudioFadeIn = 0.5, AudioFadeOut = 0.5 }
   };
  }
  public static W8Template Find(string id) {
   foreach (var t in BuiltIn()) if (t.Id == id) return t;
   return null;
  }
  static readonly string[] Transitions = { "cut", "fade", "dissolve", "wipeleft", "wiperight", "slideleft", "circleopen", "fadeblack", "fadewhite" };
  static readonly string[] TextStyles = { "title", "lowerThird", "emphasis" };
  static readonly string[] ColorPresets = { "warm", "cool" };
  static readonly string[] MaskShapes = { "circle", "ellipse", "rect", "roundedRect" };
  static readonly string[] KnownKeys = { "id", "label", "description", "version", "transition", "transitionDuration", "textStylePreset", "textStyle", "colorPreset", "color", "mask", "autoZoom", "beatPulse", "audioFadeIn", "audioFadeOut", "canvas" };
  static string Str(Dictionary<string, object> d, string key) {
   object v;
   if (!d.TryGetValue(key, out v) || v == null) return null;
   return v.ToString();
  }
  static void CheckNum(Dictionary<string, object> d, string key, string id, double lo, double hi) {
   object v;
   if (!d.TryGetValue(key, out v) || v == null) return;
   double n;
   try { n = Convert.ToDouble(v, CultureInfo.InvariantCulture); } catch { throw new Exception("模板 " + id + "：" + key + " 不是数字。"); }
   if (!EditDocument.Finite(n) || n < lo || n > hi) throw new Exception("模板 " + id + "：" + key + " " + n + " 超出 [" + lo + ", " + hi + "]。");
  }
  // 解析 + 校验（templates.ts validateTemplate 的同款规则）：10 种坏
  // 模板全部拒绝——无效 JSON、缺 id、缺 label、缺 description、未知转场、
  // 未知文字/调色预设名、预设与内联并存、坏蒙版形状、未知字段、版本号不是 1。
  public static W8Template Parse(string json) {
   Dictionary<string, object> d;
   try { d = EditDocument.Serializer().Deserialize<Dictionary<string, object>>(json); }
   catch (Exception ex) { throw new Exception("模板不是有效 JSON：" + ex.Message); }
   if (d == null) throw new Exception("模板不是一个对象。");
   foreach (string k in d.Keys) if (!KnownKeys.Contains(k)) throw new Exception("模板 " + Str(d, "id") + "：未知字段 " + k + "。");
   string id = Str(d, "id");
   if (string.IsNullOrEmpty(id)) throw new Exception("模板缺 id。");
   if (string.IsNullOrEmpty(Str(d, "label"))) throw new Exception("模板 " + id + "：缺 label。");
   if (string.IsNullOrEmpty(Str(d, "description"))) throw new Exception("模板 " + id + "：缺 description。");
   object ver;
   if (d.TryGetValue("version", out ver) && ver != null) {
    double v;
    try { v = Convert.ToDouble(ver, CultureInfo.InvariantCulture); } catch { throw new Exception("模板 " + id + "：version 不是数字。"); }
    if (v != 1) throw new Exception("模板 " + id + "：不支持的版本 " + v + "。");
   }
   string tr = Str(d, "transition");
   if (tr != null && !Transitions.Contains(tr)) throw new Exception("模板 " + id + "：未知转场 " + tr + "。");
   CheckNum(d, "transitionDuration", id, 0.1, 5);
   string ts = Str(d, "textStylePreset");
   if (ts != null && !TextStyles.Contains(ts)) throw new Exception("模板 " + id + "：未知文字预设 " + ts + "。");
   if (ts != null && d.ContainsKey("textStyle")) throw new Exception("模板 " + id + "：textStylePreset 与 textStyle 并存，只能选一个。");
   string cp = Str(d, "colorPreset");
   if (cp != null && !ColorPresets.Contains(cp)) throw new Exception("模板 " + id + "：未知调色预设 " + cp + "。");
   if (cp != null && d.ContainsKey("color")) throw new Exception("模板 " + id + "：colorPreset 与 color 并存，只能选一个。");
   string maskShape = null;
   object mask;
   if (d.TryGetValue("mask", out mask) && mask != null) {
    var md = mask as Dictionary<string, object>;
    if (md == null) throw new Exception("模板 " + id + "：mask 不是对象。");
    maskShape = Str(md, "shape");
    if (maskShape == null || !MaskShapes.Contains(maskShape)) throw new Exception("模板 " + id + "：坏蒙版形状 " + maskShape + "。");
   }
   CheckNum(d, "audioFadeIn", id, 0, 10);
   CheckNum(d, "audioFadeOut", id, 0, 10);
   var t = new W8Template { Id = id, Label = Str(d, "label"), Description = Str(d, "description"), Transition = tr ?? "cut", TextStylePreset = ts, ColorPreset = cp, MaskShape = maskShape };
   object td;
   if (d.TryGetValue("transitionDuration", out td) && td != null) t.TransitionDuration = Convert.ToDouble(td, CultureInfo.InvariantCulture);
   object fi;
   if (d.TryGetValue("audioFadeIn", out fi) && fi != null) t.AudioFadeIn = Convert.ToDouble(fi, CultureInfo.InvariantCulture);
   object fo;
   if (d.TryGetValue("audioFadeOut", out fo) && fo != null) t.AudioFadeOut = Convert.ToDouble(fo, CultureInfo.InvariantCulture);
   return t;
  }
  // 应用到当前项目：调色预设（与 ApplyColorPreset 同款数值）+ 字幕烧录
  // 开 + 转场/淡入淡出记在项目上。转场本身 C# 导出管线不渲染（无 xfade），
  // 面板写明，不假装套了转场就有转场。
  public static void Apply(EditDocument doc, string id) {
   var t = Find(id);
   if (t == null) throw new Exception("找不到内置模板：" + id + "。");
   ApplyTemplate(doc, t);
  }
  public static void ApplyTemplate(EditDocument doc, W8Template t) {
   if (doc == null || t == null) throw new Exception("没有可应用的模板。");
   doc.Grade.Reset();
   if (t.ColorPreset == "warm") { doc.Grade.Temperature = .35; doc.Grade.Saturation = 1.05; }
   else if (t.ColorPreset == "cool") { doc.Grade.Temperature = -.35; doc.Grade.Saturation = 1.05; }
   doc.SubtitleBurnIn = true;
   doc.TemplateId = t.Id;
   doc.Transition = t.Transition;
   doc.TransitionDuration = t.TransitionDuration;
   doc.AudioFadeIn = t.AudioFadeIn;
   doc.AudioFadeOut = t.AudioFadeOut;
  }
 }

 // ---- 4. 场景切分面板（smartcut.ts）----
 static class SceneCut {
  public class Span { public double Start; public double End; public double Length { get { return End - Start; } } }
  public static void ValidateThreshold(double threshold) {
   if (!EditDocument.Finite(threshold) || threshold < 0.05 || threshold > 0.95)
    throw new Exception("场景阈值无效：" + threshold + "（0.05–0.95）。");
  }
  // select='gt(scene,阈值)' + showinfo，读 pts_time。只认硬切，
  // 溶解不检测（面板写明）。探针：6 秒红/亮绿/蓝硬切，阈值 0.3/0.4/0.5
  // 都返回 [2.0, 4.0]（注意：named green 是暗绿 0x008000，亮度与红
  // 相同，切点看不见；测试素材必须用亮绿 0x00FF00）。
  public static List<double> Detect(string source, double threshold, CancellationToken token) {
   ValidateThreshold(threshold);
   if (string.IsNullOrEmpty(source) || !File.Exists(source)) throw new Exception("找不到要检测场景的素材：" + source + "。");
   using (var p = Media.Start("ffmpeg", "-v info -i " + Media.Q(source) + " -vf select='gt(scene," + Media.N(threshold) + ")',showinfo -f null -", false)) {
    var err = p.StandardError.ReadToEndAsync();
    p.StandardInput.Close();
    p.WaitForExit();
    token.ThrowIfCancellationRequested();
    if (p.ExitCode != 0) throw new Exception("场景检测失败：" + err.Result);
    var cuts = new List<double>();
    foreach (string raw in err.Result.Split('\n')) {
     if (!raw.Contains("Parsed_showinfo")) continue;
     int at = raw.IndexOf("pts_time:", StringComparison.Ordinal);
     if (at < 0) continue;
     string rest = raw.Substring(at + 9).Trim().Split(' ')[0];
     double v;
     if (double.TryParse(rest, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) cuts.Add(v);
    }
    cuts.Sort();
    return cuts;
   }
  }
  // 切点（源时间）→ 分段（<0.1 秒的相邻切点合并到前一个，编码抖动）。
  public static List<Span> ToSegments(List<double> cuts, double duration) {
   var bounds = new List<double> { 0 };
   if (cuts != null) foreach (double c in cuts) {
    if (c <= 0 || c >= duration) continue;
    if (c - bounds[bounds.Count - 1] < 0.1) continue;
    bounds.Add(c);
   }
   bounds.Add(duration);
   var segs = new List<Span>();
   for (int i = 0; i + 1 < bounds.Count; i++) if (bounds[i + 1] - bounds[i] > 0.001) segs.Add(new Span { Start = bounds[i], End = bounds[i + 1] });
   return segs;
  }
  // 切点进时间线：把每个非空隙片段按切点劈开（保留原速度），返回新片段数。
  public static int Apply(EditDocument doc, List<double> cuts) {
   if (doc == null) throw new Exception("没有打开的项目。");
   if (cuts == null || cuts.Count == 0) return doc.Cuts.Count;
   var kept = new List<Cut>();
   foreach (var c in doc.Cuts) {
    if (c.Gap) { kept.Add(c); continue; }
    var bounds = new List<double> { c.Start };
    foreach (double t in cuts) if (t > c.Start + 0.05 && t < c.End - 0.05) bounds.Add(t);
    bounds.Add(c.End);
    bounds.Sort();
    for (int i = 0; i + 1 < bounds.Count; i++) kept.Add(new Cut { Start = bounds[i], End = bounds[i + 1], Speed = c.Speed });
   }
   if (kept.Count == 0) throw new Exception("场景切分后没有剩下片段。");
   doc.Cuts = kept;
   return kept.Count;
  }
 }

 // ---- 5. 对象跟踪（p3g.ts）----
 public class TrackPoint { public double T; public double X; public double Y; public bool Lost; public double Mass; }
 static class ObjectTracker {
  public const double SampleFps = 5;
  public const int TrackW = 320; public const int TrackH = 180;
  public static void Validate(EditDocument doc) {
   if (!doc.ObjectTrackEnabled) return;
   if (doc.ObjectTrackMethod != "color" && doc.ObjectTrackMethod != "template")
    throw new Exception("跟踪方法无效：" + doc.ObjectTrackMethod + "（color / template）。");
   if (doc.ObjectTrackMethod == "color") KeyOutline.ParseColor(doc.ObjectTrackColor);
   if (doc.ObjectTrackMethod == "template") {
    if (!EditDocument.Finite(doc.TrackBoxX) || !EditDocument.Finite(doc.TrackBoxY) || !EditDocument.Finite(doc.TrackBoxW) || !EditDocument.Finite(doc.TrackBoxH)
     || doc.TrackBoxX < 0 || doc.TrackBoxY < 0 || doc.TrackBoxW <= 0 || doc.TrackBoxH <= 0 || doc.TrackBoxX + doc.TrackBoxW > 1 || doc.TrackBoxY + doc.TrackBoxH > 1)
     throw new Exception("跟踪框超出画面：" + doc.TrackBoxX + "," + doc.TrackBoxY + "," + doc.TrackBoxW + "," + doc.TrackBoxH + "。");
   }
   if (!EditDocument.Finite(doc.ObjectTrackTolerance) || doc.ObjectTrackTolerance < 0 || doc.ObjectTrackTolerance > 442)
    throw new Exception("颜色容差无效：" + doc.ObjectTrackTolerance + "（0–442）。");
   if (!EditDocument.Finite(doc.ObjectTrackMosaic) || doc.ObjectTrackMosaic < 0 || doc.ObjectTrackMosaic > 0.5)
    throw new Exception("马赛克大小无效：" + doc.ObjectTrackMosaic + "（0–0.5 画面宽）。");
   if (!string.IsNullOrEmpty(doc.ObjectTrackSticker) && string.IsNullOrWhiteSpace(doc.ObjectTrackSticker))
    throw new Exception("跟随文字不能为空。");
   if (string.IsNullOrEmpty(doc.ObjectTrackSticker) && doc.ObjectTrackMosaic <= 0)
    throw new Exception("对象跟踪需要跟随文字或马赛克其一，否则跟了也没东西可看。");
  }
  // 5 fps / 320x180 RGB24 解码（与 BeatDetector.DecodeAudioMono 同款取流方式）。
  static byte[] DecodeRgb24(string file, CancellationToken token) {
   using (var p = Media.Start("ffmpeg", "-v error -i " + Media.Q(file) + " -vf fps=fps=" + Media.N(SampleFps) + ",scale=" + TrackW + ":" + TrackH + " -f rawvideo -pix_fmt rgb24 -", true))
   using (token.Register(() => { try { if (!p.HasExited) p.Kill(); } catch { } })) {
    var errors = p.StandardError.ReadToEndAsync();
    using (var ms = new MemoryStream()) {
     p.StandardOutput.BaseStream.CopyTo(ms);
     p.WaitForExit();
     token.ThrowIfCancellationRequested();
     if (p.ExitCode != 0) throw new Exception("跟踪解码失败：" + errors.Result);
     return ms.ToArray();
    }
   }
  }
  public static List<TrackPoint> Track(string source, EditDocument doc, CancellationToken token) {
   Validate(doc);
   if (string.IsNullOrEmpty(source) || !File.Exists(source)) throw new Exception("找不到要跟踪的素材：" + source + "。");
   byte[] bytes = DecodeRgb24(source, token);
   int fs = TrackW * TrackH * 3;
   int n = bytes.Length / fs;
   if (n == 0) throw new Exception("跟踪没有解出任何帧。");
   var points = new List<TrackPoint>();
   if (doc.ObjectTrackMethod == "color") {
    int[] c = KeyOutline.ParseColor(doc.ObjectTrackColor);
    double tol = doc.ObjectTrackTolerance;
    double lastX = .5, lastY = .5;
    for (int f = 0; f < n; f++) {
     double sx = 0, sy = 0; long sw = 0;
     int off = f * fs;
     for (int y = 0; y < TrackH; y++) for (int x = 0; x < TrackW; x++) {
      int o = off + (y * TrackW + x) * 3;
      double dr = bytes[o] - c[0], dg = bytes[o + 1] - c[1], db = bytes[o + 2] - c[2];
      if (dr * dr + dg * dg + db * db <= tol * tol) { sx += x; sy += y; sw++; }
     }
     double mass = (double)sw / (TrackW * TrackH);
     bool lost = mass < 0.005;
     if (!lost) { lastX = sx / sw / TrackW; lastY = sy / sw / TrackH; }
     points.Add(new TrackPoint { T = f / SampleFps, X = lastX, Y = lastY, Lost = lost, Mass = mass });
    }
    return points;
   }
   // template：首帧框选区作模板，NCC 在上一位置 ±24 px 窗口内搜，
   // 最佳 NCC < 0.5 判丢失、停在上一位置不编造。
   int bx = (int)(doc.TrackBoxX * TrackW), by = (int)(doc.TrackBoxY * TrackH);
   int bw = Math.Max(4, (int)(doc.TrackBoxW * TrackW)), bh = Math.Max(4, (int)(doc.TrackBoxH * TrackH));
   bw = Math.Min(bw, 64); bh = Math.Min(bh, 64);
   Func<int, int, int, double> gray = (f, x, y) => {
    int o = f * fs + (y * TrackW + x) * 3;
    return (bytes[o] * .299 + bytes[o + 1] * .587 + bytes[o + 2] * .114);
   };
   double cx = doc.TrackBoxX + doc.TrackBoxW / 2, cy = doc.TrackBoxY + doc.TrackBoxH / 2;
   for (int f = 0; f < n; f++) {
    if (f == 0) { points.Add(new TrackPoint { T = 0, X = cx, Y = cy, Lost = false, Mass = 1 }); continue; }
    double best = -2; int bestX = (int)(cx * TrackW), bestY = (int)(cy * TrackH);
    int pcx = (int)(cx * TrackW), pcy = (int)(cy * TrackH);
    for (int dy = -24; dy <= 24; dy += 2) for (int dx = -24; dx <= 24; dx += 2) {
     int tx = pcx + dx - bw / 2, ty = pcy + dy - bh / 2;
     if (tx < 0 || ty < 0 || tx + bw > TrackW || ty + bh > TrackH) continue;
     double sxy = 0, sxx = 0, syy = 0, mx = 0, my = 0; int cnt = 0;
     for (int y = 0; y < bh; y += 2) for (int x = 0; x < bw; x += 2) { mx += gray(0, bx + x, by + y); my += gray(f, tx + x, ty + y); cnt++; }
     mx /= cnt; my /= cnt;
     for (int y = 0; y < bh; y += 2) for (int x = 0; x < bw; x += 2) {
      double a = gray(0, bx + x, by + y) - mx, b = gray(f, tx + x, ty + y) - my;
      sxy += a * b; sxx += a * a; syy += b * b;
     }
     double ncc = (sxx <= 0 || syy <= 0) ? -1 : sxy / Math.Sqrt(sxx * syy);
     if (ncc > best) { best = ncc; bestX = tx + bw / 2; bestY = ty + bh / 2; }
    }
    bool lost = best < 0.5;
    if (!lost) { cx = (double)bestX / TrackW; cy = (double)bestY / TrackH; }
    points.Add(new TrackPoint { T = f / SampleFps, X = cx, Y = cy, Lost = lost, Mass = best });
   }
   return points;
  }
  static string EscapeDrawtext(string text) {
   return text.Replace("\\", "\\\\").Replace("'", "\\'").Replace(":", "\\:").Replace("%", "\\%").Replace("\n", " ").Replace("\r", " ");
  }
  public static string FontFile() {
   string dir = Path.GetFullPath(Path.Combine(Media.Root, "..", "Resources", "Fonts"));
   if (!Directory.Exists(dir)) return null;
   string[] fonts = Directory.GetFiles(dir, "*.otf");
   if (fonts.Length == 0) fonts = Directory.GetFiles(dir, "*.ttf");
   return fonts.Length == 0 ? null : fonts[0];
  }
  // 跟随文字：每 0.2 秒一个 drawtext，只在自己的时间窗内显示，
  // 位置取该采样点的跟踪中心（text_w/text_h 居中）。
  public static string StickerFilter(List<TrackPoint> track, string text, int width, int height) {
   string font = FontFile();
   if (font == null) throw new Exception("跟随文字需要字体文件（Resources/Fonts 下没有 .otf/.ttf）。");
   var sb = new StringBuilder();
   for (int i = 0; i < track.Count; i++) {
    var p = track[i];
    double t0 = p.T, t1 = i + 1 < track.Count ? track[i + 1].T : p.T + 1 / SampleFps;
    int cx = (int)Math.Round(p.X * width), cy = (int)Math.Round(p.Y * height);
    if (i > 0) sb.Append(",");
    sb.Append("drawtext=text='").Append(EscapeDrawtext(text)).Append("':fontfile=").Append(W8Paths.FilterPath(font))
     .Append(":fontsize=48:fontcolor=white:borderw=2:bordercolor=black")
     .Append(":x=").Append(cx).Append("-text_w/2:y=").Append(cy).Append("-text_h/2")
     .Append(":enable='between(t,").Append(Media.N(t0)).Append(",").Append(Media.N(t1)).Append(")'");
   }
   return sb.ToString();
  }
  // 马赛克遮罩视频：黑底 + 每采样点一个白框（drawbox + enable 时间窗），
  // 与跟踪采样对齐；复合时 maskedmerge 用它把像素化区域盖上去。
  public static void MosaicMaskVideo(List<TrackPoint> track, double mosaicSize, int width, int height, double fps, double duration, string output, CancellationToken token) {
   int box = Math.Max(4, (int)Math.Round(mosaicSize * width));
   box -= box % 2;
   var sb = new StringBuilder();
   for (int i = 0; i < track.Count; i++) {
    var p = track[i];
    double t0 = p.T, t1 = i + 1 < track.Count ? track[i + 1].T : duration;
    int x = Math.Max(0, Math.Min(width - box, (int)Math.Round(p.X * width - box / 2.0)));
    int y = Math.Max(0, Math.Min(height - box, (int)Math.Round(p.Y * height - box / 2.0)));
    if (i > 0) sb.Append(",");
    sb.Append("drawbox=x=").Append(x).Append(":y=").Append(y).Append(":w=").Append(box).Append(":h=").Append(box)
     .Append(":color=white:t=fill:enable='between(t,").Append(Media.N(t0)).Append(",").Append(Media.N(t1)).Append(")'");
   }
   StudioMedia.Run("-v error -y -f lavfi -i color=c=black:s=" + width + "x" + height + ":r=" + Media.N(fps) + ":d=" + Media.N(duration) + " -vf " + sb + " -c:v libx264 -pix_fmt yuv420p -r " + Media.N(fps) + " " + Media.Q(output), token);
  }
  // 对整个文件应用跟踪（马赛克和/或跟随文字），返回处理后的文件。
  // 调用方是导出：防抖之后、解码之前，对 timeline.mp4 或源文件做一遍。
  public static string ApplyToFile(string source, EditDocument doc, string workDir, CancellationToken token) {
   Validate(doc);
   var info = StudioMedia.Import(source);
   var track = Track(source, doc, token);
   string output = Path.Combine(workDir, "tracked.mp4");
   string mask = null;
   if (doc.ObjectTrackMosaic > 0) {
    mask = Path.Combine(workDir, "track-mask.mp4");
    MosaicMaskVideo(track, doc.ObjectTrackMosaic, info.Width, info.Height, info.FrameRate, info.Duration, mask, token);
   }
   string sticker = string.IsNullOrEmpty(doc.ObjectTrackSticker) ? null : StickerFilter(track, doc.ObjectTrackSticker, info.Width, info.Height);
   string graph;
   string inputs = "-v error -y -i " + Media.Q(source);
   if (mask != null) {
    inputs += " -i " + Media.Q(mask);
    // 像素化：先缩后放；回放必须写显式宽高——缩完后 iw/ih 已是缩后的
    // 尺寸，写 scale=iw:ih 会停在小尺寸上（maskedmerge 报尺寸不匹配）。
    int smallW = Math.Max(2, info.Width / 8), smallH = Math.Max(2, info.Height / 8);
    graph = "[0:v]split=2[orig][px];[px]scale=" + smallW + ":" + smallH + ":flags=neighbor,scale=" + info.Width + ":" + info.Height + ":flags=neighbor[pix];[orig][pix][1:v]maskedmerge[mv]";
    if (sticker != null) graph += ";[mv]" + sticker + "[vout]";
    else graph += ";[mv]format=yuv420p[vout]";
   } else {
    graph = "[0:v]" + sticker + "[vout]";
   }
   string audio = info.Audio ? "-map 0:a -c:a copy " : "-an ";
   StudioMedia.Run(inputs + " -filter_complex " + Media.Q(graph) + " -map [vout] " + audio + "-c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p -r " + Media.N(info.FrameRate) + " " + Media.Q(output), token);
   double d = Media.Duration(output), s = Media.Duration(source);
   if (Math.Abs(d - s) > .1) throw new Exception("对象跟踪后时长与原片不符：跟踪 " + d.ToString("0.00") + "s，原片 " + s.ToString("0.00") + "s。");
   return output;
  }
 }

 // ---- 6. 克隆（p3g.ts）----
 static class CloneEffect {
  public static double[] ParseOffsets(EditDocument doc) {
   if (string.IsNullOrWhiteSpace(doc.CloneOffsets)) throw new Exception("克隆时间偏移为空。");
   var parts = doc.CloneOffsets.Split(',');
   var offsets = new double[parts.Length];
   for (int i = 0; i < parts.Length; i++) {
    double v;
    if (!double.TryParse(parts[i].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out v))
     throw new Exception("克隆时间偏移不是数字：" + parts[i] + "。");
    offsets[i] = v;
   }
   return offsets;
  }
  public static void Validate(EditDocument doc) {
   if (!doc.CloneEnabled) return;
   if (doc.CloneLanes != 2 && doc.CloneLanes != 4)
    throw new Exception("克隆路数无效：" + doc.CloneLanes + "（2 或 4）。");
   double[] offsets = ParseOffsets(doc);
   if (offsets.Length != doc.CloneLanes)
    throw new Exception("克隆时间偏移必须是 " + doc.CloneLanes + " 个，实际 " + offsets.Length + " 个。");
   if (offsets[0] != 0)
    throw new Exception("克隆第 1 路偏移必须是 0（基准路），实际 " + offsets[0] + "。");
   for (int k = 1; k < offsets.Length; k++)
    if (!(offsets[k] > offsets[k - 1]))
     throw new Exception("克隆时间偏移必须严格递增。");
   if (doc.CloneLayout != "horizontal" && doc.CloneLayout != "grid")
    throw new Exception("克隆布局无效：" + doc.CloneLayout + "（horizontal / grid）。");
   if (doc.CloneLanes == 4 && doc.CloneLayout == "horizontal")
    throw new Exception("克隆 4 路必须用 grid 布局。");
  }
  // 每路画面尺寸（yuv420p 要偶数）：2 路左右分、4 路 2x2。
  public static void LaneSize(int lanes, int width, int height, out int laneW, out int laneH) {
   laneW = 2 * (width / 4);
   laneH = lanes == 2 ? height : 2 * (height / 4);
  }
  // 同一素材复制多路 + 固定遮罩分屏拼合：每路从源时间 offsets[k] 起
  // 取 duration 秒，缩到路宽，并排（hstack）或 2x2（xstack）。
  // 音频只取第 1 路（基准路）。复用 P1 形状蒙版 + 画中画的思路：
  // 每路就是一路画中画，位置固定。
  public static string Render(string source, EditDocument doc, double duration, string output, CancellationToken token) {
   Validate(doc);
   var info = StudioMedia.Import(source);
   double[] offsets = ParseOffsets(doc);
   if (offsets[offsets.Length - 1] + duration > info.Duration + 0.05)
    throw new Exception("克隆最晚一路的窗口超出素材：偏移 " + offsets[offsets.Length - 1] + "s + 片长 " + duration + "s > 素材 " + info.Duration.ToString("0.00") + "s。");
   int laneW, laneH;
   LaneSize(doc.CloneLanes, info.Width, info.Height, out laneW, out laneH);
   var sb = new StringBuilder();
   for (int k = 0; k < doc.CloneLanes; k++)
    sb.Append("[0:v]trim=start=").Append(Media.N(offsets[k])).Append(":end=").Append(Media.N(offsets[k] + duration))
     .Append(",setpts=PTS-STARTPTS,scale=").Append(laneW).Append(":").Append(laneH).Append("[v").Append(k).Append("];");
   for (int k = 0; k < doc.CloneLanes; k++) sb.Append("[v").Append(k).Append("]");
   if (doc.CloneLanes == 2) sb.Append("hstack=inputs=2[vout];");
   else sb.Append("xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[vout];");
   string audio = info.Audio ? "[0:a]atrim=start=0:end=" + Media.N(duration) + ",asetpts=PTS-STARTPTS[aout];" : "";
   string mapAudio = info.Audio ? " -map [aout] -c:a aac" : " -an";
   StudioMedia.Run("-v error -y -i " + Media.Q(source) + " -filter_complex " + Media.Q(sb + audio) + " -map [vout]" + mapAudio + " -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p -r " + Media.N(info.FrameRate) + " " + Media.Q(output), token);
   double d = Media.Duration(output);
   if (Math.Abs(d - duration) > .15) throw new Exception("克隆输出时长不符：输出 " + d.ToString("0.00") + "s，要 " + duration.ToString("0.00") + "s。");
   return output;
  }
 }

 // ---- 8. AI 放大（p3g.ts）----
 static class Upscaler {
  public static readonly string[] Models = { "realesrgan-x4plus", "realesrgan-x2plus" };
  public static int ScaleOf(string model) { return model == "realesrgan-x2plus" ? 2 : 4; }
  public static string ModelFileName(string model) { return model == "realesrgan-x2plus" ? "RealESRGAN_x2plus.onnx" : "RealESRGAN_x4plus.onnx"; }
  // 模型 + helper 脚本的查找位置（tools/models 随包分发是目标位置，
  // 发版前还要核模型许可；engine 侧的测试模型位置也认）。
  public static string FindModel(string model) {
   foreach (string dir in new[] { Path.Combine(Media.Root, "tools", "models"), Path.GetFullPath(Path.Combine(Media.Root, "..", "engine", "test", "models")), Path.GetFullPath(Path.Combine(Media.Root, "..", "engine", "models")) }) {
    string p = Path.Combine(dir, ModelFileName(model));
    if (File.Exists(p)) return p;
   }
   return null;
  }
  public static string FindScript() {
   foreach (string p in new[] { Path.Combine(Media.Root, "tools", "upscale.py"), Path.GetFullPath(Path.Combine(Media.Root, "..", "engine", "scripts", "upscale.py")) })
    if (File.Exists(p)) return p;
   return null;
  }
  // 缺什么就报什么，不编造。模型许可发版前再核（面板写明）。
  public static string CheckAvailable(string model) {
   if (!Models.Contains(model)) return "未知的放大模型：" + model + "。";
   if (FindModel(model) == null) return "AI 放大模型缺失（" + ModelFileName(model) + " 不在 tools/models/）。模型许可发版前再核，当前无法放大。";
   if (FindScript() == null) return "AI 放大 helper 脚本缺失（tools/upscale.py 不在包里）。";
   string python = WhisperTranscriber.FindPython();
   if (python == null) return "未找到 Python（python/py/python3 均不在 PATH）。";
   return null;
  }
  public static void Validate(EditDocument doc) {
   if (!doc.UpscaleEnabled) return;
   string problem = CheckAvailable(doc.UpscaleModel);
   if (problem != null) throw new Exception("AI 放大不可用：" + problem);
   if (doc.UpscaleTarget != "1080p" && doc.UpscaleTarget != "4K")
    throw new Exception("放大目标无效：" + doc.UpscaleTarget + "（1080p / 4K）。");
  }
  // 导出时可选的放大：对已渲染好的成片逐帧超分（与引擎 upscaleVideo
  // 同款帧循环：抽 PNG → onnxruntime 逐帧 → 按目标尺寸重编码，原音频
  // 原样接回）。慢——面板写明；目标必须大于源（否则拒绝，与引擎一致）。
  public static string UpscaleFile(string input, EditDocument doc, string workDir, CancellationToken token) {
   string problem = CheckAvailable(doc.UpscaleModel);
   if (problem != null) throw new Exception("AI 放大失败：" + problem);
   var info = StudioMedia.Import(input);
   int targetH = doc.UpscaleTarget == "4K" ? 2160 : 1080;
   int targetW = (int)Math.Round((double)info.Width * targetH / info.Height / 2) * 2;
   if (targetW <= info.Width || targetH <= info.Height)
    throw new Exception("放大目标 " + targetW + "x" + targetH + " 没有大于源 " + info.Width + "x" + info.Height + "，拒绝放大。");
   string model = FindModel(doc.UpscaleModel), script = FindScript(), python = WhisperTranscriber.FindPython();
   string inDir = Path.Combine(workDir, "upscale-in"), outDir = Path.Combine(workDir, "upscale-out");
   Directory.CreateDirectory(inDir);
   Directory.CreateDirectory(outDir);
   StudioMedia.Run("-v error -y -i " + Media.Q(input) + " -vf fps=fps=" + Media.N(info.FrameRate) + " " + Media.Q(Path.Combine(inDir, "%06d.png")), token);
   string[] frames = Directory.GetFiles(inDir, "*.png");
   if (frames.Length == 0) throw new Exception("AI 放大没有抽出任何帧。");
   using (var p = Media.Start(python, Media.Q(script) + " --model " + Media.Q(model) + " --in-dir " + Media.Q(inDir) + " --out-dir " + Media.Q(outDir) + " --scale " + ScaleOf(doc.UpscaleModel), false))
   using (token.Register(() => { try { p.Kill(); } catch { } })) {
    var err = p.StandardError.ReadToEndAsync();
    p.StandardInput.Close();
    p.WaitForExit();
    token.ThrowIfCancellationRequested();
    if (p.ExitCode != 0) throw new Exception("AI 放大推理失败：" + err.Result);
   }
   if (Directory.GetFiles(outDir, "*.png").Length != frames.Length)
    throw new Exception("AI 放大输出帧数与输入不符。");
   string output = Path.Combine(workDir, "upscaled.mp4");
   string audioArgs = info.Audio ? "-i " + Media.Q(input) + " -map 1:a -c:a copy" : "-an";
   StudioMedia.Run("-v error -y -framerate " + Media.N(info.FrameRate) + " -i " + Media.Q(Path.Combine(outDir, "%06d.png")) + " " + audioArgs + " -map 0:v -vf scale=" + targetW + ":" + targetH + ":flags=lanczos -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -shortest " + Media.Q(output), token);
   return output;
  }
 }

 // ---- 9. 脚本转视频（p3g.ts）----
 // W9（2026-11-19）：TTS 配音 + 节拍同步。段长规则照抄引擎
 // buildAutoVideoProject（p3g.ts）：配音开时段长 = 该段 TTS 实测时长
 // （不是行时长估），关时段长 = 行时长；节拍贴合只把段边界向前贴到
 // 0.35 秒内的最近节拍点（延长上一段的静帧 hold，旁白本身绝不拉伸，
 // 其长度永远装得进自己的段）；旁白按 apad=whole_dur 垫到段长，绝不
 // 用 -shortest（P3g 探针教训：卡点延长段会被 -shortest 截断）。
 public class AutoVideoLine { public string Text = ""; public string Image = ""; public double Duration = 3; }
 public class AutoVideoOptions {
  public bool NarrationEnabled = true;
  public string Voice = "aishell3 女声";
  public double TtsSpeed = 1;
  public bool BeatSyncEnabled = false;
  public string MusicPath = "";
  public double MusicVolume = 0.3;
  public const double BeatSnapWindow = 0.35;
 }
 public class AutoVideoSegment {
  public string Text = "";
  public double Start; public double Duration; public double TtsDuration;
  public bool Snapped; public double Beat; public bool HasNarration;
 }
 static class AutoVideo {
  public static void Validate(List<AutoVideoLine> lines, string templateId) {
   if (lines == null || lines.Count == 0) throw new Exception("脚本为空：至少写一行。");
   for (int i = 0; i < lines.Count; i++) {
    var line = lines[i];
    if (line == null || string.IsNullOrWhiteSpace(line.Text)) throw new Exception("脚本第 " + (i + 1) + " 行没有文字。");
    if (line.Text.Length > 2000) throw new Exception("脚本第 " + (i + 1) + " 行超过 2000 字（TTS 上限）。");
    if (!string.IsNullOrEmpty(line.Image) && !File.Exists(line.Image)) throw new Exception("脚本第 " + (i + 1) + " 行图片缺失：" + line.Image + "。");
    if (!EditDocument.Finite(line.Duration) || line.Duration < 0.5 || line.Duration > 60)
     throw new Exception("脚本第 " + (i + 1) + " 行时长无效：" + line.Duration + " 秒（0.5–60）。");
   }
   if (!string.IsNullOrEmpty(templateId) && TemplateStore.Find(templateId) == null)
    throw new Exception("未知的模板：" + templateId + "。");
  }
  public static void ValidateOptions(AutoVideoOptions options) {
   if (options == null) throw new Exception("脚本转视频缺少选项。");
   if (!TtsSettings.Voices.Contains(options.Voice)) throw new Exception("TTS 音色无效：" + options.Voice + "（v1 只有一个开源音色 aishell3 女声）。");
   if (!EditDocument.Finite(options.TtsSpeed) || options.TtsSpeed < 0.5 || options.TtsSpeed > 2)
    throw new Exception("TTS 语速无效：" + options.TtsSpeed + "（0.5–2）。");
   if (!EditDocument.Finite(options.MusicVolume) || options.MusicVolume < 0 || options.MusicVolume > 1)
    throw new Exception("音乐床音量无效：" + options.MusicVolume + "（0–1）。");
   // 选了音乐文件但文件不在了是配置错，诚实报错；没选音乐不报错，
   // 组装时退化为等长分段（见 Assemble）。
   if (options.BeatSyncEnabled && !string.IsNullOrEmpty(options.MusicPath) && !File.Exists(options.MusicPath))
    throw new Exception("节拍同步的音乐文件缺失：" + options.MusicPath + "。");
  }
  // 纯逻辑（可单测，不碰 TTS/FFmpeg）：段长 + 节拍贴合。
  // 配音开时 ttsDurations 必须与 lines 一一对应；grid 为 null
  // 时不贴合（等长分段）。贴合只向前（engine p3g.ts 同款）：边界之
  // 前的节拍不贴——往前挪会把旁白挤出段外；边界之后 0.35 秒内没有
  // 节拍也不贴，不硬编节拍。
  public static List<AutoVideoSegment> ComputeDurations(List<AutoVideoLine> lines, AutoVideoOptions options, List<double> ttsDurations, BeatGrid grid) {
   if (lines == null || lines.Count == 0) throw new Exception("脚本为空：至少写一行。");
   if (options == null) throw new Exception("脚本转视频缺少选项。");
   if (options.NarrationEnabled && (ttsDurations == null || ttsDurations.Count != lines.Count))
    throw new Exception("配音已开，但 TTS 时长没有与脚本行一一对应。");
   var segments = new List<AutoVideoSegment>();
   double t = 0;
   for (int i = 0; i < lines.Count; i++) {
    double dur = options.NarrationEnabled ? ttsDurations[i] : lines[i].Duration;
    if (!EditDocument.Finite(dur) || dur <= 0) throw new Exception("脚本第 " + (i + 1) + " 行段长无效：" + dur + " 秒。");
    var seg = new AutoVideoSegment { Text = lines[i].Text, Start = t, Duration = dur, TtsDuration = options.NarrationEnabled ? ttsDurations[i] : 0, HasNarration = options.NarrationEnabled };
    if (grid != null && grid.Beats != null && i + 1 < lines.Count) {
     double boundary = t + dur;
     foreach (double b in grid.Beats) {
      if (b > boundary + AutoVideoOptions.BeatSnapWindow) break;
      if (b >= boundary - 1e-6 && b - boundary <= AutoVideoOptions.BeatSnapWindow) { seg.Duration += b - boundary; seg.Snapped = true; seg.Beat = b; break; }
     }
    }
    segments.Add(seg);
    t += seg.Duration;
   }
   return segments;
  }
  static string EscapeDrawtextFile(string text) { return text.Replace("\r", " ").Replace("\n", " "); }
  // 老入口（静音成片回归用）：配音关、节拍关，与 W8 行为一字不差。
  public static string Build(List<AutoVideoLine> lines, string templateId, string output, CancellationToken token) {
   BuildDetailed(lines, templateId, output, new AutoVideoOptions { NarrationEnabled = false, BeatSyncEnabled = false }, token);
   return output;
  }
  // 全量入口：先调 TTS 合成每段旁白（模型缺失时这里就抛错，发生在
  // 任何一段渲染之前，所以缺模型时不出半成品、不出假配音），再组装。
  public static List<AutoVideoSegment> BuildDetailed(List<AutoVideoLine> lines, string templateId, string output, AutoVideoOptions options, CancellationToken token) {
   Validate(lines, templateId);
   if (options == null) options = new AutoVideoOptions { NarrationEnabled = false, BeatSyncEnabled = false };
   ValidateOptions(options);
   string work = Path.Combine(Path.GetDirectoryName(output), ".dogsc-autovideo-" + Guid.NewGuid().ToString("N"));
   Directory.CreateDirectory(work);
   try {
    List<string> wavs = null;
    if (options.NarrationEnabled) {
     wavs = new List<string>();
     for (int i = 0; i < lines.Count; i++) {
      string wav = Path.Combine(work, "narr" + i + ".wav");
      TtsSynth.Synthesize(lines[i].Text, options.TtsSpeed, wav);
      wavs.Add(wav);
     }
    }
    return Assemble(lines, templateId, output, options, wavs, work, token);
   } finally {
    try { if (Directory.Exists(work)) Directory.Delete(work, true); } catch { }
   }
  }
  // 组装（合成与组装的接缝，供自测用合成音调 wav 当旁白替身验证接线，
  // 不冒充 TTS）：narrationWavs 与 lines 一一对应；null 表示不配音。
  // 节拍网格只在选了音乐文件时检；检不出（空拍/静音/解码失败）退化
  // 为等长分段，不报错、不硬编节拍。
  public static List<AutoVideoSegment> Assemble(List<AutoVideoLine> lines, string templateId, string output, AutoVideoOptions options, List<string> narrationWavs, string work, CancellationToken token) {
   Validate(lines, templateId);
   if (options == null) options = new AutoVideoOptions { NarrationEnabled = false, BeatSyncEnabled = false };
   ValidateOptions(options);
   if (options.NarrationEnabled) {
    if (narrationWavs == null || narrationWavs.Count != lines.Count)
     throw new Exception("配音已开，但没有给每行配好旁白音频（先调 TTS 合成每段 wav 再组装）。");
    foreach (string w in narrationWavs)
     if (string.IsNullOrEmpty(w) || !File.Exists(w))
      throw new Exception("配音文件缺失：" + (string.IsNullOrEmpty(w) ? "（未生成）" : w) + "。不伪造静音当配音。");
   }
   Directory.CreateDirectory(work);
   bool musicOn = options.BeatSyncEnabled && !string.IsNullOrEmpty(options.MusicPath) && File.Exists(options.MusicPath);
   BeatGrid grid = null;
   if (musicOn) {
    try {
     double musicDur = Media.Duration(options.MusicPath);
     var g = BeatDetector.Detect(options.MusicPath, 0, musicDur, token);
     if (g != null && g.Beats != null && g.Beats.Count > 0 && g.Bpm > 0) grid = g;
    } catch { grid = null; }
   }
   var ttsDurations = new List<double>();
   if (options.NarrationEnabled) {
    foreach (string w in narrationWavs) {
     double d = Media.Duration(w);
     if (d <= 0) throw new Exception("配音音频时长为 0：" + w + "。");
     ttsDurations.Add(d);
    }
   }
   var segments = ComputeDurations(lines, options, ttsDurations, grid);
   var segs = new List<string>();
   var srt = new StringBuilder();
   string font = ObjectTracker.FontFile();
   for (int i = 0; i < lines.Count; i++) {
    var line = lines[i];
    double dur = segments[i].Duration;
    string seg = Path.Combine(work, "seg" + i + ".mp4");
    string draw = "";
    if (font != null) {
     string txtFile = Path.Combine(work, "line" + i + ".txt");
     File.WriteAllText(txtFile, EscapeDrawtextFile(line.Text), new UTF8Encoding(false));
     draw = ",drawtext=textfile=" + W8Paths.FilterPath(txtFile) + ":fontfile=" + W8Paths.FilterPath(font) + ":fontsize=48:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-120";
    }
    string imgArgs;
    if (!string.IsNullOrEmpty(line.Image))
     imgArgs = "-loop 1 -t " + Media.N(dur) + " -i " + Media.Q(line.Image);
    else
     imgArgs = "-f lavfi -t " + Media.N(dur) + " -i color=c=0x1a1a1a:s=1280x720:r=30";
    string videoChain = "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720" + draw;
    if (!options.NarrationEnabled && !musicOn) {
     // 老路：静音段（anullsrc + -shortest），与 W8 一字不差。
     StudioMedia.Run("-v error -y " + imgArgs + " -f lavfi -i anullsrc=r=48000:cl=stereo -vf " + videoChain + " -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(seg), token);
    } else {
     // 配音和/或音乐床：filter_complex 拼音频。-vf 与 -filter_complex
     // 不能同用于一条流，所以视频链也进 filter_complex（[vout]）。
     // 旁白先 atrim 截到段长、再 apad 垫满段长（P3g 教训：不用 -shortest）；
     // 两路音频先统一成 48kHz 立体声再 amix（amix 要求同采样率/同声道布局）。
     string inputs = "-v error -y " + imgArgs;
     if (options.NarrationEnabled) inputs += " -i " + Media.Q(narrationWavs[i]);
     else inputs += " -f lavfi -i anullsrc=r=48000:cl=stereo";
     if (musicOn) inputs += " -stream_loop -1 -i " + Media.Q(options.MusicPath);
     string graph = "[0:v]" + videoChain + "[vout];[1:a]atrim=0:" + Media.N(dur) + ",apad=whole_dur=" + Media.N(dur) + ",aresample=48000,aformat=channel_layouts=stereo[narr]";
     if (musicOn) graph += ";[2:a]volume=" + Media.N(options.MusicVolume) + ",atrim=0:" + Media.N(dur) + ",aresample=48000,aformat=channel_layouts=stereo[mus];[narr][mus]amix=inputs=2:duration=first:normalize=0[aout]";
     else graph += ";[narr]anull[aout]";
     StudioMedia.Run(inputs + " -filter_complex " + Media.Q(graph) + " -map [vout] -map [aout] -t " + Media.N(dur) + " -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -c:a aac " + Media.Q(seg), token);
    }
    segs.Add(seg);
    srt.Append((i + 1) + "\n").Append(SrtTime(segments[i].Start)).Append(" --> ").Append(SrtTime(segments[i].Start + segments[i].Duration)).Append("\n").Append(line.Text).Append("\n\n");
   }
   string list = Path.Combine(work, "list.txt");
   File.WriteAllText(list, string.Join("\n", segs.Select(s => "file " + W8Paths.QuotedPath(s)).ToArray()), new UTF8Encoding(false));
   StudioMedia.Run("-v error -y -f concat -safe 0 -i " + Media.Q(list) + " -c copy " + Media.Q(output), token);
   File.WriteAllText(Path.ChangeExtension(output, ".srt"), srt.ToString(), new UTF8Encoding(false));
   double total = segments.Count == 0 ? 0 : segments[segments.Count - 1].Start + segments[segments.Count - 1].Duration;
   double outDur = Media.Duration(output);
   if (Math.Abs(outDur - total) > .3) throw new Exception("脚本成片时长不符：输出 " + outDur.ToString("0.00") + "s，要 " + total.ToString("0.00") + "s。");
   return segments;
  }
  static string SrtTime(double seconds) {
   int ms = (int)Math.Round(seconds * 1000);
   return string.Format(CultureInfo.InvariantCulture, "{0:00}:{1:00}:{2:00},{3:000}", ms / 3600000, ms / 60000 % 60, ms / 1000 % 60, ms % 1000);
  }
 }

 // ---- 10. 元数据面板（medialib.ts）----
 public class ClipMetadata {
  public string Scene = ""; public string Take = ""; public string Notes = "";
  public List<string> Keywords = new List<string>();
 }
 static class AleExport {
  public static string Timecode(double seconds, int fps) {
   if (fps < 1) fps = 30;
   int total = (int)Math.Round(seconds * fps);
   int ff = total % fps, s = total / fps % 60, m = total / (fps * 60) % 60, h = total / (fps * 3600);
   return string.Format(CultureInfo.InvariantCulture, "{0:00}:{1:00}:{2:00}:{3:00}", h, m, s, ff);
  }
  // ALE（Avid Log Exchange，Tab 分隔）：一行一个素材，列与引擎
  // medialib.ts toALE 一致（Name/Tape/Start/End/Duration/Scene/
  // Take/Keywords/Comments），供 Resolve/Premiere 交接。
  public static string ToAle(EditDocument doc) {
   if (doc == null || string.IsNullOrEmpty(doc.Source)) throw new Exception("没有可导出的素材。");
   int fps = Math.Max(1, (int)Math.Round(doc.FrameRate));
   var md = doc.Metadata ?? new ClipMetadata();
   var sb = new StringBuilder();
   sb.Append("Heading\nFIELD_DELIM\tTABS\nVIDEO_FORMAT\t1080\nAUDIO_FORMAT\t48kHz\n\nColumn\nName\tTape\tStart\tEnd\tDuration\tScene\tTake\tKeywords\tComments\n\nData\n");
   string keywords = string.Join(";", (md.Keywords ?? new List<string>()).ToArray());
   sb.Append(Path.GetFileName(doc.Source)).Append("\t").Append("")
    .Append("\t").Append(Timecode(0, fps)).Append("\t").Append(Timecode(doc.Duration, fps)).Append("\t").Append(Timecode(doc.Duration, fps))
    .Append("\t").Append(md.Scene).Append("\t").Append(md.Take).Append("\t").Append(keywords).Append("\t").Append(md.Notes ?? "").Append("\n");
   return sb.ToString();
  }
 }

 // ---- 11. 归档/重链接（medialib.ts）----
 public class ArchiveResult { public string Dir; public List<string> Copied = new List<string>(); public string ProjectFile; }
 static class MediaArchive {
  static string CopyOnce(string file, string mediaDir, Dictionary<string, string> remap, List<string> copied) {
   string key = Path.GetFullPath(file);
   string rel;
   if (remap.TryGetValue(key, out rel)) return rel;
   if (!File.Exists(file)) throw new Exception("归档拒绝：源文件缺失：" + file + "（带洞的归档不如不归档）。");
   Directory.CreateDirectory(mediaDir);
   string dest = Path.Combine(mediaDir, Path.GetFileName(file));
   File.Copy(file, dest, true);
   copied.Add(dest);
   rel = "media/" + Path.GetFileName(file);
   remap[key] = rel;
   return rel;
  }
  // 归档打包：源文件（+ 代理/优化媒体/多机位角度）+ 项目 JSON 拷到
  // 一个文件夹，归档里的项目路径改写成相对路径，文件夹能独立打开。
  public static ArchiveResult Archive(EditDocument doc, string projectPath, string destDir) {
   if (doc == null) throw new Exception("没有打开的项目。");
   Directory.CreateDirectory(destDir);
   string mediaDir = Path.Combine(destDir, "media");
   var copied = new List<string>();
   var remap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
   var clone = EditDocument.Deserialize(doc.Serialize());
   clone.Source = CopyOnce(doc.Source, mediaDir, remap, copied);
   if (!string.IsNullOrEmpty(doc.ProxyPath) && File.Exists(doc.ProxyPath)) clone.ProxyPath = CopyOnce(doc.ProxyPath, mediaDir, remap, copied);
   if (!string.IsNullOrEmpty(doc.OptimizedPath) && File.Exists(doc.OptimizedPath)) clone.OptimizedPath = CopyOnce(doc.OptimizedPath, mediaDir, remap, copied);
   if (doc.MulticamAngles != null) for (int i = 0; i < doc.MulticamAngles.Count; i++)
     if (!string.IsNullOrEmpty(doc.MulticamAngles[i]) && File.Exists(doc.MulticamAngles[i])) clone.MulticamAngles[i] = CopyOnce(doc.MulticamAngles[i], mediaDir, remap, copied);
   string projectFile = Path.Combine(destDir, "project.dogscwin");
   clone.Save(projectFile);
   return new ArchiveResult { Dir = destDir, Copied = copied, ProjectFile = projectFile };
  }
  // 素材丢失重链接：按 basename 在文件夹里找，时长与原片差 ±0.1 秒
  // 才认；同名出现两个候选时报错、不猜；找不到的留在未匹配里。
  public static string Relink(EditDocument doc, string searchDir) {
   if (doc == null) throw new Exception("没有打开的项目。");
   if (string.IsNullOrEmpty(searchDir) || !Directory.Exists(searchDir)) throw new Exception("找不到重链接文件夹：" + searchDir + "。");
   var report = new StringBuilder();
   RelinkOne(doc, searchDir, ref doc.Source, "主素材", report);
   if (!string.IsNullOrEmpty(doc.ProxyPath)) RelinkOne(doc, searchDir, ref doc.ProxyPath, "代理", report);
   if (!string.IsNullOrEmpty(doc.OptimizedPath)) RelinkOne(doc, searchDir, ref doc.OptimizedPath, "优化媒体", report);
   return report.ToString();
  }
  static void RelinkOne(EditDocument doc, string searchDir, ref string path, string label, StringBuilder report) {
   if (string.IsNullOrEmpty(path) || File.Exists(path)) return;
   string name = Path.GetFileName(path);
   var candidates = Directory.GetFiles(searchDir, name, SearchOption.TopDirectoryOnly);
   if (candidates.Length == 0) { report.Append(label).Append("未找到：").Append(name).Append("；"); return; }
   if (candidates.Length > 1) throw new Exception("重链接歧义：" + name + " 在文件夹里出现 " + candidates.Length + " 次，不猜，手动选一个。");
   if (label == "主素材") {
    double d = Media.Duration(candidates[0]);
    if (Math.Abs(d - doc.Duration) > .1) throw new Exception("重链接候选时长不符：" + name + "（" + d.ToString("0.00") + "s vs 原片 " + doc.Duration.ToString("0.00") + "s）。");
   }
   report.Append(label).Append("已重链接：").Append(name).Append(" → ").Append(candidates[0]).Append("；");
   path = candidates[0];
  }
 }

 // ---- 12. 优化媒体（optimized.ts）----
 public class OptimizedInfo { public string File; public int Width; public int Height; public string Profile; public double Duration; }
 static class OptimizedMedia {
  public static readonly string[] Profiles = { "dnxhr_lb", "dnxhr_sq", "dnxhr_hq" };
  public static string PathFor(string source) {
   return Path.Combine(Path.GetDirectoryName(source), Path.GetFileNameWithoutExtension(source) + ".optimized.mov");
  }
  // DNxHR 中间片（dnxhd 编码器，LGPL）：全分辨率、帧内编码、yuv422p，
  // 音频 PCM；保留源的分辨率、帧率与时长。奇数尺寸 dnxhd 做不了，
  // 直接拒绝（与引擎一致）。
  public static OptimizedInfo Generate(string source, string output, string profile, CancellationToken token) {
   if (!Profiles.Contains(profile)) throw new Exception("未知的 DNxHR 规格：" + profile + "（dnxhr_lb / dnxhr_sq / dnxhr_hq）。");
   var info = StudioMedia.Import(source);
   if (info.Width % 2 != 0 || info.Height % 2 != 0)
    throw new Exception("优化媒体：源是 " + info.Width + "x" + info.Height + "，dnxhd 需要偶数尺寸。");
   string audio = info.Audio ? "-c:a pcm_s16le" : "-an";
   StudioMedia.Run("-v error -y -i " + Media.Q(source) + " -c:v dnxhd -profile:v " + profile + " -pix_fmt yuv422p " + audio + " " + Media.Q(output), token);
   if (W8Paths.CodecOf(output) != "dnxhd") throw new Exception("优化媒体编码失败：输出不是 dnxhd。");
   double d = Media.Duration(output);
   if (Math.Abs(d - info.Duration) > .1) throw new Exception("优化媒体时长与原片不符：优化 " + d.ToString("0.00") + "s，原片 " + info.Duration.ToString("0.00") + "s。");
   return new OptimizedInfo { File = output, Width = info.Width, Height = info.Height, Profile = profile, Duration = d };
  }
  // 优化媒体缺失/时长不符是硬错，不静默回退原片（与代理同款语义）。
  // 导出始终用原片——这里只校验，不参与导出。
  public static void Validate(EditDocument doc) {
   if (!doc.OptimizedEnabled) return;
   if (string.IsNullOrEmpty(doc.OptimizedPath)) throw new Exception("优化媒体已开启，但没有生成优化文件。请先生成，或关闭优化媒体。");
   if (!File.Exists(doc.OptimizedPath)) throw new Exception("优化媒体已开启，但优化文件缺失：" + doc.OptimizedPath + "。请重新生成，或关闭优化媒体。不要静默回退原片。");
   double actual = Media.Duration(doc.OptimizedPath);
   if (Math.Abs(actual - doc.Duration) > .1) throw new Exception("优化文件时长与原片不符（优化 " + actual.ToString("0.00") + "s，原片 " + doc.Duration.ToString("0.00") + "s）。请重新生成。");
  }
 }

 // ---- 13. 观察文件夹（medialib.ts）----
 static class WatchFolder {
  static readonly string[] MediaExtensions = { ".mp4", ".mov", ".mkv", ".webm", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".png", ".jpg", ".jpeg", ".bmp" };
  // 监看文件夹：列出文件夹里还不在库里的文件（按 basename 认），
  // 只做扫描、不自动导入——导入由用户点确认（medialib.ts 同款）。
  public static List<string> Scan(string watchDir, List<string> knownFiles) {
   var found = new List<string>();
   if (string.IsNullOrEmpty(watchDir) || !Directory.Exists(watchDir)) return found;
   var known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
   if (knownFiles != null) foreach (string f in knownFiles) if (!string.IsNullOrEmpty(f)) known.Add(Path.GetFileName(f));
   foreach (string file in Directory.GetFiles(watchDir).OrderBy(f => f, StringComparer.OrdinalIgnoreCase)) {
    if (!MediaExtensions.Contains(Path.GetExtension(file).ToLowerInvariant())) continue;
    if (known.Contains(Path.GetFileName(file))) continue;
    found.Add(file);
   }
   return found;
  }
 }

 // ---- 14. 导入收录（medialib.ts ingest，与第 12 项共用转码管线）----
 public class IngestResult { public string File; public string Transcoded; }
 static class Ingest {
  // 导入时可选复制到项目媒体文件夹（copy）或转码成中间片
  // （dnxhr = DNxHR 优化媒体，proxy = 720p 代理）；与第 12 项共用
  // OptimizedMedia.Generate，与代理共用 ProxyTools.Generate。
  public static IngestResult IngestFile(string source, string projectDir, string transcode, CancellationToken token) {
   if (string.IsNullOrEmpty(source) || !File.Exists(source)) throw new Exception("找不到要导入的素材：" + source + "。");
   if (string.IsNullOrEmpty(projectDir)) throw new Exception("先保存项目，再导入收录（需要项目文件夹放媒体）。");
   string mediaDir = Path.Combine(projectDir, "media");
   Directory.CreateDirectory(mediaDir);
   string dest = Path.Combine(mediaDir, Path.GetFileName(source));
   if (File.Exists(dest) && !string.Equals(Path.GetFullPath(dest), Path.GetFullPath(source), StringComparison.OrdinalIgnoreCase)) {
    string stem = Path.GetFileNameWithoutExtension(source), ext = Path.GetExtension(source);
    int n = 1;
    while (File.Exists(dest)) { dest = Path.Combine(mediaDir, stem + "-" + n + ext); n++; }
   }
   if (!string.Equals(Path.GetFullPath(dest), Path.GetFullPath(source), StringComparison.OrdinalIgnoreCase)) File.Copy(source, dest, true);
   string transcoded = null;
   if (transcode == "dnxhr") {
    string opt = Path.Combine(mediaDir, Path.GetFileNameWithoutExtension(dest) + ".optimized.mov");
    OptimizedMedia.Generate(dest, opt, "dnxhr_hq", token);
    transcoded = opt;
   } else if (transcode == "proxy") {
    string proxy = Path.Combine(mediaDir, Path.GetFileNameWithoutExtension(dest) + ".proxy.mp4");
    ProxyTools.Generate(dest, proxy);
    transcoded = proxy;
   } else if (transcode != "none") {
    throw new Exception("未知的导入转码：" + transcode + "（none / dnxhr / proxy）。");
   }
   return new IngestResult { File = dest, Transcoded = transcoded };
  }
 }
}

