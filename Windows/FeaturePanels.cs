// W3 功能面板接线（2026-11-18）：时间线磁吸/波纹、字幕、调色、混音台、代理、
// 多机位、素材库内容接入的 C# 侧模型与纯逻辑。
//
// 桥接路线（已定，见 m2-build-log.md 的 W3 条目）：路线 (1) C# 原生实现，
// TS 引擎只作规格/参照，不走 project.json + node CLI。理由：便携包
// （Windows/package.ps1）只发 exe + xaml + ffmpeg/ffprobe + 字体，没有
// node、没有引擎文件；给用户包里塞 node 运行时 + TS 编译链是未经验证的
// 分发改动。C# 应用本来就直接 shell 出 ffmpeg 自拼滤镜串（EditorCore.cs
// 的 StudioMedia/StudioRenderer），所以这里照抄 TS 引擎已验证的滤镜串
// （同样的滤镜、同样的参数、同样的取值范围），1415 项 TS 测试是滤镜
// 正确性的证据——但注意：引擎验过 ≠ 产品里能用，本文件 + FeaturePanelsUI.cs
// 才是产品侧真正的接线，面板功能在真机上的实测仍待验。
//
// 与 TS 规格的对应关系（参数逐一照抄，出处写在各节注释里）：
// - 调色基础：filtergraph.ts 的 eq=brightness/contrast/saturation +
//   colorbalance=rs=t:bs=-t（P0）；白平衡增益、HSL 分区、色轮三区：
//   color.ts 的 applyAdvancedColorToRgb / buildColorLut（17^3 .cube，
//   经 lut3d 应用，解码帧上先 format=rgb24 再进 LUT）。
// - 字幕：subtitles.ts 的 SRT/VTT/ASS 时间码与解析、deliver.ts 的双字幕
//   ASS（Sub 底行 + Sub2 上行，Sub2 字号 -4、黄色、marginV = 主 + 字号 + 12）。
//   烧录不走 ffmpeg subtitles 滤镜——C# 导出是 GDI+ 逐帧渲染，字幕画在
//   DrawCore 里（预览与导出同一条路）；边车是真写文件。
// - 混音：roles.ts 的 roleFilter（aresample=48000 → volume=X dB → pan，
//   pan 增益 lg=min(1,1-p)、rg=min(1,1+p)，单声道用 pan 全电平复制，
//   不用 aformat——aformat 每声道亏 3 dB，TS 探针已证实）。
// - 代理：proxy.ts——720p 上限（scale='min(1280,iw)':-2）、libx264
//   veryfast、CRF 28、时长误差容限 0.1s；导出始终用原片（这就是 relink），
//   代理缺失时导出与预览明确报错、不静默回退。注意：这与 W3 任务书里
//   “代理开时导出走代理”一句有出入，取 TS 引擎规格为准——代理导出会把
//   成片质量降到 720p CRF 28，属产品回归；分歧已记入构建日志，待主会话定夺。
// - 多机位：multicam.ts——角度 0 就是主源、共 2–16 路（17 路拒绝）、
//   各角度时长与主源差 ≤0.05s、音频始终取角度 0、v1 不支持变速片段。
//   区别：TS 的切换点是片段内源时间，C# 这里是时间线时间（C# 的 Cut
//   本来就是时间线顺序的源范围，播放头处的切换按时间线时间记录更直观）。
// - 波纹/空隙：C# 的 Cut 本来就是首尾相接的源范围，删片段后后续自动
//   跟进就是波纹开的行为；波纹关时删除改为留一段同等时长的空隙片段
//   （黑场 + 静音），这才是波纹开关真正改变的东西。
//
// 限制（诚实写清）：自动识别字幕（P0b 转写）本批没接——需要 Whisper
// 可执行文件与模型，未随包分发，面板里只留导入/手动编辑；HSL 曲线
// 编辑器与 RGB/主曲线本批未接（LUT 烘焙器只含白平衡 + HSL 分区 +
// 色轮三区）；混音台没有电平表（要音频分析，未做）；美颜/降噪/变速等
// 其余引擎功能的面板接线不在本批，见构建日志的未接清单。
// 本机 Linux 跑不了 WPF，验证全靠云端 windows-2025 构建 + 启动检查
// + 新增的 --w3-test（FeaturePanelsTests.cs）。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using DogSC.Windows;

