// W6 收尾批（2026-11-18）：RGB/主曲线、卡点闪白、音频类型一键处理、
// 平滑跳切 Morph Cut、时间线内录配音、代理与缓存磁盘管理、360° 基础。
// 模型与纯逻辑；UI 见 W6UI.cs。滤镜串出处（全部是已验证的数，不是现编的）：
// - RGB/主曲线：color.ts 的 curves（applyAdvancedColorToRgb 末尾：先逐通道
//   RGB 曲线，再主曲线作用于每个通道；applyCurve 分段线性、端点外钳制，
//   与 HSL 曲线同一条数学，复用 HslCurves.ApplyCurve）。
// - 闪白：beat.ts 的 beatFlashFilters（drawbox + enable=between，2 帧默认，
//   1–10 帧；fade=t=in 已被探针证伪——会把节拍前的画面也漂白）。
// - 音频预设：audiofx.ts 的美化链（highpass 80 → deesser f=0.85 →
//   presence EQ 3000Hz +3dB）、audiorepair.ts 的 afftdn nr=25:nf=-30
//   （默认 nr=12:nf=-50 近乎无效）、filtergraph.ts 的
//   loudnorm=I=-16:TP=-1.5:LRA=11:linear=true；闪避 sidechaincompress
//   threshold=0.05:ratio=4:attack=200:release=250（本地探针：真实电平下
//   对话出现时音乐压低 8.4dB，对话结束恢复到 ±0dB）。
// - Morph Cut：minterpolate（LGPL）光流插值；本地探针：10px 跳变时插值帧
//   方块落在正中间（105），40px 硬跳变时插值帧是重影糊片——快速运动会糊，
//   不如 Adobe Morph Cut，面板里写明。
// - 360°：Google Spherical Video V2 的 sv3d box（svhd + proj/prhd/equi，
//   全幅 bounds 全 0——ffprobe 的 mov.c 要求 b < UINT_MAX - t，0xFFFFFFFF
//   会报错“Invalid bounding rectangle”）；ffmpeg CLI 写不出 sv3d（Bino3D 也
//   证实“没有可靠办法写”），这里直接改 MP4 box，注入后 ffprobe 认出
//   Spherical Mapping（本地已验证）。
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
 static class RgbCurves {
  public static List<CurvePoint> Identity() { return new List<CurvePoint> { new CurvePoint { X = 0, Y = 0 }, new CurvePoint { X = 1, Y = 1 } }; }
  public static bool IsIdentity(List<CurvePoint> points) {
   if (points == null || points.Count == 0) return true;
   foreach (var p in points) if (Math.Abs(p.Y - p.X) > .000001) return false;
   return true;
  }
 }

 // 卡点闪白（beat.ts 的 beatFlashFilters 移植到 GDI+ 绘制层）。
 static class BeatFlash {
  // 源节拍（相对源文件秒）→ 时间线秒：按 Cut 映射；空隙不含源时间，跳过；
  // 变速片段按 /Speed 换算（输出时长 = 源长 / Speed）。
  public static List<double> MapBeats(EditDocument doc, List<double> sourceBeats) {
   var result = new List<double>();
   if (doc == null || sourceBeats == null) return result;
   double offset = 0;
   foreach (var c in doc.Cuts) {
    if (!c.Gap) {
     foreach (double b in sourceBeats) {
      if (b >= c.Start && b < c.End) result.Add(offset + (b - c.Start) / c.Speed);
     }
    }
    offset += c.Length;
   }
   result.Sort();
   return result;
  }
  // 当前时间线时刻是否落在某次闪白窗口里（[beat, beat + frames/fps)）。
  public static bool IsFlash(double time, List<double> beats, int frames, double fps) {
   if (beats == null || frames < 1 || fps <= 0) return false;
   double span = frames / fps;
   foreach (double b in beats) if (time >= b && time < b + span) return true;
   return false;
  }
 }

 // 音频类型一键处理（Essential Sound 类）：预设只作用于主音轨（对话轨），
 // 音乐床不受预设影响；闪避只在有音乐床 + 有主音轨时生效。
 static class AudioTypePreset {
  public static readonly string[] Types = new[] { "无", "对话", "音乐", "音效", "氛围" };
  public static string FilterFor(string type) {
   if (type == "对话") return "highpass=f=80,deesser=i=0.5:m=0.5:f=0.85,equalizer=f=3000:width_type=q:width=1:g=3,afftdn=nr=25:nf=-30,loudnorm=I=-16:TP=-1.5:LRA=11:linear=true";
   if (type == "音乐") return "loudnorm=I=-14:TP=-1.5:LRA=11:linear=true";
   if (type == "音效") return "highpass=f=100,acompressor=threshold=-18dB:ratio=4:attack=5:release=100,loudnorm=I=-16:TP=-1.5:LRA=11:linear=true";
   if (type == "氛围") return "lowpass=f=8000,loudnorm=I=-18:TP=-1.5:LRA=11:linear=true";
   return "";
  }
  public static string Describe(string type) {
   if (type == "对话") return "去低频嗡鸣 → 去齿音 → 3kHz 提亮 → 降噪 → 响度 -16 LUFS；对话时音乐床自动压低。";
   if (type == "音乐") return "只做响度 -14 LUFS，不降噪、不切频，保留完整频段。";
   if (type == "音效") return "切 100Hz 以下 → 压缩（-18dB/4:1）→ 响度 -16 LUFS。";
   if (type == "氛围") return "切 8kHz 以上 → 响度 -18 LUFS，压得比对话轻，作背景。";
   return "不对主音轨做任何处理（响度、降噪、闪避全部关闭）。";
  }
  // 闪避：对话出现时压低音乐床（本地探针：真实电平下压 8.4dB，恢复 ±0dB）。
  public const string DuckFilter = "sidechaincompress=threshold=0.05:ratio=4:attack=200:release=250";
 }

 // 平滑跳切 Morph Cut：跳切边界处用 minterpolate 光流插值过渡（LGPL）。
 // 只对同源、1×、无变速的跳切边界生效；多机位切换点（两段文件不同）、
 // 变速片段、空隙边界保持硬切。过渡只在导出里生效，预览仍显示硬切。
 static class MorphCut {
  public static bool BoundaryOk(PlaySegment a, PlaySegment b, double seconds, double fps) {
   if (a == null || b == null || a.Gap || b.Gap) return false;
   if (a.File != b.File) return false;
   if (Math.Abs(a.Speed - 1) > .000001 || Math.Abs(b.Speed - 1) > .000001) return false;
   double half = seconds / 2;
   return a.Length > half + 2 / fps && b.Length > half + 2 / fps;
  }
  // morph 视频片段：A 尾 + B 头拼起来，minterpolate 插到 2 倍帧率，再从
  // 1/(2F) 秒处截（错开半帧，让 fps=F 采样到插值帧而不是原帧——本地探针
  // 已验证：10px 跳变时插值帧方块落在正中间），最后 fps 回到时间线帧率。
  // tag 是边界编号，避免多处过渡的标签撞车。
  public static string VideoSnippet(int input, double aStart, double aEnd, double bStart, double bEnd, double fps, string tag) {
   double half = 1 / (2 * fps);
   var sb = new StringBuilder();
   sb.Append("[" + input + ":v]trim=start=" + Media.N(aStart) + ":end=" + Media.N(aEnd) + ",setpts=PTS-STARTPTS[mA" + tag + "];\n");
   sb.Append("[" + input + ":v]trim=start=" + Media.N(bStart) + ":end=" + Media.N(bEnd) + ",setpts=PTS-STARTPTS[mB" + tag + "];\n");
   sb.Append("[mA" + tag + "][mB" + tag + "]concat=n=2:v=1:a=0,minterpolate=fps=" + Media.N(2 * fps) + ":mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,trim=start=" + Media.N(half) + ",setpts=PTS-STARTPTS,fps=" + Media.N(fps) + "[mv" + tag + "];\n");
   return sb.ToString();
  }
  public static string AudioSnippet(double aStart, double aEnd, double bStart, double bEnd, string tag) {
   var sb = new StringBuilder();
   sb.Append("[0:a:0]atrim=start=" + Media.N(aStart) + ":end=" + Media.N(aEnd) + ",asetpts=PTS-STARTPTS,apad[maA" + tag + "];\n");
   sb.Append("[0:a:0]atrim=start=" + Media.N(bStart) + ":end=" + Media.N(bEnd) + ",asetpts=PTS-STARTPTS,apad[maB" + tag + "];\n");
   sb.Append("[maA" + tag + "][maB" + tag + "]concat=n=2:v=0:a=1[ma" + tag + "];\n");
   return sb.ToString();
  }
 }

 // 时间线内录配音：WASAPI 经 DirectShow 采麦克风（与录制条同款 dshow 枚举，
 // CameraDevices.ListAudioDevices），ffmpeg 编 pcm_s16le 48kHz 单声道 WAV。
 // 录好的每一遍是一条 Role="旁白" 的混音通道，Start 记录制时的播放头位置，
 // 导出时按 Start 对齐（adelay），不循环；试听 = 在混音台里独奏该遍。
 static class Voiceover {
  public static List<string> ListMicrophones() { return CameraDevices.ListAudioDevices(); }
  public static string TakePathFor(string projectPath, EditDocument doc, int takeIndex) {
   string dir = !string.IsNullOrEmpty(projectPath) ? Path.GetDirectoryName(Path.GetFullPath(projectPath)) : Path.GetTempPath();
   string path = Path.Combine(dir, doc.Name + "-配音" + takeIndex + ".wav");
   int n = takeIndex;
   while (File.Exists(path)) { n++; path = Path.Combine(dir, doc.Name + "-配音" + n + ".wav"); }
   return path;
  }
  public static Process StartRecording(string microphone, string output) {
   if (string.IsNullOrEmpty(microphone)) throw new Exception("没有选择麦克风。");
   return Media.Start("ffmpeg", "-hide_banner -y -f dshow -i " + Media.Q("audio=" + microphone) + " -c:a pcm_s16le -ar 48000 -ac 1 " + Media.Q(output), false);
  }
  public static void StopRecording(Process p) {
   if (p == null) return;
   try {
    if (!p.HasExited) { try { p.StandardInput.WriteLine("q"); p.StandardInput.Flush(); } catch { } if (!p.WaitForExit(5000)) p.Kill(); }
   } catch { try { p.Kill(); } catch { } }
  }
 }

 // 代理与缓存的磁盘管理（纯信息 + 格式化；生成/清理复用 ProxyTools 与
 // W4 的 RenderCache）。注意：多机位角度的代理文件不在此列——角度代理
 // 目前不参与预览与导出（Filter/EffectiveSource 只用主源），生成了也没用。
 static class ProxyDisk {
  public static string FormatSize(long bytes) {
   if (bytes < 1024) return bytes + " B";
   if (bytes < 1048576) return (bytes / 1024.0).ToString("0.0", CultureInfo.InvariantCulture) + " KB";
   return (bytes / 1048576.0).ToString("0.0", CultureInfo.InvariantCulture) + " MB";
  }
  public static long ProxyBytes(EditDocument doc) {
   try { if (!string.IsNullOrEmpty(doc.ProxyPath) && File.Exists(doc.ProxyPath)) return new FileInfo(doc.ProxyPath).Length; } catch { }
   return 0;
  }
  public static string UsageLine(string projectPath, EditDocument doc) {
   string cacheDir = RenderCache.CacheDirFor(projectPath, doc);
   int count = RenderCache.CacheFileCount(cacheDir);
   long cacheBytes = RenderCache.CacheTotalBytes(cacheDir);
   long proxyBytes = ProxyBytes(doc);
   return "代理：" + (proxyBytes > 0 ? FormatSize(proxyBytes) : "未生成") + " · 渲染缓存：" + count + " 个文件 · " + FormatSize(cacheBytes) + " · 合计 " + FormatSize(proxyBytes + cacheBytes);
  }
 }

 // 360° 基础：等距柱状（equirectangular）素材导入识别 + 导出时注入
 // Spherical Video V2 球面元数据（sv3d box）。全景漫游交互不做。
 public enum SphericalKind { None, Likely, Definite }
 public class SphericalDetect { public SphericalKind Kind; public string Reason = ""; }
 static class Spherical {
  // ffprobe 侧数据：side_data_list 里 side_data_type == "Spherical Mapping"
  // 且 projection == "equirectangular" 就是已带球面元数据的 360° 素材。
  // 没有元数据时，画面恰好 2:1 只算“疑似”，需用户确认（普通 2:1 宽幅
  // 视频也会误判）。
  public static SphericalDetect Detect(string path) {
   var result = new SphericalDetect { Kind = SphericalKind.None };
   try {
    using (var p = Media.Start("ffprobe", "-v error -show_entries stream=codec_type,width,height:stream_side_data -of json " + Media.Q(path), true)) {
     var err = p.StandardError.ReadToEndAsync(); string text = p.StandardOutput.ReadToEnd(); p.WaitForExit();
     if (p.ExitCode != 0) { result.Reason = "ffprobe 读不到这个文件。"; return result; }
     var json = EditDocument.Serializer().Deserialize<Dictionary<string, object>>(text);
     var streams = (System.Collections.ArrayList)json["streams"];
     foreach (Dictionary<string, object> s in streams) {
      if ((string)s["codec_type"] != "video") continue;
      int w = Convert.ToInt32(s["width"]), h = Convert.ToInt32(s["height"]);
      object side;
      if (s.TryGetValue("side_data_list", out side) && side is System.Collections.ArrayList) {
       foreach (Dictionary<string, object> d in (System.Collections.ArrayList)side) {
        object t, proj;
        if (d.TryGetValue("side_data_type", out t) && (string)t == "Spherical Mapping" && d.TryGetValue("projection", out proj) && (string)proj == "equirectangular") {
         result.Kind = SphericalKind.Definite; result.Reason = "已带 Spherical Video V2 球面元数据（equirectangular）。"; return result;
        }
       }
      }
      if (h > 0 && Math.Abs((double)w / h - 2.0) < 0.01) { result.Kind = SphericalKind.Likely; result.Reason = "画面 " + w + "×" + h + " 正好是 2:1，可能是等距柱状素材，但文件里没有球面元数据。"; return result; }
      result.Reason = "画面 " + w + "×" + h + "，不是 2:1，也没有球面元数据。"; return result;
     }
     result.Reason = "文件里没有视频轨道。"; return result;
    }
   } catch (Exception ex) { result.Reason = "识别失败：" + ex.Message; return result; }
  }
  static byte[] Box(string type, byte[] payload) {
   var b = new byte[8 + payload.Length];
   b[0] = (byte)((8 + payload.Length) >> 24); b[1] = (byte)((8 + payload.Length) >> 16); b[2] = (byte)((8 + payload.Length) >> 8); b[3] = (byte)(8 + payload.Length);
   Encoding.ASCII.GetBytes(type, 0, 4, b, 4);
   Array.Copy(payload, 0, b, 8, payload.Length);
   return b;
  }
  static byte[] Be32(uint v) { return new[] { (byte)(v >> 24), (byte)(v >> 16), (byte)(v >> 8), (byte)v }; }
  // sv3d box（106 字节，本地已验证：ffprobe 认出 Spherical Mapping）：
  // svhd（版本/标志 + 来源字符串）+ proj（prhd 偏航/俯仰/翻滚全 0 +
  // equi 全幅 bounds 全 0——ffprobe 的 mov.c 要求 b < UINT_MAX - t，
  // 0xFFFFFFFF 会报错“Invalid bounding rectangle”）。
  public static byte[] BuildSv3d() {
   var svhdPayload = new List<byte> { 0, 0, 0, 0 };
   svhdPayload.AddRange(Encoding.UTF8.GetBytes("CatCut Spherical Video V2"));
   svhdPayload.Add(0);
   byte[] svhd = Box("svhd", svhdPayload.ToArray());
   var prhdPayload = new List<byte> { 0, 0, 0, 0 };
   prhdPayload.AddRange(Be32(0)); prhdPayload.AddRange(Be32(0)); prhdPayload.AddRange(Be32(0));
   byte[] prhd = Box("prhd", prhdPayload.ToArray());
   var equiPayload = new List<byte> { 0, 0, 0, 0 };
   equiPayload.AddRange(Be32(0)); equiPayload.AddRange(Be32(0)); equiPayload.AddRange(Be32(0)); equiPayload.AddRange(Be32(0));
   byte[] equi = Box("equi", equiPayload.ToArray());
   var projPayload = new List<byte>();
   projPayload.AddRange(prhd); projPayload.AddRange(equi);
   byte[] proj = Box("proj", projPayload.ToArray());
   var sv3dPayload = new List<byte>();
   sv3dPayload.AddRange(svhd); sv3dPayload.AddRange(proj);
   return Box("sv3d", sv3dPayload.ToArray());
  }
  static int FindChild(byte[] data, int start, int end, string type) {
   int p = start;
   while (p + 8 <= end) {
    uint size = (uint)((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]);
    if (size < 8) return -1;
    if (Encoding.ASCII.GetString(data, p + 4, 4) == type) return p;
    p += (int)size;
   }
   return -1;
  }
  static void BumpSize(List<byte> data, int boxStart, int delta) {
   uint size = (uint)((data[boxStart] << 24) | (data[boxStart + 1] << 16) | (data[boxStart + 2] << 8) | data[boxStart + 3]);
   uint next = size + (uint)delta;
   data[boxStart] = (byte)(next >> 24); data[boxStart + 1] = (byte)(next >> 16); data[boxStart + 2] = (byte)(next >> 8); data[boxStart + 3] = (byte)next;
  }
  static uint ReadSize(byte[] data, int p) { return (uint)((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]); }
  // 把 sv3d 插到第一个视频 sample entry（avc1 等）的末尾，沿路把
  // stsd/stbl/minf/mdia/trak/moov 的 size 都加上。只处理 32 位 size 的
  // 常规 MP4（size==1 的 64 位 box 或 size==0 的文件直接报错，不硬写，
  // 免得把成片写坏）。先写临时文件、ffprobe 验过是 Definite 再替换原文件。
  public static void Inject(string path) {
   // 已带球面元数据时不再重复注入（避免 sv3d box 越堆越多）。
   if (Detect(path).Kind == SphericalKind.Definite) return;
   byte[] raw = File.ReadAllBytes(path);
   int moov = -1, p = 0;
   while (p + 8 <= raw.Length) {
    uint size = ReadSize(raw, p);
    if (size < 8) throw new Exception("360° 元数据注入失败：MP4 顶层 box 损坏。");
    if (Encoding.ASCII.GetString(raw, p + 4, 4) == "moov") { moov = p; break; }
    p += (int)size;
   }
   if (moov < 0) throw new Exception("360° 元数据注入失败：找不到 moov。");
   int moovEnd = moov + (int)ReadSize(raw, moov);
   int trak = FindChild(raw, moov + 8, moovEnd, "trak");
   if (trak < 0) throw new Exception("360° 元数据注入失败：找不到视频轨。");
   int trakEnd = trak + (int)ReadSize(raw, trak);
   int mdia = FindChild(raw, trak + 8, trakEnd, "mdia");
   int minf = mdia < 0 ? -1 : FindChild(raw, mdia + 8, mdia + (int)ReadSize(raw, mdia), "minf");
   int stbl = minf < 0 ? -1 : FindChild(raw, minf + 8, minf + (int)ReadSize(raw, minf), "stbl");
   int stsd = stbl < 0 ? -1 : FindChild(raw, stbl + 8, stbl + (int)ReadSize(raw, stbl), "stsd");
   if (stsd < 0) throw new Exception("360° 元数据注入失败：找不到 stsd。");
   int stsdEnd = stsd + (int)ReadSize(raw, stsd);
   int entry = stsd + 16;
   if (entry + 8 > stsdEnd) throw new Exception("360° 元数据注入失败：stsd 里没有 sample entry。");
   uint entrySize = ReadSize(raw, entry);
   if (entrySize < 8) throw new Exception("360° 元数据注入失败：sample entry 损坏。");
   byte[] sv3d = BuildSv3d();
   var data = new List<byte>(raw);
   data.InsertRange(entry + (int)entrySize, sv3d);
   BumpSize(data, entry, sv3d.Length);
   BumpSize(data, stsd, sv3d.Length);
   BumpSize(data, stbl, sv3d.Length);
   BumpSize(data, minf, sv3d.Length);
   BumpSize(data, mdia, sv3d.Length);
   BumpSize(data, trak, sv3d.Length);
   BumpSize(data, moov, sv3d.Length);
   string tmp = path + ".sv3d-tmp";
   File.WriteAllBytes(tmp, data.ToArray());
   try {
    var check = Detect(tmp);
    if (check.Kind != SphericalKind.Definite) throw new Exception("360° 元数据注入后校验失败：" + check.Reason);
    File.Replace(tmp, path, null);
   } catch { try { File.Delete(tmp); } catch { } throw; }
  }
 }
}
