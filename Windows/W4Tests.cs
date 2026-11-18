// W4 自测（2026-11-18）：--w4-test 入口，无窗口，纯逻辑 + 合成素材实测。
// 跑在云端构建里（build-test.yml 的 W4 checks 步），结果写
// Windows/bin/w4-results.txt（PASS: 开头才算过）。本地 Linux 跑不了 WPF，
// 但这些测试不碰窗口，只碰模型/备份/缓存/ffmpeg，所以云端是唯一可信的验证。
// 断言值来自 TS 引擎规格（medialib.ts / rendercache.ts）与本批的 C# 实现。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using DogSC.Windows;
using D=System.Drawing;
using Imaging=System.Drawing.Imaging;

namespace DogSC.Replica {
 static class W4Tests {
  static void Require(bool ok,string name){if(!ok)throw new Exception("W4 检查失败："+name);}
  static bool Near(double a,double b,double tol){return Math.Abs(a-b)<=tol;}
  public static void Run(){
   string folder=Path.Combine(Media.Root,"bin","w4-test");Directory.CreateDirectory(folder);
   string log=Path.Combine(Media.Root,"bin","w4-results.txt");
   string savedOverride=AutoSave.AppDataOverride;
   AutoSave.AppDataOverride=Path.Combine(folder,"appdata");
   try{
    // 0. 改名迁移：旧 DogSC.Windows 目录与旧录制目录整目录搬到 CatCut；两边都有时不动。
    string oldApp=Path.Combine(folder,"old-appdata");string newApp=Path.Combine(folder,"new-appdata");
    string oldRec=Path.Combine(folder,"old-rec");string newRec=Path.Combine(folder,"new-rec");
    Directory.CreateDirectory(oldApp);File.WriteAllText(Path.Combine(oldApp,"keep.txt"),"keep");
    Directory.CreateDirectory(oldRec);File.WriteAllText(Path.Combine(oldRec,"r.mp4"),"x");
    Require(AppIdentity.Migrate(oldApp,newApp,oldRec,newRec),"migration moves old dirs");
    Require(File.Exists(Path.Combine(newApp,"keep.txt"))&&File.Exists(Path.Combine(newRec,"r.mp4"))&&!Directory.Exists(oldApp)&&!Directory.Exists(oldRec),"migrated files land in new dirs, old dirs gone");
    Directory.CreateDirectory(oldApp);Directory.CreateDirectory(newApp);
    Require(!AppIdentity.Migrate(oldApp,newApp,oldRec,newRec),"migration leaves both dirs alone when new exists");
    // 1. 自动保存：写 7 份、最新一份可读回、只留 5 份。
    string source=Path.Combine(folder,"source.mp4");
    StudioMedia.Run("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac "+Media.Q(source),CancellationToken.None);
    var doc=StudioMedia.Import(source);doc.Name="w4-autosave";
    string dir=AutoSave.BackupDirFor(null,doc);
    var baseTime=new DateTime(2026,11,18,6,0,0,DateTimeKind.Local);
    string last=null;
    for(int i=0;i<7;i++)last=AutoSave.WriteBackup(doc,null,baseTime.AddSeconds(i));
    Require(AutoSave.ListBackups(dir).Count==7,"autosave wrote 7 backups");
    Require(AutoSave.LatestBackup(dir)==last,"latest backup is the 7th");
    var restored=EditDocument.Deserialize(File.ReadAllText(last));restored.Validate();
    Require(restored.Name=="w4-autosave"&&restored.Cuts.Count==doc.Cuts.Count,"autosave round-trip validates");
    Require(AutoSave.Prune(dir,5)==2&&AutoSave.ListBackups(dir).Count==5,"prune keeps 5");
    // 2. 崩溃检测：flag 与备份缺一不可（medialib.ts detectCrashRecovery 语义）。
    AutoSave.ClearUnclean();
    Require(!AutoSave.DetectCrash().Crashed,"no flag no backup is not a crash");
    AutoSave.MarkUnclean();
    var crash=AutoSave.DetectCrash();
    Require(crash.Crashed&&crash.Backup==AutoSave.LatestBackup(dir),"flag + backup is a crash");
    AutoSave.ClearUnclean();
    Require(!AutoSave.DetectCrash().Crashed,"clear removes the crash flag");
    // 3. 设置往返。
    AutoSave.IntervalMinutes=7;AutoSave.KeepCount=3;AutoSave.SaveSettings();
    AutoSave.IntervalMinutes=5;AutoSave.KeepCount=5;AutoSave.LoadSettings();
    Require(AutoSave.IntervalMinutes==7&&AutoSave.KeepCount==3,"settings round-trip");
    AutoSave.IntervalMinutes=AutoSave.DefaultIntervalMinutes;AutoSave.KeepCount=AutoSave.DefaultKeepCount;AutoSave.SaveSettings();
    // 4. 渲染缓存切片：变速拒绝、空隙可切、越界拒绝、键确定且随改动变。
    var speedDoc=StudioMedia.Import(source);
    speedDoc.Cuts=new List<Cut>{new Cut {Start=0,End=3,Speed=2}};
    bool threw=false;try{RenderCache.SliceProject(speedDoc,0,1);}catch(Exception ex){threw=ex.Message.Contains("变速");}
    Require(threw,"cache slice rejects speed cuts");
    var gapDoc=StudioMedia.Import(source);
    gapDoc.Cuts=new List<Cut>{new Cut {Start=0,End=1},new Cut {Gap=true,GapDuration=.5,Start=1,End=1},new Cut {Start=1,End=3}};
    Require(Near(RenderCache.SliceProject(gapDoc,.5,2).Length,1.5,.001),"cache slice across a gap keeps span length");
    threw=false;try{RenderCache.SliceProject(gapDoc,0,9);}catch{threw=true;}
    Require(threw,"cache slice rejects out-of-range spans");
    string key1=RenderCache.CacheKey(gapDoc,.5,2),key2=RenderCache.CacheKey(gapDoc,.5,2);
    Require(key1==key2&&key1.Length==16,"cache key deterministic 16 hex");
    gapDoc.Cuts[0].End=1.5;
    Require(RenderCache.CacheKey(gapDoc,.5,2)!=key1,"cache key changes after an edit");
    gapDoc.Cuts[0].End=1;
    // 5. 渲染缓存段落：首次 miss 渲染、第二次 hit 且 mtime 不变、清理删干净。
    string cacheDir=Path.Combine(folder,"rendercache");
    var first=RenderCache.RenderSegment(gapDoc,.5,2,cacheDir,(v,s)=>{},CancellationToken.None);
    Require(!first.Hit&&File.Exists(first.Task.File)&&Near(first.Duration,1.5,.05),"cache miss renders 1.5s span");
    var mtime=File.GetLastWriteTimeUtc(first.Task.File);
    var second=RenderCache.RenderSegment(gapDoc,.5,2,cacheDir,(v,s)=>{},CancellationToken.None);
    Require(second.Hit&&second.Task.File==first.Task.File&&File.GetLastWriteTimeUtc(first.Task.File)==mtime,"cache hit does no work");
    Require(RenderCache.ClearRenderCache(cacheDir)>=1&&RenderCache.CacheFileCount(cacheDir)==0,"clear removes cache mp4s");
    // 6. 摄像头/系统声音设备枚举：纯解析（固定样例）+ 真实枚举不抛错。
    string sample="[dshow @ 0000000000000000] DirectShow video devices\n[dshow @ 0000000000000000]  \"FaceTime HD Camera\"\n[dshow @ 0000000000000000]  \"USB Camera\"\n[dshow @ 0000000000000000] DirectShow audio devices\n[dshow @ 0000000000000000]  \"Microphone (Realtek Audio)\"\n[dshow @ 0000000000000000]  \"Stereo Mix (Realtek Audio)\"\n";
    var video=CameraDevices.ParseDevices(sample,"video");
    var audio=CameraDevices.ParseDevices(sample,"audio");
    Require(video.Count==2&&video[0]=="FaceTime HD Camera"&&video[1]=="USB Camera","dshow video parse");
    Require(audio.Count==2&&audio[1]=="Stereo Mix (Realtek Audio)","dshow audio parse");
    Require(CameraDevices.IsSystemAudioCandidate("Stereo Mix (Realtek Audio)")&&CameraDevices.IsSystemAudioCandidate("立体声混音")&&!CameraDevices.IsSystemAudioCandidate("Microphone (Realtek Audio)"),"stereo mix classification");
    var liveVideo=CameraDevices.ListVideoDevices();
    var liveAudio=CameraDevices.ListAudioDevices();
    Require(liveVideo!=null&&liveAudio!=null,"live device enumeration does not throw");
    // 7. 画中画校验：缺文件硬错（与代理同款语义）、关时不校验、形状/大小越界拒绝。
    var camDoc=StudioMedia.Import(source);
    camDoc.Camera=new CameraClip {Enabled=true,SourcePath=Path.Combine(folder,"nope-camera.mp4")};
    threw=false;try{camDoc.Validate();}catch(Exception ex){threw=ex.Message.Contains("摄像头");}
    Require(threw,"enabled camera with missing file throws");
    camDoc.Camera.Enabled=false;camDoc.Validate();
    string camFile=Path.Combine(folder,"camera.mp4");
    StudioMedia.Run("-v error -y -f lavfi -i color=c=red:s=320x240:r=30:d=3 -c:v libx264 -preset ultrafast -pix_fmt yuv420p "+Media.Q(camFile),CancellationToken.None);
    camDoc.Camera=new CameraClip {Enabled=true,SourcePath=camFile,Shape="triangle"};
    threw=false;try{camDoc.Validate();}catch(Exception ex){threw=ex.Message.Contains("形状");}
    Require(threw,"bad camera shape throws");
    camDoc.Camera.Shape="circle";camDoc.Camera.Size=.9;
    threw=false;try{camDoc.Validate();}catch(Exception ex){threw=ex.Message.Contains("大小");}
    Require(threw,"bad camera size throws");
    camDoc.Camera.Size=.28;camDoc.Validate();
    // 8. 画中画绘制：红色摄像头帧画进暂停画面中心；无 provider 时不画也不抛错。
    var drawDoc=StudioMedia.Import(source);
    drawDoc.Camera=new CameraClip {Enabled=true,SourcePath=camFile};
    drawDoc.Style.Padding=0;drawDoc.Style.Frame="none";drawDoc.Style.Radius=0;drawDoc.Style.Shadow=0;
    using(var frameBytes=new MemoryStream(StudioMedia.Frame(source,1,640)))
    using(var frame=new D.Bitmap(frameBytes))
    using(var motion=new MotionEvaluator(drawDoc)){
     var layout=SceneLayout.Make(drawDoc,640,360,new Pose());
     var rect=CameraOverlay.PipRect(drawDoc,layout.Video,320,240);
     using(var canvas=new D.Bitmap(640,360,Imaging.PixelFormat.Format32bppArgb))
     using(var g=D.Graphics.FromImage(canvas)){
      g.SmoothingMode=D.Drawing2D.SmoothingMode.AntiAlias;
      using(var still=new CameraStillProvider(camFile)){
       StudioRenderer.Draw(g,frame,drawDoc,motion,1,640,360,null,canvas,t=>still.FrameAt(t));
       var pixel=canvas.GetPixel((int)(rect.X+rect.Width/2),(int)(rect.Y+rect.Height/2));
       Require(pixel.R>150&&pixel.G<100&&pixel.B<100,"PiP centre pixel is the red camera frame");
      }
      StudioRenderer.Draw(g,frame,drawDoc,motion,1,640,360,null,canvas,null);
     }
    }
    // 9. 摄像头顺序流：正向取帧、倒退 -ss 重启、越过结尾不抛错。
    using(var stream=new CameraFrameStream(camFile,30)){
     var f1=stream.FrameAt(.5);
     Require(f1!=null&&f1.Width==320,"camera stream forward frame");
     var centre=f1.GetPixel(160,120);
     Require(centre.R>150&&centre.G<100,"camera stream frame is red");
     var f2=stream.FrameAt(.2);
     Require(f2!=null&&f2.Width==320,"camera stream seek-back restarts");
     var f3=stream.FrameAt(10);
     Require(f3!=null,"camera stream past EOF returns last frame");
    }
    File.WriteAllText(log,"PASS: autosave 7 backups + latest round-trip + prune to 5; crash flag+backup semantics; settings round-trip; cache slice rejects speed/out-of-range, gap slice 1.5s, key deterministic 16 hex + changes on edit; cache miss renders 1.5s + hit keeps mtime + clear empties dir; dshow parse 2 video/2 audio + stereo mix classification + live enumeration no-throw; camera validation missing-file/shape/size; PiP red centre pixel + null provider no-throw; camera stream forward/seek-back/EOF; rename migration moves old dirs + leaves both alone when new exists.\nLive devices on this runner: video "+liveVideo.Count+", audio "+liveAudio.Count+" (no camera expected on a cloud runner).\n");
   }catch(Exception ex){File.WriteAllText(log,"FAIL\n"+ex);Environment.ExitCode=1;}
   finally{AutoSave.AppDataOverride=savedOverride;}
  }
 }
}