namespace DogSC.Replica {
 public class SubtitleCue { public double Start; public double End; public string Text=""; public string Text2=""; }
 public class MulticamSwitch { public double Time; public int Angle; }
 public class MixerChannel {
  // Role 取值：对话（主音轨）/音乐（本地音频床）/音效/旁白。C# 侧目前只
  // 有主音轨与音乐床两种来源，音效/旁白角色保留给以后接 TTS/音效轨。
  public string Role="对话"; public string SourcePath=""; public double GainDb; public double Pan; public bool Mute; public bool Solo;
 }
 public class PlaySegment {
  public bool Gap; public double TimelineStart; public double TimelineEnd;
  public double SourceStart; public double SourceEnd; public double Speed=1; public string File="";
  public double Length { get { return TimelineEnd-TimelineStart; } }
 }

 public class ColorGrade {
  public double Brightness; public double Contrast=1; public double Saturation=1;
  public double Temperature; public double Tint;
  // HSL 分区：7 个色相区（红/橙/黄/绿/青/蓝/品红，中心 0/30/60/120/180/240/300 度，
  // 权重在 ±45 度内线性衰减，见 color.ts 的 HUE_ZONE_CENTER / HSL_ZONE_HALF_WIDTH）。
  // 饱和度是倍数（1 = 不变），明度是增量（0 = 不变）。
  public double[] HslSat=new double[]{1,1,1,1,1,1,1};
  public double[] HslLum=new double[7];
  // 色轮三区：阴影/中间调/高光，每区色相偏移（度）+ 饱和度倍数。
  public double[] WheelHue=new double[3];
  public double[] WheelSat=new double[]{1,1,1};
  public static readonly string[] HslZoneNames=new[]{"红","橙","黄","绿","青","蓝","品红"};
  public static readonly double[] HslZoneCenters=new[]{0.0,30,60,120,180,240,300};
  public static readonly string[] WheelZoneNames=new[]{"阴影","中间调","高光"};
  static bool Near(double a,double b){return Math.Abs(a-b)<.000001;}
  public bool IsIdentity(){
   if(!Near(Brightness,0)||!Near(Contrast,1)||!Near(Saturation,1)||!Near(Temperature,0)||!Near(Tint,0))return false;
   for(int i=0;i<7;i++)if(!Near(HslSat[i],1)||!Near(HslLum[i],0))return false;
   for(int i=0;i<3;i++)if(!Near(WheelHue[i],0)||!Near(WheelSat[i],1))return false;
   return true;
  }
  // 白平衡色调（tint）没有 P0 的 colorbalance 等价写法（colorbalance 只有
  // 温度一路 rs/bs），所以 tint != 0 时必须走 LUT 烘焙；温度单独出现时走
  // colorbalance，与 TS 的 P0 阶段完全一致。
  public bool NeedsLut(){
   if(!Near(Tint,0))return true;
   for(int i=0;i<7;i++)if(!Near(HslSat[i],1)||!Near(HslLum[i],0))return true;
   for(int i=0;i<3;i++)if(!Near(WheelHue[i],0)||!Near(WheelSat[i],1))return true;
   return false;
  }
  // 解码器 vf 链的追加片段（以逗号开头，直接拼在 scale=... 之后）。
  // 基础走 eq/colorbalance（YUV）；高级走 format=rgb24 + lut3d——LUT 是
  // 按 RGB 烤的，直接套在 YUV 数据上颜色会错，必须先转 rgb24。
  public string VideoFilter(){
   if(IsIdentity())return "";
   var parts=new List<string>();
   if(!NeedsLut()){
    var eq=new List<string>();
    if(!Near(Brightness,0))eq.Add("brightness="+Media.N(Brightness));
    if(!Near(Contrast,1))eq.Add("contrast="+Media.N(Contrast));
    if(!Near(Saturation,1))eq.Add("saturation="+Media.N(Saturation));
    if(eq.Count>0)parts.Add("eq="+string.Join(":",eq.ToArray()));
    if(!Near(Temperature,0))parts.Add("colorbalance=rs="+Media.N(Temperature)+":gs=0:bs="+Media.N(-Temperature));
    return ","+string.Join(",",parts.ToArray());
   }
   // LUT 路径：eq 阶段仍先跑（亮度/对比度/饱和度），温度/色调/HSL/色轮
   // 全进 LUT（与 TS 的“P0 阶段先跑、LUT 后贴”顺序一致）。
   var eq2=new List<string>();
   if(!Near(Brightness,0))eq2.Add("brightness="+Media.N(Brightness));
   if(!Near(Contrast,1))eq2.Add("contrast="+Media.N(Contrast));
   if(!Near(Saturation,1))eq2.Add("saturation="+Media.N(Saturation));
   if(eq2.Count>0)parts.Add("eq="+string.Join(":",eq2.ToArray()));
   parts.Add("format=rgb24");
   parts.Add(ColorLut.Lut3dFilter(ColorLut.PathFor(this)));
   return ","+string.Join(",",parts.ToArray());
  }
  public string Key(){
   var sb=new StringBuilder();
   sb.Append(Media.N(Brightness)).Append("/").Append(Media.N(Contrast)).Append("/").Append(Media.N(Saturation)).Append("/").Append(Media.N(Temperature)).Append("/").Append(Media.N(Tint));
   for(int i=0;i<7;i++)sb.Append("/").Append(Media.N(HslSat[i])).Append(",").Append(Media.N(HslLum[i]));
   for(int i=0;i<3;i++)sb.Append("/").Append(Media.N(WheelHue[i])).Append(",").Append(Media.N(WheelSat[i]));
   return sb.ToString();
  }
  public void Reset(){
   Brightness=0;Contrast=1;Saturation=1;Temperature=0;Tint=0;
   for(int i=0;i<7;i++){HslSat[i]=1;HslLum[i]=0;}
   for(int i=0;i<3;i++){WheelHue[i]=0;WheelSat[i]=1;}
  }
 }

