// W9 插件宿主组（2026-11-19）：插件发现 / 扫描 + 元数据展示层。
// 评估结论：B 级（见 docs/windows/plugins.md）。本批只做扫描，不加载插件：
// - VST3：只读 bundle 里的 moduleinfo.json（不 LoadLibrary、不跑任何插件代码）。
//   格式依据是 Steinberg SDK 源码 public.sdk/source/vst/moduleinfo/
//   moduleinfoparser.cpp（master，2026-11-19 拉取核对）：顶层 Name / Version /
//   "Factory Info"（Vendor、URL、E-Mail、Flags）/ Classes / Compatibility（可选）；
//   每类 CID、Category、Name、Vendor、Version、SDKVersion、"Sub Categories"、
//   "Class Flags"、Cardinality 必填，Snapshots 可选。moduleinfo.json 的规范位置
//   是 Contents/Resources/moduleinfo.json（module_win32.cpp getModuleInfoPath）；
//   3.7 时代的 Contents/moduleinfo.json 也认（兼容老插件）。
// - OFX：没有 moduleinfo.json 这类元数据文件，名称/参数只能在加载二进制后读取；
//   本批只认 bundle 结构（NAME.ofx.bundle/Contents/Win64/NAME.ofx）并报二进制在不在。
// 许可（2026-11-19 核对，已纠正任务简报里的旧说法）：
// - VST3 SDK 3.8.0（2025-10 发布）起是 MIT 许可，steinbergmedia/vst3sdk 的
//   LICENSE.txt 原文就是 MIT；GPLv3 与 Steinberg 专有许可双轨已停止，
//   不再需要签任何免费许可协议。本仓库没有引入 SDK 代码，只在文档里注明。
//   "VST" 仍是 Steinberg 的注册商标：只作格式名称使用，不声称背书或关联。
// - OFX API 与 Support 库是 BSD-3-Clause（AcademySoftwareFoundation/openfx）。
//   本仓库同样没有引入其代码。VST2 已废弃（Steinberg 自 2018-10 起不再发新
//   许可），AAX / AU 是别家专用格式，三者一律不扫。
// 完整宿主（加载 + 参数 + 进链）为什么本批不做：VST3 是 C++ COM 式接口，C# 不能
// 直接 P/Invoke，必须写原生 C++ 桥接 DLL（SDK hosting 层 + IHostApplication /
// IComponentHandler 等一整套宿主实现，约千行级）；OFX 虽是纯 C API，但宿主侧
// 仍需实现 property / memory / image-effect / parameter 等全套 suite；
// 测试插件 AGain 要先 clone SDK、配 CMake、编出 again.vst3 再验证。云端 runner
// 虽有 MSVC（windows-2025 带 VS Build Tools + CMake，需经 vswhere 找 cl.exe），
// 但桥 + AGain + OFX 宿主 + 双链路实测不是一批能诚实做完的量。强行拼一个
// “能加载”的壳子就是假宿主，所以本批只做到 B，并把桥设计与下一步清单写进
// docs/windows/plugins.md。UI 与测试里任何“已加载/已生效”的说法都是错的。
// 链挂接点（只画线，不接线）：VST3 以后走离线 stem 渲染——源音频经桥处理成
// 临时 wav，再像人声分离的 stem 一样进 AudioArgs（见 W8AudioChain 的
// AudioSourceForExport 同款路子），挂在 W8 链（变声→EQ→压缩→修复）之后、
// 混音之前；OFX 以后走导出前视频预处理（与防抖/对象跟踪同一位置）。在桥
// 建好之前，PluginHostSeam.RequireHostReady() 一律抛错，绝不静默跳过。
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using DogSC.Windows;

