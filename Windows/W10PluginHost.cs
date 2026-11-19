// W10 插件宿主组（2026-11-19）：原生 VST3 桥的 C# 侧。
// 架构（见 docs/windows/plugins.md §4）：C# 不直接加载任何插件代码，
// 只 spawn Windows/bin/Vst3BridgeHost.exe 子进程调桥；插件崩了只死子进程，
// 主程序不受影响。子进程里桥再加载 .vst3 模块、跑离线处理。
// 语义与 VocalSep.Separate 同款：缺桥 / 缺插件 / 处理失败都抛错，
// 绝不返回静音或空文件冒充成功。
// 进程内加载（PluginHostSeam.RequireHostReady）仍未建——那条接缝的意思
// 现在是“进程内宿主未建”，与本文件的子进程桥是两回事，别混用。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using DogSC.Windows;

namespace DogSC.Replica {
 public class Vst3ParamInfo {
  public int Id; public string Title = ""; public string ShortTitle = ""; public string Units = "";
  public int StepCount; public double Default; public int Flags; public double Current;
  public string Display() {
   return "#" + Id + " " + Title + (string.IsNullOrEmpty(Units) ? "" : "（" + Units + "）") +
    " 默认 " + Default.ToString("0.###", CultureInfo.InvariantCulture);
  }
 }
 static class PluginHost {
  public const string BridgeVersion = "CatCut.Vst3Bridge 1.0 (VST3 SDK 3.8.0, MIT)";
  public static string HostExePath() { return Path.Combine(Media.Root, "bin", "Vst3BridgeHost.exe"); }
  public static string BridgeDllPath() { return Path.Combine(Media.Root, "bin", "CatCut.Vst3Bridge.dll"); }
  // 随包分发的 AGain 测试插件（SDK 自带示例，MIT）：CI 从编好的 again.vst3 拷过来。
  public static string AgainBundlePath() { return Path.Combine(Media.Root, "bin", "Plugins", "AGain.vst3"); }
  public const string Setup =
   "VST3 桥未就绪：\n" +
   "1. 云端构建的“Build VST3 bridge + AGain”一步要产出 Windows/bin/Vst3BridgeHost.exe、\n" +
   "   CatCut.Vst3Bridge.dll 与 Windows/bin/Plugins/AGain.vst3（见 .github/workflows/build-test.yml）。\n" +
   "2. 本地只编 C#（build.ps1）不会产出桥：桥要 CMake + VST3 SDK 3.8.0（MIT）现编。\n" +
   "3. 桥缺失时插件处理一律抛错，不静默跳过、不返回原音频冒充。";
  public static bool IsReady(out string reason) {
   if (!File.Exists(HostExePath())) { reason = "缺少桥子进程：" + HostExePath(); return false; }
   if (!File.Exists(BridgeDllPath())) { reason = "缺少桥 DLL：" + BridgeDllPath(); return false; }
   if (!Directory.Exists(AgainBundlePath())) { reason = "缺少 AGain 测试插件：" + AgainBundlePath(); return false; }
   reason = "";
   return true;
  }
  public static void RequireBridgeReady() {
   string reason;
   if (!IsReady(out reason)) throw new Exception("VST3 桥未就绪：" + reason + "\n" + Setup);
  }
  // 桥状态一行，供插件面板显示（只陈述事实）。
  public static string StatusLine() {
   string reason;
   if (IsReady(out reason)) return "桥已就绪：Vst3BridgeHost.exe + CatCut.Vst3Bridge.dll + AGain.vst3（子进程隔离，插件崩不拖垮主程序）。";
   return "桥未就绪：" + reason;
  }
  // 跑一次桥子进程：stdout 必须是单行 JSON（classes / params / process 摘要），
  // 退出码非 0 即失败，stderr 原样带回。超时直接杀进程再抛错。
  public static string RunHost(string args, int timeoutMs = 120000) {
   return RunHostExe(HostExePath(), args, timeoutMs);
  }
  internal static string RunHostExe(string exePath, string args, int timeoutMs) {
   if (string.IsNullOrEmpty(exePath) || !File.Exists(exePath))
    throw new Exception("VST3 桥子进程缺失：" + exePath + "。\n" + Setup);
   var psi = new ProcessStartInfo(exePath, args) {
    UseShellExecute = false, CreateNoWindow = true,
    RedirectStandardOutput = true, RedirectStandardError = true,
    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
   };
   using (var p = new Process { StartInfo = psi }) {
    try { p.Start(); } catch (Exception ex) { throw new Exception("启动 VST3 桥子进程失败：" + ex.Message + "。\n" + Setup); }
    var errTask = p.StandardError.ReadToEndAsync();
    string stdout = p.StandardOutput.ReadToEnd();
    if (!p.WaitForExit(timeoutMs)) {
     try { p.Kill(); } catch { }
     throw new Exception("VST3 桥子进程超时（" + timeoutMs + "ms，未退出，已杀掉）：" + args);
    }
    string stderr = "";
    try { stderr = errTask.Result; } catch { }
    if (p.ExitCode != 0)
     throw new Exception("VST3 桥子进程失败（退出码 " + p.ExitCode + "）：" + (string.IsNullOrEmpty(stderr) ? "(无 stderr)" : stderr.Trim()) + "\n命令：" + args);
    return stdout == null ? "" : stdout.Trim();
   }
  }
  static string JsonStr(Dictionary<string, object> d, string key) {
   object v;
   if (d == null || !d.TryGetValue(key, out v) || !(v is string)) return "";
   return (string)v;
  }
  static double JsonNum(Dictionary<string, object> d, string key, double fallback) {
   object v;
   if (d == null || !d.TryGetValue(key, out v)) return fallback;
   if (v is double) return (double)v;
   if (v is long) return (double)(long)v;
   return fallback;
  }
  static long JsonInt(Dictionary<string, object> d, string key, long fallback) {
   object v;
   if (d == null || !d.TryGetValue(key, out v)) return fallback;
   if (v is long) return (long)v;
   if (v is double) return (long)(double)v;
   return fallback;
  }
  static List<object> JsonArr(Dictionary<string, object> d, string key) {
   object v;
   if (d == null || !d.TryGetValue(key, out v)) return new List<object>();
   var list = v as List<object>;
   return list ?? new List<object>();
  }
  // 列出模块工厂里的类（走桥真实加载，不是读 moduleinfo.json 的扫描）。
  public static List<PluginClassInfo> ListClasses(string pluginPath) {
   RequireBridgeReady();
   if (string.IsNullOrEmpty(pluginPath) || (!File.Exists(pluginPath) && !Directory.Exists(pluginPath)))
    throw new Exception("插件路径不存在：" + pluginPath);
   string json = RunHost("classes --plugin " + Media.Q(pluginPath));
   var root = MiniJson.Parse(json) as Dictionary<string, object>;
   if (root == null) throw new Exception("桥返回的 classes 不是 JSON 对象：" + json);
   var list = new List<PluginClassInfo>();
   foreach (object item in JsonArr(root, "classes")) {
    var c = item as Dictionary<string, object>;
    if (c == null) continue;
    var ci = new PluginClassInfo {
     Cid = JsonStr(c, "cid"), Category = JsonStr(c, "category"), Name = JsonStr(c, "name"),
     Vendor = JsonStr(c, "vendor"), Version = JsonStr(c, "version"), SdkVersion = JsonStr(c, "sdkVersion")
    };
    foreach (object sub in JsonArr(c, "subCategories")) if (sub is string) ci.SubCategories.Add((string)sub);
    list.Add(ci);
   }
   return list;
  }
  // 列出效果参数表（走桥真实加载 + 控制器 getParameterInfo）。
  public static List<Vst3ParamInfo> ListParams(string pluginPath) {
   RequireBridgeReady();
   if (string.IsNullOrEmpty(pluginPath) || (!File.Exists(pluginPath) && !Directory.Exists(pluginPath)))
    throw new Exception("插件路径不存在：" + pluginPath);
   string json = RunHost("params --plugin " + Media.Q(pluginPath));
   var root = MiniJson.Parse(json) as Dictionary<string, object>;
   if (root == null) throw new Exception("桥返回的 params 不是 JSON 对象：" + json);
   var list = new List<Vst3ParamInfo>();
   foreach (object item in JsonArr(root, "params")) {
    var c = item as Dictionary<string, object>;
    if (c == null) continue;
    list.Add(new Vst3ParamInfo {
     Id = (int)JsonInt(c, "id", -1), Title = JsonStr(c, "title"), ShortTitle = JsonStr(c, "shortTitle"),
     Units = JsonStr(c, "units"), StepCount = (int)JsonInt(c, "stepCount", 0),
     Default = JsonNum(c, "defaultNormalizedValue", 0), Flags = (int)JsonInt(c, "flags", 0),
     Current = JsonNum(c, "current", 0)
    });
   }
   return list;
  }
  // 离线过一遍插件：inWav 立体声、采样率 == sampleRate；outWav 写 float32 立体声。
  // parameters：id -> 归一化 0..1（null 用插件默认值）。失败抛错，绝不返回原音频。
  // 返回 outWav。outWav 必须不存在或可覆盖；处理失败时半截文件已由桥删掉。
  public static string ProcessStem(string pluginPath, string inWav, string outWav, double sampleRate,
                                   Dictionary<int, double> parameters) {
   RequireBridgeReady();
   if (string.IsNullOrEmpty(pluginPath) || (!File.Exists(pluginPath) && !Directory.Exists(pluginPath)))
    throw new Exception("插件路径不存在：" + pluginPath);
   if (string.IsNullOrEmpty(inWav) || !File.Exists(inWav)) throw new Exception("VST3 处理：找不到输入 wav：" + inWav);
   if (string.IsNullOrEmpty(outWav)) throw new Exception("VST3 处理：输出 wav 路径为空。");
   if (!EditDocument.Finite(sampleRate) || sampleRate < 8000 || sampleRate > 192000)
    throw new Exception("VST3 处理：采样率无效：" + sampleRate + "（8000–192000）。");
   var args = new StringBuilder();
   args.Append("process --plugin ").Append(Media.Q(pluginPath));
   args.Append(" --in ").Append(Media.Q(inWav));
   args.Append(" --out ").Append(Media.Q(outWav));
   args.Append(" --rate ").Append(((int)sampleRate).ToString(CultureInfo.InvariantCulture));
   if (parameters != null) foreach (var kv in parameters) {
    if (kv.Key < 0) throw new Exception("VST3 处理：参数 id 无效：" + kv.Key);
    if (!EditDocument.Finite(kv.Value) || kv.Value < 0 || kv.Value > 1)
     throw new Exception("VST3 处理：参数 #" + kv.Key + " 越界（归一化 0..1，收到 " + kv.Value + "）。");
    args.Append(" --param ").Append(kv.Key).Append("=")
     .Append(kv.Value.ToString("0.######", CultureInfo.InvariantCulture));
   }
   string dir = Path.GetDirectoryName(Path.GetFullPath(outWav));
   if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
   string summary = RunHost(args.ToString());
   if (!File.Exists(outWav) || new FileInfo(outWav).Length <= 44)
    throw new Exception("VST3 处理没有产出可用 wav（桥退 0 但输出缺失/过小）：" + outWav + "。桥摘要：" + summary);
   var root = MiniJson.Parse(summary) as Dictionary<string, object>;
   if (root == null || JsonInt(root, "frames", 0) <= 0)
    throw new Exception("VST3 处理摘要异常（0 帧或非 JSON）：" + summary);
   return outWav;
  }
 }
}