 // color.ts 的 applyAdvancedColorToRgb / buildColorLut / lutToCube 的 C# 移植。
 // 数学逐行照抄 TS（白平衡增益、HSL 分区权重、色轮 smoothstep 权重、HSL 互转）；
 // 不含曲线（curves / hslCurves）：那两个编辑器本批未接，烘焙器也不含它们。
 static class ColorLut {
  static double Clamp01(double v){return Math.Max(0,Math.Min(1,v));}
  static double HueDistance(double a,double b){double d=Math.Abs(a-b)%360;return d>180?360-d:d;}
  public static double[] RgbToHsl(double r,double g,double b){
   double mx=Math.Max(r,Math.Max(g,b)),mn=Math.Min(r,Math.Min(g,b)),l=(mx+mn)/2;
   if(mx==mn)return new[]{0.0,0.0,l};
   double d=mx-mn,s=l>.5?d/(2-mx-mn):d/(mx+mn),h;
   if(mx==r)h=((g-b)/d)%6;else if(mx==g)h=(b-r)/d+2;else h=(r-g)/d+4;
   h*=60;if(h<0)h+=360;return new[]{h,s,l};
  }
  public static double[] HslToRgb(double h,double s,double l){
   if(s==0)return new[]{l,l,l};
   double c=(1-Math.Abs(2*l-1))*s,hp=(h%360)/60,x=c*(1-Math.Abs(hp%2-1)),m=l-c/2,r=0,g=0,b=0;
   if(hp<1){r=c;g=x;}else if(hp<2){r=x;g=c;}else if(hp<3){g=c;b=x;}else if(hp<4){g=x;b=c;}else if(hp<5){r=x;b=c;}else{r=c;b=x;}
   return new[]{r+m,g+m,b+m};
  }
  // color.ts 的 colorWheelWeight：smoothstep 权重，L=0.25 时阴影 0.94 /
  // 中间调 0.07 / 高光 0.00（TS 探针实测值）。
  public static double WheelWeight(int zone,double l){
   Func<double,double,double,double> smooth=(a,b,x)=>{double t=Math.Max(0,Math.Min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
   if(zone==0)return 1-smooth(.2,.55,l);
   if(zone==2)return smooth(.45,.8,l);
   return smooth(.2,.5,l)*(1-smooth(.5,.8,l));
  }
  public static double[] Apply(ColorGrade grade,double r,double g,double b){
   double t=grade.Temperature,tint=grade.Tint;
   r=r*(1+.25*t)*(1+.075*tint);g=g*(1-.15*tint);b=b*(1-.25*t)*(1+.075*tint);
   r=Clamp01(r);g=Clamp01(g);b=Clamp01(b);
   bool anyZone=false,anyWheel=false;
   for(int i=0;i<7;i++)if(Math.Abs(grade.HslSat[i]-1)>.000001||Math.Abs(grade.HslLum[i])>.000001)anyZone=true;
   for(int i=0;i<3;i++)if(Math.Abs(grade.WheelHue[i])>.000001||Math.Abs(grade.WheelSat[i]-1)>.000001)anyWheel=true;
   if(anyZone||anyWheel||Math.Abs(t)>.000001||Math.Abs(tint)>.000001){
    var hsl=RgbToHsl(r,g,b);double h=hsl[0],s=hsl[1],l=hsl[2];
    for(int i=0;i<7;i++){
     double w=Math.Max(0,1-HueDistance(h,ColorGrade.HslZoneCenters[i])/45);
     if(w==0)continue;
     s=Clamp01(s*(1+(grade.HslSat[i]-1)*w));l=Clamp01(l+grade.HslLum[i]*w);
    }
    for(int k=0;k<3;k++){
     double w=WheelWeight(k,l);if(w==0)continue;
     h=(((h+grade.WheelHue[k]*w)%360)+360)%360;
     s=Clamp01(s*(1+(grade.WheelSat[k]-1)*w));
    }
    var rgb=HslToRgb(h,s,l);r=rgb[0];g=rgb[1];b=rgb[2];
   }
   return new[]{Clamp01(r),Clamp01(g),Clamp01(b)};
  }
  public static string BuildCube(ColorGrade grade,int size=17){
   var sb=new StringBuilder();
   sb.Append("TITLE \"CatCut advanced colour\"\nLUT_3D_SIZE "+size+"\nDOMAIN_MIN 0.0 0.0 0.0\nDOMAIN_MAX 1.0 1.0 1.0\n");
   for(int bi=0;bi<size;bi++)for(int gi=0;gi<size;gi++)for(int ri=0;ri<size;ri++){
    var rgb=Apply(grade,(double)ri/(size-1),(double)gi/(size-1),(double)bi/(size-1));
    sb.Append(rgb[0].ToString("F6",CultureInfo.InvariantCulture)).Append(" ").Append(rgb[1].ToString("F6",CultureInfo.InvariantCulture)).Append(" ").Append(rgb[2].ToString("F6",CultureInfo.InvariantCulture)).Append("\n");
   }
   return sb.ToString();
  }
  public static string PathFor(ColorGrade grade){
   string hash;using(var sha=SHA256.Create())hash=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(grade.Key()))).Replace("-","").ToLowerInvariant().Substring(0,16);
   string path=Path.Combine(Path.GetTempPath(),"catcut-lut-"+hash+".cube");
   if(!File.Exists(path))File.WriteAllText(path,BuildCube(grade),new UTF8Encoding(false));
   return path;
  }
  // lut3dFilter（color.ts）：反斜杠翻倍、单引号转义后包进单引号。
  public static string Lut3dFilter(string path){return "lut3d='"+path.Replace("\\","\\\\").Replace("'","'\\''")+"'";}
 }