namespace DogSC.Replica {
 // ---- 插件元数据模型（只描述扫描到的事实，不代表已加载）----
 public enum PluginFormat { Vst3, Ofx }
 public class PluginClassInfo {
  public string Cid = ""; public string Category = ""; public string Name = ""; public string Vendor = "";
  public string Version = ""; public string SdkVersion = ""; public List<string> SubCategories = new List<string>();
  // 只有音频效果类能进音频链；控制器类（Component Controller Class）只是
  // 同一模块的配对类，不是效果，绝不能当效果列出来。
  public bool IsEffect { get { return Category == "Audio Module Class"; } }
 }
 public class PluginInfo {
  public PluginFormat Format; public string BundlePath = ""; public string BinaryPath = "";
  public string ModuleName = ""; public string Vendor = ""; public string Version = ""; public string SdkVersion = "";
  public List<PluginClassInfo> Classes = new List<PluginClassInfo>();
  public List<string> Architectures = new List<string>();
  public int SnapshotCount;
  public bool HasMetadata; public string MetadataError = "";
  public string Name {
   get {
    foreach (var c in Classes) if (c.IsEffect) return c.Name;
    if (!string.IsNullOrEmpty(ModuleName)) return ModuleName;
    return BundleName();
   }
  }
  public string BundleName() {
   string name = Path.GetFileName(BundlePath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
   if (Format == PluginFormat.Vst3 && name.EndsWith(".vst3", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 5);
   if (Format == PluginFormat.Ofx && name.EndsWith(".ofx.bundle", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 11);
   return name;
  }
  public int EffectCount { get { int n = 0; foreach (var c in Classes) if (c.IsEffect) n++; return n; } }
  // 面板一行：只陈述扫描事实 + 未加载状态，绝不写“可用/已挂载”。
  public string DisplayLine() {
   string fmt = Format == PluginFormat.Vst3 ? "VST3" : "OFX";
   string meta = HasMetadata
    ? (string.IsNullOrEmpty(Vendor) ? "" : Vendor + " · ") + Version + (string.IsNullOrEmpty(SdkVersion) ? "" : " · SDK " + SdkVersion)
    : "元数据未知" + (string.IsNullOrEmpty(MetadataError) ? "" : "（" + MetadataError + "）");
   string bin = string.IsNullOrEmpty(BinaryPath) ? "无本机二进制" : "二进制已找到";
   return fmt + " · " + Name + " — " + meta + " · " + bin + " · 未加载（宿主开发中）";
  }
 }

 // ---- 扫描器：只读文件与 JSON，绝不加载任何插件二进制 ----
 static class PluginScanner {
  public const string HostStatus = "插件宿主加载开发中：本版只扫描、列元数据，不加载插件、不处理音频/画面。";
  public static readonly string[] Vst3ArchDirs = new[] { "x86_64-win", "x86-win", "arm64-win" };

  static string Env(string name) { try { return Environment.GetEnvironmentVariable(name); } catch { return null; } }
  static string Join(string a, string b) { return string.IsNullOrEmpty(a) ? "" : Path.Combine(a, b); }
  static void AddRoot(List<string> list, string path) {
   if (string.IsNullOrEmpty(path)) return;
   if (!list.Any(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase))) list.Add(path);
  }
  // VST3 默认路径（Steinberg 规范 + 各宿主通用做法）：系统 Common Files、
  // 32 位 Common Files（x64 宿主只列不加载）、用户 %LOCALAPPDATA%。
  // 不存在的目录也照样列出——扫描时不存在的根直接返回空，不抛错。
  public static List<string> DefaultVst3Roots() {
   var roots = new List<string>();
   string common = Env("CommonProgramFiles"), common86 = Env("CommonProgramFiles(x86)"), local = Env("LOCALAPPDATA");
   AddRoot(roots, Join(common, "VST3"));
   AddRoot(roots, Join(common86, "VST3"));
   AddRoot(roots, Join(Join(local, "Programs"), Path.Combine("Common", "VST3")));
   AddRoot(roots, Join(Join(local, "Programs"), "VST3"));
   return roots;
  }
  // OFX 默认路径：系统 Common Files\OFX\Plugins；OFX_PLUGIN_PATH（分号分隔）
  // 按规范先于默认路径扫描。
  public static List<string> DefaultOfxRoots() {
   var roots = new List<string>();
   string extra = Env("OFX_PLUGIN_PATH");
   if (!string.IsNullOrEmpty(extra)) foreach (string part in extra.Split(';')) AddRoot(roots, part.Trim());
   AddRoot(roots, Join(Join(Env("CommonProgramFiles"), "OFX"), "Plugins"));
   return roots;
  }
  // 供测试用的纯路径展开：不碰磁盘，只算出“应该扫哪里”。
  public static List<string> Vst3RootsFor(string common, string common86, string local) {
   var roots = new List<string>();
   AddRoot(roots, Join(common, "VST3"));
   AddRoot(roots, Join(common86, "VST3"));
   AddRoot(roots, Join(Join(local, "Programs"), Path.Combine("Common", "VST3")));
   AddRoot(roots, Join(Join(local, "Programs"), "VST3"));
   return roots;
  }

  public static List<PluginInfo> ScanDefault() { return ScanRoots(DefaultVst3Roots(), DefaultOfxRoots()); }
  public static List<PluginInfo> ScanRoots(IEnumerable<string> vst3Roots, IEnumerable<string> ofxRoots) {
   var found = new List<PluginInfo>();
   var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
   Action<List<PluginInfo>> add = list => { foreach (var p in list) if (seen.Add(p.BundlePath)) found.Add(p); };
   if (vst3Roots != null) foreach (string r in vst3Roots) add(ScanOneRoot(r, PluginFormat.Vst3));
   if (ofxRoots != null) foreach (string r in ofxRoots) add(ScanOneRoot(r, PluginFormat.Ofx));
   found.Sort((a, b) => { int f = a.Format.CompareTo(b.Format); return f != 0 ? f : string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase); });
   return found;
  }
  // 只扫两层：根目录直属的 bundle + 厂商子目录下的一层 bundle（VST3/OFX
  // 安装器都用“厂商文件夹套 bundle”的布局）。更深的不扫，避免整盘遍历。
  public static List<PluginInfo> ScanOneRoot(string root, PluginFormat format) {
   var list = new List<PluginInfo>();
   if (string.IsNullOrEmpty(root)) return list;
   try { if (!Directory.Exists(root)) return list; } catch { return list; }
   try {
    foreach (string dir in Directory.GetDirectories(root)) {
     if (IsBundle(dir, format)) { var p = InspectBundle(dir, format); if (p != null) list.Add(p); continue; }
     try {
      foreach (string sub in Directory.GetDirectories(dir)) {
       if (IsBundle(sub, format)) { var p = InspectBundle(sub, format); if (p != null) list.Add(p); }
      }
     } catch { }
    }
   } catch { }
   return list;
  }
  static bool IsBundle(string dir, PluginFormat format) {
   string name = Path.GetFileName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
   return format == PluginFormat.Vst3
    ? name.EndsWith(".vst3", StringComparison.OrdinalIgnoreCase)
    : name.EndsWith(".ofx.bundle", StringComparison.OrdinalIgnoreCase);
  }
  public static PluginInfo InspectBundle(string bundlePath, PluginFormat format) {
   return format == PluginFormat.Vst3 ? InspectVst3Bundle(bundlePath) : InspectOfxBundle(bundlePath);
  }
  static PluginInfo InspectVst3Bundle(string bundlePath) {
   var info = new PluginInfo { Format = PluginFormat.Vst3, BundlePath = bundlePath };
   string contents = Path.Combine(bundlePath, "Contents");
   try {
    if (Directory.Exists(contents)) {
     foreach (string arch in Vst3ArchDirs) {
      string dir = Path.Combine(contents, arch);
      try {
       if (!Directory.Exists(dir)) continue;
       string[] files = Directory.GetFiles(dir, "*.vst3");
       if (files.Length > 0) {
        info.Architectures.Add(arch);
        if (string.IsNullOrEmpty(info.BinaryPath) && arch == "x86_64-win") info.BinaryPath = files[0];
        if (string.IsNullOrEmpty(info.BinaryPath)) info.BinaryPath = files[0];
       }
      } catch { }
     }
     try {
      string snapDir = Path.Combine(Path.Combine(contents, "Resources"), "Snapshots");
      if (Directory.Exists(snapDir)) info.SnapshotCount = Directory.GetFiles(snapDir, "*.png").Length;
     } catch { }
    }
   } catch { }
   // moduleinfo.json：先规范位置 Contents/Resources/，再认 3.7 老位置 Contents/。
   string jsonPath = Path.Combine(Path.Combine(contents, "Resources"), "moduleinfo.json");
   if (!File.Exists(jsonPath)) jsonPath = Path.Combine(contents, "moduleinfo.json");
   if (!File.Exists(jsonPath)) { info.MetadataError = "无 moduleinfo.json（老插件或未生成），元数据未知"; return info; }
   try {
    string json = File.ReadAllText(jsonPath);
    ParseModuleInfo(json, info);
    info.HasMetadata = info.Classes.Count > 0;
    if (!info.HasMetadata && string.IsNullOrEmpty(info.MetadataError)) info.MetadataError = "moduleinfo.json 里没有可用的类";
   } catch (Exception ex) {
    info.HasMetadata = false;
    info.MetadataError = "moduleinfo.json 解析失败：" + FirstLine(ex.Message);
   }
   return info;
  }
  static PluginInfo InspectOfxBundle(string bundlePath) {
   var info = new PluginInfo { Format = PluginFormat.Ofx, BundlePath = bundlePath };
   // OFX 没有元数据文件：名称/厂商/参数只能加载二进制后读取，宿主未建，故未知。
   info.MetadataError = "OFX 无元数据文件，名称与参数需加载后读取（宿主未建）";
   try {
    string win64 = Path.Combine(Path.Combine(bundlePath, "Contents"), "Win64");
    if (Directory.Exists(win64)) {
     string[] files = Directory.GetFiles(win64, "*.ofx");
     if (files.Length > 0) info.BinaryPath = files[0];
    }
   } catch { }
   return info;
  }
  static string FirstLine(string s) {
   if (string.IsNullOrEmpty(s)) return "";
   int at = s.IndexOf('\n');
   string line = at >= 0 ? s.Substring(0, at) : s;
   return line.Length > 120 ? line.Substring(0, 120) : line;
  }

  // moduleinfo.json 解析（SDK moduleinfoparser.cpp 的字段名逐字对照；但比 SDK
  // 宽松：SDK 缺必填键就整文件拒掉，扫描器只要求每类有 CID/Category/Name，
  // Version/SDKVersion/Flags 缺了就留空照样列出，老 bundle 不会因此消失）。
  public static void ParseModuleInfo(string json, PluginInfo info) {
   if (string.IsNullOrWhiteSpace(json)) throw new Exception("moduleinfo.json 为空。");
   var root = MiniJson.Parse(json) as Dictionary<string, object>;
   if (root == null) throw new Exception("moduleinfo.json 顶层不是对象。");
   string name, version;
   if (TryStr(root, "Name", out name)) info.ModuleName = name;
   if (TryStr(root, "Version", out version)) info.Version = version;
   object factoryObj;
   if (root.TryGetValue("Factory Info", out factoryObj)) {
    var factory = factoryObj as Dictionary<string, object>;
    if (factory != null) { string v; if (TryStr(factory, "Vendor", out v)) info.Vendor = v; }
   }
   object classesObj;
   if (!root.TryGetValue("Classes", out classesObj)) throw new Exception("moduleinfo.json 缺少 Classes。");
   var classes = classesObj as List<object>;
   if (classes == null) throw new Exception("moduleinfo.json 的 Classes 不是数组。");
   foreach (object item in classes) {
    var c = item as Dictionary<string, object>;
    if (c == null) continue;
    string cid, category, cname;
    if (!TryStr(c, "CID", out cid) || !TryStr(c, "Category", out category) || !TryStr(c, "Name", out cname)) continue;
    var ci = new PluginClassInfo { Cid = cid, Category = category, Name = cname };
    string s;
    if (TryStr(c, "Vendor", out s)) ci.Vendor = s;
    if (TryStr(c, "Version", out s)) ci.Version = s;
    if (TryStr(c, "SDKVersion", out s)) ci.SdkVersion = s;
    object subs;
    if (c.TryGetValue("Sub Categories", out subs)) {
     var arr = subs as List<object>;
     if (arr != null) foreach (object sub in arr) if (sub is string) ci.SubCategories.Add((string)sub);
    }
    info.Classes.Add(ci);
    if (string.IsNullOrEmpty(info.SdkVersion) && !string.IsNullOrEmpty(ci.SdkVersion)) info.SdkVersion = ci.SdkVersion;
    if (string.IsNullOrEmpty(info.Version) && !string.IsNullOrEmpty(ci.Version)) info.Version = ci.Version;
    if (string.IsNullOrEmpty(info.Vendor) && !string.IsNullOrEmpty(ci.Vendor)) info.Vendor = ci.Vendor;
   }
  }
  static bool TryStr(Dictionary<string, object> dict, string key, out string value) {
   value = "";
   object v;
   if (!dict.TryGetValue(key, out v) || !(v is string)) return false;
   value = (string)v;
   return true;
  }
 }

