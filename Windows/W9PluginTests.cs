// W9 插件扫描自测（2026-11-19）：--w9plugin-test 入口，无窗口，纯逻辑 +
// 合成 bundle 夹具。跑在云端构建里（build-test.yml 的 W9 plugin checks 步），
// 结果写 Windows/bin/w9plugin-results.txt（PASS: 开头才算过）。
// 夹具说明（诚实标签，不是真插件）：
// - GVst 的 moduleinfo.json 复刻的是 Steinberg 论坛上一份 validator 实测输出
//   （GVst，Audio Module Class，Fx，1.0.0.1，VST 3.7.5，
//   CID 0CDBB66985D548A9BFD8371909D24BB3；配对控制器类 GVstController，
//   CID 038E7FA9629A4EAA8541B88918E8952C）。bundle 里的“二进制”只是文本文件，
//   扫描从不加载它——这本身就是断言：扫描不靠加载。
// - 其余夹具（Legacy / NoMeta / Broken / OFX 空包）是按 SDK/OFX 规范手写的
//   边界情形。没有哪一项假装加载过真实插件。
// 云端 runner 上一般没有已装插件：ScanDefault() 必须返回空列表而不是抛错。
// 真实 AGain bundle 的校验是下一步（桥批）的事，见 docs/windows/plugins.md。
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using DogSC.Windows;