 static class SubtitleFiles {
  public static string FormatSrtTime(double sec){
   long ms=Math.Max(0,(long)Math.Round(sec*1000));
   return string.Format(CultureInfo.InvariantCulture,"{0:D2}:{1:D2}:{2:D2},{3:D3}",ms/3600000,(ms/60000)%60,(ms/1000)%60,ms%1000);
  }
  public static string FormatVttTime(double sec){
   long ms=Math.Max(0,(long)Math.Round(sec*1000));
   return string.Format(CultureInfo.InvariantCulture,"{0:D2}:{1:D2}:{2:D2}.{3:D3}",ms/3600000,(ms/60000)%60,(ms/1000)%60,ms%1000);
  }
  public static string FormatAssTime(double sec){
   long cs=Math.Max(0,(long)Math.Round(sec*100));
   return string.Format(CultureInfo.InvariantCulture,"{0}:{1:D2}:{2:D2}.{3:D2}",cs/360000,(cs/6000)%60,(cs/100)%60,cs%100);
  }
  static string CueText(SubtitleCue c){return string.IsNullOrWhiteSpace(c.Text2)?c.Text:c.Text+"\n"+c.Text2;}
  public static string ToSrt(List<SubtitleCue> cues){
   var sb=new StringBuilder();
   for(int i=0;i<cues.Count;i++)sb.Append((i+1)+"\n"+FormatSrtTime(cues[i].Start)+" --> "+FormatSrtTime(cues[i].End)+"\n"+CueText(cues[i])+"\n\n");
   return sb.ToString();
  }
  public static string ToVtt(List<SubtitleCue> cues){
   var sb=new StringBuilder("WEBVTT\n\n");
   for(int i=0;i<cues.Count;i++)sb.Append((i+1)+"\n"+FormatVttTime(cues[i].Start)+" --> "+FormatVttTime(cues[i].End)+"\n"+CueText(cues[i])+"\n\n");
   return sb.ToString();
  }
  // deliver.ts 的 subtitlesToDualASS：Sub 底行 + Sub2 上行；Sub2 字号 -4、
  // 黄色 &H0000FFFF、marginV = 主 marginV + 字号 + 12（40 号字时 30+40+12=82，
  // 与 P3c 探针实测的 360p 下 82 一致）。无第二语言不报错，只出一行；
  // 无主语言是建模错误，抛错。
  public static string ToAss(List<SubtitleCue> cues,int playResX,int playResY){
   if(cues.Count==0)throw new Exception("没有字幕可写。");
   int fontSize=40,marginV=30;
   var sb=new StringBuilder();
   sb.Append("[Script Info]\nTitle: dual subtitles\nScriptType: v4.00+\nPlayResX: "+playResX+"\nPlayResY: "+playResY+"\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n");
   sb.Append("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n");
   sb.Append("Style: Sub,Microsoft YaHei UI,"+fontSize+",&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,"+marginV+",1\n");
   sb.Append("Style: Sub2,Microsoft YaHei UI,"+Math.Max(16,fontSize-4)+",&H0000FFFF,&H0000FFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,"+(marginV+fontSize+12)+",1\n\n[Events]\n");
   sb.Append("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");
   Func<string,string> esc=s=>s.Replace("{","\\{").Replace("}","\\}");
   foreach(var c in cues){
    sb.Append("Dialogue: 0,"+FormatAssTime(c.Start)+","+FormatAssTime(c.End)+",Sub,,0,0,0,,"+esc(c.Text.Replace("\n","\\N"))+"\n");
    if(!string.IsNullOrWhiteSpace(c.Text2))sb.Append("Dialogue: 0,"+FormatAssTime(c.Start)+","+FormatAssTime(c.End)+",Sub2,,0,0,0,,"+esc(c.Text2.Replace("\n","\\N"))+"\n");
   }
   return sb.ToString();
  }
  static double ParseTime(string s){
   var m=System.Text.RegularExpressions.Regex.Match(s.Trim(),@"(\d+):(\d+):(\d+)[,.](\d+)");
   if(!m.Success)throw new Exception("字幕时间码无法解析："+s);
   return int.Parse(m.Groups[1].Value)*3600+int.Parse(m.Groups[2].Value)*60+int.Parse(m.Groups[3].Value)+int.Parse(m.Groups[4].Value)/1000.0;
  }
  public static List<SubtitleCue> ParseSrt(string text){
   var items=new List<SubtitleCue>();
   foreach(var block in text.Replace("\r\n","\n").Trim().Split(new[]{"\n\n"},StringSplitOptions.RemoveEmptyEntries)){
    var lines=block.Split('\n');int tc=-1;
    for(int i=0;i<lines.Length;i++)if(lines[i].Contains("-->")){tc=i;break;}
    if(tc<0)continue;var parts=lines[tc].Split(new[]{"-->"},StringSplitOptions.None);
    var cue=new SubtitleCue {Start=ParseTime(parts[0]),End=ParseTime(parts[1])};
    var body=string.Join("\n",lines.Skip(tc+1).ToArray()).Trim();
    var nl=body.IndexOf('\n');cue.Text=nl<0?body:body.Substring(0,nl);cue.Text2=nl<0?"":body.Substring(nl+1);
    items.Add(cue);
   }
   items.Sort((a,b)=>a.Start.CompareTo(b.Start));return items;
  }
  public static List<SubtitleCue> ParseVtt(string text){
   var items=new List<SubtitleCue>();
   foreach(var block in text.Replace("\r\n","\n").Trim().Split(new[]{"\n\n"},StringSplitOptions.RemoveEmptyEntries)){
    var lines=block.Split('\n');if(lines.Length==0||lines[0].Trim()=="WEBVTT")continue;
    int tc=-1;for(int i=0;i<lines.Length;i++)if(lines[i].Contains("-->")){tc=i;break;}
    if(tc<0)continue;var parts=lines[tc].Split(new[]{"-->"},StringSplitOptions.None);
    var cue=new SubtitleCue {Start=ParseTime(parts[0]),End=ParseTime(parts[1])};
    var body=string.Join("\n",lines.Skip(tc+1).ToArray()).Trim();
    var nl=body.IndexOf('\n');cue.Text=nl<0?body:body.Substring(0,nl);cue.Text2=nl<0?"":body.Substring(nl+1);
    items.Add(cue);
   }
   items.Sort((a,b)=>a.Start.CompareTo(b.Start));return items;
  }
  // ASS 导入（尽力而为）：读 [Events] 的 Format 列位，Dialogue 的 Text
  // 去 {\...}、\N 换行；Sub2 按起止时间合并到同条主字幕的 Text2。
  public static List<SubtitleCue> ParseAss(string text){
   var lines=text.Replace("\r\n","\n").Split('\n');
   int startIdx=1,endIdx=2,styleIdx=3,textIdx=9;bool inEvents=false;
   var cues=new List<SubtitleCue>();
   foreach(var raw in lines){
    var line=raw.Trim();if(line=="[Events]"){inEvents=true;continue;}
    if(line.StartsWith("[")){if(inEvents)break;continue;}
    if(!inEvents)continue;
    if(line.StartsWith("Format:")){
     var cols=line.Substring(7).Split(',');for(int i=0;i<cols.Length;i++){var c=cols[i].Trim();if(c=="Start")startIdx=i;else if(c=="End")endIdx=i;else if(c=="Style")styleIdx=i;else if(c=="Text")textIdx=i;}
     continue;
    }
    if(!line.StartsWith("Dialogue:"))continue;
    var fields=line.Substring(9).Split(new[]{','},10);
    if(fields.Length<=textIdx)continue;
    double start=ParseTime(fields[startIdx]),end=ParseTime(fields[endIdx]);
    string body=System.Text.RegularExpressions.Regex.Replace(fields[textIdx],"\\{[^}]*\\}","").Replace("\\N","\n").Trim();
    var match=cues.FirstOrDefault(c=>Math.Abs(c.Start-start)<.01&&Math.Abs(c.End-end)<.01);
    if(fields[styleIdx].Trim()=="Sub2"){
     if(match!=null)match.Text2=body;else cues.Add(new SubtitleCue {Start=start,End=end,Text="",Text2=body});
    }else{
     if(match!=null)match.Text=body;else cues.Add(new SubtitleCue {Start=start,End=end,Text=body});
    }
   }
   cues.Sort((a,b)=>a.Start.CompareTo(b.Start));return cues;
  }
  public static List<SubtitleCue> ParseFile(string path){
   string text=File.ReadAllText(path,new UTF8Encoding(false));
   string ext=Path.GetExtension(path).ToLowerInvariant();
   if(ext==".vtt")return ParseVtt(text);
   if(ext==".ass")return ParseAss(text);
   return ParseSrt(text);
  }
  // 写边车：format 为 none 或无字幕时什么都不做，返回 null；否则返回写出的路径。
  public static string WriteSidecar(EditDocument doc,string outputMp4Path){
   if(doc.Subtitles==null||doc.Subtitles.Count==0||string.IsNullOrEmpty(doc.SubtitleSidecar)||doc.SubtitleSidecar=="none")return null;
   string ext=doc.SubtitleSidecar=="ass"?".ass":doc.SubtitleSidecar=="vtt"?".vtt":".srt";
   string path=Path.ChangeExtension(outputMp4Path,ext);
   string text=doc.SubtitleSidecar=="ass"?ToAss(doc.Subtitles,doc.Width,doc.Height):doc.SubtitleSidecar=="vtt"?ToVtt(doc.Subtitles):ToSrt(doc.Subtitles);
   File.WriteAllText(path,text,new UTF8Encoding(false));return path;
  }
 }

