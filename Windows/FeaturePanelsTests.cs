// W3 自测（2026-11-18）：--w3-test 入口，无窗口，纯逻辑 + 合成素材实测。
// 跑在云端构建里（build-test.yml 的 W3 feature-panel checks 步），结果写
// Windows/bin/w3-results.txt（PASS: 开头才算过）。本地 Linux 跑不了 WPF，
// 但这些测试不碰窗口，只碰模型/滤镜串/ffmpeg，所以云端是唯一可信的验证。
// 断言值全部来自 TS 引擎的探针实测（见 FeaturePanels.cs 头注释的出处）。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using DogSC.Windows;

namespace DogSC.Replica {
 static class FeaturePanelsTests {
  static void Require(bool ok,string name){if(!ok)throw new Exception("W3 检查失败："+name);}
  static bool Near(double a,double b,double tol){return Math.Abs(a-b)<=tol;}
  public static void Run(){
   string folder=Path.Combine(Media.Root,"bin","w3-test");Directory.CreateDirectory(folder);
   string log=Path.Combine(Media.Root,"bin","w3-results.txt");
   try{
    // 1. 字幕 SRT/VTT 往返 + 双语第二行。
    var cues=new List<SubtitleCue>{new SubtitleCue {Start=.2,End=1.5,Text="你好",Text2="Hello"},new SubtitleCue {Start=2,End=3,Text="再见"}};
    var back=SubtitleFiles.ParseSrt(SubtitleFiles.ToSrt(cues));
    Require(back.Count==2&&Near(back[0].Start,.2,.001)&&back[0].Text=="你好"&&back[0].Text2=="Hello"&&back[1].Text=="再见","SRT round-trip");
    var vtt=SubtitleFiles.ToVtt(cues);Require(vtt.StartsWith("WEBVTT"),"VTT header");
    var backV=SubtitleFiles.ParseVtt(vtt);Require(backV.Count==2&&Near(backV[1].End,3,.001)&&backV[0].Text2=="Hello","VTT round-trip");
    // 2. 双语 ASS：Sub2 样式在，marginV = 30+40+12 = 82（P3c 探针实测值）。
    string ass=SubtitleFiles.ToAss(cues,640,360);
    Require(ass.Contains("Style: Sub2,")&&ass.Contains(",82,1"),"dual ASS Sub2 marginV 82");
    Require(ass.Contains("Dialogue: 0,0:00:00.20,0:00:01.50,Sub,")&&ass.Contains("Dialogue: 0,0:00:00.20,0:00:01.50,Sub2,"),"dual ASS dialogues");
    var backA=SubtitleFiles.ParseAss(ass);Require(backA.Count==2&&backA[0].Text=="你好"&&backA[0].Text2=="Hello","ASS parse back");
    // 3. LUT：确定性 + 暗红 + 阴影色相+120 → (0.055,0.500,0.000)（TS P3d 探针实测）。
    var grade=new ColorGrade();grade.WheelHue[0]=120;
    string cube1=ColorLut.BuildCube(grade),cube2=ColorLut.BuildCube(grade);
    Require(cube1==cube2,"LUT deterministic");
    var spot=ColorLut.Apply(grade,.5,0,0);
    Require(Near(spot[0],.055,.02)&&Near(spot[1],.5,.02)&&Near(spot[2],0,.02),"LUT spot dark-red shadow hue+120");
    Require(Near(ColorLut.WheelWeight(0,.25),.94,.02)&&Near(ColorLut.WheelWeight(1,.25),.07,.02)&&Near(ColorLut.WheelWeight(2,.25),0,.02),"wheel weights L=0.25");
    // 4. 角色滤镜串（roles.ts 的 roleFilter 顺序与 pan 增益）。
    var mono=new MixerChannel {GainDb=0,Pan=-.5};
    Require(MixerAudio.RoleFilter(mono,false,1)=="aresample=48000,volume=0dB,pan=stereo|c0=1*c0|c1=0.5*c0","role filter mono pan -0.5");
    var stereo=new MixerChannel {GainDb=-3,Pan=0};
    Require(MixerAudio.RoleFilter(stereo,false,2)=="aresample=48000,volume=-3dB","role filter stereo pan 0 has no pan stage");
    Require(MixerAudio.RoleFilter(stereo,true,2)=="aresample=48000,volume=0","role filter muted");
    // 5. 空隙 SourceTime / CutAt。
    var gapDoc=new EditDocument {Source="x.mp4",Width=640,Height=360,Duration=4,Audio=false};
    gapDoc.Cuts=new List<Cut>{new Cut {Start=0,End=2},new Cut {Gap=true,GapDuration=1,Start=2,End=2},new Cut {Start=2,End=4}};
    Require(Near(gapDoc.Length,5,.001),"gap length");
    int idx;Require(Near(gapDoc.SourceTime(2.5,out idx),2,.001),"gap source time frozen at anchor");
    Require(Near(gapDoc.SourceTime(4.5,out idx),3.5,.001),"source time after gap");
    double off;Require(gapDoc.CutAt(2.5,out off).Gap,"CutAt gap");
    // 6. 多机位分段：切换点把 Cut 切开。
    var mcDoc=new EditDocument {Source="a.mp4",Width=640,Height=360,Duration=3,Audio=false};
    mcDoc.Cuts=new List<Cut>{new Cut {Start=0,End=3}};mcDoc.MulticamAngles=new List<string>{"b.mp4"};
    mcDoc.MulticamSwitches=new List<MulticamSwitch>{new MulticamSwitch {Time=1,Angle=1}};
    var segs=MulticamModel.BuildSegments(mcDoc);
    Require(segs.Count==2&&Near(segs[0].TimelineEnd,1,.001)&&segs[0].File=="a.mp4"&&segs[1].File=="b.mp4"&&Near(segs[1].SourceStart,1,.001),"multicam segments split at switch");
    // 7. 代理缺失是硬错。
    var pxDoc=new EditDocument {Source="x.mp4",Width=640,Height=360,Duration=3,Audio=false,ProxyEnabled=true,ProxyPath=Path.Combine(folder,"nope.proxy.mp4")};
    bool threw=false;try{ProxyTools.Validate(pxDoc);}catch(Exception ex){threw=ex.Message.Contains("代理");}
    Require(threw,"missing proxy throws");
    // 8. 调色滤镜串。
    var g2=new ColorGrade {Brightness=.1,Contrast=1.2};
    Require(g2.VideoFilter()==",eq=brightness=0.1:contrast=1.2","eq filter string");
    var g3=new ColorGrade {Temperature=.3};
    Require(g3.VideoFilter()==",colorbalance=rs=0.3:gs=0:bs=-0.3","colorbalance filter string");
    var g4=new ColorGrade();g4.WheelHue[1]=30;
    Require(g4.VideoFilter().Contains("lut3d="),"wheel grade uses lut3d");
    // 9. 合成素材实测：代理生成 + 空隙/字幕/调色/音乐床导出 + 多机位导出。
    string source=Path.Combine(folder,"source.mp4");
    StudioMedia.Run("-v error -y -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac "+Media.Q(source),CancellationToken.None);
    var doc=StudioMedia.Import(source);
    string proxy=Path.Combine(folder,"source.proxy.mp4");
    double proxyDur=ProxyTools.Generate(source,proxy);
    Require(Math.Abs(proxyDur-3)<.1,"proxy duration matches source");
    doc.Cuts=new List<Cut>{new Cut {Start=0,End=1},new Cut {Gap=true,GapDuration=.5,Start=1,End=1},new Cut {Start=1,End=3}};
    doc.Subtitles.Add(new SubtitleCue {Start=.2,End=1,Text="测试字幕",Text2="test"});
    doc.SubtitleSidecar="srt";doc.Grade.Brightness=.1;
    doc.Mixer.Add(new MixerChannel {Role="音乐",SourcePath=source,GainDb=-6});
    string output=Path.Combine(folder,"export.mp4");
    StudioRenderer.Export(doc,output,360,30,(v,s)=>{},CancellationToken.None);
    var info=StudioMedia.Import(output);
    Require(Math.Abs(info.Duration-3.5)<.15&&info.Audio&&info.Width==640&&info.Height==360,"gap+subtitle+grade+music export");
    Require(File.Exists(Path.ChangeExtension(output,".srt"))&&File.ReadAllText(Path.ChangeExtension(output,".srt")).Contains("测试字幕"),"sidecar srt written");
    string angle=Path.Combine(folder,"angle1.mp4");File.Copy(source,angle,true);
    var mc=StudioMedia.Import(source);
    mc.MulticamAngles=new List<string>{angle};mc.MulticamSwitches=new List<MulticamSwitch>{new MulticamSwitch {Time=1,Angle=1}};
    string mcOut=Path.Combine(folder,"multicam.mp4");
    StudioRenderer.Export(mc,mcOut,360,30,(v,s)=>{},CancellationToken.None);
    Require(Math.Abs(StudioMedia.Import(mcOut).Duration-3)<.15,"multicam export");
    File.WriteAllText(log,"PASS: subtitles SRT/VTT/ASS round-trip + dual ASS Sub2 marginV 82; LUT deterministic + dark-red spot + wheel weights; role filter mono/stereo/muted; gap SourceTime/CutAt; multicam segments; missing proxy throws; eq/colorbalance/lut3d filter strings; proxy generate; gap+subtitle+grade+music export 3.5s; sidecar srt; multicam export.\n");
   }catch(Exception ex){File.WriteAllText(log,"FAIL\n"+ex);Environment.ExitCode=1;}
  }
 }
}
