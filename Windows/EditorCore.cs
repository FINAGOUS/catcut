using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using DogSC.Windows;

namespace DogSC.Replica {
 public class Cut { public double Start; public double End; public double Speed=1; public double Length { get { return Gap?GapDuration:(End-Start)/Speed; } }
  // W3 波纹/空隙：Gap=true 时这段不是源素材，而是黑场 + 静音的空隙；
  // Start==End 为锚点源时间（空隙不消耗源时间），GapDuration 是时间线时长。
  public bool Gap; public double GapDuration; }
 public class Zoom { public double Start; public double End; public double Scale=1.6; public double X=.5; public double Y=.5; public bool Automatic; public double Transition=.7; public string Easing="spring"; }
 public class Appearance {
  public string Ratio="16:9"; public string Background="dots"; public string ImagePath="";
  public string ColorA="#F5F6F7"; public string ColorB="#F5F6F7";
  public double Padding=70; public double Radius=16; public double Shadow=25; public double Border=0;
  public double Scale=1; public double X=.5; public double Y=.5; public string Frame="window";
  public bool AutoZoom=true; public bool Follow=true; public double ZoomScale=1.6;
  public double Volume=1; public double Opening=0;
 }
 public class EditDocument {
  public string Format="dogsc-windows-editor"; public int Version=2; public string Name="未命名项目";
  public string Source; public int Width; public int Height; public double Duration; public bool Audio;public double FrameRate=30;
  public Appearance Style=new Appearance(); public List<Cut> Cuts=new List<Cut>();public bool IndependentCursor=false;public CursorSettings Cursor=new CursorSettings();public List<OverlayClip> Overlays=new List<OverlayClip>();
  public List<PointerSample> Pointer=new List<PointerSample>(); public List<Zoom> Zooms=new List<Zoom>();
  public ScreenMotionState ScreenBase;public List<ScreenMotionClip> ScreenMotions=new List<ScreenMotionClip>();
  // W3 功能面板接线的新字段（模型见 Windows/FeaturePanels.cs；老项目文件
  // 反序列化时这些字段为 null，Validate() 里逐一补默认值，老行为不变）：
  public List<SubtitleCue> Subtitles=new List<SubtitleCue>(); public bool SubtitleBurnIn=true; public string SubtitleSidecar="srt";
  public ColorGrade Grade=new ColorGrade(); public List<MixerChannel> Mixer=new List<MixerChannel>(); public double MasterGainDb;
  public string ProxyPath=""; public bool ProxyEnabled; public double ProxyDuration;
  public List<string> MulticamAngles=new List<string>(); public List<MulticamSwitch> MulticamSwitches=new List<MulticamSwitch>();
  // W4：摄像头画中画轨（模型见 Windows/W4Camera.cs；老工程反序列化为 null，Validate() 里补默认值）。
  public CameraClip Camera;
  public double Length { get { return Cuts.Sum(c=>c.Length); } }
  public static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength=int.MaxValue }; }
  public string Serialize() { return Serializer().Serialize(this); }
  public static EditDocument Deserialize(string text) { return Serializer().Deserialize<EditDocument>(text); }
  public void Save(string path) {
   string pending=path+".tmp"; File.WriteAllText(pending,Serialize(),new UTF8Encoding(false));
   if(File.Exists(path)) File.Replace(pending,path,null); else File.Move(pending,path);
  }
  public void Validate() {
   if(Format!="dogsc-windows-editor"||Version!=2||!File.Exists(Source)||Width<2||Height<2||!Finite(Duration)||Duration<=0||Style==null||Cuts==null||Cuts.Count==0||Pointer==null||Zooms==null) throw new Exception("项目不完整、版本不支持，或找不到视频素材。");
   // W3：老项目文件缺新字段时补默认值（反序列化后为 null）。
   if(Subtitles==null)Subtitles=new List<SubtitleCue>(); if(string.IsNullOrEmpty(SubtitleSidecar))SubtitleSidecar="srt";
   if(Grade==null)Grade=new ColorGrade(); if(Grade.HslSat==null||Grade.HslSat.Length!=7)Grade.HslSat=new double[]{1,1,1,1,1,1,1}; if(Grade.HslLum==null||Grade.HslLum.Length!=7)Grade.HslLum=new double[7]; if(Grade.WheelHue==null||Grade.WheelHue.Length!=3)Grade.WheelHue=new double[3]; if(Grade.WheelSat==null||Grade.WheelSat.Length!=3)Grade.WheelSat=new double[]{1,1,1};
   if(Mixer==null)Mixer=new List<MixerChannel>(); if(MulticamAngles==null)MulticamAngles=new List<string>(); if(MulticamSwitches==null)MulticamSwitches=new List<MulticamSwitch>();
   if(Camera==null)Camera=new CameraClip();
   if(!Finite(FrameRate)||FrameRate<=0||FrameRate>240)FrameRate=30;
   if(Cuts.Any(c=>!Finite(c.Start)||!Finite(c.End)||!Finite(c.Speed)||c.Start<0||c.End>Duration+.1||(!c.Gap&&(c.End<=c.Start||c.Speed<.5||c.Speed>2))||(c.Gap&&(!Finite(c.GapDuration)||c.GapDuration<=0||c.End<c.Start)))) throw new Exception("项目的剪辑范围无效。");
   // W3：字幕 / 调色 / 混音 / 代理 / 多机位校验（范围外的值直接拒绝，不静默修正）。
   foreach(var s in Subtitles)if(!Finite(s.Start)||!Finite(s.End)||s.Start<0||s.End<=s.Start||s.End>Length+.1||string.IsNullOrWhiteSpace(s.Text)&&string.IsNullOrWhiteSpace(s.Text2))throw new Exception("字幕时间或文本无效。");
   if(!Finite(Grade.Brightness)||Grade.Brightness<-1||Grade.Brightness>1||!Finite(Grade.Contrast)||Grade.Contrast<0||Grade.Contrast>2||!Finite(Grade.Saturation)||Grade.Saturation<0||Grade.Saturation>2||!Finite(Grade.Temperature)||Grade.Temperature<-1||Grade.Temperature>1||!Finite(Grade.Tint)||Grade.Tint<-1||Grade.Tint>1)throw new Exception("调色参数超出范围。");
   if(Grade.HslSat.Any(v=>!Finite(v)||v<0||v>3)||Grade.HslLum.Any(v=>!Finite(v)||v<-1||v>1)||Grade.WheelHue.Any(v=>!Finite(v)||v<-180||v>180)||Grade.WheelSat.Any(v=>!Finite(v)||v<0||v>3))throw new Exception("HSL 分区或色轮参数超出范围。");
   if(!Finite(MasterGainDb)||MasterGainDb<-60||MasterGainDb>12)throw new Exception("总输出增益超出范围。");
   foreach(var ch in Mixer){if(string.IsNullOrEmpty(ch.Role)||!new[]{"对话","音乐","音效","旁白"}.Contains(ch.Role)||!Finite(ch.GainDb)||ch.GainDb<-60||ch.GainDb>12||!Finite(ch.Pan)||ch.Pan<-1||ch.Pan>1)throw new Exception("混音通道参数无效。");if(!string.IsNullOrEmpty(ch.SourcePath)&&!File.Exists(ch.SourcePath))throw new Exception("混音通道的音频文件缺失："+ch.SourcePath);}
   ProxyTools.Validate(this);MulticamModel.Validate(this);
   // W4：画中画开时素材缺失是硬错（与代理/混音通道同款语义，不静默回退）。
   if(Camera.Enabled){
    if(string.IsNullOrEmpty(Camera.SourcePath)||!File.Exists(Camera.SourcePath))throw new Exception("摄像头画中画素材缺失："+(string.IsNullOrEmpty(Camera.SourcePath)?"（未关联）":Camera.SourcePath)+"。请重新关联或关闭画中画。");
    if(!Finite(Camera.X)||!Finite(Camera.Y)||Camera.X<0||Camera.X>1||Camera.Y<0||Camera.Y>1||!Finite(Camera.Size)||Camera.Size<.05||Camera.Size>.5)throw new Exception("摄像头画中画位置或大小无效。");
    if(Camera.Shape!="circle"&&Camera.Shape!="rounded"&&Camera.Shape!="rect")throw new Exception("摄像头画中画形状无效。");
   }
   if(Pointer.Any(p=>!Finite(p.Time)||!Finite(p.X)||!Finite(p.Y)))throw new Exception("鼠标轨迹无效。");
   if(Zooms.Any(z=>!Finite(z.Start)||!Finite(z.End)||!Finite(z.Scale)||!Finite(z.X)||!Finite(z.Y)||!Finite(z.Transition)||z.End<=z.Start||z.Start<0||z.Scale<1||z.Scale>3||z.Transition<.05||z.Transition>5))throw new Exception("运镜参数无效。");
   double[] values={Style.Padding,Style.Radius,Style.Shadow,Style.Border,Style.Scale,Style.X,Style.Y,Style.Volume,Style.ZoomScale,Style.Opening};
   if(values.Any(v=>!Finite(v)))throw new Exception("画面参数无效。");
   Style.Padding=Clamp(Style.Padding,0,180);Style.Radius=Clamp(Style.Radius,0,80);Style.Scale=Clamp(Style.Scale,.5,1.5);Style.X=Clamp(Style.X,0,1);Style.Y=Clamp(Style.Y,0,1);Style.Volume=Clamp(Style.Volume,0,1);Style.ZoomScale=Clamp(Style.ZoomScale,1,3);
   EffectModels.Validate(this);ScreenMotionModels.Validate(this);
  }
  public static bool Finite(double n) {return !double.IsNaN(n)&&!double.IsInfinity(n);}
  public static double Clamp(double n,double lo,double hi) {return Math.Max(lo,Math.Min(hi,n));}
  public double SourceTime(double time,out int index) { double offset=0;index=0;foreach(var c in Cuts){if(c.Gap){if(time<offset+c.GapDuration||index==Cuts.Count-1)return c.Start;offset+=c.GapDuration;index++;continue;}if(time<offset+c.Length||index==Cuts.Count-1)return c.Start+Clamp(time-offset,0,c.Length)*c.Speed;offset+=c.Length;index++;}return 0; }
  // W3：时间线时刻所在的片段及其起始偏移；空隙也返回（预览时画黑场）。
  public Cut CutAt(double time,out double offset){offset=0;foreach(var c in Cuts){if(time<offset+c.Length||c==Cuts[Cuts.Count-1])return c;offset+=c.Length;}return Cuts[Cuts.Count-1];}
  // W3：预览/播放用的实际解码源。代理开时走代理文件；代理缺失是硬错，
  // 不静默回退原片（ProxyTools.Validate 同款语义）。导出不用这个方法——
  // 导出始终用原片（见 FeaturePanels.cs 头注释的分歧说明）。
  public string EffectiveSource(){if(ProxyEnabled){if(string.IsNullOrEmpty(ProxyPath)||!File.Exists(ProxyPath))throw new Exception("代理已开启，但代理文件缺失："+(string.IsNullOrEmpty(ProxyPath)?"（未生成）":ProxyPath)+"。请重新生成代理，或关闭代理。");return ProxyPath;}return Source;}
  public List<PointerSample> TimelinePointer() {
   var result=new List<PointerSample>(); double offset=0;
   int segment=0;foreach(var cut in Cuts){var prior=Pointer.LastOrDefault(p=>p.Time<=cut.Start);if(prior!=null)result.Add(new PointerSample {Time=offset,X=prior.X,Y=prior.Y,Visible=prior.Visible,CursorKind=prior.CursorKind,Segment=segment*100000+prior.Segment});foreach(var p in Pointer.Where(p=>p.Time>=cut.Start&&p.Time<cut.End)) result.Add(new PointerSample {Time=offset+(p.Time-cut.Start)/cut.Speed,X=p.X,Y=p.Y,Click=p.Click,Visible=p.Visible,CursorKind=p.CursorKind,Segment=segment*100000+p.Segment});offset+=cut.Length;segment++;}
   return result.OrderBy(p=>p.Time).ToList();
  }
  public void GenerateZooms() {
   Zooms.RemoveAll(z=>z.Automatic);var events=TimelinePointer().Where(p=>p.Visible).ToList();var clicks=events.Where(p=>p.Click).ToList();int index=0;
   // Port of the current planner's temporal grouping, lead time, hold extension,
   // and connected envelopes (RecorderCore/AutoZoomPlanner.swift).
   while(index<clicks.Count) {
    var first=clicks[index];var last=first;index++;
    while(index<clicks.Count&&clicks[index].Time-last.Time<=1.4)last=clicks[index++];
    double start=Math.Max(0,first.Time-.7*.18),hold=Math.Max(last.Time+.9,start+.7);
    double activity=last.Time;PointerSample previous=last;
    foreach(var p in events.Where(p=>p.Time>last.Time)) {
     if(p.Time-activity>1.4)break;
     if(p.Click||Math.Abs(p.X-previous.X)+Math.Abs(p.Y-previous.Y)>.001){activity=p.Time;previous=p;}
    }
    hold=Math.Max(hold,activity+.55);if(index<clicks.Count)hold=Math.Min(hold,Math.Max(start+.1,clicks[index].Time-.126));
    var z=new Zoom {Start=start,End=Math.Min(Length,hold+.7),X=Clamp(first.X,.12,.88),Y=Clamp(first.Y,.12,.88),Automatic=true,Scale=Style.ZoomScale};
    if(z.End-z.Start>.02)Zooms.Add(z);
   }
   Zooms=Zooms.OrderBy(z=>z.Start).ToList();
  }
 }
 public class Pose { public double Zoom=1,X=.5,Y=.5; public double Opacity=1; public double OpeningScale=1; }
 public partial class MotionEvaluator {
  readonly EditDocument doc; readonly List<PointerSample> pointers;readonly PointerSample[] clicks;readonly StableFollow follow;
  public MotionEvaluator(EditDocument d){doc=d;pointers=d.TimelinePointer();clicks=pointers.Where(p=>p.Click&&p.Visible).ToArray();if(d.Style!=null&&d.Style.AutoZoom&&d.Style.Follow&&d.Zooms!=null&&d.Zooms.Any(z=>z.Automatic))follow=new StableFollow(pointers);}
  public static double Ease(double t,string easing){t=EditDocument.Clamp(t,0,1);if(t==0||t==1)return t;if(easing=="linear")return t;if(easing=="smooth")return t*t*(3-2*t);
   // RecorderCore/ZoomAnimation.swift springProgress, original MotionStyle defaults.
   const double mass=2.4,stiffness=210,damping=42;double omega=Math.Sqrt(stiffness/mass),zeta=Math.Min(damping/(2*Math.Sqrt(stiffness*mass)),.9999),wd=omega*Math.Sqrt(1-zeta*zeta);
   Func<double,double> response=s=>1-Math.Exp(-zeta*omega*s)*(Math.Cos(wd*s)+zeta*omega/wd*Math.Sin(wd*s));return EditDocument.Clamp(response(t*.72)/response(.72),0,1);
  }
  public Pose At(double t) {
   var pose=new Pose();
   foreach(var z in doc.Zooms){if(t<z.Start||t>z.End||(z.Automatic&&!doc.Style.AutoZoom))continue;
    double transition=Math.Min(z.Transition,(z.End-z.Start)/2);
    double v=t<z.Start+transition?Ease((t-z.Start)/transition,z.Easing):t>z.End-transition?1-Ease((t-z.End+transition)/transition,z.Easing):1;
    double scale=1+(z.Scale-1)*v;if(scale<pose.Zoom)continue;pose.Zoom=scale;pose.X=z.X;pose.Y=z.Y;
    if(z.Automatic&&doc.Style.Follow&&pointers.Count>0){
     double x,y;if(follow!=null&&follow.At(t,out x,out y)){pose.X=x;pose.Y=y;}
    }
   }
   double half=.5/pose.Zoom;pose.X=EditDocument.Clamp(pose.X,half,1-half);pose.Y=EditDocument.Clamp(pose.Y,half,1-half);
   if(doc.Style.Opening>0&&t<doc.Style.Opening){double f=EditDocument.Clamp(t/doc.Style.Opening,0,1);f=f*f*(3-2*f);pose.Opacity=f;pose.OpeningScale=.92+.08*f;}
   return pose;
  }
 }
 public class SceneLayout {
  public RectangleF Frame; public RectangleF Video; public float Radius; public float Header;
  public static double Aspect(EditDocument d){switch(d.Style.Ratio){case "1:1":return 1;case "9:16":return 9.0/16;case "4:3":return 4.0/3;case "适应":return (double)d.Width/d.Height;default:return 16.0/9;}}
  public static int[] OutputSize(EditDocument d,int shortEdge){double ratio=Aspect(d);return ratio>=1?new[]{(int)Math.Round(shortEdge*ratio/2)*2,shortEdge}:new[]{shortEdge,(int)Math.Round(shortEdge/ratio/2)*2};}
  public static SceneLayout Make(EditDocument d,int width,int height,Pose p) {
   double unit=Math.Min(width,height)/720.0,pad=d.Style.Padding*unit;
   double availableW=Math.Max(16,width-pad*2),availableH=Math.Max(16,height-pad*2),header=d.Style.Frame=="none"?0:24*unit;
   double ratio=(double)d.Width/d.Height;double h=Math.Min(availableH-header,availableW/ratio),w=h*ratio;
   double scale=d.Style.Scale*p.OpeningScale;w*=scale;h*=scale;header*=scale;
   double x=(width-w)*d.Style.X,y=(height-h-header)*d.Style.Y;
   return new SceneLayout {Frame=new RectangleF((float)x,(float)y,(float)w,(float)(h+header)),Video=new RectangleF((float)x,(float)(y+header),(float)w,(float)h),Radius=(float)(d.Style.Radius*unit),Header=(float)header};
  }
 }
 static class StudioMedia {
  public static EditDocument Import(string path) {
   using(var p=Media.Start("ffprobe","-v error -show_entries stream=codec_type,width,height,avg_frame_rate:format=duration -of json "+Media.Q(path),true)) {
    var err=p.StandardError.ReadToEndAsync();string text=p.StandardOutput.ReadToEnd();p.WaitForExit();if(p.ExitCode!=0)throw new Exception(err.Result);
    var json=EditDocument.Serializer().Deserialize<Dictionary<string,object>>(text);var streams=(System.Collections.ArrayList)json["streams"];
    var video=streams.Cast<Dictionary<string,object>>().FirstOrDefault(s=>(string)s["codec_type"]=="video");if(video==null)throw new Exception("文件中没有视频轨道。");
    var format=(Dictionary<string,object>)json["format"];double duration=double.Parse(format["duration"].ToString(),CultureInfo.InvariantCulture);
    var d=new EditDocument {Source=Path.GetFullPath(path),Name=Path.GetFileNameWithoutExtension(path),Width=Convert.ToInt32(video["width"]),Height=Convert.ToInt32(video["height"]),Duration=duration,Audio=streams.Cast<Dictionary<string,object>>().Any(s=>(string)s["codec_type"]=="audio")};
    object rate;if(video.TryGetValue("avg_frame_rate",out rate)){var parts=rate.ToString().Split('/');double numerator,denominator;if(parts.Length==2&&double.TryParse(parts[0],NumberStyles.Float,CultureInfo.InvariantCulture,out numerator)&&double.TryParse(parts[1],NumberStyles.Float,CultureInfo.InvariantCulture,out denominator)&&denominator>0&&numerator>0)d.FrameRate=numerator/denominator;}
    d.Cuts.Add(new Cut {Start=0,End=duration});return d;
   }
  }
  public static void Run(string args,CancellationToken token) {
   using(var p=Media.Start("ffmpeg",args,false))using(token.Register(()=>{try{p.Kill();}catch{}})) {var errors=p.StandardError.ReadToEndAsync();p.StandardInput.Close();p.WaitForExit();token.ThrowIfCancellationRequested();if(p.ExitCode!=0)throw new Exception(errors.Result);}
  }
  public static byte[] Frame(string path,double time,int width,CancellationToken token=default(CancellationToken),string colorVf="") {
   token.ThrowIfCancellationRequested();using(var p=Media.Start("ffmpeg","-v error -threads 2 -filter_threads 1 -ss "+Media.N(Math.Max(0,time))+" -i "+Media.Q(path)+" -frames:v 1 -vf scale="+width+":-2"+colorVf+" -threads 1 -f image2pipe -vcodec png pipe:1",true))using(token.Register(()=>{try{if(!p.HasExited)p.Kill();}catch{}})) {
    var errors=p.StandardError.ReadToEndAsync();using(var ms=new MemoryStream()){p.StandardOutput.BaseStream.CopyTo(ms);p.WaitForExit();token.ThrowIfCancellationRequested();if(p.ExitCode!=0)throw new Exception(errors.Result);return ms.ToArray();}
   }
  }
  // W3：时间线中间片滤镜。单源老行为不变；多机位时按切换点把 Cut 切成段，
  // 每段从对应角度文件 trim（视频），音频一律取角度 0（主源）同段范围；
  // 空隙段视频用 color 黑场、音频用 anullsrc。concat 段数 = 视频段数 =
  // 音频段数，顺序一致。
  public static string Filter(EditDocument doc,bool audio) {
   var s=new StringBuilder();var tracks=new StringBuilder();var inputs=new Dictionary<string,int>();
   // 输入 0 固定是主源（角度 0），音频一律取它；其余角度按出现顺序编号。
   inputs[doc.Source]=0;
   Func<string,int> inputOf=file=>{int i;if(inputs.TryGetValue(file,out i))return i;i=inputs.Count;inputs[file]=i;return i;};
   var segs=MulticamModel.BuildSegments(doc);
   for(int i=0;i<segs.Count;i++){var g=segs[i];
    if(g.Gap){s.Append("color=c=black:s="+doc.Width+"x"+doc.Height+":r="+Media.N(doc.FrameRate)+":d="+Media.N(g.Length)+"[v"+i+"];\n");if(audio)s.Append("anullsrc=r=48000:cl=stereo:d="+Media.N(g.Length)+"[a"+i+"];\n");}
    else{int v=inputOf(g.File);s.Append("["+v+":v]trim=start="+Media.N(g.SourceStart)+":end="+Media.N(g.SourceEnd)+",setpts=(PTS-STARTPTS)/"+Media.N(g.Speed)+"[v"+i+"];\n");
     if(audio)s.Append("[0:a:0]atrim=start="+Media.N(g.SourceStart)+":end="+Media.N(g.SourceEnd)+",asetpts=PTS-STARTPTS,atempo="+Media.N(g.Speed)+",apad,atrim=duration="+Media.N(g.Length)+"[a"+i+"];\n");}
    tracks.Append("[v"+i+"]");if(audio)tracks.Append("[a"+i+"]");}
   s.Append(tracks+"concat=n="+segs.Count+":v=1:a="+(audio?1:0)+"[video]"+(audio?"[audio]":"")+"\n");
   // 多输入时调用方须按 InputFiles(doc) 的顺序把 -i 排在 filter_complex 之前。
   return s.ToString();
  }
  // Filter() 用到的输入文件列表（顺序与 filter 内的 [n:v] 编号一致）。
  public static List<string> InputFiles(EditDocument doc){
   var files=new List<string>{doc.Source};foreach(var g in MulticamModel.BuildSegments(doc))if(!g.Gap&&!files.Contains(g.File))files.Add(g.File);
   return files;
  }
 }
 static class StudioRenderer {
  sealed class ShadowCache:IDisposable {
   Bitmap layer;RectangleF previous;float radius,unit;double strength,opacity;bool seen;
   public bool Draw(Graphics target,RectangleF frame,float corner,float scale,double shadow,double alpha,int width,int height){bool same=seen&&previous==frame&&radius==corner&&unit==scale&&strength==shadow&&opacity==alpha;if(!same){if(layer!=null){layer.Dispose();layer=null;}previous=frame;radius=corner;unit=scale;strength=shadow;opacity=alpha;seen=true;return false;}if(layer==null){layer=new Bitmap(width,height,PixelFormat.Format32bppArgb);using(var g=Graphics.FromImage(layer)){g.SmoothingMode=target.SmoothingMode;DrawShadow(g,frame,corner,scale,shadow,alpha);}}target.DrawImageUnscaled(layer,0,0);return true;}
   public void Dispose(){if(layer!=null)layer.Dispose();}
  }
  static void DrawShadow(Graphics g,RectangleF frame,float radius,float unit,double shadow,double opacity){for(int i=10;i>=1;i--){var r=frame;float spread=i*unit*1.2f;r.Inflate(spread,spread);r.Y+=5*unit;using(var path=Round(r,radius+spread))using(var b=new SolidBrush(Color.FromArgb((int)(shadow*.13*opacity),0,0,0)))g.FillPath(b,path);}}
  public static GraphicsPath Round(RectangleF r,float radius) {if(radius<.1){var p=new GraphicsPath();p.AddRectangle(r);return p;}return Renderer.Rounded(r,Math.Min(radius,Math.Min(r.Width,r.Height)/2));}
  public static Color ColorOf(string hex){try{return ColorTranslator.FromHtml(hex);}catch{return Color.White;}}
  static void DrawBackground(Graphics g,EditDocument doc,int width,int height,Image wallpaper){
   var a=doc.Style;g.Clear(ColorOf(a.ColorA));
   if(a.Background=="gradient")using(var brush=new LinearGradientBrush(new Rectangle(0,0,width,height),ColorOf(a.ColorA),ColorOf(a.ColorB),45))g.FillRectangle(brush,0,0,width,height);
   else if(a.Background=="image"&&wallpaper!=null){double s=Math.Max((double)width/wallpaper.Width,(double)height/wallpaper.Height);g.DrawImage(wallpaper,new RectangleF((float)((width-wallpaper.Width*s)/2),(float)((height-wallpaper.Height*s)/2),(float)(wallpaper.Width*s),(float)(wallpaper.Height*s)));}
   if(a.Background=="dots"){float step=Math.Max(8,width/80f);using(var dot=new SolidBrush(Color.FromArgb(48,80,85,88)))for(float x=step/2;x<width;x+=step)for(float y=step/2;y<height;y+=step)g.FillEllipse(dot,x,y,1.2f,1.2f);}
  }
  // W1 GPU 预览：静态铬层（与时间无关的部分），与 DrawScreen 的静态部分保持一致。
  // 播放时 GPU 把解码帧贴在铬层之下（视频区已抠成透明）；导出仍走 DrawCore/DrawScreen，不用这里。
  // 只在无贴图/柔化/聚光、无光标、无开场、无屏幕 3D 时可用（见 EditorApp.IsGpuEligible）。
  public static Bitmap RenderChrome(EditDocument doc,int width,int height,Image wallpaper){
   var a=doc.Style;var canvas=new Bitmap(width,height,PixelFormat.Format32bppArgb);
   using(var g=Graphics.FromImage(canvas)){
    g.InterpolationMode=InterpolationMode.HighQualityBicubic;g.SmoothingMode=SmoothingMode.AntiAlias;
    DrawBackground(g,doc,width,height,wallpaper);
    var layout=SceneLayout.Make(doc,width,height,new Pose());float unit=Math.Min(width,height)/720f;
    if(a.Shadow>0)DrawShadow(g,layout.Frame,layout.Radius,unit,a.Shadow,1.0);
    using(var outline=Round(layout.Frame,layout.Radius)){
     var state=g.Save();g.SetClip(outline);
     using(var b=new SolidBrush(Color.FromArgb(255,a.Frame=="dark"?Color.FromArgb(42,43,45):Color.FromArgb(243,243,245))))g.FillRectangle(b,layout.Frame);
     if(layout.Header>0){Color[] colors={Color.FromArgb(255,96,86),Color.FromArgb(255,188,46),Color.FromArgb(40,200,64)};for(int i=0;i<3;i++)using(var dot=new SolidBrush(colors[i]))g.FillEllipse(dot,layout.Frame.X+(9+10*i)*unit,layout.Frame.Y+layout.Header/2-3*unit,6*unit,6*unit);
      using(var font=new Font("Microsoft YaHei UI",8*unit,GraphicsUnit.Pixel))using(var text=new SolidBrush(Color.FromArgb(255,130,132,136)))using(var format=new StringFormat {Alignment=StringAlignment.Center,LineAlignment=StringAlignment.Center})g.DrawString(doc.Name,font,text,new RectangleF(layout.Frame.X,layout.Frame.Y,layout.Frame.Width,layout.Header),format);}
     g.Restore(state);
     if(a.Border>0)using(var pen=new Pen(Color.FromArgb(100,90,90,95),(float)(a.Border*unit)))g.DrawPath(pen,outline);
    }
    // 把视频可见区抠成透明（与圆角框取交集，圆角处仍由框面盖住视频方角）。
    using(var region=new Region(Round(layout.Frame,layout.Radius))){region.Intersect(layout.Video);g.Clip=region;g.Clear(Color.Transparent);}
   }
   return canvas;
  }
  internal sealed class SceneCache:IDisposable {
   readonly Bitmap background;readonly ShadowCache shadow=new ShadowCache();
   public SceneCache(EditDocument doc,int width,int height,Image wallpaper){background=new Bitmap(width,height,PixelFormat.Format32bppArgb);using(var g=Graphics.FromImage(background)){g.InterpolationMode=InterpolationMode.HighQualityBicubic;g.SmoothingMode=SmoothingMode.AntiAlias;DrawBackground(g,doc,width,height,wallpaper);}}
   public void Render(Graphics g,Bitmap frame,EditDocument doc,MotionEvaluator motion,double time,int width,int height,Image wallpaper,Bitmap canvas,Func<double,Bitmap> cameraFrame=null){DrawCore(g,frame,doc,motion,time,width,height,wallpaper,canvas,background,shadow,cameraFrame);}
   public void Dispose(){shadow.Dispose();background.Dispose();}
  }
  public static void Draw(Graphics g,Bitmap frame,EditDocument doc,MotionEvaluator motion,double time,int width,int height,Image wallpaper,Bitmap canvas=null,Func<double,Bitmap> cameraFrame=null){DrawCore(g,frame,doc,motion,time,width,height,wallpaper,canvas,null,null,cameraFrame);}
  static void DrawCore(Graphics g,Bitmap frame,EditDocument doc,MotionEvaluator motion,double time,int width,int height,Image wallpaper,Bitmap canvas,Bitmap background,ShadowCache shadowCache,Func<double,Bitmap> cameraFrame=null) {
   var a=doc.Style;if(background==null)DrawBackground(g,doc,width,height,wallpaper);else g.DrawImageUnscaled(background,0,0);
   var pose=motion.At(time);pose.Opacity*=1-EffectRenderer.Suppression(doc,time);var layout=SceneLayout.Make(doc,width,height,pose);float unit=Math.Min(width,height)/720f;
   var projection=new ScreenProjection(layout.Frame,ScreenMotionModels.At(doc,time),width,height);
   if(projection.Identity(layout.Frame)){DrawScreen(g,frame,doc,motion,time,width,height,pose,layout,shadowCache);EffectRenderer.Spotlights(g,doc,time,layout,pose,width,height);}
   else {var r=layout.Frame;float expansion=(16+(float)a.Border)*unit;r.Inflate(expansion,expansion);var bounds=Rectangle.FromLTRB((int)Math.Floor(r.Left),(int)Math.Floor(r.Top),(int)Math.Ceiling(r.Right),(int)Math.Ceiling(r.Bottom));using(var card=new Bitmap(bounds.Width,bounds.Height,PixelFormat.Format32bppPArgb)){
    using(var cg=Graphics.FromImage(card)){cg.Clear(Color.Transparent);cg.TranslateTransform(-bounds.X,-bounds.Y);cg.InterpolationMode=g.InterpolationMode;cg.SmoothingMode=g.SmoothingMode;DrawScreen(cg,frame,doc,motion,time,width,height,pose,layout);using(var mask=Round(layout.Frame,layout.Radius)){cg.SetClip(mask);EffectRenderer.Spotlights(cg,doc,time,layout,pose,width,height);}}
    using(var projected=projection.Warp(card,bounds,width,height))g.DrawImageUnscaled(projected,0,0);
   }
   }EffectRenderer.Backdrop(g,canvas,doc,time,width,height);EffectRenderer.Stickers(g,doc,motion,time,width,height);CameraOverlay.Draw(g,doc,time,layout,width,height,cameraFrame);DrawSubtitles(g,doc,time,layout,width,height);
  }
  // W3 字幕烧录（GDI+，与贴图/光标同一条路）：预览 Compose 与导出 DrawCore
  // 都走这里，所以烧录效果在预览里看得到、导出里也一定有。主行白色在下，
  // 第二语言黄色在上；时间是时间线时间（与边车一致）。
  static void DrawSubtitles(Graphics g,EditDocument doc,double time,SceneLayout layout,int width,int height){
   if(!doc.SubtitleBurnIn||doc.Subtitles==null)return;
   SubtitleCue cue=null;foreach(var c in doc.Subtitles)if(time>=c.Start&&time<c.End){cue=c;break;}
   if(cue==null)return;
   var v=layout.Video;float unit=Math.Min(width,height)/720f;
   using(var format=new StringFormat {Alignment=StringAlignment.Center,LineAlignment=StringAlignment.Far})
   using(var black=new SolidBrush(Color.FromArgb(220,0,0,0)))
   using(var white=new SolidBrush(Color.White))
   using(var yellow=new SolidBrush(Color.Yellow)){
    float primarySize=Math.Max(14,v.Height*.055f),secondSize=Math.Max(12,v.Height*.045f);
    var rect=new RectangleF(v.X,v.Y,v.Width,v.Height-8*unit);
    PointF[] offsets={new PointF(-2,-2),new PointF(2,-2),new PointF(-2,2),new PointF(2,2)};
    if(!string.IsNullOrWhiteSpace(cue.Text2)){
     using(var f2=new Font("Microsoft YaHei UI",secondSize,FontStyle.Bold,GraphicsUnit.Pixel)){
      var r2=new RectangleF(rect.X,rect.Y,rect.Width,rect.Height-primarySize-4*unit);
      foreach(var o in offsets){var shifted=r2;shifted.Offset(o.X,o.Y);g.DrawString(cue.Text2,f2,black,shifted,format);}
      g.DrawString(cue.Text2,f2,yellow,r2,format);
     }
    }
    if(!string.IsNullOrWhiteSpace(cue.Text)){
     using(var f1=new Font("Microsoft YaHei UI",primarySize,FontStyle.Bold,GraphicsUnit.Pixel)){
      foreach(var o in offsets){var shifted=rect;shifted.Offset(o.X,o.Y);g.DrawString(cue.Text,f1,black,shifted,format);}
      g.DrawString(cue.Text,f1,white,rect,format);
     }
    }
   }
  }
  static void DrawScreen(Graphics g,Bitmap frame,EditDocument doc,MotionEvaluator motion,double time,int width,int height,Pose pose,SceneLayout layout,ShadowCache shadowCache=null) {
   var a=doc.Style;float unit=Math.Min(width,height)/720f;
   if(pose.Opacity>.001){
   if(a.Shadow>0&&(shadowCache==null||!shadowCache.Draw(g,layout.Frame,layout.Radius,unit,a.Shadow,pose.Opacity,width,height)))DrawShadow(g,layout.Frame,layout.Radius,unit,a.Shadow,pose.Opacity);
   using(var outline=Round(layout.Frame,layout.Radius)){
    var state=g.Save();g.SetClip(outline);using(var b=new SolidBrush(Color.FromArgb((int)(255*pose.Opacity),a.Frame=="dark"?Color.FromArgb(42,43,45):Color.FromArgb(243,243,245))))g.FillRectangle(b,layout.Frame);
    var v=layout.Video;var crop=new RectangleF((float)((pose.X-.5/pose.Zoom)*frame.Width),(float)((pose.Y-.5/pose.Zoom)*frame.Height),(float)(frame.Width/pose.Zoom),(float)(frame.Height/pose.Zoom));
    using(var softened=EffectRenderer.ApplyBlur(frame,doc,time)){var source=softened??frame;if(pose.Opacity<.999){using(var attrs=new ImageAttributes()){var matrix=new ColorMatrix();matrix.Matrix33=(float)pose.Opacity;attrs.SetColorMatrix(matrix);g.DrawImage(source,Rectangle.Round(v),crop.X,crop.Y,crop.Width,crop.Height,GraphicsUnit.Pixel,attrs);}}else g.DrawImage(source,v,crop,GraphicsUnit.Pixel);}
    EffectRenderer.Cursor(g,doc,motion,time,layout,pose,width,height);
    if(layout.Header>0){Color[] colors={Color.FromArgb(255,96,86),Color.FromArgb(255,188,46),Color.FromArgb(40,200,64)};for(int i=0;i<3;i++)using(var b=new SolidBrush(Color.FromArgb((int)(255*pose.Opacity),colors[i])))g.FillEllipse(b,layout.Frame.X+(9+10*i)*unit,layout.Frame.Y+layout.Header/2-3*unit,6*unit,6*unit);
     using(var font=new Font("Microsoft YaHei UI",8*unit,GraphicsUnit.Pixel))using(var b=new SolidBrush(Color.FromArgb((int)(255*pose.Opacity),130,132,136)))using(var format=new StringFormat {Alignment=StringAlignment.Center,LineAlignment=StringAlignment.Center})g.DrawString(doc.Name,font,b,new RectangleF(layout.Frame.X,layout.Frame.Y,layout.Frame.Width,layout.Header),format);}
    g.Restore(state);if(a.Border>0)using(var pen=new Pen(Color.FromArgb((int)(100*pose.Opacity),90,90,95),(float)(a.Border*unit)))g.DrawPath(pen,outline);
   }
   }
  }
  // W3 混音台导出音频参数（roles.ts 的 roleFilter 规则；音乐床用 amix）。
  // 只有主音轨、无增益/声像/总增益时，返回与老版本逐字一致的 -af volume=，
  // 老项目导出行为零变化。extraInputs 是追加的音乐输入（-stream_loop -1 -i …），
  // 由调用方拼在 -i <media> 之后、-map 之前。
  static string AudioArgs(EditDocument doc,string media,out string extraInputs){
   extraInputs="";
   var music=MixerAudio.MusicChannels(doc);
   var source=doc.Audio?MixerAudio.SourceChannel(doc):null;
   if(source==null&&music.Count==0)return "-an ";
   bool plain=source!=null&&music.Count==0&&Math.Abs(doc.MasterGainDb)<.000001&&Math.Abs(source.GainDb)<.000001&&source.Pan==0;
   if(plain)return "-map 1:a:0 -af volume="+Media.N(doc.Style.Volume)+" -c:a aac ";
   if(music.Count==0){
    int channels=Media.AudioChannels(media);
    if(doc.Style.Volume<=.001)return "-map 1:a:0 -af volume=0 -c:a aac ";
    double totalDb=20*Math.Log10(doc.Style.Volume)+doc.MasterGainDb+source.GainDb;
    var ch=new MixerChannel {Role="对话",GainDb=totalDb,Pan=source.Pan};
    return "-map 1:a:0 -af "+MixerAudio.RoleFilter(ch,false,channels)+" -c:a aac ";
   }
   var graph=new StringBuilder();var labels=new List<string>();
   if(source!=null){
    int channels=Media.AudioChannels(media);
    bool muted=doc.Style.Volume<=.001;
    double totalDb=muted?0:20*Math.Log10(doc.Style.Volume)+doc.MasterGainDb+source.GainDb;
    var ch=new MixerChannel {Role="对话",GainDb=totalDb,Pan=source.Pan};
    graph.Append("[1:a]"+MixerAudio.RoleFilter(ch,muted,channels)+"[a0];");labels.Add("[a0]");
   }
   for(int i=0;i<music.Count;i++){
    var m=music[i];int inputIndex=2+i;
    extraInputs+=" -stream_loop -1 -i "+Media.Q(m.SourcePath);
    int mch=Media.AudioChannels(m.SourcePath);
    var ch=new MixerChannel {Role=m.Role,GainDb=m.GainDb+doc.MasterGainDb,Pan=m.Pan};
    graph.Append("["+inputIndex+":a]"+MixerAudio.RoleFilter(ch,false,mch)+"[a"+(i+1)+"];");labels.Add("[a"+(i+1)+"]");
   }
   graph.Append(string.Join("",labels.ToArray())+"amix=inputs="+labels.Count+":duration=first:normalize=0,atrim=duration="+Media.N(doc.Length)+"[aout]");
   return "-filter_complex "+Media.Q(graph.ToString())+" -map [aout] -c:a aac ";
  }
  public static void Export(EditDocument doc,string output,int height,int fps,Action<double,string> progress,CancellationToken token,Action<string> diagnostics=null) {
   doc.Validate();if(File.Exists(output))throw new Exception("请选择一个新的导出文件名。");
   var size=SceneLayout.OutputSize(doc,height);int width=size[0];height=size[1];
   string work=Path.Combine(Path.GetDirectoryName(output),".dogsc-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(work);
   Process decoder=null,encoder=null;CameraFrameStream cameraStream=null;
   try {
    string timeline=Path.Combine(work,"timeline.mp4"),filter=Path.Combine(work,"timeline.txt"),result=Path.Combine(work,"result.mp4");
    progress(0,"整理时间线");bool direct=doc.Cuts.Count==1&&Math.Abs(doc.Cuts[0].Speed-1)<.000001&&!doc.Cuts[0].Gap&&!MulticamModel.Active(doc);string media=direct?doc.Source:timeline;string selection=direct?"-ss "+Media.N(doc.Cuts[0].Start)+" -t "+Media.N(doc.Cuts[0].End-doc.Cuts[0].Start)+" ":"";
    if(!direct){File.WriteAllText(filter,StudioMedia.Filter(doc,doc.Audio),new UTF8Encoding(false));var inputs=string.Join(" ",StudioMedia.InputFiles(doc).Select(f=>"-i "+Media.Q(f)).ToArray());StudioMedia.Run("-v error -y "+inputs+" -/filter_complex "+Media.Q(filter)+" -map [video] "+(doc.Audio?"-map [audio] -c:a aac ":"")+"-c:v libx264 -preset ultrafast -crf 16 -pix_fmt yuv420p -r "+fps+" "+Media.Q(timeline),token);}
    token.ThrowIfCancellationRequested();progress(.1,"渲染画面与运镜");
    int dw=Math.Min(doc.Width,width);dw-=dw%2;int dh=Math.Max(2,(int)Math.Round((double)dw*doc.Height/doc.Width/2)*2);
    decoder=Media.Start("ffmpeg","-v error "+selection+"-i "+Media.Q(media)+" -an -vf "+(direct?"fps="+fps+",":"")+"scale="+dw+":"+dh+doc.Grade.VideoFilter()+" -pix_fmt bgra -f rawvideo pipe:1",true);var decodeError=decoder.StandardError.ReadToEndAsync();
    string musicInputs;string audioArgs=AudioArgs(doc,media,out musicInputs);
    encoder=Media.Start("ffmpeg","-v error -y -f rawvideo -pixel_format bgra -video_size "+width+"x"+height+" -framerate "+fps+" -i pipe:0 "+selection+"-i "+Media.Q(media)+musicInputs+" -map 0:v "+audioArgs+"-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -t "+Media.N(doc.Length)+" -movflags +faststart "+Media.Q(result),false);var encodeError=encoder.StandardError.ReadToEndAsync();
    using(token.Register(()=>{try{decoder.Kill();}catch{}try{encoder.Kill();}catch{}}))
    using(var source=new Bitmap(dw,dh,PixelFormat.Format32bppArgb))using(var canvas=new Bitmap(width,height,PixelFormat.Format32bppArgb))using(var g=Graphics.FromImage(canvas))
    using(var wall=doc.Style.Background=="image"&&File.Exists(doc.Style.ImagePath)?Image.FromFile(doc.Style.ImagePath):null)
    using(var background=new Bitmap(width,height,PixelFormat.Format32bppArgb))using(var shadowCache=new ShadowCache()){
     g.InterpolationMode=InterpolationMode.HighQualityBicubic;g.SmoothingMode=SmoothingMode.AntiAlias;
     using(var bg=Graphics.FromImage(background)){bg.InterpolationMode=g.InterpolationMode;bg.SmoothingMode=g.SmoothingMode;DrawBackground(bg,doc,width,height,wall);}
     var input=new byte[dw*dh*4];var bytes=new byte[width*height*4];int frame=0;long drawTicks=0,writeTicks=0;
     // W4：画中画开时用一条顺序流解码摄像头文件（与主画面逐帧对齐；失败只关画中画，不拦导出）。声明在 try 外，catch/finally 也能看见。
     try{if(doc.Camera!=null&&doc.Camera.Enabled&&File.Exists(doc.Camera.SourcePath))cameraStream=new CameraFrameStream(doc.Camera.SourcePath,fps);}catch{}
     using(var motion=new MotionEvaluator(doc)){
     while(true){token.ThrowIfCancellationRequested();int filled=0,count;while(filled<input.Length&&(count=decoder.StandardOutput.BaseStream.Read(input,filled,input.Length-filled))>0)filled+=count;
      if(filled==0)break;if(filled!=input.Length)throw new Exception("解码帧不完整。");
      var data=source.LockBits(new Rectangle(0,0,dw,dh),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);try{Marshal.Copy(input,0,data.Scan0,input.Length);}finally{source.UnlockBits(data);}
      long timeStart=diagnostics==null?0:Stopwatch.GetTimestamp();DrawCore(g,source,doc,motion,frame/(double)fps,width,height,wall,canvas,background,shadowCache,cameraStream==null?(Func<double,Bitmap>)null:(t=>cameraStream.FrameAt(t)));if(diagnostics!=null)drawTicks+=Stopwatch.GetTimestamp()-timeStart;
      data=canvas.LockBits(new Rectangle(0,0,width,height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);try{Marshal.Copy(data.Scan0,bytes,0,bytes.Length);}finally{canvas.UnlockBits(data);}
      timeStart=diagnostics==null?0:Stopwatch.GetTimestamp();encoder.StandardInput.BaseStream.Write(bytes,0,bytes.Length);if(diagnostics!=null)writeTicks+=Stopwatch.GetTimestamp()-timeStart;frame++;if(frame%15==0)progress(.1+.88*Math.Min(1,frame/(doc.Length*fps)),"渲染画面与运镜");
     }
     encoder.StandardInput.Close();decoder.WaitForExit();encoder.WaitForExit();token.ThrowIfCancellationRequested();
     if(frame==0||decoder.ExitCode!=0||encoder.ExitCode!=0)throw new Exception("导出失败："+decodeError.Result+encodeError.Result);if(diagnostics!=null)diagnostics("Frames: "+frame+"; rendering: "+(drawTicks/(double)Stopwatch.Frequency).ToString("F2")+" seconds; encoder input wait: "+(writeTicks/(double)Stopwatch.Frequency).ToString("F2")+" seconds.");}
     if(cameraStream!=null)cameraStream.Dispose();
    }
    File.Move(result,output);SubtitleFiles.WriteSidecar(doc,output);progress(1,"导出完成");
   }catch{if(cameraStream!=null)cameraStream.Dispose();token.ThrowIfCancellationRequested();throw;}finally{
    foreach(var p in new[]{decoder,encoder})if(p!=null){try{if(!p.HasExited)p.Kill();p.WaitForExit();}catch{}p.Dispose();}
    // Only delete the unique, explicitly created transaction directory.
    try{if(Directory.Exists(work))Directory.Delete(work,true);}catch{}
   }
  }
 }
}