 // roles.ts 的 roleFilter 移植（顺序照抄：aresample → >2 声道 aformat →
 // 静音分支 / volume dB → pan）。pan 增益 lg=min(1,1-p)、rg=min(1,1+p)。
 static class MixerAudio {
  public static double DbToLinear(double db){return Math.Pow(10,db/20);}
  public static double PanLeft(double pan){return Math.Min(1,1-pan);}
  public static double PanRight(double pan){return Math.Min(1,1+pan);}
  static string Fmt(double n){return n==Math.Floor(n)?((long)n).ToString(CultureInfo.InvariantCulture):n.ToString("0.####",CultureInfo.InvariantCulture);}
  public static string RoleFilter(MixerChannel ch,bool muted,int channels,double extraGainDb=0){
   var parts=new List<string>{"aresample=48000"};
   if(channels>2)parts.Add("aformat=channel_layouts=stereo");
   if(muted){if(channels==1)parts.Add("pan=stereo|c0=c0|c1=c0");parts.Add("volume=0");return string.Join(",",parts.ToArray());}
   parts.Add("volume="+Fmt(ch.GainDb+extraGainDb)+"dB");
   double lg=PanLeft(ch.Pan),rg=PanRight(ch.Pan);
   if(channels==1)parts.Add("pan=stereo|c0="+Fmt(lg)+"*c0|c1="+Fmt(rg)+"*c0");
   else if(ch.Pan!=0)parts.Add("pan=stereo|c0="+Fmt(lg)+"*c0|c1="+Fmt(rg)+"*c1");
   return string.Join(",",parts.ToArray());
  }
  // 独奏/静音解析：有独奏时只留独奏轨，否则去掉静音轨。Mixer 为空时返回
  // 一条默认对话轨（主音轨），老项目行为不变。
  // W3：混音台无主音轨通道时补一条默认对话轨（加音乐床不应把主音轨静音）。
  public static List<MixerChannel> Audible(EditDocument doc){
   var all=doc.Mixer==null||doc.Mixer.Count==0?new List<MixerChannel>{new MixerChannel {Role="对话"}}:doc.Mixer.ToList();
   if(doc.Audio&&!all.Any(c=>string.IsNullOrEmpty(c.SourcePath)))all.Add(new MixerChannel {Role="对话"});
   if(all.Any(c=>c.Solo))return all.Where(c=>c.Solo).ToList();
   return all.Where(c=>!c.Mute).ToList();
  }
  public static MixerChannel SourceChannel(EditDocument doc){
   var audible=Audible(doc);return audible.FirstOrDefault(c=>string.IsNullOrEmpty(c.SourcePath));
  }
  public static List<MixerChannel> MusicChannels(EditDocument doc){
   return Audible(doc).Where(c=>!string.IsNullOrEmpty(c.SourcePath)).ToList();
  }
 }

