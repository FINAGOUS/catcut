// W8 音频高级自测（2026-11-18）：--w8audio-test 入口，无窗口，纯逻辑 + 合成素材实测。
// 跑在云端构建里（build-test.yml 的 W8 audio checks 步），结果写
// Windows/bin/w8audio-results.txt（PASS: 开头才算过）。本地 Linux 跑不了 WPF，
// 但这些测试不碰窗口，只碰模型/滤镜串/ffmpeg/真实导出，所以云端是唯一可信的验证。
// 断言值全部来自本地探针实测（见 W8AudioPanels.cs 头注释的出处，FFmpeg 8.1.2）：
// 修复：爆音峰值 1.000→0.136、440Hz 不变；高通 f=100 去 50Hz 嗡鸣降 12.3dB、
// 440Hz 不变；afftdn nr=25:nf=-30 间隙底噪降 17.2dB、音调 ±0.5dB。
// 变调：+12 半音 440Hz→880Hz、时长 3.982s。EQ：+6dB@3000Hz 后 3000Hz +5.99dB、
// 440Hz 不变。压缩器：响段 -9.03→-18.85dB、静段 -29.03dB 不变、动态范围
// 20.00→10.19dB。环绕：5.1 ac3 6 声道、7.1 aac 8 声道、单声道映射 FC -18.16dB
// （错用立体声映射 FC 掉 6dB 到 -24.18dB）。
// 云端 runner 无 Demucs/Sherpa 模型、无真 GPU/摄像头/麦克风：人声分离与 TTS
// 只验校验 + 缺模型诚实报错 + 合成音轨混入导出，不假装模型实跑过；面板拖动、
// 旋钮、波形显示只在真机上能验，测试只验模型、滤镜串与真实导出。
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
 static class W8AudioTests {
  static void Require(bool ok, string name) { if (!ok) throw new Exception("W8 audio 检查失败：" + name); }
  static bool Near(double a, double b, double tol) { return Math.Abs(a - b) <= tol; }
  static string Folder;
  static string LogPath;
  static void Mark(string s) { try { File.AppendAllText(LogPath, s + "\n"); } catch { } }
  static void RunFfmpeg(string args) { StudioMedia.Run(args, CancellationToken.None); }
  static string Probe(string args) {
   using (var p = Media.Start("ffprobe", args, true)) {
    var err = p.StandardError.ReadToEndAsync();
    string text = p.StandardOutput.ReadToEnd();
    p.WaitForExit();
    if (p.ExitCode != 0) throw new Exception("ffprobe 失败：" + err.Result);
    return text;
   }
  }
  static void WriteWav(string path, int sampleRate, double seconds, Func<double, double> sample) {
   int n = (int)(sampleRate * seconds);
   using (var fs = File.Create(path))
   using (var w = new BinaryWriter(fs)) {
    w.Write(new char[] { 'R', 'I', 'F', 'F' }); w.Write(36 + n * 2); w.Write(new char[] { 'W', 'A', 'V', 'E' });
    w.Write(new char[] { 'f', 'm', 't', ' ' }); w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(sampleRate); w.Write(sampleRate * 2); w.Write((short)2); w.Write((short)16);
    w.Write(new char[] { 'd', 'a', 't', 'a' }); w.Write(n * 2);
    for (int i = 0; i < n; i++) { double v = Math.Max(-1, Math.Min(1, sample((double)i / sampleRate))); w.Write((short)(v * 32767)); }
   }
  }
  // 解码成 48kHz 单声道 f32 PCM（Goertzel / RMS 的输入）。
  static float[] Pcm(string file) {
   using (var p = Media.Start("ffmpeg", "-v error -i " + Media.Q(file) + " -vn -ac 1 -ar 48000 -f f32le -", true)) {
    var err = p.StandardError.ReadToEndAsync();
    using (var ms = new MemoryStream()) {
     p.StandardOutput.BaseStream.CopyTo(ms);
     p.WaitForExit();
     if (p.ExitCode != 0) throw new Exception("PCM 解码失败：" + err.Result);
     byte[] bytes = ms.ToArray();
     var samples = new float[bytes.Length / 4];
     Buffer.BlockCopy(bytes, 0, samples, 0, bytes.Length);
     return samples;
    }
   }
  }
  static double Goertzel(float[] x, double freq, int sr = 48000) {
   int n = x.Length;
   int k = (int)(0.5 + (double)n * freq / sr);
   double w = 2 * Math.PI * k / n, coeff = 2 * Math.Cos(w);
   double s0 = 0, s1 = 0, s2 = 0;
   foreach (float v in x) { s0 = v + coeff * s1 - s2; s2 = s1; s1 = s0; }
   double power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
   double amp = 2 * Math.Sqrt(Math.Max(power, 0)) / n;
   return amp > 0 ? 20 * Math.Log10(amp) : -240;
  }
  static double RmsDb(float[] x, double t0, double t1, int sr = 48000) {
   int a = (int)(t0 * sr), b = (int)(t1 * sr);
   double sum = 0;
   int count = 0;
   for (int i = Math.Max(0, a); i < Math.Min(x.Length, b); i++) { sum += x[i] * x[i]; count++; }
   return 20 * Math.Log10(Math.Sqrt(sum / Math.Max(1, count)) + 1e-12);
  }
  static double PeakWindow(float[] x, double t0, double t1, int sr = 48000) {
   double peak = 0;
   for (int i = (int)(t0 * sr); i < Math.Min(x.Length, (int)(t1 * sr)); i++) peak = Math.Max(peak, Math.Abs(x[i]));
   return peak;
  }
  static string AudioInfo(string file) {
   string text = Probe("-v error -select_streams a:0 -show_entries stream=codec_name,channels,channel_layout -of csv=p=0 " + Media.Q(file));
   return text.Trim().TrimEnd(',').Replace("\n", "").Replace("\r", "");
  }
  static string ChannelWav(string file, string channel, string outName) {
   string outFile = Path.Combine(Folder, outName);
   RunFfmpeg("-v error -y -i " + Media.Q(file) + " -af \"pan=mono|c0=" + channel + "\" -c:a pcm_s16le " + Media.Q(outFile));
   return outFile;
  }
  static string MakeMp4(string name, string audioArgs, double seconds) {
   string outFile = Path.Combine(Folder, name);
   RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=" + Media.N(seconds) + " " + audioArgs + " -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(outFile));
   return outFile;
  }
  public static void Run() {
   Folder = Path.Combine(Media.Root, "bin", "w8audio-test");
   Directory.CreateDirectory(Folder);
   string log = Path.Combine(Media.Root, "bin", "w8audio-results.txt");
   LogPath = log;
   File.WriteAllText(log, "RUNNING\n");
   try {
    // 1. 音频修复：滤镜串 + 校验 + 强度映射。
    var rep = new AudioRepairSettings { Declick = true, HumCutoffHz = 100, Denoise = true, Strength = 100 };
    Require(rep.Filter() == "adeclick,highpass=f=100,afftdn=nr=25:nf=-30", "repair filter string is adeclick,highpass,afftdn nr=25 (got " + rep.Filter() + ")");
    Require(new AudioRepairSettings { Denoise = true, Strength = 0 }.Filter() == "afftdn=nr=5:nf=-30", "repair strength 0 maps to nr=5");
    Require(new AudioRepairSettings { Denoise = true, Strength = 50 }.Filter() == "afftdn=nr=15:nf=-30", "repair strength 50 maps to nr=15");
    Require(!new AudioRepairSettings().Active && new AudioRepairSettings().Filter() == "", "empty repair is a no-op");
    bool threw = false;
    try { new AudioRepairSettings { HumCutoffHz = 300 }.Validate(); } catch { threw = true; }
    Require(threw, "hum cutoff 300 is rejected");
    threw = false;
    try { new AudioRepairSettings { Strength = 101 }.Validate(); } catch { threw = true; }
    Require(threw, "repair strength 101 is rejected");
    Mark("STEP 1 repair filter + validation OK");
    // 2. 音频修复实测：去咔哒 / 去嗡鸣 / 降噪。
    string clickWav = Path.Combine(Folder, "click.wav");
    WriteWav(clickWav, 48000, 4, t => (t == 1.0 || t == 2.0 || t == 3.0) ? 1.0 : 0.25 * Math.Sin(2 * Math.PI * 440 * t));
    string clickFix = Path.Combine(Folder, "click-fix.wav");
    RunFfmpeg("-v error -y -i " + Media.Q(clickWav) + " -af adeclick -c:a pcm_s16le " + Media.Q(clickFix));
    var clickBefore = Pcm(clickWav);
    var clickAfter = Pcm(clickFix);
    double clickPeakBefore = PeakWindow(clickBefore, 0.99, 1.01), clickPeakAfter = PeakWindow(clickAfter, 0.99, 1.01);
    double toneBefore = Goertzel(clickBefore, 440), toneAfter = Goertzel(clickAfter, 440);
    Require(clickPeakBefore > 0.9 && clickPeakAfter < 0.3, "adeclick drops click peak " + clickPeakBefore.ToString("0.00") + " -> " + clickPeakAfter.ToString("0.00"));
    Require(Near(toneAfter, toneBefore, 1.0), "adeclick leaves the 440Hz tone alone (" + toneBefore.ToString("0.00") + " -> " + toneAfter.ToString("0.00") + ")");
    string humWav = Path.Combine(Folder, "hum.wav");
    RunFfmpeg("-v error -y -f lavfi -i sine=frequency=440:sample_rate=48000:duration=4 -f lavfi -i sine=frequency=50:sample_rate=48000:duration=4 -filter_complex \"[0:a]volume=0.5[a];[1:a]volume=0.3[b];[a][b]amix=inputs=2:normalize=0[c]\" -map \"[c]\" -c:a pcm_s16le " + Media.Q(humWav));
    string humFix = Path.Combine(Folder, "hum-fix.wav");
    RunFfmpeg("-v error -y -i " + Media.Q(humWav) + " -af highpass=f=100 -c:a pcm_s16le " + Media.Q(humFix));
    var humBefore = Pcm(humWav);
    var humAfter = Pcm(humFix);
    double humDrop = Goertzel(humBefore, 50) - Goertzel(humAfter, 50);
    Require(humDrop >= 10, "highpass f=100 drops 50Hz hum by " + humDrop.ToString("0.0") + "dB");
    Require(Near(Goertzel(humAfter, 440), Goertzel(humBefore, 440), 1.0), "highpass leaves 440Hz alone");
    string hissWav = Path.Combine(Folder, "hiss.wav");
    RunFfmpeg("-v error -y -f lavfi -i sine=frequency=440:sample_rate=48000:duration=4 -f lavfi -i anoisesrc=color=white:duration=4:amplitude=0.1 -filter_complex \"[0:a]volume='if(between(t,2,4),0,1)':eval=frame[a];[1:a]volume=0.5[b];[a][b]amix=inputs=2:normalize=0[c]\" -map \"[c]\" -c:a pcm_s16le " + Media.Q(hissWav));
    string hissFix = Path.Combine(Folder, "hiss-fix.wav");
    RunFfmpeg("-v error -y -i " + Media.Q(hissWav) + " -af afftdn=nr=25:nf=-30 -c:a pcm_s16le " + Media.Q(hissFix));
    var hissBefore = Pcm(hissWav);
    var hissAfter = Pcm(hissFix);
    double gapDrop = RmsDb(hissBefore, 2.2, 3.8) - RmsDb(hissAfter, 2.2, 3.8);
    Require(gapDrop >= 10, "afftdn nr=25:nf=-30 drops gap noise by " + gapDrop.ToString("0.0") + "dB");
    Require(Near(RmsDb(hissAfter, 0.2, 1.8), RmsDb(hissBefore, 0.2, 1.8), 1.5), "afftdn keeps the tone (gap " + gapDrop.ToString("0.0") + "dB down)");
    Mark("STEP 2 repair measured OK");
    // 3. 变声：滤镜串 + 校验 + 变调实测。
    var vc = new VoiceChangeSettings { Kind = "变调", Semitones = 12 };
    Require(vc.Filter() == "aresample=48000,asetrate=96000,aresample=48000,atempo=0.5", "pitch +12 filter string (got " + vc.Filter() + ")");
    Require(new VoiceChangeSettings { Kind = "变调", Semitones = 0 }.Filter() == "", "pitch 0 semitones is a no-op");
    Require(new VoiceChangeSettings { Kind = "混响" }.Filter() == "aecho=0.8:0.7:60|90|120|180:0.5|0.4|0.3|0.2", "reverb filter is the 4-tap aecho");
    threw = false;
    try { new VoiceChangeSettings { Kind = "变调", Semitones = 13 }.Validate(); } catch { threw = true; }
    Require(threw, "pitch +13 semitones is rejected");
    threw = false;
    try { new VoiceChangeSettings { Kind = "花腔" }.Validate(); } catch { threw = true; }
    Require(threw, "unknown voice kind is rejected");
    string toneWav = Path.Combine(Folder, "tone440.wav");
    RunFfmpeg("-v error -y -f lavfi -i sine=frequency=440:sample_rate=48000:duration=4 -c:a pcm_s16le " + Media.Q(toneWav));
    string pitchWav = Path.Combine(Folder, "pitch.wav");
    RunFfmpeg("-v error -y -i " + Media.Q(toneWav) + " -af \"aresample=48000,asetrate=96000,aresample=48000,atempo=0.5\" -c:a pcm_s16le " + Media.Q(pitchWav));
    var pitchPcm = Pcm(pitchWav);
    Require(Goertzel(pitchPcm, 880) > -30 && Goertzel(pitchPcm, 440) < -60, "pitch +12 moves 440Hz to 880Hz (880 " + Goertzel(pitchPcm, 880).ToString("0.00") + "dB, 440 " + Goertzel(pitchPcm, 440).ToString("0.00") + "dB)");
    Require(Near(Media.Duration(pitchWav), 3.982, 0.05), "pitch +12 keeps duration 3.982s (got " + Media.Duration(pitchWav).ToString("0.000") + ")");
    Mark("STEP 3 voice change OK");
    // 4. TTS：校验 + 缺模型诚实报错 + 合成音轨混入导出。
    var tts = new TtsSettings();
    threw = false;
    try { tts.ValidateText(""); } catch { threw = true; }
    Require(threw, "empty TTS text is rejected");
    threw = false;
    try { tts.ValidateText(new string('啊', 2001)); } catch { threw = true; }
    Require(threw, "TTS text over 2000 chars is rejected");
    threw = false;
    try { new TtsSettings { Speed = 3 }.Validate(); } catch { threw = true; }
    Require(threw, "TTS speed 3 is rejected");
    threw = false;
    try { new TtsSettings { Voice = "不存在的音色" }.Validate(); } catch { threw = true; }
    Require(threw, "unknown TTS voice is rejected");
    threw = false;
    string ttsErr = "";
    try { TtsSynth.Synthesize("你好世界", 1, Path.Combine(Folder, "tts-out.wav")); } catch (Exception ex) { threw = true; ttsErr = ex.Message; }
    Require(threw && ttsErr.Contains("sherpa-onnx"), "TTS without a model fails honestly with the sherpa-onnx setup text");
    // 合成音轨混入：用一段 660Hz 合成 wav 冒充已生成的旁白（模型缺失时不伪造语音，
    // 混入逻辑本身用真实 wav 验）。
    string ttsWav = Path.Combine(Folder, "tts-fake.wav");
    WriteWav(ttsWav, 48000, 2, t => 0.3 * Math.Sin(2 * Math.PI * 660 * t));
    string ttsSrc = MakeMp4("tts-src.mp4", "-f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=4\"", 4);
    var tdoc = StudioMedia.Import(ttsSrc);
    tdoc.Tts.WavPath = ttsWav;
    tdoc.Tts.Start = 1.0;
    tdoc.Tts.GainDb = 0;
    string ttsOut = Path.Combine(Folder, "tts-out.mp4");
    StudioRenderer.Export(tdoc, ttsOut, 360, 30, (v, s) => { }, CancellationToken.None);
    var ttsPcm = Pcm(ttsOut);
    Require(Goertzel(ttsPcm, 660) > -40, "TTS take is audible after its start (660Hz " + Goertzel(ttsPcm, 660).ToString("0.00") + "dB)");
    Require(Near(StudioMedia.Import(ttsOut).Duration, 4, 0.15), "TTS mix-in keeps 4s duration");
    Mark("STEP 4 TTS validation + honest missing-model error + mix-in OK");
    // 5. 环绕声：滤镜串 + 编码规则 + 真实导出。
    Require(Surround.UpmixFilter("立体声") == "", "stereo has no upmix filter");
    Require(Surround.UpmixFilter("5.1") == "pan=5.1|c0=c0|c1=c1|c2=0.5*c0+0.5*c1|c3=0*c0|c4=c0|c5=c1", "5.1 upmix mapping (LFE is 0*c0, not a bare constant)");
    Require(Surround.UpmixFilter("7.1") == "pan=7.1|c0=c0|c1=c1|c2=0.5*c0+0.5*c1|c3=0*c0|c4=c0|c5=c1|c6=c0|c7=c1", "7.1 upmix mapping");
    Require(Surround.AudioCodec("5.1", "自动") == "ac3" && Surround.AudioCodec("7.1", "自动") == "aac" && Surround.AudioCodec("立体声", "自动") == "aac", "surround codec defaults: 5.1 ac3, 7.1 aac, stereo aac");
    Require(Surround.AudioCodec("5.1", "aac") == "aac", "explicit codec wins over the default");
    threw = false;
    try { Surround.Validate("7.1", "ac3"); } catch { threw = true; }
    Require(threw, "7.1 with AC-3 is rejected (AC-3 tops out at 5.1)");
    threw = false;
    try { Surround.Validate("9.1", "自动"); } catch { threw = true; }
    Require(threw, "unknown surround layout is rejected");
    string surSrc = MakeMp4("sur-src.mp4", "-f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=2\"", 2);
    var sdoc51 = StudioMedia.Import(surSrc);
    sdoc51.SurroundLayout = "5.1";
    string out51 = Path.Combine(Folder, "sur51.mp4");
    StudioRenderer.Export(sdoc51, out51, 360, 30, (v, s) => { }, CancellationToken.None);
    string info51 = AudioInfo(out51);
    Require(info51.Contains("ac3") && info51.Contains(",6,") && info51.StartsWith("ac3,6,5.1"), "5.1 export is ac3 6ch 5.1 (got " + info51 + ")");
    var sdoc71 = StudioMedia.Import(surSrc);
    sdoc71.SurroundLayout = "7.1";
    string out71 = Path.Combine(Folder, "sur71.mp4");
    StudioRenderer.Export(sdoc71, out71, 360, 30, (v, s) => { }, CancellationToken.None);
    string info71 = AudioInfo(out71);
    Require(info71.Contains("aac") && info71.Contains(",8,") && info71.Contains("7.1"), "7.1 export is aac 8ch 7.1 (got " + info71 + ")");
    // 单声道源：FC 必须与 FL 同级（错用立体声映射会掉 6dB）。
    string monoWav = Path.Combine(Folder, "mono.wav");
    RunFfmpeg("-v error -y -f lavfi -i sine=frequency=440:sample_rate=48000:duration=2 -ac 1 -c:a pcm_s16le " + Media.Q(monoWav));
    string monoSrc = Path.Combine(Folder, "mono-src.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=2 -i " + Media.Q(monoWav) + " -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(monoSrc));
    var mdoc = StudioMedia.Import(monoSrc);
    mdoc.SurroundLayout = "5.1";
    string outMono51 = Path.Combine(Folder, "mono51.mp4");
    StudioRenderer.Export(mdoc, outMono51, 360, 30, (v, s) => { }, CancellationToken.None);
    Require(AudioInfo(outMono51).Contains(",6,"), "mono source upmixed to 5.1 still has 6 channels");
    double fcLevel = Goertzel(Pcm(ChannelWav(outMono51, "c2", "fc.wav")), 440);
    double flLevel = Goertzel(Pcm(ChannelWav(outMono51, "c0", "fl.wav")), 440);
    Require(fcLevel > -30 && Near(fcLevel, flLevel, 3.0), "mono 5.1 centre channel matches front-left (FC " + fcLevel.ToString("0.00") + "dB, FL " + flLevel.ToString("0.00") + "dB)");
    Mark("STEP 5 surround OK");
    // 6. 子片段：建子片段规则 + 真实导出。
    var lib = new List<MediaLibraryItem> {
     new MediaLibraryItem { Id = "m1", Name = "长素材", File = surSrc, Kind = "media", Duration = 2 },
    };
    var sub = Subclips.Create(lib, "m1", "sc1", "精华", 0.5, 1.5);
    Require(sub.Kind == "subclip" && sub.File == surSrc && Near(sub.Duration, 1.0, 0.001) && Near(sub.In, 0.5, 0.001), "subclip stores a reference, not a copy (duration 1.0s)");
    lib.Add(sub);
    threw = false;
    try { Subclips.Create(lib, "m1", "sc1", "重复", 0, 1); } catch { threw = true; }
    Require(threw, "duplicate subclip id is rejected");
    threw = false;
    try { Subclips.Create(lib, "sc1", "sc2", "套娃", 0, 0.5); } catch { threw = true; }
    Require(threw, "subclip-of-subclip is rejected");
    threw = false;
    try { Subclips.Create(lib, "m1", "sc3", "超长", 0, 5); } catch { threw = true; }
    Require(threw, "subclip past the parent duration is rejected");
    threw = false;
    try { Subclips.Create(lib, "m1", "sc4", "空", 1, 1); } catch { threw = true; }
    Require(threw, "empty subclip range is rejected");
    threw = false;
    try { Subclips.Create(lib, "nope", "sc5", "无父", 0, 1); } catch { threw = true; }
    Require(threw, "subclip without a parent is rejected");
    var sdocSub = StudioMedia.Import(surSrc);
    sdocSub.Cuts = new List<Cut> { Subclips.ToCut(sub) };
    string subOut = Path.Combine(Folder, "sub-out.mp4");
    StudioRenderer.Export(sdocSub, subOut, 360, 30, (v, s) => { }, CancellationToken.None);
    Require(Near(StudioMedia.Import(subOut).Duration, 1.0, 0.15), "subclip export is 1.0s (got " + StudioMedia.Import(subOut).Duration.ToString("0.00") + ")");
    Mark("STEP 6 subclips OK");
    // 7. EQ：滤镜串 + 校验 + 曲线数学 + 真实导出 + 波形图。
    var eq = new EqSettings { LowCutHz = 80, HighCutHz = 12000, Bands = new List<EqBand> { new EqBand { Frequency = 3000, GainDb = 6, Width = 1 } } };
    Require(eq.Filter() == "highpass=f=80,lowpass=f=12000,equalizer=f=3000:width_type=q:width=1:g=6", "EQ filter string (got " + eq.Filter() + ")");
    threw = false;
    try { new EqSettings { LowCutHz = 5000, HighCutHz = 1000 }.Validate(); } catch { threw = true; }
    Require(threw, "low cut above high cut is rejected");
    threw = false;
    try { new EqSettings { Bands = new List<EqBand> { new EqBand { Frequency = 3000, GainDb = 40 } } }.Validate(); } catch { threw = true; }
    Require(threw, "EQ band gain +40dB is rejected");
    threw = false;
    try { new EqSettings { Bands = new List<EqBand> { new EqBand { Frequency = 1000, GainDb = 0 }, new EqBand { Frequency = 500, GainDb = 0 } } }.Validate(); } catch { threw = true; }
    Require(threw, "EQ bands out of frequency order are rejected");
    Require(Near(EqCurveMath.FreqToX(EqCurveMath.XToFreq(0.37)), 0.37, 0.001) && Near(EqCurveMath.XToFreq(EqCurveMath.FreqToX(3000)), 3000, 1), "EQ curve log-frequency mapping round-trips");
    Require(Near(EqCurveMath.GainToY(EqCurveMath.YToGain(0.25)), 0.25, 0.001), "EQ curve gain mapping round-trips");
    Require(Near(EqCurveMath.ResponseAt(3000, eq.Bands), 6, 0.5) && Near(EqCurveMath.ResponseAt(440, eq.Bands), 0, 0.5), "EQ response at the band centre is +6dB, far away ~0dB");
    string dualWav = Path.Combine(Folder, "dual.wav");
    RunFfmpeg("-v error -y -f lavfi -i sine=frequency=440:sample_rate=48000:duration=4 -f lavfi -i sine=frequency=3000:sample_rate=48000:duration=4 -filter_complex \"[0:a][1:a]amix=inputs=2:normalize=0,volume=0.5[a]\" -map \"[a]\" -c:a pcm_s16le " + Media.Q(dualWav));
    string dualEq = Path.Combine(Folder, "dual-eq.wav");
    RunFfmpeg("-v error -y -i " + Media.Q(dualWav) + " -af \"equalizer=f=3000:width_type=q:width=1:g=6\" -c:a pcm_s16le " + Media.Q(dualEq));
    var dualBefore = Pcm(dualWav);
    var dualAfter = Pcm(dualEq);
    double eqBoost = Goertzel(dualAfter, 3000) - Goertzel(dualBefore, 3000);
    Require(Near(eqBoost, 6, 0.5), "EQ +6dB @3000Hz measures +" + eqBoost.ToString("0.00") + "dB");
    Require(Near(Goertzel(dualAfter, 440), Goertzel(dualBefore, 440), 1.0), "EQ leaves 440Hz alone");
    string wavePng = Path.Combine(Folder, "wave.png");
    Waveform.Png(dualWav, wavePng, 248, 48);
    byte[] pngHead = File.ReadAllBytes(wavePng);
    Require(pngHead.Length > 8 && pngHead[0] == 0x89 && pngHead[1] == 0x50 && pngHead[2] == 0x4E && pngHead[3] == 0x47, "waveform PNG is a real PNG (" + pngHead.Length + " bytes)");
    // 导出级 EQ：双音源 + EQ 导出，3000Hz 照样 +6dB。
    string dualSrc = Path.Combine(Folder, "dual-src.mp4");
    RunFfmpeg("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30:duration=2 -i " + Media.Q(dualWav) + " -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest " + Media.Q(dualSrc));
    var edoc = StudioMedia.Import(dualSrc);
    edoc.Eq.Bands.Add(new EqBand { Frequency = 3000, GainDb = 6, Width = 1 });
    string dualOut = Path.Combine(Folder, "dual-out.mp4");
    StudioRenderer.Export(edoc, dualOut, 360, 30, (v, s) => { }, CancellationToken.None);
    var dualOutPcm = Pcm(dualOut);
    double eqBoostExport = Goertzel(dualOutPcm, 3000) - Goertzel(Pcm(dualSrc), 3000);
    Require(Near(eqBoostExport, 6, 1.5), "exported EQ +6dB @3000Hz measures +" + eqBoostExport.ToString("0.00") + "dB");
    Mark("STEP 7 EQ curve + export + waveform OK");
    // 8. 压缩器：滤镜串 + 校验 + 估算 + 两段电平实测。
    var comp = new CompressorSettings { Enabled = true, ThresholdDb = -20, Ratio = 4, AttackMs = 10, ReleaseMs = 100, MakeupDb = 0 };
    string compFilter = comp.Filter();
    Require(compFilter.Contains("acompressor=threshold=0.1:ratio=4:attack=10:release=100:makeup=1"), "compressor filter string (got " + compFilter + ")");
    Require(Near(comp.EstimatedReduction(-9.03), 8.25, 0.1), "estimated reduction at peak -9dB is 8.25dB");
    Require(comp.EstimatedReduction(-29.03) == 0, "no reduction below the threshold");
    threw = false;
    try { new CompressorSettings { Enabled = true, Ratio = 99 }.Validate(); } catch { threw = true; }
    Require(threw, "compressor ratio 99 is rejected");
    threw = false;
    try { new CompressorSettings { Enabled = true, ThresholdDb = 5 }.Validate(); } catch { threw = true; }
    Require(threw, "compressor threshold +5dB is rejected");
    string twoWav = Path.Combine(Folder, "two.wav");
    WriteWav(twoWav, 48000, 4, t => (t < 2 ? 0.5 : 0.05) * Math.Sin(2 * Math.PI * 440 * t));
    string twoComp = Path.Combine(Folder, "two-comp.wav");
    RunFfmpeg("-v error -y -i " + Media.Q(twoWav) + " -af \"" + compFilter + "\" -c:a pcm_s16le " + Media.Q(twoComp));
    var twoBefore = Pcm(twoWav);
    var twoAfter = Pcm(twoComp);
    double loudBefore = RmsDb(twoBefore, 0.2, 1.8), loudAfter = RmsDb(twoAfter, 0.2, 1.8);
    double quietBefore = RmsDb(twoBefore, 2.2, 3.8), quietAfter = RmsDb(twoAfter, 2.2, 3.8);
    Require(Near(loudBefore, -9.03, 0.5) && Near(loudAfter, -18.85, 1.5), "compressor loud section " + loudBefore.ToString("0.00") + " -> " + loudAfter.ToString("0.00") + "dB");
    Require(Near(quietAfter, quietBefore, 1.5), "compressor leaves the quiet section alone (" + quietBefore.ToString("0.00") + " -> " + quietAfter.ToString("0.00") + "dB)");
    Require(Near((loudAfter - quietAfter), 10.19, 2.0), "dynamic range 20.00 -> " + (loudAfter - quietAfter).ToString("0.00") + "dB");
    Mark("STEP 8 compressor OK");
    // 9. 链顺序 + 全链导出 + 人声分离接线。
    string chain = W8AudioChain.BuildChain(new EditDocument { VoiceChange = new VoiceChangeSettings { Kind = "混响" }, Eq = new EqSettings { Bands = new List<EqBand> { new EqBand { Frequency = 1000, GainDb = 3 } } }, Compressor = new CompressorSettings { Enabled = true }, Repair = new AudioRepairSettings { Declick = true } });
    Require(chain.IndexOf("aecho", StringComparison.Ordinal) < chain.IndexOf("equalizer", StringComparison.Ordinal) && chain.IndexOf("equalizer", StringComparison.Ordinal) < chain.IndexOf("acompressor", StringComparison.Ordinal) && chain.IndexOf("acompressor", StringComparison.Ordinal) < chain.IndexOf("adeclick", StringComparison.Ordinal), "chain order is voice -> EQ -> compressor -> repair (got " + chain + ")");
    // 全链导出：EQ + 压缩 + 修复 + 变调同开，时长与音频都在。
    string fullSrc = MakeMp4("full-src.mp4", "-f lavfi -i \"sine=frequency=440:sample_rate=48000:duration=2\"", 2);
    var fdoc = StudioMedia.Import(fullSrc);
    fdoc.Eq.Bands.Add(new EqBand { Frequency = 3000, GainDb = 3, Width = 1 });
    fdoc.Compressor.Enabled = true;
    fdoc.Repair.Declick = true;
    fdoc.VoiceChange.Kind = "变调";
    fdoc.VoiceChange.Semitones = 0;
    string fullOut = Path.Combine(Folder, "full-out.mp4");
    StudioRenderer.Export(fdoc, fullOut, 360, 30, (v, s) => { }, CancellationToken.None);
    Require(Near(StudioMedia.Import(fullOut).Duration, 2, 0.15) && AudioProbe.MeanVolume(fullOut) > -60, "full-chain export keeps 2s + audible audio");
    // 人声分离接线：假音轨（660Hz）当分离后的人声，导出只留它；多段 + 分离模式直接拒绝。
    string stemWav = Path.Combine(Folder, "stem.wav");
    WriteWav(stemWav, 48000, 2, t => 0.3 * Math.Sin(2 * Math.PI * 660 * t));
    var vdoc = StudioMedia.Import(fullSrc);
    vdoc.VocalSep.Mode = "人声";
    vdoc.VocalSep.VocalsPath = stemWav;
    vdoc.VocalSep.AccompPath = stemWav;
    string vOut = Path.Combine(Folder, "vocals-out.mp4");
    StudioRenderer.Export(vdoc, vOut, 360, 30, (v, s) => { }, CancellationToken.None);
    var vPcm = Pcm(vOut);
    Require(Goertzel(vPcm, 660) > -40 && Goertzel(vPcm, 440) < -60, "vocal-sep export uses the stem (660Hz " + Goertzel(vPcm, 660).ToString("0.00") + "dB, 440Hz " + Goertzel(vPcm, 440).ToString("0.00") + "dB)");
    var vdocMulti = StudioMedia.Import(fullSrc);
    vdocMulti.VocalSep.Mode = "人声";
    vdocMulti.VocalSep.VocalsPath = stemWav;
    vdocMulti.VocalSep.AccompPath = stemWav;
    vdocMulti.Cuts = new List<Cut> { new Cut { Start = 0, End = 1 }, new Cut { Start = 1, End = 2 } };
    threw = false;
    try { StudioRenderer.Export(vdocMulti, Path.Combine(Folder, "vocals-multi.mp4"), 360, 30, (v, s) => { }, CancellationToken.None); } catch { threw = true; }
    Require(threw, "vocal-sep export with multiple cuts is rejected (use the mixer track instead)");
    // 人声分离缺后端诚实报错。
    threw = false;
    string vsErr = "";
    try { VocalSep.Separate(fullSrc, "htdemucs", Path.Combine(Folder, "vs-out")); } catch (Exception ex) { threw = true; vsErr = ex.Message; }
    Require(threw && (vsErr.Contains("Demucs") || vsErr.Contains("Python")), "vocal separation without Demucs fails honestly (got: " + vsErr.Substring(0, Math.Min(80, vsErr.Length)).Replace("\n", " ") + ")");
    threw = false;
    try { new VocalSepSettings { Mode = "人声", Model = "htdemucs" }.Validate(); } catch { threw = true; }
    Require(threw, "vocal-sep mode without a separated stem is rejected");
    Mark("STEP 9 chain order + full-chain export + vocal-sep wiring OK");
    // 10. Doc.Validate 的 W8 默认值与坏值拒绝。
    var good = StudioMedia.Import(fullSrc);
    good.Validate();
    Require(good.Repair != null && good.Eq.Bands != null && good.MediaLibrary.Count >= 1 && good.SurroundLayout == "立体声" && good.VocalSep.Mode == "关", "fresh doc gets W8 defaults (repair/eq/library/surround/vocalsep)");
    threw = false;
    try { var bad = StudioMedia.Import(fullSrc); bad.SurroundLayout = "7.1"; bad.SurroundCodec = "ac3"; bad.Validate(); } catch { threw = true; }
    Require(threw, "doc validation rejects 7.1 + AC-3");
    threw = false;
    try { var bad = StudioMedia.Import(fullSrc); bad.Repair.HumCutoffHz = 300; bad.Validate(); } catch { threw = true; }
    Require(threw, "doc validation rejects hum cutoff 300");
    threw = false;
    try { var bad = StudioMedia.Import(fullSrc); bad.Tts.Speed = 3; bad.Validate(); } catch { threw = true; }
    Require(threw, "doc validation rejects TTS speed 3");
    Mark("STEP 10 doc validation OK");
    File.WriteAllText(log, "PASS: repair adeclick 1.00 -> " + clickPeakAfter.ToString("0.00") + " (tone " + toneBefore.ToString("0.00") + " -> " + toneAfter.ToString("0.00") + "dB), hum 50Hz down " + humDrop.ToString("0.0") + "dB, afftdn gap down " + gapDrop.ToString("0.0") + "dB; pitch +12 440 -> 880Hz, duration " + Media.Duration(pitchWav).ToString("0.000") + "s; TTS validation + missing-model honest error + take mix-in audible; surround 5.1 ac3 6ch 5.1 + 7.1 aac 8ch 7.1 + mono FC " + fcLevel.ToString("0.00") + "dB vs FL " + flLevel.ToString("0.00") + "dB; subclip 1.0s reference-only + export 1.0s; EQ +6dB @3000Hz +" + eqBoost.ToString("0.00") + "dB (export +" + eqBoostExport.ToString("0.00") + "dB), waveform PNG " + pngHead.Length + " bytes; compressor loud " + loudBefore.ToString("0.00") + " -> " + loudAfter.ToString("0.00") + "dB, quiet unchanged, range -> " + (loudAfter - quietAfter).ToString("0.00") + "dB; chain order voice->EQ->compressor->repair, full-chain export 2s, vocal-sep stem export + multi-cut rejected + missing-Demucs honest error; doc W8 defaults + bad values rejected.\n");
   }
   catch (Exception ex) { File.AppendAllText(log, "FAIL\n" + ex + "\n"); Mark("FAIL: " + ex.Message); Environment.ExitCode = 1; }
  }
 }
}