 // ---- 极小 JSON 解析器（只为读 moduleinfo.json；不依赖 JavaScriptSerializer
// 对数组返回类型的版本差异——云端实测曾因此丢掉 Classes 数组。
// 只认对象 / 数组 / 字符串 / 数字 / true / false / null；严格，
// 畸形 JSON 直接抛错，调用方记成“解析失败”而不是静默吞掉。
// 唯一放宽：容忍对象/数组末尾多一个逗号——moduleinfotool 写的 moduleinfo.json
// 是 JSON5（JSON5Writer 每个键值和每个数组元素后都写逗号，包括最后一个），
// 真插件文件全带尾逗号；不容忍它，扫描器读不了任何真插件，只能读手写夹具。
// （W10 云端实测：AGain 真文件在位置 323 抛“期待 '"'”，根因就是这里。）
static class MiniJson {
 public static object Parse(string json) {
  if (string.IsNullOrWhiteSpace(json)) throw new Exception("JSON 为空。");
  var p = new Parser(json);
  object v = p.Value();
  p.SkipWs();
  if (p.Pos != json.Length) throw new Exception("JSON 末尾有多余字符。");
  return v;
 }
 class Parser {
  readonly string s; public int Pos;
  public Parser(string s) { this.s = s; }
  public void SkipWs() { while (Pos < s.Length && (s[Pos] == ' ' || s[Pos] == '\t' || s[Pos] == '\n' || s[Pos] == '\r')) Pos++; }
  char Peek() { SkipWs(); if (Pos >= s.Length) throw new Exception("JSON 意外结束。"); return s[Pos]; }
  void Expect(char c) { if (Peek() != c) throw new Exception("JSON 在位置 " + Pos + " 期待 '" + c + "'。"); Pos++; }
  public object Value() {
   char c = Peek();
   if (c == '{') return Obj();
   if (c == '[') return Arr();
   if (c == '"') return Str();
   if (c == 't') { Lit("true"); return true; }
   if (c == 'f') { Lit("false"); return false; }
   if (c == 'n') { Lit("null"); return null; }
   return Num();
  }
  void Lit(string lit) { if (Pos + lit.Length > s.Length || s.Substring(Pos, lit.Length) != lit) throw new Exception("JSON 在位置 " + Pos + " 期待 " + lit + "。"); Pos += lit.Length; }
  Dictionary<string, object> Obj() {
   var d = new Dictionary<string, object>();
   Expect('{');
   if (Peek() == '}') { Pos++; return d; }
   while (true) {
    string key = Str();
    Expect(':');
    d[key] = Value();
    char c = Peek();
    if (c == ',') { Pos++; if (Peek() == '}') { Pos++; return d; } continue; }
    if (c == '}') { Pos++; return d; }
    throw new Exception("JSON 对象在位置 " + Pos + " 期待 ',' 或 '}'。");
   }
  }
  List<object> Arr() {
   var list = new List<object>();
   Expect('[');
   if (Peek() == ']') { Pos++; return list; }
   while (true) {
    list.Add(Value());
    char c = Peek();
    if (c == ',') { Pos++; if (Peek() == ']') { Pos++; return list; } continue; }
    if (c == ']') { Pos++; return list; }
    throw new Exception("JSON 数组在位置 " + Pos + " 期待 ',' 或 ']'。");
   }
  }
  string Str() {
   Expect('"');
   var sb = new System.Text.StringBuilder();
   while (true) {
    if (Pos >= s.Length) throw new Exception("JSON 字符串未闭合。");
    char c = s[Pos++];
    if (c == '"') return sb.ToString();
    if (c == '\\') {
     if (Pos >= s.Length) throw new Exception("JSON 转义未闭合。");
     char e = s[Pos++];
     if (e == '"') sb.Append('"');
     else if (e == '\\') sb.Append('\\');
     else if (e == '/') sb.Append('/');
     else if (e == 'b') sb.Append('\b');
     else if (e == 'f') sb.Append('\f');
     else if (e == 'n') sb.Append('\n');
     else if (e == 'r') sb.Append('\r');
     else if (e == 't') sb.Append('\t');
     else if (e == 'u') {
      if (Pos + 4 > s.Length) throw new Exception("JSON \\u 转义不完整。");
      int code;
      if (!int.TryParse(s.Substring(Pos, 4), System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out code)) throw new Exception("JSON \\u 转义无效。");
      Pos += 4;
      sb.Append((char)code);
     } else throw new Exception("JSON 未知转义 \\" + e + "。");
    } else sb.Append(c);
   }
  }
  object Num() {
   int start = Pos;
   while (Pos < s.Length && "+-0123456789.eE".IndexOf(s[Pos]) >= 0) Pos++;
   if (Pos == start) throw new Exception("JSON 在位置 " + start + " 不是合法值。");
   string tok = s.Substring(start, Pos - start);
   long l;
   if (long.TryParse(tok, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out l)) return l;
   double d;
   if (double.TryParse(tok, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out d)) return d;
   throw new Exception("JSON 数字无效：" + tok + "。");
  }
 }
}
 // ---- 未来宿主的接缝：现在只有一句诚实报错，没有任何“假加载”入口 ----
 static class PluginHostSeam {
  public const string NotBuilt =
   "插件宿主未建：VST3/OFX 插件现在只能扫描、列元数据，不能加载、不能进音频/视频链。\n" +
   "下一步见 docs/windows/plugins.md（原生 C++ 桥接 DLL + AGain 实测插件 + OFX HostSupport）。";
  public static void RequireHostReady() { throw new Exception(NotBuilt); }
 }
}