 static class ProxyTools {
  public static string ProxyPathFor(string source){return Path.Combine(Path.GetDirectoryName(source),Path.GetFileNameWithoutExtension(source)+".proxy.mp4");}
  // proxy.ts 的 generateProxy：scale='min(1280,iw)':-2（只缩小不放大）、
  // libx264 veryfast、CRF 28、aac 96k。生成后核时长（容限 0.1s）。
  public static double Generate(string source,string output){
   StudioMedia.Run("-v error -y -i "+Media.Q(source)+" -vf scale='min(1280,iw)':-2 -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -c:a aac -b:a 96k "+Media.Q(output),CancellationToken.None);
   double proxy=Media.Duration(output),src=Media.Duration(source);
   if(Math.Abs(proxy-src)>.1)throw new Exception("代理时长与原片不符：代理 "+proxy.ToString("0.00")+"s，原片 "+src.ToString("0.00")+"s。");
   return proxy;
  }
  // 代理缺失/时长不符是硬错，不静默回退原片（proxy.ts 的 validateProxies 同款语义）。
  public static void Validate(EditDocument doc){
   if(!doc.ProxyEnabled)return;
   if(string.IsNullOrEmpty(doc.ProxyPath))throw new Exception("代理已开启，但没有生成代理文件。请先生成代理，或关闭代理。");
   if(!File.Exists(doc.ProxyPath))throw new Exception("代理已开启，但代理文件缺失："+doc.ProxyPath+"。请重新生成代理，或关闭代理。不要静默回退原片。");
   double actual=Media.Duration(doc.ProxyPath);
   if(Math.Abs(actual-doc.Duration)>.1)throw new Exception("代理文件时长与原片不符（代理 "+actual.ToString("0.00")+"s，原片 "+doc.Duration.ToString("0.00")+"s）。请重新生成代理。");
  }
 }

