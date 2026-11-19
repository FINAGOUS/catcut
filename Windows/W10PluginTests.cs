// W10 插件宿主 A 级自测（2026-11-19）：--w10plugin-test 入口，无窗口。
// 跑在云端构建里（build-test.yml 的 W10 plugin checks 步），
// 结果写 Windows/bin/w10plugin-results.txt（PASS: 开头才算过）。
//
// 验的是真链路，不是壳子：
// - 桥子进程 Vst3BridgeHost.exe 必须存在（云端 native 步没产出就 FAIL，不跳过）；
// - AGain.vst3 必须是 CI 现编的真 bundle：W9 扫描器先读它的 moduleinfo.json
//   （AGain 处理器 CID 84E8DE5F… + AGainController CID D39D5B65…），
//   再走桥真实加载列类/列参数（不是读 JSON 的扫描）；
// - 音频真过 DSP：立体声正弦（左 0.5 / 右 0.25，440Hz，2 秒，48kHz）过 AGain，
//   增益 0.5 → 两声道 RMS 比 0.5；增益 1.0 → 比 1.0；增益 0 → 近静音。
//   假桥（原样返回输入）会在增益 0 一项上露馅。
// - 诚实报错：不存在的插件 / 单声道 wav / 文本假插件一律抛错，
//   且抛错后测试进程继续跑（子进程隔离的证明：插件死不死主程序）。
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using DogSC.Windows;

