// W4 摄像头叠加（2026-11-18）：摄像头作为画中画轨叠在录屏上。
// C# 原生实现，TS 引擎只作规格/参照（桥接路线与 W3 相同）。
//
// 查到的结论（先查现状再定路线，见本文件头注释与构建日志）：
// - 代码里的 Camera 类（DogSC.Windows.cs）是虚拟运镜（跟随鼠标的缩放），
//   不是摄像头；EditorPolish.cs 的“摄像头”竖轨与 EditorPolishWindows.cs
//   录制浮条的摄像头/系统声音按钮此前都是 IsEnabled=false 的占位，
//   ToolTip 写明“尚未移植”。本批把摄像头按钮真正接上，系统声音按钮
//   只做检测、不接线（见下）。
// - 采集路线：不走 DirectShow COM interop，不引新库。整站录制本来就
//   是 shell 出 ffmpeg（CaptureEngine.cs），麦克风就是 -f dshow 音频
//   输入（RecorderWindow.Microphone 的枚举写法同款）。摄像头走同一条
//   路：ffmpeg -f dshow -i video="<设备名>" 录一份独立的 camera.mp4，
//   与屏幕录制并行、互不干扰；停止后自动挂为工程的画中画轨。
//   设备枚举同样走 ffmpeg -list_devices（与麦克风同款解析）。
//   这条路在云端 runner 上无法实测（runner 没有摄像头设备——
//   枚举返回空列表是预期行为），真机采集要等他电脑实测。
// - 画中画渲染：画在 DrawCore 里（贴图之后、字幕之前），与预览、
//   导出同一条路；形状蒙版圆形/圆角/矩形；时间按主画面源时间对齐
//   （SourceTime，与变速/重排一致）；空隙段不画。GPU 直通在画中画
//   开启时禁用（IsGpuEligible 同款排除逻辑，与贴图/字幕一致），
//   否则画中画会被跳过。
// - 帧来源分两种：暂停预览用单帧解码（CameraStillProvider，经
//   StudioMedia.Frame）；播放与导出用顺序流解码（CameraFrameStream，
//   一条 ffmpeg rawvideo 管道按帧推进，时间倒退时 -ss 重启）。
//   两种 provider 失败时都只返回 null/上一帧，绝不把 DrawCore 拖垮。
// - 系统声音（顺带查的同缺口，M4 第 91 行）：ffmpeg 没有 WASAPI
//   输入；不装虚拟声卡驱动的前提下唯一现成路子是声卡自带的
//   “立体声混音”（Stereo Mix）——它就是一个 dshow 音频设备，与
//   麦克风同一机制。检测函数在 CameraDevices 里；但接线要改录制
//   主路的 ffmpeg 音频图（第二路 dshow 输入 + amix），云端 runner
//   上没有该设备、无法验证，改主路有断录制的风险，所以本批只检测、
//   列清单，不硬接。见构建日志的收尾待办。
// - 录制暂停：摄像头与屏幕录制同步分段（每段一个 camera-segNNN.mp4，
//   停时用 RecordingTake.Assemble 同款 ffconcat 合并），段边界与屏
//   幕段对齐；摄像头启动有约 1 秒延迟，段首尾可能有 <0.1s 级的
//   对齐误差（见已知限制）。
// 本机 Linux 跑不了 WPF，验证全靠云端 windows-2025 构建 + --w4-test。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using DogSC.Windows;
using D=System.Drawing;
using Imaging=System.Drawing.Imaging;

