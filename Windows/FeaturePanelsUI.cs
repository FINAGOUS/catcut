// W3 功能面板接线 · 检查器 UI（2026-11-18）。
// 画面-调色 / 字幕 / 混音 / 代理 / 多机位 五个面板 + 素材库四栏内容 +
// 时间线吸附线 + 媒体拖进时间线。模型与滤镜逻辑见 FeaturePanels.cs。
// 控件全部复用现有检查器助手（Section/Note/Slider/Number/Toggle/Buttons/
// Choices/InspectorAction），不抄任何闭源软件的界面。
// 诚实说明写在各面板的 Note 里；没接的（RGB/主曲线）只写“未接”，不画假控件。
// W5 已接：自动识别字幕（Whisper）、HSL 曲线编辑器、电平表（W5UI.cs）。
// W7 已接：色轮三区可拖拽圆盘（W7UI.cs）。
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using DogSC.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using Path=System.IO.Path;

namespace DogSC.Replica {
 public partial class Studio {
  int selectedSubtitle=-1;
  // ---- 调色（画面 tab 的第四页 frameTab=="调色"）----
  void BuildColorInspector(){
   var g=Doc.Grade;
   Section("基础");
   Slider("亮度",-1,1,g.Brightness,"",v=>g.Brightness=v);
   Slider("对比度",0,2,g.Contrast,"×",v=>g.Contrast=v);
   Slider("饱和度",0,2,g.Saturation,"×",v=>g.Saturation=v);
   Slider("色温",-1,1,g.Temperature,"",v=>g.Temperature=v);
   Slider("色调",-1,1,g.Tint,"",v=>g.Tint=v);
   Section("色轮三区");
   for(int z=0;z<3;z++){int zone=z;
    Slider(ColorGrade.WheelZoneNames[zone]+" · 色相偏移",-180,180,g.WheelHue[zone],"°",v=>g.WheelHue[zone]=v);
    Slider(ColorGrade.WheelZoneNames[zone]+" · 饱和度",0,3,g.WheelSat[zone],"×",v=>g.WheelSat[zone]=v);
   }
   BuildColorWheelSection();
   Section("HSL 分区");
   for(int z=0;z<7;z++){int zone=z;
    Slider(ColorGrade.HslZoneNames[zone]+" · 饱和度",0,3,g.HslSat[zone],"×",v=>g.HslSat[zone]=v);
    Slider(ColorGrade.HslZoneNames[zone]+" · 明度",-1,1,g.HslLum[zone],"",v=>g.HslLum[zone]=v);
   }
   BuildHslCurveSection();
   BuildRgbCurveSection();
   Section("预设");
   var presets=new UniformGrid {Columns=3,Margin=new Thickness(0,0,0,8)};
   foreach(var name in new[]{"原片","冷调","暖调","黑白","电影感","高饱和"}){string p=name;var b=UI.Button(p,()=>ApplyColorPreset(p));b.FontSize=12;b.Padding=new Thickness(4,6,4,6);b.Margin=new Thickness(2);presets.Children.Add(b);}
   inspector.Children.Add(presets);
   inspector.Children.Add(UI.Button("重置调色",()=>{Checkpoint();g.Reset();Changed();BuildInspector();}));
   Note("基础调节走 eq / colorbalance（与 TS 引擎 filtergraph.ts 同款滤镜串）；色轮、HSL 分区、HSL 曲线、RGB/主曲线、白平衡色调烘进 17³ .cube，经 lut3d 应用到解码帧，预览与导出一致。");
  }
  void ApplyColorPreset(string name){
   if(Doc==null)return;Checkpoint();var g=Doc.Grade;g.Reset();
   if(name=="冷调"){g.Temperature=-.35;g.Saturation=1.05;}
   else if(name=="暖调"){g.Temperature=.35;g.Saturation=1.05;}
   else if(name=="黑白"){g.Saturation=0;}
   else if(name=="电影感"){g.Contrast=1.15;g.Saturation=.85;g.Temperature=.1;}
   else if(name=="高饱和"){g.Saturation=1.4;}
   Changed();BuildInspector();RefreshMediaLibrary();Status("已应用调色预设 · "+name);
  }
  // ---- 字幕 ----
  void BuildSubtitleInspector(){
   Section("字幕");
   Toggle("烧录进画面",Doc.SubtitleBurnIn,v=>{Doc.SubtitleBurnIn=v;BuildInspector();});
   Choices("边车格式",Doc.SubtitleSidecar,new[]{new[]{"不导出边车","none"},new[]{"SRT","srt"},new[]{"VTT","vtt"},new[]{"ASS（双语双样式）","ass"}},v=>Doc.SubtitleSidecar=v);
   Note("边车在导出成片时写在视频旁边（同名 .srt/.vtt/.ass）；双语时 SRT/VTT 合并为双行，ASS 用 Sub/Sub2 双样式。");
   BuildWhisperSection();
   inspector.Children.Add(InspectorAction("plus","添加字幕（从播放头起 2 秒）",AddSubtitleAtPlayhead));
   inspector.Children.Add(InspectorAction("folder","导入字幕文件…（.srt/.vtt/.ass）",()=>ImportSubtitles(null)));
   if(Doc.Subtitles.Count>0)inspector.Children.Add(InspectorAction("export","导出边车到项目目录",ExportSidecarNow));
   if(Doc.Subtitles.Count==0){Note("还没有字幕。先用自动识别转写，或导入/手动添加。");return;}
   Section("字幕列表（"+Doc.Subtitles.Count+" 条）");
   for(int i=0;i<Doc.Subtitles.Count;i++){int index=i;var c=Doc.Subtitles[i];
    var b=UI.Button(UI.Time(c.Start)+" – "+UI.Time(c.End)+"  "+(string.IsNullOrWhiteSpace(c.Text)?"（空）":c.Text),()=>{selectedSubtitle=index;BuildInspector();});
    b.FontSize=12;b.HorizontalContentAlignment=HorizontalAlignment.Left;
    if(selectedSubtitle==i){b.FontWeight=FontWeights.SemiBold;UI.Role(b,Control.BackgroundProperty,"SelectedControl");}
    inspector.Children.Add(b);
   }
   if(selectedSubtitle<0||selectedSubtitle>=Doc.Subtitles.Count)return;
   var cue=Doc.Subtitles[selectedSubtitle];
   Section("编辑字幕");
   Number("开始 / 秒",cue.Start,v=>cue.Start=EditDocument.Clamp(v,0,cue.End-.05));
   Number("结束 / 秒",cue.End,v=>cue.End=EditDocument.Clamp(v,cue.Start+.05,Doc.Length));
   var label1=UI.Text("主语言",13,"#63696D");label1.Margin=new Thickness(0,9,0,3);inspector.Children.Add(label1);
   var t1=new TextBox {Text=cue.Text,AcceptsReturn=true,MinHeight=44,TextWrapping=TextWrapping.Wrap,FontSize=13,Margin=new Thickness(0,4,0,9)};
   t1.LostKeyboardFocus+=(s,e)=>{if(t1.Text!=cue.Text){Checkpoint();cue.Text=t1.Text;Changed();}};inspector.Children.Add(t1);
   var label2=UI.Text("第二语言（可空，双语时用）",13,"#63696D");label2.Margin=new Thickness(0,9,0,3);inspector.Children.Add(label2);
   var t2=new TextBox {Text=cue.Text2,AcceptsReturn=true,MinHeight=44,TextWrapping=TextWrapping.Wrap,FontSize=13,Margin=new Thickness(0,4,0,9)};
   t2.LostKeyboardFocus+=(s,e)=>{if(t2.Text!=cue.Text2){Checkpoint();cue.Text2=t2.Text;Changed();}};inspector.Children.Add(t2);
   inspector.Children.Add(InspectorAction("trash","删除这条字幕",()=>{Checkpoint();Doc.Subtitles.RemoveAt(selectedSubtitle);selectedSubtitle=-1;Changed();BuildInspector();RefreshMediaLibrary();},true));
  }
  void AddSubtitleAtPlayhead(){
   if(Doc==null)return;Checkpoint();
   var cue=new SubtitleCue {Start=position,End=Math.Min(Doc.Length,position+2),Text="新字幕"};
   if(cue.End-cue.Start<.1)cue.End=Math.Min(Doc.Length,cue.Start+.1);
   Doc.Subtitles.Add(cue);Doc.Subtitles.Sort((a,b)=>a.Start.CompareTo(b.Start));
   selectedSubtitle=Doc.Subtitles.IndexOf(cue);Changed();BuildInspector();RefreshMediaLibrary();
  }
  void ImportSubtitles(string path){
   if(Doc==null)return;
   if(path==null){var dlg=new Microsoft.Win32.OpenFileDialog {Filter="字幕文件|*.srt;*.vtt;*.ass|所有文件|*.*"};if(dlg.ShowDialog(Window)!=true)return;path=dlg.FileName;}
   try{
    var cues=SubtitleFiles.ParseFile(path);if(cues.Count==0)throw new Exception("文件里没有解析出字幕。");
    Checkpoint();Doc.Subtitles.AddRange(cues);Doc.Subtitles.Sort((a,b)=>a.Start.CompareTo(b.Start));
    selectedSubtitle=Doc.Subtitles.Count-1;Changed();BuildInspector();RefreshMediaLibrary();Status("已导入字幕 "+cues.Count+" 条 · "+Path.GetFileName(path));
   }catch(Exception ex){Error(ex);}
  }
  void ExportSidecarNow(){
   if(Doc==null||Doc.Subtitles.Count==0)return;
   try{
    string dir=FilePath!=null?Path.GetDirectoryName(FilePath):Path.GetDirectoryName(Doc.Source);
    string written=SubtitleFiles.WriteSidecar(Doc,Path.Combine(dir,Doc.Name+".mp4"));
    Status(written==null?"边车格式为“不导出”，未写文件。":"边车已写出 · "+written);
   }catch(Exception ex){Error(ex);}
  }
  // ---- 混音台 ----
  void BuildMixerInspector(){
   Section("混音台");
   Slider("总输出",-30,12,Doc.MasterGainDb," dB",v=>Doc.MasterGainDb=v);
   if(Doc.Mixer==null)Doc.Mixer=new List<MixerChannel>();
   if(Doc.Mixer.Count==0)Doc.Mixer.Add(new MixerChannel {Role="对话"});
   if(Doc.Mixer.Count==1&&string.IsNullOrEmpty(Doc.Mixer[0].SourcePath))Note("当前只有主音轨（对话）。从素材库音乐栏导入本地音频可加音乐床。");
   foreach(var ch in Doc.Mixer.ToList()){
    var channel=ch;
    Section(channel.Role+(string.IsNullOrEmpty(channel.SourcePath)?" · 主音轨":" · "+Path.GetFileName(channel.SourcePath)));
    Slider("增益",-60,12,channel.GainDb," dB",v=>channel.GainDb=v);
    Slider("声像",-1,1,channel.Pan,"",v=>channel.Pan=v);
    Toggle("静音",channel.Mute,v=>{channel.Mute=v;BuildInspector();});
    Toggle("独奏",channel.Solo,v=>{channel.Solo=v;BuildInspector();});
    if(!string.IsNullOrEmpty(channel.SourcePath))inspector.Children.Add(InspectorAction("trash","移除这条音乐轨",()=>{Checkpoint();Doc.Mixer.Remove(channel);Changed();BuildInspector();RefreshMediaLibrary();},true));
   }
   inspector.Children.Add(InspectorAction("plus","添加音乐轨…（本地音频）",()=>AddMusicChannel(null)));
   BuildLevelMeterSection();
   Note("推子/静音/独奏实时进预览；导出按角色混音（对话/音乐，roles.ts 的 pan/volume 规则：声像 lg=min(1,1-p)、rg=min(1,1+p)）。");
  }
  void AddMusicChannel(string path){
   if(Doc==null)return;
   if(path==null){var dlg=new Microsoft.Win32.OpenFileDialog {Filter="音频文件|*.mp3;*.wav;*.m4a;*.aac;*.flac;*.ogg|所有文件|*.*"};if(dlg.ShowDialog(Window)!=true)return;path=dlg.FileName;}
   try{
    int channels=Media.AudioChannels(path);
    if(Doc.Mixer==null)Doc.Mixer=new List<MixerChannel>();
    Checkpoint();Doc.Mixer.Add(new MixerChannel {Role="音乐",SourcePath=Path.GetFullPath(path)});
    Changed();BuildInspector();RefreshMediaLibrary();Status("已添加音乐轨 · "+Path.GetFileName(path)+"（"+channels+" 声道）");
   }catch(Exception ex){Error(ex);}
  }
  // ---- 代理 ----
  void BuildProxyInspector(){
   Section("代理剪辑");
   bool has=!string.IsNullOrEmpty(Doc.ProxyPath)&&File.Exists(Doc.ProxyPath);
   Note(has?"代理："+Doc.ProxyPath+"\n代理时长 "+Doc.ProxyDuration.ToString("0.00")+"s（原片 "+Doc.Duration.ToString("0.00")+"s）":"尚未生成代理。");
   Toggle("启用代理（预览用代理）",Doc.ProxyEnabled,v=>{Doc.ProxyEnabled=v;if(v&&!has)Status("代理未生成：请先点“生成代理”。");BuildInspector();});
   inspector.Children.Add(InspectorAction("plus",has?"重新生成代理":"生成代理",()=>GenerateProxy()));
   if(has)inspector.Children.Add(InspectorAction("trash","删除代理文件",()=>{try{File.Delete(Doc.ProxyPath);}catch(Exception ex){Error(ex);return;}Checkpoint();Doc.ProxyPath="";Doc.ProxyDuration=0;Doc.ProxyEnabled=false;Changed();BuildInspector();RefreshMediaLibrary();},true));
   Note("预览用代理、导出始终用原片（与 TS 引擎 P2c 一致，这就是重链接）；代理缺失时预览与导出明确报错，不静默回退原片。代理 720p 上限、CRF 28。");
   BuildProxyDiskSection();
  }
  async void GenerateProxy(){
   if(Doc==null)return;Pause();Status("正在生成代理…");
   string path=ProxyTools.ProxyPathFor(Doc.Source);
   try{
    double dur=await Task.Run(()=>ProxyTools.Generate(Doc.Source,path));
    Checkpoint();Doc.ProxyPath=path;Doc.ProxyDuration=dur;Doc.ProxyEnabled=true;
    Changed();BuildInspector();RefreshMediaLibrary();Status("代理已生成 · "+path);
   }catch(Exception ex){Error(ex);}
  }
  // ---- 多机位 ----
  void BuildMulticamInspector(){
   Section("多机位");
   int count=MulticamModel.AngleCount(Doc);
   Note(count<=1?"还没有第二角度。添加与主源同条同步拍摄的视频作为角度（时长须一致，容限 0.05s）。":"共 "+count+" 路角度（上限 16 路）。音频始终取主机位（角度 0）。");
   for(int a=0;a<count;a++){int angle=a;
    Section((a==0?"角度 1 · 主机位":"角度 "+(a+1))+" · "+Path.GetFileName(MulticamModel.AngleSource(Doc,a)));
    if(a>0)inspector.Children.Add(InspectorAction("trash","移除这个角度",()=>RemoveMulticamAngle(angle),true));
   }
   inspector.Children.Add(InspectorAction("plus","添加角度…",()=>AddMulticamAngle(null,false)));
   if(count>1){
    Section("切换点");
    if(Doc.MulticamSwitches.Count==0)Note("还没有切换点。把播放头放到要切换的位置，点下面的角度按钮。");
    foreach(var s in Doc.MulticamSwitches.ToList()){var sw=s;
     var row=new StackPanel {Orientation=Orientation.Horizontal,Margin=new Thickness(0,3,0,3)};
     var jump=UI.Button(UI.Time(sw.Time)+" → 角度 "+(sw.Angle+1),()=>Seek(sw.Time));jump.FontSize=12;jump.HorizontalContentAlignment=HorizontalAlignment.Left;jump.MinWidth=170;row.Children.Add(jump);
     var del=UI.Button("删除",()=>{Checkpoint();Doc.MulticamSwitches.Remove(sw);Changed();BuildInspector();DrawTimeline();});del.FontSize=11;del.Padding=new Thickness(8,3,8,3);del.Margin=new Thickness(6,0,0,0);row.Children.Add(del);
     inspector.Children.Add(row);
    }
    var grid=new UniformGrid {Columns=count,Margin=new Thickness(0,8,0,0)};
    for(int a=0;a<count;a++){int angle=a;var b=UI.Button("切到角度 "+(a+1),()=>AddSwitchAtPlayhead(angle));b.FontSize=12;b.Padding=new Thickness(4,6,4,6);b.Margin=new Thickness(2);grid.Children.Add(b);}
    inspector.Children.Add(grid);
    Note("切换点按时间线时间记录；变速片段下多机位不可用（引擎 v1 限制）。");
   }
  }
  void AddMulticamAngle(string path,bool fromDrop){
   if(Doc==null)return;
   if(path==null){var dlg=new Microsoft.Win32.OpenFileDialog {Filter="视频文件|*.mp4;*.mov;*.mkv;*.webm|所有文件|*.*"};if(dlg.ShowDialog(Window)!=true)return;path=dlg.FileName;}
   try{
    if(MulticamModel.AngleCount(Doc)>=16)throw new Exception("多机位已满 16 路。");
    var probe=StudioMedia.Import(path);
    if(Math.Abs(probe.Duration-Doc.Duration)>.05)throw new Exception("角度时长与主源不符："+probe.Duration.ToString("0.00")+"s，主源 "+Doc.Duration.ToString("0.00")+"s（容限 0.05s）。角度须为同步拍摄的同条素材。");
    Checkpoint();Doc.MulticamAngles.Add(Path.GetFullPath(path));
    if(fromDrop){Doc.MulticamSwitches.RemoveAll(s=>Math.Abs(s.Time-position)<.05);Doc.MulticamSwitches.Add(new MulticamSwitch {Time=position,Angle=Doc.MulticamAngles.Count});Doc.MulticamSwitches.Sort((a,b)=>a.Time.CompareTo(b.Time));}
    Changed();BuildInspector();RefreshMediaLibrary();DrawTimeline();
    Status("已添加多机位角度 "+(Doc.MulticamAngles.Count+1)+" · "+Path.GetFileName(path)+(fromDrop?"，已在播放头处切换到该角度":""));
   }catch(Exception ex){Error(ex);}
  }
  void RemoveMulticamAngle(int angle){
   if(Doc==null||angle<=0||angle>Doc.MulticamAngles.Count)return;
   Checkpoint();Doc.MulticamAngles.RemoveAt(angle-1);
   Doc.MulticamSwitches.RemoveAll(s=>s.Angle==angle);
   foreach(var s in Doc.MulticamSwitches)if(s.Angle>angle)s.Angle--;
   Changed();BuildInspector();RefreshMediaLibrary();DrawTimeline();
  }
  void AddSwitchAtPlayhead(int angle){
   if(Doc==null)return;Checkpoint();
   Doc.MulticamSwitches.RemoveAll(s=>Math.Abs(s.Time-position)<.05);
   Doc.MulticamSwitches.Add(new MulticamSwitch {Time=position,Angle=angle});
   Doc.MulticamSwitches.Sort((a,b)=>a.Time.CompareTo(b.Time));
   Changed();BuildInspector();DrawTimeline();
  }
  // ---- 素材库内容（W2 只留了占位文案，这里真正接数据）----
  Border MediaRow(string title,string meta,string dragPayload){
   var card=new Border {CornerRadius=new CornerRadius(12),Padding=new Thickness(10,8,10,8),Margin=new Thickness(0,0,0,8)};
   UI.Role(card,Border.BackgroundProperty,"Well");
   var stack=new StackPanel();
   var name=new TextBlock {Text=title,FontWeight=FontWeights.SemiBold,FontSize=12,TextTrimming=TextTrimming.CharacterEllipsis};
   name.SetResourceReference(TextBlock.ForegroundProperty,"Ink");stack.Children.Add(name);
   if(!string.IsNullOrEmpty(meta)){var m=UI.Text(meta,11,"#63696D");m.Margin=new Thickness(0,3,0,0);stack.Children.Add(m);}
   var buttons=new StackPanel {Orientation=Orientation.Horizontal,Margin=new Thickness(0,6,0,0)};
   stack.Children.Add(buttons);card.Child=stack;card.Tag=buttons;
   if(!string.IsNullOrEmpty(dragPayload))AttachMediaDrag(card,dragPayload);
   return card;
  }
  void MediaRowButton(Border row,string text,Action action){
   var b=UI.Button(text,action);b.FontSize=11;b.Padding=new Thickness(8,3,8,3);b.Margin=new Thickness(0,0,6,0);
   ((StackPanel)row.Tag).Children.Add(b);
  }
  void MediaLibraryNote(StackPanel panel,string text){
   var t=UI.Text(text,11,"#63696D");t.Margin=new Thickness(0,4,0,10);t.TextAlignment=TextAlignment.Center;panel.Children.Add(t);
  }
  void RefreshMediaLibrary(){
   var panel=Find<StackPanel>("MediaLibraryContent");if(panel==null)return;
   panel.Children.Clear();
   if(Doc==null){
    panel.Children.Add(new TextBlock {Text="还没有素材",FontSize=13,FontWeight=FontWeights.SemiBold,HorizontalAlignment=HorizontalAlignment.Center});
    MediaLibraryNote(panel,"导入视频后，素材会出现在这里。");
    return;
   }
   if(mediaTab=="素材"){
    long proxyBytes=ProxyDisk.ProxyBytes(Doc);
    string proxyBadge=proxyBytes>0?" · 代理 ✓ "+ProxyDisk.FormatSize(proxyBytes):(Doc.ProxyEnabled?" · 代理缺失！":" · 无代理");
    if(Doc.Spherical360)proxyBadge+=" · 360°";
    var main=MediaRow(Path.GetFileName(Doc.Source),Doc.Width+" × "+Doc.Height+" · "+UI.Time(Doc.Duration)+proxyBadge,"video|"+Doc.Source);
    MediaRowButton(main,"打开",()=>Open());
    panel.Children.Add(main);
    // W8：子片段行（只存引用不复制文件；点“加入时间线”复用）。
    AddSubclipRows(panel);
    for(int a=1;a<MulticamModel.AngleCount(Doc);a++){int angle=a;
     var row=MediaRow("角度 "+(a+1)+" · "+Path.GetFileName(MulticamModel.AngleSource(Doc,a)),"多机位角度","video|"+MulticamModel.AngleSource(Doc,a));
     MediaRowButton(row,"移除",()=>RemoveMulticamAngle(angle));
     panel.Children.Add(row);
    }
    panel.Children.Add(InspectorAction("plus","添加为多机位角度…",()=>AddMulticamAngle(null,false)));
    MediaLibraryNote(panel,"拖动素材到时间线：在播放头处切换到该角度。");
   }else if(mediaTab=="音乐"){
    var music=Doc.Mixer==null?new List<MixerChannel>():Doc.Mixer.Where(c=>!string.IsNullOrEmpty(c.SourcePath)).ToList();
    if(music.Count==0)MediaLibraryNote(panel,"还没有音乐轨。只接本地 / 用户自己的音频，不搬运剪映 / CapCut 的曲库。");
    foreach(var ch in music.ToList()){var channel=ch;
     var row=MediaRow(Path.GetFileName(channel.SourcePath),"音乐 · 增益 "+channel.GainDb.ToString("0.#",System.Globalization.CultureInfo.InvariantCulture)+" dB","audio|"+channel.SourcePath);
     MediaRowButton(row,"移除",()=>{Checkpoint();Doc.Mixer.Remove(channel);Changed();BuildInspector();RefreshMediaLibrary();});
     panel.Children.Add(row);
    }
    panel.Children.Add(InspectorAction("plus","导入本地音频…",()=>AddMusicChannel(null)));
    MediaLibraryNote(panel,"拖动音频到时间线：加为音乐轨。只接本地 / 用户自己的音频。");
   }else if(mediaTab=="字幕"){
    if(Doc.Subtitles.Count==0)MediaLibraryNote(panel,"还没有字幕。导入 .srt/.vtt/.ass，或在字幕面板手动添加。");
    else{
     MediaLibraryNote(panel,"共 "+Doc.Subtitles.Count+" 条 · 边车 "+(Doc.SubtitleSidecar=="none"?"不导出":Doc.SubtitleSidecar.ToUpperInvariant())+" · "+(Doc.SubtitleBurnIn?"烧录开":"烧录关"));
     foreach(var c in Doc.Subtitles.Take(30)){
      var row=MediaRow(UI.Time(c.Start)+" – "+UI.Time(c.End),c.Text,"");
      panel.Children.Add(row);
     }
     if(Doc.Subtitles.Count>30)MediaLibraryNote(panel,"…还有 "+(Doc.Subtitles.Count-30)+" 条，见字幕面板。");
    }
    panel.Children.Add(InspectorAction("folder","导入字幕文件…",()=>ImportSubtitles(null)));
    if(Doc.Subtitles.Count>0)panel.Children.Add(InspectorAction("export","导出边车到项目目录",ExportSidecarNow));
   }else{
    foreach(var name in new[]{"原片","冷调","暖调","黑白","电影感","高饱和"}){string p=name;
     var row=MediaRow("调色 · "+p,"点击应用到全片","preset|"+p);
     MediaRowButton(row,"应用",()=>ApplyColorPreset(p));
     panel.Children.Add(row);
    }
    panel.Children.Add(InspectorAction("plus","添加柔化区域",()=>AddEffect("blur",null)));
    panel.Children.Add(InspectorAction("plus","导入贴图…",()=>AddEffect("sticker",null)));
    MediaLibraryNote(panel,"调色预设是我们自己的参数组合。拖动预设到时间线也可应用。");
   }
  }
  void AttachMediaDrag(FrameworkElement element,string payload){
   Point down=new Point();bool armed=false;
   element.MouseLeftButtonDown+=(s,e)=>{down=e.GetPosition(null);armed=true;};
   element.MouseMove+=(s,e)=>{
    if(!armed||e.LeftButton!=MouseButtonState.Pressed)return;
    var p=e.GetPosition(null);if(Math.Abs(p.X-down.X)+Math.Abs(p.Y-down.Y)<5)return;
    armed=false;try{DragDrop.DoDragDrop(element,new DataObject("CatCutMedia",payload),DragDropEffects.Copy);}catch{}
   };
   element.MouseLeftButtonUp+=(s,e)=>armed=false;
  }
  void TimelineDrop(object sender,DragEventArgs e){
   if(Doc==null)return;
   try{
    if(e.Data.GetDataPresent("CatCutMedia")){HandleMediaDrop(e.Data.GetData("CatCutMedia") as string);e.Handled=true;return;}
    var files=e.Data.GetData(DataFormats.FileDrop) as string[];
    if(files!=null&&files.Length>0){foreach(var f in files)HandleMediaDrop(MediaPayloadForFile(f));e.Handled=true;}
   }catch(Exception ex){Error(ex);}
  }
  string MediaPayloadForFile(string path){
   string ext=Path.GetExtension(path).ToLowerInvariant();
   if(ext==".srt"||ext==".vtt"||ext==".ass")return "subtitle|"+path;
   if(ext==".mp3"||ext==".wav"||ext==".m4a"||ext==".aac"||ext==".flac"||ext==".ogg")return "audio|"+path;
   return "video|"+path;
  }
  void HandleMediaDrop(string payload){
   if(string.IsNullOrEmpty(payload))return;
   var parts=payload.Split(new[]{'|'},2);if(parts.Length<2)return;
   if(parts[0]=="video")AddMulticamAngle(parts[1],true);
   else if(parts[0]=="audio")AddMusicChannel(parts[1]);
   else if(parts[0]=="subtitle")ImportSubtitles(parts[1]);
   else if(parts[0]=="preset")ApplyColorPreset(parts[1]);
  }
  // ---- 时间线吸附线 ----
  Line snapLine;
  List<double> SnapCandidates(){
   var list=new List<double>{0,Doc.Length,position};
   double offset=0;foreach(var c in Doc.Cuts){list.Add(offset);offset+=c.Length;list.Add(offset);}
   foreach(var z in Doc.Zooms){list.Add(z.Start);list.Add(z.End);}
   foreach(var o in Doc.Overlays){list.Add(o.Start);list.Add(o.End);}
   if(Doc.MulticamSwitches!=null)foreach(var s in Doc.MulticamSwitches)list.Add(s.Time);
   if(Doc.RecordingMarkers!=null)foreach(var m in Doc.RecordingMarkers)list.Add(m.Time);
   list.Sort();return list.Distinct().ToList();
  }
  // 拖动中的边离某个候选点够近（0.12s）就吸过去并亮线；否则按帧取整（老行为）。
  double SnapDelta(double edge,double delta){
   double target=edge+delta,best=target,bestDist=.12;
   foreach(var c in SnapCandidates()){double d=Math.Abs(c-target);if(d<bestDist){bestDist=d;best=c;}}
   if(best!=target){ShowSnapLine(best);return best-edge;}
   HideSnapLine();return Math.Round(delta*Doc.FrameRate)/Doc.FrameRate;
  }
  double SnapTime(double t){
   double best=t,bestDist=.12;
   foreach(var c in SnapCandidates()){double d=Math.Abs(c-t);if(d<bestDist){bestDist=d;best=c;}}
   return best;
  }
  void ShowSnapLine(double t){
   if(snapLine==null||Doc==null)return;
   double x=t/Doc.Length*TimelineWidth;snapLine.X1=snapLine.X2=x;snapLine.Visibility=Visibility.Visible;
  }
  void HideSnapLine(){if(snapLine!=null)snapLine.Visibility=Visibility.Collapsed;}
 }
}