namespace DogSC.Replica {
 static class W10PluginTests {
  static void Require(bool ok, string name) { if (!ok) throw new Exception("W10 plugin 检查失败：" + name); }
  static string Folder;
  static string LogPath;
  static void Mark(string s) { try { File.AppendAllText(LogPath, s + "\n"); } catch { } }
  // 立体声 PCM16 wav（左/右各一个采样函数）。
  static void WriteStereoWav(string path, int sampleRate, double seconds, Func<double, double> left, Func<double, double> right) {
   int n = (int)(sampleRate * seconds);
   Directory.CreateDirectory(Path.GetDirectoryName(path));
   using (var fs = File.Create(path))
   using (var w = new BinaryWriter(fs)) {
    w.Write(new char[] { 'R', 'I', 'F', 'F' }); w.Write(36 + n * 4); w.Write(new char[] { 'W', 'A', 'V', 'E' });
    w.Write(new char[] { 'f', 'm', 't', ' ' }); w.Write(16); w.Write((short)1); w.Write((short)2); w.Write(sampleRate); w.Write(sampleRate * 4); w.Write((short)4); w.Write((short)16);
    w.Write(new char[] { 'd', 'a', 't', 'a' }); w.Write(n * 4);
    for (int i = 0; i < n; i++) {
     double t = (double)i / sampleRate;
     w.Write((short)(Math.Max(-1, Math.Min(1, left(t))) * 32767));
     w.Write((short)(Math.Max(-1, Math.Min(1, right(t))) * 32767));
    }
   }
  }
  static void WriteMonoWav(string path, int sampleRate, double seconds, Func<double, double> sample) {
   int n = (int)(sampleRate * seconds);
   Directory.CreateDirectory(Path.GetDirectoryName(path));
   using (var fs = File.Create(path))
   using (var w = new BinaryWriter(fs)) {
    w.Write(new char[] { 'R', 'I', 'F', 'F' }); w.Write(36 + n * 2); w.Write(new char[] { 'W', 'A', 'V', 'E' });
    w.Write(new char[] { 'f', 'm', 't', ' ' }); w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(sampleRate); w.Write(sampleRate * 2); w.Write((short)2); w.Write((short)16);
    w.Write(new char[] { 'd', 'a', 't', 'a' }); w.Write(n * 2);
    for (int i = 0; i < n; i++) w.Write((short)(Math.Max(-1, Math.Min(1, sample((double)i / sampleRate))) * 32767));
   }
  }
  // 读回 PCM16 / float32 wav，按声道拆开（不走 ffmpeg，免得把解码问题算到桥头上）。
  static float[][] ReadWavChannels(string path, out int sampleRate) {
   using (var fs = File.OpenRead(path))
   using (var r = new BinaryReader(fs)) {
    string riff = new string(r.ReadChars(4));
    Require(riff == "RIFF", "输出 wav 不是 RIFF（" + path + "）");
    r.ReadInt32();
    string wave = new string(r.ReadChars(4));
    Require(wave == "WAVE", "输出 wav 不是 WAVE（" + path + "）");
    short format = 0, channels = 0, bits = 0;
    sampleRate = 0;
    long dataPos = -1; int dataBytes = 0;
    while (fs.Position < fs.Length) {
     string id = new string(r.ReadChars(4));
     int size = r.ReadInt32();
     if (id == "fmt ") {
      format = r.ReadInt16(); channels = r.ReadInt16(); sampleRate = r.ReadInt32();
      r.ReadInt32(); r.ReadInt16(); bits = r.ReadInt16();
      if (size > 16) fs.Seek(size - 16, SeekOrigin.Current);
     } else if (id == "data") {
      dataPos = fs.Position; dataBytes = size;
      break;
     } else {
      fs.Seek(size + (size & 1), SeekOrigin.Current);
     }
    }
    Require(dataPos >= 0, "输出 wav 没有 data chunk（" + path + "）");
    Require((format == 1 && bits == 16) || (format == 3 && bits == 32), "输出 wav 格式不是 PCM16/float32（format=" + format + ", bits=" + bits + "）");
    int bytesPerSample = bits / 8;
    int frames = dataBytes / (bytesPerSample * channels);
    Require(frames > 0, "输出 wav 0 帧（" + path + "）");
    fs.Seek(dataPos, SeekOrigin.Begin);
    var ch = new float[channels][];
    for (int c = 0; c < channels; c++) ch[c] = new float[frames];
    for (int i = 0; i < frames; i++) for (int c = 0; c < channels; c++) {
     if (format == 1) ch[c][i] = r.ReadInt16() / 32768f;
     else ch[c][i] = r.ReadSingle();
    }
    return ch;
   }
  }
  static double Rms(float[] s) {
   double sum = 0;
   foreach (float v in s) sum += (double)v * v;
   return Math.Sqrt(sum / Math.Max(1, s.Length));
  }
  static PluginClassInfo FindClass(List<PluginClassInfo> list, string cid) {
   foreach (var c in list) if (string.Equals(c.Cid, cid, StringComparison.OrdinalIgnoreCase)) return c;
   return null;
  }
  // CID 字节序：源码 FUID 字面量是 plain 序（84E8DE5F…），Windows 上
  // moduleinfotool 与桥的 toString() 默认是 GUID 序（前三组字节反过来）。
  // 两边都是同一 UID，比较时两种序都接受。
  static string GuidOrder(string cid) {
   string h = "";
   foreach (char c in cid) if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f')) h += char.ToUpperInvariant(c);
   if (h.Length != 32) return cid;
   return h.Substring(6, 2) + h.Substring(4, 2) + h.Substring(2, 2) + h.Substring(0, 2)
    + h.Substring(10, 2) + h.Substring(8, 2) + h.Substring(14, 2) + h.Substring(12, 2) + h.Substring(16);
  }
  static bool CidMatches(string a, string b) {
   if (string.Equals(a, b, StringComparison.OrdinalIgnoreCase)) return true;
   return string.Equals(GuidOrder(a), b, StringComparison.OrdinalIgnoreCase);
  }
  static PluginClassInfo FindEffect(List<PluginClassInfo> list, string name) {
   foreach (var c in list) if (c.Category == "Audio Module Class" && c.Name == name) return c;
   return null;
  }
  static PluginClassInfo FindController(List<PluginClassInfo> list, string name) {
   foreach (var c in list) if (c.Category == "Component Controller Class" && c.Name == name) return c;
   return null;
  }
  static Vst3ParamInfo FindParam(List<Vst3ParamInfo> list, int id) {
   foreach (var p in list) if (p.Id == id) return p;
   return null;
  }
  public static void Run() {
   Folder = Path.Combine(Media.Root, "bin", "w10plugin-test");
   Directory.CreateDirectory(Folder);
   string log = Path.Combine(Media.Root, "bin", "w10plugin-results.txt");
   LogPath = log;
   File.WriteAllText(log, "RUNNING\n");
   try {
    // 1. 桥必须在：缺了就是 FAIL，不跳过、不编造。
    string reason;
    Require(PluginHost.IsReady(out reason), "桥未就绪：" + reason + "（云端 native 步没产出桥/AGain）");
    Require(PluginHost.BridgeVersion.Contains("3.8.0"), "桥版本串含 VST3 SDK 3.8.0");
    string version = PluginHost.RunHost("version");
    Require(version.Contains("CatCut.Vst3Bridge"), "桥子进程 version 自报（got: " + version + ")");
    Mark("STEP 1 bridge ready: " + PluginHost.StatusLine());
    // 2. W9 扫描器读 AGain 的 moduleinfo.json（CI 现编的真 bundle，不是手写夹具）。
    string again = PluginHost.AgainBundlePath();
    var scanned = PluginScanner.InspectBundle(again, PluginFormat.Vst3);
    Require(scanned != null && scanned.HasMetadata, "AGain moduleinfo.json 可解析（metaErr=" + (scanned == null ? "null" : scanned.MetadataError) + ")");
    var ag = FindEffect(scanned.Classes, "AGain VST3");
    Require(ag != null, "扫描到 AGain 处理器类（Audio Module Class，名 AGain VST3）");
    Require(CidMatches(ag.Cid, "84E8DE5F92554F5396FAE4133C935A18"), "AGain CID 与源码 FUID 一致（允许 GUID 字节序，got: " + ag.Cid + ")");
    Require(ag.SubCategories.Contains("Fx"), "AGain 子类别含 Fx（got: " + string.Join(",", ag.SubCategories.ToArray()) + ")");
    var agc = FindController(scanned.Classes, "AGain VST3Controller");
    Require(agc != null, "扫描到 AGainController 配对类（名 AGain VST3Controller）");
    Require(CidMatches(agc.Cid, "D39D5B65D7AF42FA843F4AC841EB04F0"), "AGainController CID 与源码 FUID 一致（允许 GUID 字节序，got: " + agc.Cid + ")");
    Require(scanned.EffectCount >= 1, "AGain 至少 1 个效果类（got " + scanned.EffectCount + ")");
    Require(!string.IsNullOrEmpty(scanned.BinaryPath) && scanned.BinaryPath.EndsWith(".vst3", StringComparison.OrdinalIgnoreCase), "AGain 二进制已找到（" + scanned.BinaryPath + ")");
    Mark("STEP 2 scanner reads real AGain moduleinfo.json OK (" + scanned.Classes.Count + " classes, " + scanned.EffectCount + " effects)");
    // 3. 桥真实加载列类：与扫描结果对得上才算加载成功。
    var classes = PluginHost.ListClasses(again);
    Require(classes.Count >= 2, "桥列出至少 2 个类（got " + classes.Count + ")");
    var bag = FindEffect(classes, "AGain VST3");
    Require(bag != null, "桥加载后列出 AGain 处理器类（名 AGain VST3）");
    Require(CidMatches(bag.Cid, "84E8DE5F92554F5396FAE4133C935A18"), "桥列出的 AGain CID 与源码 FUID 一致（got: " + bag.Cid + ")");
    Require(string.Equals(bag.Cid, ag.Cid, StringComparison.OrdinalIgnoreCase), "桥列出的 AGain CID 与 moduleinfo.json 里的 CID 精确一致（got: " + bag.Cid + " vs " + ag.Cid + ")");
    Require(FindController(classes, "AGain VST3Controller") != null, "桥加载后列出 AGainController 类");
    Mark("STEP 3 bridge classes OK (" + classes.Count + " classes incl. AGain + AGainController)");
    // 4. 桥真实列参数：Gain #0 默认 0.5、单位 dB；VuPPM #1、Bypass #2 也在。
    var pars = PluginHost.ListParams(again);
    var gain = FindParam(pars, 0);
    Require(gain != null && gain.Title == "Gain", "桥列出 Gain 参数 #0（got: " + (gain == null ? "null" : gain.Title) + ")");
    Require(Math.Abs(gain.Default - 0.5) < 0.001, "Gain 默认 0.5（got " + gain.Default + ")");
    Require(gain.Units == "dB", "Gain 单位 dB（got: " + gain.Units + ")");
    Require(FindParam(pars, 1) != null && FindParam(pars, 2) != null, "桥列出 VuPPM #1 与 Bypass #2");
    Mark("STEP 4 bridge params OK (Gain #0 default 0.5 dB, " + pars.Count + " params)");
    // 5. 音频真过 DSP：立体声正弦左 0.5 / 右 0.25，440Hz，2 秒，48kHz。
    string inWav = Path.Combine(Folder, "sine-stereo.wav");
    WriteStereoWav(inWav, 48000, 2, t => 0.5 * Math.Sin(2 * Math.PI * 440 * t), t => 0.25 * Math.Sin(2 * Math.PI * 440 * t));
    int inRate; var inCh = ReadWavChannels(inWav, out inRate);
    Require(inRate == 48000 && inCh.Length == 2 && inCh[0].Length == 96000, "输入夹具 48kHz 立体声 96000 帧");
    double inRmsL = Rms(inCh[0]), inRmsR = Rms(inCh[1]);
    Require(inRmsL > 0.3 && inRmsL < 0.4 && inRmsR > 0.15 && inRmsR < 0.2, "输入 RMS 左 ~0.354 / 右 ~0.177（got " + inRmsL.ToString("0.000") + " / " + inRmsR.ToString("0.000") + ")");
    // 5a. 增益 0.5（走公开 API ProcessStem）。
    string outHalf = Path.Combine(Folder, "sine-gain-half.wav");
    PluginHost.ProcessStem(again, inWav, outHalf, 48000, new Dictionary<int, double> { { 0, 0.5 } });
    int outRate; var outCh = ReadWavChannels(outHalf, out outRate);
    Require(outRate == 48000 && outCh.Length == 2 && outCh[0].Length == 96000, "增益 0.5 输出 48kHz 立体声 96000 帧（与输入同帧数）");
    double ratioL = Rms(outCh[0]) / inRmsL, ratioR = Rms(outCh[1]) / inRmsR;
    Require(Math.Abs(ratioL - 0.5) < 0.03 && Math.Abs(ratioR - 0.5) < 0.03, "增益 0.5 时两声道 RMS 比 ~0.5（got L " + ratioL.ToString("0.000") + " / R " + ratioR.ToString("0.000") + ")");
    Mark("STEP 5a gain 0.5 via ProcessStem OK (ratio L " + ratioL.ToString("0.000") + " / R " + ratioR.ToString("0.000") + ")");
    // 5b. 增益 1.0（走子进程直调， bypass 式对照：输出应 ≈ 输入）。
    string outOne = Path.Combine(Folder, "sine-gain-one.wav");
    string summaryOne = PluginHost.RunHost("process --plugin " + Media.Q(again) + " --in " + Media.Q(inWav) + " --out " + Media.Q(outOne) + " --rate 48000 --param 0=1");
    Require(summaryOne.Contains("\"frames\":96000"), "增益 1.0 桥摘要 96000 帧（got: " + summaryOne + ")");
    var oneCh = ReadWavChannels(outOne, out outRate);
    double ratioOneL = Rms(oneCh[0]) / inRmsL, ratioOneR = Rms(oneCh[1]) / inRmsR;
    Require(Math.Abs(ratioOneL - 1.0) < 0.02 && Math.Abs(ratioOneR - 1.0) < 0.02, "增益 1.0 时输出 ≈ 输入（got L " + ratioOneL.ToString("0.000") + " / R " + ratioOneR.ToString("0.000") + ")");
    Mark("STEP 5b gain 1.0 via host exe OK (ratio L " + ratioOneL.ToString("0.000") + " / R " + ratioOneR.ToString("0.000") + ")");
    // 5c. 增益 0 → 近静音（假桥原样返回输入会在这里露馅）。
    string outZero = Path.Combine(Folder, "sine-gain-zero.wav");
    PluginHost.ProcessStem(again, inWav, outZero, 48000, new Dictionary<int, double> { { 0, 0.0 } });
    var zeroCh = ReadWavChannels(outZero, out outRate);
    double zeroRms = Math.Max(Rms(zeroCh[0]), Rms(zeroCh[1]));
    Require(zeroRms < 0.002, "增益 0 时输出近静音（max RMS " + zeroRms.ToString("0.0000") + "，应 < 0.002）");
    Mark("STEP 5c gain 0.0 near-silence OK (max RMS " + zeroRms.ToString("0.0000") + ")");
    // 6. 诚实报错：不存在的插件 / 单声道 / 文本假插件 / 缺桥子进程。
    bool threw = false;
    try { PluginHost.ProcessStem(Path.Combine(Folder, "NoSuch.vst3"), inWav, Path.Combine(Folder, "x.wav"), 48000, null); } catch { threw = true; }
    Require(threw, "不存在的插件路径抛错");
    Mark("STEP 6a missing plugin throws OK");
    string monoWav = Path.Combine(Folder, "sine-mono.wav");
    WriteMonoWav(monoWav, 48000, 2, t => 0.5 * Math.Sin(2 * Math.PI * 440 * t));
    threw = false; string monoErr = "";
    try { PluginHost.ProcessStem(again, monoWav, Path.Combine(Folder, "y.wav"), 48000, null); } catch (Exception ex) { threw = true; monoErr = ex.Message; }
    Require(threw && monoErr.Contains("立体声"), "单声道 wav 被拒且理由提立体声（got: " + monoErr.Substring(0, Math.Min(80, monoErr.Length)) + ")");
    Mark("STEP 6b mono rejected as non-stereo OK");
    string fake = Path.Combine(Folder, "Fake.vst3");
    Directory.CreateDirectory(Path.Combine(Path.Combine(fake, "Contents"), "x86_64-win"));
    File.WriteAllText(Path.Combine(Path.Combine(Path.Combine(fake, "Contents"), "x86_64-win"), "Fake.vst3"), "not a real plugin binary");
    threw = false;
    try { PluginHost.ProcessStem(fake, inWav, Path.Combine(Folder, "z.wav"), 48000, null); } catch { threw = true; }
    Require(threw, "文本假插件加载抛错（且主测试进程还活着——子进程隔离）");
    Mark("STEP 6c fake text plugin throws OK");
    threw = false;
    try { PluginHost.RunHostExe(Path.Combine(Folder, "NoSuchHost.exe"), "version", 5000); } catch (Exception ex) { threw = true; Require(ex.Message.Contains("桥子进程缺失"), "缺桥子进程的报错要指名（got: " + ex.Message.Substring(0, Math.Min(60, ex.Message.Length)) + ")"); }
    Require(threw, "缺桥子进程抛错");
    Mark("STEP 6d missing host exe throws OK");
    Mark("STEP 6 honest errors OK (missing plugin / mono rejected as non-stereo / fake text plugin / missing host exe)");
    // 7. 进程内宿主仍未建：接缝继续诚实拒绝，别让人误以为两条路都通了。
    bool seamThrew = false;
    try { PluginHostSeam.RequireHostReady(); } catch (Exception ex) { seamThrew = ex.Message.Contains("宿主未建"); }
    Require(seamThrew, "进程内宿主接缝仍抛“宿主未建”（子进程桥 ≠ 进程内宿主）");
    Mark("STEP 7 in-process seam still refuses honestly OK");
    File.WriteAllText(log, "PASS: bridge ready (Vst3BridgeHost.exe + CatCut.Vst3Bridge.dll + AGain.vst3); AGain moduleinfo parsed by W9 scanner (AGain VST3 84E8DE5F… Fx + AGain VST3Controller D39D5B65…); bridge loaded the real module (classes >= 2, params Gain #0 default 0.5 dB + VuPPM #1 + Bypass #2); stereo 440Hz sine 2s @48kHz through AGain DSP: gain 0.5 RMS ratio L " + ratioL.ToString("0.000") + " / R " + ratioR.ToString("0.000") + ", gain 1.0 ratio L " + ratioOneL.ToString("0.000") + " / R " + ratioOneR.ToString("0.000") + ", gain 0.0 max RMS " + zeroRms.ToString("0.0000") + "; honest errors for missing plugin / mono input / fake text plugin / missing host exe; in-process seam still refuses.\n");
   }
   catch (Exception ex) { File.AppendAllText(log, "FAIL\n" + ex + "\n"); Mark("FAIL: " + ex.Message); Environment.ExitCode = 1; }
  }
 }
}