namespace DogSC.Replica {
 // 画中画轨模型（存在工程文件里，随工程保存；老工程反序列化为 null，
 // Validate() 里补默认值）。X/Y 是画中画中心在视频区内的归一化位置，
 // Size 是宽度占视频区宽度的比例。
 public class CameraClip {
  public bool Enabled;
  public string SourcePath="";
  public string Device="";
  public double X=.78,Y=.72;
  public double Size=.28;
  public string Shape="circle";
 }
 // ---- 设备枚举（与 RecorderWindow.Microphone 同款 dshow 枚举）----
 public static class CameraDevices {
  public static List<string> ParseDevices(string text,string kind){
   var result=new List<string>();
   if(string.IsNullOrEmpty(text))return result;
   string marker="("+kind+")";
   foreach(string line in text.Split('\n')){
    if(!line.Contains(marker))continue;
    int begin=line.IndexOf('"'),end=line.LastIndexOf('"');
    if(begin<0||end<=begin)continue;
    string name=line.Substring(begin+1,end-begin-1);
    if(name.Length>0&&!result.Contains(name))result.Add(name);
   }
   return result;
  }
  public static List<string> ListDevices(string kind){
   try{
    using(var p=Media.Start("ffmpeg","-hide_banner -list_devices true -f dshow -i dummy",false)){
     string text=p.StandardError.ReadToEnd();p.WaitForExit();
     return ParseDevices(text,kind);
    }
   }catch{return new List<string>();}
  }
  public static List<string> ListVideoDevices(){return ListDevices("video");}
  public static List<string> ListAudioDevices(){return ListDevices("audio");}
  // 系统声音候选：声卡自带的立体声混音设备（与麦克风同一 dshow 机制）。
  public static bool IsSystemAudioCandidate(string name){
   if(string.IsNullOrEmpty(name))return false;
   string lower=name.ToLowerInvariant();
   return lower.Contains("stereo mix")||lower.Contains("stereomix")||name.Contains("立体声混音")||name.Contains("混音");
  }
  public static List<string> SystemAudioCandidates(){
   return ListAudioDevices().Where(n=>IsSystemAudioCandidate(n)).ToList();
  }
  public static string Survey(){
   var video=ListVideoDevices();
   var audio=ListAudioDevices();
   var candidates=audio.Where(n=>IsSystemAudioCandidate(n)).ToList();
   var text=new StringBuilder();
   text.Append("摄像头设备（DirectShow 视频）：" + (video.Count==0?"未找到":string.Join("、",video.ToArray())) + "\n");
   text.Append("音频设备（DirectShow 音频）：" + (audio.Count==0?"未找到":string.Join("、",audio.ToArray())) + "\n");
   text.Append("系统声音（立体声混音）：" + (candidates.Count==0?"未找到——系统声音采集待接线（见构建日志）；不装虚拟声卡驱动就没有这路输入":"已找到 "+string.Join("、",candidates.ToArray())+"，可作第二路 dshow 音频输入（混音接入仍待验证）"));
   return text.ToString();
  }
 }
 // ---- 摄像头录制（与屏幕录制并行的独立 ffmpeg 进程）----
 // 一段录制一个 camera-segNNN.mp4；Finish 时合并成 camera.mp4。
 // 失败只影响摄像头（录制主路继续），绝不抛到 ToggleRecording 外面。
 public sealed class CameraRecorder:IDisposable {
  readonly string device,folder;
  readonly List<string> segments=new List<string>();
  Process current;Task<string> currentErrors;int next;
  public CameraRecorder(string device,string folder){this.device=device;this.folder=folder;}
  public string DeviceName {get{return device;}}
  public bool IsRunning {get{return current!=null&&!current.HasExited;}}
  public async Task Start(){
   if(IsRunning)return;
   string seg=Path.Combine(folder,"camera-seg"+(next++).ToString("000")+".mp4");
   string[] attempts={
    "-hide_banner -y -nostats -loglevel warning -f dshow -video_size 1280x720 -framerate 30 -i "+Media.Q("video="+device)+" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +frag_keyframe+empty_moov+default_base_moof -r 30 "+Media.Q(seg),
    "-hide_banner -y -nostats -loglevel warning -f dshow -i "+Media.Q("video="+device)+" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +frag_keyframe+empty_moov+default_base_moof "+Media.Q(seg)
   };
   Exception last=null;
   foreach(var args in attempts){
    try{
     var p=Media.Start("ffmpeg",args,true);
     current=p;currentErrors=p.StandardError.ReadToEndAsync();
     await Task.Delay(900);
     if(!p.HasExited){segments.Add(seg);try{File.WriteAllText(Path.Combine(folder,"camera-device.txt"),device,new UTF8Encoding(false));}catch{}return;}
     string errors="";try{errors=await currentErrors;}catch{}
     try{p.Dispose();}catch{}
     current=null;last=new Exception("摄像头启动失败："+errors);
     try{if(File.Exists(seg))File.Delete(seg);}catch{}
    }catch(Exception ex){last=ex;current=null;}
   }
   throw last??new Exception("摄像头启动失败。");
  }
  public async Task Pause(){
   if(current==null)return;
   var p=current;current=null;
   try{p.StandardInput.WriteLine("q");p.StandardInput.Flush();}catch{}
   bool exited=false;
   try{exited=await Task.Run(()=>p.WaitForExit(5000));}catch{}
   if(!exited){try{p.Kill();await Task.Run(()=>p.WaitForExit());}catch{}}
   try{await currentErrors;}catch{}
   try{p.Dispose();}catch{}
  }
  public async Task<string> Finish(){
   await Pause();
   if(segments.Count==0)return null;
   string output=Path.Combine(folder,"camera.mp4");
   if(File.Exists(output))File.Delete(output);
   if(segments.Count==1){File.Move(segments[0],output);return output;}
   string list=Path.Combine(folder,"camera-segments.ffconcat");
   await RecordingTake.Assemble(segments,output,list);
   return output;
  }
  public void Dispose(){
   if(current==null)return;
   try{if(!current.HasExited)current.Kill();current.WaitForExit(3000);}catch{}
   try{current.Dispose();}catch{}current=null;
  }
 }
 // ---- 画中画帧来源：顺序流（播放/导出用）----
 public sealed class CameraFrameStream:IDisposable {
  readonly string path;readonly int fps,width,height;
  Process process;byte[] buffer;D.Bitmap frame;int nextIndex;bool disposed;
  public CameraFrameStream(string path,int fps,int width=320){
   this.path=path;this.fps=Math.Max(1,fps);this.width=width;
   var info=StudioMedia.Import(path);
   height=Math.Max(2,(int)Math.Round((double)width*info.Height/info.Width/2)*2);
   buffer=new byte[width*height*4];
   frame=new D.Bitmap(width,height,Imaging.PixelFormat.Format32bppArgb);
   Start(0);
  }
  void Start(double ss){
   StopProcess();
   process=Media.Start("ffmpeg","-v error -ss "+Media.N(Math.Max(0,ss))+" -i "+Media.Q(path)+" -an -vf fps="+fps+",scale="+width+":"+height+" -pix_fmt bgra -f rawvideo pipe:1",true);
   nextIndex=(int)Math.Floor(Math.Max(0,ss)*fps);
  }
  void StopProcess(){
   if(process==null)return;
   try{if(!process.HasExited)process.Kill();process.WaitForExit(3000);}catch{}
   try{process.Dispose();}catch{}process=null;
  }
  bool ReadOne(){
   if(process==null||process.HasExited)return false;
   try{
    int filled=0,count;
    while(filled<buffer.Length&&(count=process.StandardOutput.BaseStream.Read(buffer,filled,buffer.Length-filled))>0)filled+=count;
    if(filled!=buffer.Length)return false;
    var data=frame.LockBits(new D.Rectangle(0,0,width,height),Imaging.ImageLockMode.WriteOnly,Imaging.PixelFormat.Format32bppArgb);
    try{System.Runtime.InteropServices.Marshal.Copy(buffer,0,data.Scan0,buffer.Length);}finally{frame.UnlockBits(data);}
    nextIndex++;
    return true;
   }catch{return false;}
  }
  // 取覆盖 t 的那一帧；时间倒退（切段重排）时 -ss 重启。
  public D.Bitmap FrameAt(double t){
   if(disposed)return frame;
   try{
    if(frame!=null&&nextIndex>0&&t<(nextIndex-1)/(double)fps-.001)Start(t);
    if(nextIndex==0&&!ReadOne())return null;
    while(nextIndex/(double)fps<=t){if(!ReadOne())break;}
    return frame;
   }catch{return frame;}
  }
  public void Dispose(){if(disposed)return;disposed=true;StopProcess();if(frame!=null)frame.Dispose();}
 }
 // ---- 画中画帧来源：单帧（暂停预览用）----
 public sealed class CameraStillProvider:IDisposable {
  readonly string path;D.Bitmap last;double lastTime=-1;bool disposed;
  public CameraStillProvider(string path){this.path=path;}
  public D.Bitmap FrameAt(double t){
   if(disposed)return last;
   try{
    if(last!=null&&Math.Abs(t-lastTime)<.05)return last;
    byte[] bytes=StudioMedia.Frame(path,Math.Max(0,t),320);
    D.Bitmap next;
    using(var ms=new MemoryStream(bytes))next=new D.Bitmap(ms);
    if(last!=null)last.Dispose();
    last=next;lastTime=t;
    return last;
   }catch{return last;}
  }
  public void Dispose(){if(disposed)return;disposed=true;if(last!=null)last.Dispose();}
 }
 // ---- 画中画绘制（DrawCore 里调用，贴图之后、字幕之前）----
 public static class CameraOverlay {
  public static D.RectangleF PipRect(EditDocument doc,D.RectangleF video,int camW,int camH){
   var cam=doc.Camera;
   float w=(float)(video.Width*cam.Size);
   float h=w*camH/camW;
   float cx=(float)(video.X+cam.X*video.Width),cy=(float)(video.Y+cam.Y*video.Height);
   float x=Math.Max(video.X,Math.Min(video.Right-w,cx-w/2));
   float y=Math.Max(video.Y,Math.Min(video.Bottom-h,cy-h/2));
   return new D.RectangleF(x,y,w,h);
  }
  static D.Drawing2D.GraphicsPath ShapePath(D.RectangleF rect,string shape){
   var path=new D.Drawing2D.GraphicsPath();
   if(shape=="circle")path.AddEllipse(rect);
   else if(shape=="rounded"){
    float r=Math.Min(32,Math.Min(rect.Width,rect.Height)/2);
    path.AddArc(rect.X,rect.Y,r*2,r*2,180,90);
    path.AddArc(rect.Right-r*2,rect.Y,r*2,r*2,270,90);
    path.AddArc(rect.Right-r*2,rect.Bottom-r*2,r*2,r*2,0,90);
    path.AddArc(rect.X,rect.Bottom-r*2,r*2,r*2,90,90);
    path.CloseFigure();
   }
   else path.AddRectangle(rect);
   return path;
  }
  public static void Draw(D.Graphics g,EditDocument doc,double time,SceneLayout layout,int width,int height,Func<double,D.Bitmap> cameraFrame){
   var cam=doc.Camera;
   if(cam==null||!cam.Enabled||cameraFrame==null)return;
   double offset;
   if(doc.CutAt(time,out offset).Gap)return;
   D.Bitmap frame=null;
   try{int index;frame=cameraFrame(doc.SourceTime(time,out index));}catch{return;}
   if(frame==null)return;
   var rect=PipRect(doc,layout.Video,frame.Width,frame.Height);
   using(var path=ShapePath(rect,cam.Shape)){
    var state=g.Save();
    g.SetClip(path);
    g.DrawImage(frame,rect);
    g.Restore(state);
    using(var pen=new D.Pen(D.Color.FromArgb(200,255,255,255),2))g.DrawPath(pen,path);
   }
  }
 }
}