namespace DogSC.Replica {
 static class W9PluginTests {
  static void Require(bool ok, string name) { if (!ok) throw new Exception("W9 plugin 检查失败：" + name); }
  static string Folder;
  static string LogPath;
  static void Mark(string s) { try { File.AppendAllText(LogPath, s + "\n"); } catch { } }
  static void WriteText(string path, string text) { Directory.CreateDirectory(Path.GetDirectoryName(path)); File.WriteAllText(path, text); }
  static void WriteDummyBinary(string path) { Directory.CreateDirectory(Path.GetDirectoryName(path)); File.WriteAllText(path, "not a real plugin binary, only a scan fixture"); }
  // 复刻 Steinberg 论坛 validator 实测输出的 moduleinfo.json（见文件头注释）。
  const string GvstModuleInfo =
   "{\n" +
   "  \"Name\": \"GVst\",\n" +
   "  \"Version\": \"1.0.0.1\",\n" +
   "  \"Factory Info\": { \"Vendor\": \"\", \"URL\": \"\", \"E-Mail\": \"\", \"Flags\": { \"Unicode\": true } },\n" +
   "  \"Classes\": [\n" +
   "    { \"CID\": \"0CDBB66985D548A9BFD8371909D24BB3\", \"Category\": \"Audio Module Class\", \"Name\": \"GVst\", \"Vendor\": \"\", \"Version\": \"1.0.0.1\", \"SDKVersion\": \"VST 3.7.5\", \"Sub Categories\": [\"Fx\"], \"Class Flags\": 0, \"Cardinality\": 1 },\n" +
   "    { \"CID\": \"038E7FA9629A4EAA8541B88918E8952C\", \"Category\": \"Component Controller Class\", \"Name\": \"GVstController\", \"Vendor\": \"\", \"Version\": \"1.0.0.1\", \"SDKVersion\": \"VST 3.7.5\", \"Sub Categories\": [], \"Class Flags\": 0, \"Cardinality\": 1 }\n" +
   "  ]\n" +
   "}";
  static PluginInfo Find(List<PluginInfo> list, string bundleName) {
   foreach (var p in list) if (p.BundleName() == bundleName) return p;
   return null;
  }
  public static void Run() {
   Folder = Path.Combine(Media.Root, "bin", "w9plugin-test");
   Directory.CreateDirectory(Folder);
   string log = Path.Combine(Media.Root, "bin", "w9plugin-results.txt");
   LogPath = log;
   File.WriteAllText(log, "RUNNING\n");
   try {
    // 1. 默认路径展开（纯路径，不碰磁盘）：四个 VST3 根 + OFX 根。
    var roots = PluginScanner.Vst3RootsFor(@"C:\Program Files\Common Files", @"C:\Program Files (x86)\Common Files", @"C:\Users\simon\AppData\Local");
    Require(roots.Count == 4, "VST3 default roots is 4 (got " + roots.Count + ")");
    Require(roots[0] == @"C:\Program Files\Common Files\VST3", "VST3 system root (got " + roots[0] + ")");
    Require(roots[1] == @"C:\Program Files (x86)\Common Files\VST3", "VST3 x86 root (got " + roots[1] + ")");
    Require(roots[2] == @"C:\Users\simon\AppData\Local\Programs\Common\VST3", "VST3 per-user root (got " + roots[2] + ")");
    Require(roots[3] == @"C:\Users\simon\AppData\Local\Programs\VST3", "VST3 per-user legacy root (got " + roots[3] + ")");
    var ofxRoots = PluginScanner.DefaultOfxRoots();
    Require(ofxRoots.Count >= 1 && ofxRoots[ofxRoots.Count - 1].EndsWith(@"OFX\Plugins", StringComparison.OrdinalIgnoreCase), "OFX default root ends with OFX\\Plugins (got " + string.Join(";", ofxRoots.ToArray()) + ")");
    Mark("STEP 1 default roots OK");
    // 2. 造夹具 bundle。
    string vst3Root = Path.Combine(Folder, "VST3");
    string ofxRoot = Path.Combine(Folder, "OFX");
    string gvst = Path.Combine(vst3Root, "GVst.vst3");
    WriteText(Path.Combine(Path.Combine(gvst, "Contents"), "Resources", "moduleinfo.json"), GvstModuleInfo);
    WriteDummyBinary(Path.Combine(Path.Combine(gvst, "Contents"), "x86_64-win", "GVst.vst3"));
    string legacy = Path.Combine(vst3Root, "Legacy.vst3");
    WriteText(Path.Combine(Path.Combine(legacy, "Contents"), "moduleinfo.json"),
     "{ \"Name\": \"Legacy\", \"Version\": \"0.9\", \"Factory Info\": { \"Vendor\": \"Old Vendor\", \"URL\": \"\", \"E-Mail\": \"\", \"Flags\": {} }, " +
     "\"Classes\": [ { \"CID\": \"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\", \"Category\": \"Audio Module Class\", \"Name\": \"Legacy\", \"Vendor\": \"Old Vendor\", \"Version\": \"0.9\", \"SDKVersion\": \"VST 3.6.7\", \"Sub Categories\": [\"Fx\"], \"Class Flags\": 0, \"Cardinality\": 1 } ] }");
    WriteDummyBinary(Path.Combine(Path.Combine(legacy, "Contents"), "x86_64-win", "Legacy.vst3"));
    string noMeta = Path.Combine(vst3Root, "NoMeta.vst3");
    WriteDummyBinary(Path.Combine(Path.Combine(noMeta, "Contents"), "x86_64-win", "NoMeta.vst3"));
    string broken = Path.Combine(vst3Root, "Broken.vst3");
    WriteText(Path.Combine(Path.Combine(broken, "Contents"), "Resources", "moduleinfo.json"), "{not json");
    WriteDummyBinary(Path.Combine(Path.Combine(broken, "Contents"), "x86_64-win", "Broken.vst3"));
    string deep = Path.Combine(Path.Combine(vst3Root, "Vendor"), "Deep.vst3");
    WriteDummyBinary(Path.Combine(Path.Combine(deep, "Contents"), "x86_64-win", "Deep.vst3"));
    string tooDeep = Path.Combine(Path.Combine(Path.Combine(vst3Root, "Vendor"), "Sub"), "TooDeep.vst3");
    WriteDummyBinary(Path.Combine(Path.Combine(tooDeep, "Contents"), "x86_64-win", "TooDeep.vst3"));
    WriteText(Path.Combine(vst3Root, "NotAPlugin.txt"), "ignored");
    string foo = Path.Combine(ofxRoot, "Foo.ofx.bundle");
    WriteDummyBinary(Path.Combine(Path.Combine(foo, "Contents"), "Win64", "Foo.ofx"));
    string emptyOfx = Path.Combine(ofxRoot, "Empty.ofx.bundle");
    Directory.CreateDirectory(Path.Combine(emptyOfx, "Contents"));
    Mark("STEP 2 fixtures built");
    // 3. 扫描：GVst / Legacy / NoMeta / Broken / Deep 找到，TooDeep 不找（两层上限）。
    var found = PluginScanner.ScanRoots(new[] { vst3Root }, new[] { ofxRoot });
    Require(found.Count == 7, "scan finds 7 bundles (got " + found.Count + ": " + string.Join(",", found.Select(p => p.BundleName()).ToArray()) + ")");
    var g = Find(found, "GVst");
    Require(g != null && g.Format == PluginFormat.Vst3, "GVst found as VST3");
    Require(g.HasMetadata && g.Classes.Count == 2, "GVst has 2 classes from moduleinfo.json");
    Require(g.EffectCount == 1 && g.Name == "GVst", "GVst exposes 1 effect class, controller is not an effect (name " + g.Name + ")");
    Require(g.Classes[0].Category == "Audio Module Class" && g.Classes[0].SubCategories.Count == 1 && g.Classes[0].SubCategories[0] == "Fx", "GVst effect is Fx");
    Require(g.SdkVersion == "VST 3.7.5" && g.Version == "1.0.0.1", "GVst version 1.0.0.1 / SDK VST 3.7.5");
    Require(g.Classes[0].Cid == "0CDBB66985D548A9BFD8371909D24BB3", "GVst CID matches the validator output");
    Require(!string.IsNullOrEmpty(g.BinaryPath) && g.BinaryPath.EndsWith("GVst.vst3", StringComparison.OrdinalIgnoreCase), "GVst binary found");
    Require(g.Architectures.Contains("x86_64-win"), "GVst arch x86_64-win recorded");
    Require(g.DisplayLine().Contains("未加载"), "GVst display line says not loaded (got: " + g.DisplayLine() + ")");
    var leg = Find(found, "Legacy");
    Require(leg != null && leg.HasMetadata && leg.Name == "Legacy" && leg.Vendor == "Old Vendor" && leg.SdkVersion == "VST 3.6.7", "legacy Contents/moduleinfo.json location is accepted");
    var nm = Find(found, "NoMeta");
    Require(nm != null && !nm.HasMetadata && nm.Name == "NoMeta" && !string.IsNullOrEmpty(nm.BinaryPath), "bundle without moduleinfo.json is still listed with bundle name, no metadata");
    Require(nm.MetadataError.Contains("无 moduleinfo.json"), "NoMeta explains the missing metadata (got: " + nm.MetadataError + ")");
    var br = Find(found, "Broken");
    Require(br != null && !br.HasMetadata && br.MetadataError.Contains("解析失败"), "malformed moduleinfo.json is reported, not fatal (got: " + br.MetadataError + ")");
    Require(Find(found, "Deep") != null, "vendor subfolder bundle (depth 2) is found");
    Require(Find(found, "TooDeep") == null, "depth-3 bundle is not scanned (documented two-level limit)");
    Mark("STEP 3 VST3 scan + moduleinfo parsing OK");
    // 4. OFX：有二进制的列出，无二进制的照样列出但标无二进制；元数据一律未知。
    var fooP = Find(found, "Foo");
    Require(fooP != null && fooP.Format == PluginFormat.Ofx, "OFX bundle found");
    Require(!fooP.HasMetadata && !string.IsNullOrEmpty(fooP.BinaryPath) && fooP.BinaryPath.EndsWith(".ofx", StringComparison.OrdinalIgnoreCase), "OFX binary found, metadata unknown by design");
    Require(fooP.MetadataError.Contains("无元数据文件"), "OFX explains why metadata is unknown");
    var emptyP = Find(found, "Empty");
    Require(emptyP != null && string.IsNullOrEmpty(emptyP.BinaryPath), "OFX bundle without a Win64 binary is listed with no binary");
    Mark("STEP 4 OFX scan OK");
    // 5. 去重 + 空根 + 排序。
    var twice = PluginScanner.ScanRoots(new[] { vst3Root, vst3Root }, new[] { ofxRoot, ofxRoot });
    Require(twice.Count == found.Count, "same root scanned twice still yields " + found.Count + " (got " + twice.Count + ")");
    Require(PluginScanner.ScanOneRoot(Path.Combine(Folder, "does-not-exist"), PluginFormat.Vst3).Count == 0, "missing root returns empty, no throw");
    Require(PluginScanner.ScanOneRoot(null, PluginFormat.Ofx).Count == 0, "null root returns empty, no throw");
    Require(found[0].Format == PluginFormat.Vst3, "VST3 sorts before OFX");
    Mark("STEP 5 dedupe + empty roots + sort OK");
    // 6. 宿主接缝：现在任何“加载”企图都必须抛错，不能静默通过。
    bool threw = false;
    string err = "";
    try { PluginHostSeam.RequireHostReady(); } catch (Exception ex) { threw = true; err = ex.Message; }
    Require(threw && err.Contains("宿主未建"), "host seam refuses to load (got: " + err.Substring(0, Math.Min(40, err.Length)) + ")");
    Require(PluginScanner.HostStatus.Contains("宿主加载开发中"), "scanner status string says loading is in development");
    Mark("STEP 6 host seam refuses honestly OK");
    // 7. 本机默认扫描：在云端 runner 上一般是空，但绝不能抛错。
    var def = PluginScanner.ScanDefault();
    Require(def != null, "ScanDefault never returns null on the runner");
    Mark("STEP 7 ScanDefault on runner OK (" + def.Count + " found)");
    File.WriteAllText(log, "PASS: default roots 4 VST3 + OFX\\Plugins; GVst moduleinfo parsed (2 classes, 1 effect Fx, 1.0.0.1 / VST 3.7.5, CID 0CDBB669…); legacy Contents/moduleinfo.json accepted; no-metadata + malformed JSON listed with reasons, no crash; vendor depth-2 found, depth-3 skipped; OFX binary found / missing-binary listed, metadata unknown by design; dedupe + empty roots safe; host seam refuses load honestly; ScanDefault on runner returned " + def.Count + " without throwing.\n");
   }
   catch (Exception ex) { File.AppendAllText(log, "FAIL\n" + ex + "\n"); Mark("FAIL: " + ex.Message); Environment.ExitCode = 1; }
  }
 }
}
