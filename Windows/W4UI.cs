// W4 检查器面板（2026-11-18）：摄像头画中画、自动保存、后台渲染缓存。
// 控件全部复用现有检查器助手（Section/Note/Toggle/Slider/Buttons/
// PositionPad/InspectorAction），不抄任何闭源软件的界面。
// 诚实说明写在各面板的 Note 里；没接的（系统声音混音接入、自动识别
// 字幕等）只写“未接/待办”，不画假控件。
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using DogSC.Windows;
using Path=System.IO.Path;

namespace DogSC.Replica {
 public partial class Studio {
  string cacheStatus="还没有缓存。";
  string systemAudioSurvey;
  bool cacheRunning;
  // ---- 摄像头画中画 ----
  void BuildCameraInspector(){
   if(Doc.Camera==null)Doc.Camera=new CameraClip();
   var cam=Doc.Camera;
   Section("摄像头画中画");
   Toggle("启用画中画",cam.Enabled,v=>{cam.Enabled=v;BuildInspector();});
   if(!cam.Enabled){Note("画中画关时不渲染、不影响导出。开时按下：录制浮条的摄像头按钮选设备后，录制时同步录一份 camera.mp4，停止后自动挂为画中画轨；也可以直接选一份现成的摄像头视频。");return;}
   bool has=!string.IsNullOrEmpty(cam.SourcePath)&&File.Exists(cam.SourcePath);
   Note(has?"画中画素材："+cam.SourcePath+(string.IsNullOrEmpty(cam.Device)?"":"\n录制设备："+cam.Device):"还没有画中画素材。先选一份摄像头视频，或去录制浮条选摄像头设备再录一段。");
   inspector.Children.Add(InspectorAction("folder",has?"更换画中画视频…":"选择摄像头视频文件…",PickCameraFile));
   if(has)inspector.Children.Add(InspectorAction("trash","移除画中画素材",()=>{Checkpoint();cam.SourcePath="";cam.Device="";cam.Enabled=false;Changed();BuildInspector();},true));
   Slider("画中画大小",.05,.5,cam.Size,"",v=>cam.Size=v);
   PositionPad(cam.X,cam.Y,(x,y)=>{cam.X=x;cam.Y=y;});
   Buttons(new[]{"圆形","圆角","矩形"},cam.Shape=="circle"?"圆形":cam.Shape=="rounded"?"圆角":"矩形",v=>{Checkpoint();cam.Shape=v=="圆形"?"circle":v=="圆角"?"rounded":"rect";Changed();BuildInspector();});
   Note("形状蒙版画在预览与导出里；时间按主画面源时间对齐（与变速/重排一致）；空隙段不画画中画。画中画开启时预览走 GDI+ 合成（与贴图/字幕同款，不走 GPU 直通）。");
   Section("系统声音");
   Note(systemAudioSurvey??"还没检测。系统声音采集不在本批接线范围——检测只告诉你本机有没有现成路子。");
   inspector.Children.Add(InspectorAction("sound","检测系统声音设备…",DetectSystemAudio));
  }
  void PickCameraFile(){
   if(Doc==null)return;
   var dlg=new Microsoft.Win32.OpenFileDialog {Filter="视频文件|*.mp4;*.mov;*.mkv;*.webm|所有文件|*.*"};
   if(dlg.ShowDialog(Window)!=true)return;
   try{
    var probe=StudioMedia.Import(dlg.FileName);
    if(probe.Duration<=0)throw new Exception("摄像头视频没有可播放的画面。");
    Checkpoint();Doc.Camera.SourcePath=Path.GetFullPath(dlg.FileName);Doc.Camera.Enabled=true;
    Changed();BuildInspector();Status("画中画素材已关联 · "+Path.GetFileName(dlg.FileName));
   }catch(Exception ex){Error(ex);}
  }
  async void DetectSystemAudio(){
   Status("正在检测系统声音设备…");
   try{
    string survey=await Task.Run(()=>CameraDevices.Survey());
    systemAudioSurvey=survey;Status("系统声音检测完成。");BuildInspector();
   }catch(Exception ex){Error(ex);}
  }
  // ---- 自动保存 ----
  // 设置类滑杆：只改全局设置，不动工程——不用 PolishedSlider（它会
  // Checkpoint + Changed 工程，不适合全局设置）。
  void SettingsSlider(string label,double min,double max,double value,string suffix,Action<double> set){
   var row=new System.Windows.Controls.Grid {Margin=new Thickness(0,4,0,8)};
   row.ColumnDefinitions.Add(new ColumnDefinition());
   row.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(68)});
   var text=UI.Text(label,13,"#63696D");text.VerticalAlignment=VerticalAlignment.Center;row.Children.Add(text);
   var number=UI.Pill(Window,value.ToString("0",System.Globalization.CultureInfo.InvariantCulture)+suffix,66);
   number.HorizontalAlignment=HorizontalAlignment.Right;System.Windows.Controls.Grid.SetColumn(number,1);row.Children.Add(number);
   var slider=new Slider {Minimum=min,Maximum=max,Value=value,Margin=new Thickness(0,1,0,0)};
   System.Windows.Controls.Grid.SetRow(slider,1);System.Windows.Controls.Grid.SetColumnSpan(slider,2);
   row.RowDefinitions.Add(new RowDefinition {Height=new GridLength(32)});
   row.RowDefinitions.Add(new RowDefinition {Height=new GridLength(27)});
   row.Children.Add(slider);inspector.Children.Add(row);
   slider.ValueChanged+=(s,e)=>{set(slider.Value);number.Text=slider.Value.ToString("0",System.Globalization.CultureInfo.InvariantCulture)+suffix;};
  }
  void BuildAutosaveInspector(){
   Section("自动保存");
   string dir=AutoSave.BackupDirFor(FilePath,Doc);
   int count=AutoSave.ListBackups(dir).Count;
   Note("上次自动保存："+(AutoSave.LastSavedAt==null?"还没有":AutoSave.LastSavedAt.Value.ToString("HH:mm:ss"))+"\n备份目录："+dir+"\n备份份数："+count+" 份（最多保留 "+AutoSave.KeepCount+" 份）");
   SettingsSlider("备份间隔",1,60,AutoSave.IntervalMinutes," 分钟",v=>{AutoSave.IntervalMinutes=(int)Math.Round(v);AutoSave.SaveSettings();autosaveTimer.Interval=TimeSpan.FromMinutes(AutoSave.IntervalMinutes);});
   SettingsSlider("保留份数",1,20,AutoSave.KeepCount," 份",v=>{AutoSave.KeepCount=(int)Math.Round(v);AutoSave.SaveSettings();});
   inspector.Children.Add(InspectorAction("plus","立即备份一次",BackupNow));
   inspector.Children.Add(InspectorAction("folder","打开备份目录",()=>{try{Directory.CreateDirectory(dir);Process.Start("explorer.exe",Media.Q(dir));}catch(Exception ex){Error(ex);}}));
   inspector.Children.Add(InspectorAction("trash","清理旧备份（只留最新 "+AutoSave.KeepCount+" 份）",()=>{try{int removed=AutoSave.Prune(dir,AutoSave.KeepCount);Status(removed==0?"没有可清理的旧备份。":"已清理旧备份 "+removed+" 份。");BuildInspector();}catch(Exception ex){Error(ex);}},true));
   Note("只在工程有未保存改动时写备份；备份与工程文件是同一 .dogscwin 格式。异常退出后，下次启动会提示恢复备份；正常退出不提示。恢复后请另存为新项目——备份文件本身不会被覆盖。");
   BuildMetadataSection();BuildArchiveSection();
  }
  void BackupNow(){
   if(Doc==null)return;
   try{
    string path=AutoSave.WriteBackup(Doc,FilePath);
    AutoSave.Prune(AutoSave.BackupDirFor(FilePath,Doc),AutoSave.KeepCount);
    Status("已备份 · "+Path.GetFileName(path));BuildInspector();
   }catch(Exception ex){Error(ex);}
  }
  // ---- 后台渲染缓存 ----
  void BuildRenderCacheInspector(){
   Section("后台渲染缓存");
   string dir=RenderCache.CacheDirFor(FilePath,Doc);
   int count=RenderCache.CacheFileCount(dir);
   long bytes=RenderCache.CacheTotalBytes(dir);
   Note(cacheStatus+"\n缓存目录："+dir+"\n缓存文件："+count+" 个 · "+(bytes/1048576.0).ToString("0.0",System.Globalization.CultureInfo.InvariantCulture)+" MB");
   inspector.Children.Add(InspectorAction("plus","预渲染全片",()=>RenderCacheSpan(0,Doc.Length)));
   inspector.Children.Add(InspectorAction("plus","预渲染当前片段",RenderSelectedCutCache));
   inspector.Children.Add(InspectorAction("trash","清理缓存",()=>{try{int removed=RenderCache.ClearRenderCache(dir);cacheStatus=removed==0?"缓存已经是空的。":"已清理缓存 "+removed+" 个文件。";Status(cacheStatus);BuildInspector();}catch(Exception ex){Error(ex);}},true));
   Note("只支持全切项目：段落内有变速片段（速度 ≠ 1）不能切片（P3f 限制）。缓存是 720p/30 的中间片，只用于预览加速，不影响导出画质。改动会改变缓存键，旧文件不再命中，定期清理。命中时不重新渲染。");
  }
  void RenderSelectedCutCache(){
   if(Doc==null)return;
   if(selectedCut<0||selectedCut>=Doc.Cuts.Count){Status("请先在时间线上选一个片段。");return;}
   double start=0;
   for(int i=0;i<selectedCut;i++)start+=Doc.Cuts[i].Length;
   RenderCacheSpan(start,start+Doc.Cuts[selectedCut].Length);
  }
  async void RenderCacheSpan(double start,double end){
   if(Doc==null||cacheRunning)return;
   cacheRunning=true;
   string dir=RenderCache.CacheDirFor(FilePath,Doc);
   var snapshot=EditDocument.Deserialize(Doc.Serialize());
   Status("正在渲染缓存 ["+UI.Time(start)+" – "+UI.Time(end)+"]…");
   try{
    var result=await Task.Run(()=>RenderCache.RenderSegment(snapshot,start,end,dir,(v,s)=>Window.Dispatcher.BeginInvoke(new Action(()=>{if(cacheRunning)Status(s+" · "+(v*100).ToString("0")+"%");})),CancellationToken.None));
    cacheStatus=(result.Hit?"缓存命中，未重新渲染":"已渲染进缓存")+" · ["+UI.Time(start)+" – "+UI.Time(end)+"] · "+result.Duration.ToString("0.00")+"s · "+Path.GetFileName(result.Task.File);
    Status(cacheStatus);
   }catch(Exception ex){Error(ex);}
   finally{cacheRunning=false;BuildInspector();}
  }
 }
}