 // multicam.ts 的模型移植（切换点改用时间线时间，见文件头注释）。
 static class MulticamModel {
  public static int AngleCount(EditDocument doc){return 1+(doc.MulticamAngles==null?0:doc.MulticamAngles.Count);}
  public static bool Active(EditDocument doc){return doc.MulticamAngles!=null&&doc.MulticamAngles.Count>0;}
  public static string AngleSource(EditDocument doc,int angle){return angle==0?doc.Source:doc.MulticamAngles[angle-1];}
  public static int AngleAt(EditDocument doc,double timelineTime){
   int angle=0;if(doc.MulticamSwitches==null)return 0;
   foreach(var s in doc.MulticamSwitches)if(s.Time<=timelineTime+.000001)angle=s.Angle;
   return angle;
  }
  // 把 Cut 按切换点切成播放段：每段一个角度文件 + 一段源范围；空隙单独成段。
  public static List<PlaySegment> BuildSegments(EditDocument doc){
   var segs=new List<PlaySegment>();double offset=0;
   foreach(var c in doc.Cuts){
    double len=c.Length;
    if(c.Gap){segs.Add(new PlaySegment {Gap=true,TimelineStart=offset,TimelineEnd=offset+len,SourceStart=c.Start,SourceEnd=c.Start,Speed=1,File=doc.Source});offset+=len;continue;}
    var bounds=new List<double>{offset,offset+len};
    if(doc.MulticamSwitches!=null)foreach(var s in doc.MulticamSwitches)if(s.Time>offset+.001&&s.Time<offset+len-.001)bounds.Add(s.Time);
    bounds.Sort();
    for(int i=0;i+1<bounds.Count;i++){
     double t0=bounds[i],t1=bounds[i+1];int angle=AngleAt(doc,t0);
     segs.Add(new PlaySegment {TimelineStart=t0,TimelineEnd=t1,SourceStart=c.Start+(t0-offset)*c.Speed,SourceEnd=c.Start+(t1-offset)*c.Speed,Speed=c.Speed,File=AngleSource(doc,angle)});
    }
    offset+=len;
   }
   return segs;
  }
  public static void Validate(EditDocument doc){
   if(!Active(doc)){if(doc.MulticamSwitches!=null&&doc.MulticamSwitches.Count>0)throw new Exception("有多机位切换点，但没有第二角度。请先添加角度。");return;}
   int count=AngleCount(doc);if(count>16)throw new Exception("多机位角度共 "+count+" 路，超出 16 路上限。");
   foreach(var a in doc.MulticamAngles)if(!File.Exists(a))throw new Exception("多机位角度文件缺失："+a);
   // 各角度时长须与主源一致（容限 0.05s，multicam.ts 的 MULTICAM_DURATION_TOLERANCE）。
   foreach(var a in doc.MulticamAngles){double d=Media.Duration(a);if(Math.Abs(d-doc.Duration)>.05)throw new Exception("多机位角度时长与主源不符："+Path.GetFileName(a)+" 为 "+d.ToString("0.00")+"s，主源 "+doc.Duration.ToString("0.00")+"s（容限 0.05s）。角度须为同步拍摄的同条素材。");}
   if(doc.Cuts.Any(c=>!c.Gap&&Math.Abs(c.Speed-1)>.000001))throw new Exception("多机位 v1 不支持变速片段（multicam.ts 的限制）：请先把片段速度改回 1×。");
   if(doc.MulticamSwitches!=null){
    double prev=-1;
    foreach(var s in doc.MulticamSwitches){
     if(s.Time<0||s.Time>doc.Length)throw new Exception("多机位切换点超出时间线范围："+s.Time.ToString("0.00")+"s。");
     if(s.Angle<0||s.Angle>=count)throw new Exception("多机位切换角度越界："+s.Angle+"。");
     if(s.Time<=prev)throw new Exception("多机位切换点必须按时间递增。");
     prev=s.Time;
    }
   }
  }
 }
}
