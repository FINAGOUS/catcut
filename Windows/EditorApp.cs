using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;
using DogSC.Windows;
using D=System.Drawing;
using Imaging=System.Drawing.Imaging;
using Path=System.IO.Path;

namespace DogSC.Replica {
 static partial class UI {
  public static Brush Brush(string color){return (Brush)new BrushConverter().ConvertFromString(color);}
  public static TextBlock Text(string s,double size=12,string color="#363B3E"){var text=new TextBlock {Text=s,FontSize=size,Foreground=Brush(color),TextWrapping=TextWrapping.Wrap};if(color=="#363B3E")text.SetResourceReference(TextBlock.ForegroundProperty,"Ink");else if(color!="#FFFFFF"&&color!="#000000"){var c=(Color)ColorConverter.ConvertFromString(color);if(Math.Max(c.R,Math.Max(c.G,c.B))-Math.Min(c.R,Math.Min(c.G,c.B))<45)text.SetResourceReference(TextBlock.ForegroundProperty,c.R<70?"Ink":c.R<130?"Secondary":"Muted");}return text;}
  public static Button Button(string text,Action action){var b=new Button {Content=text,Margin=new Thickness(0,3,0,3)};b.Click+=(s,e)=>action();return b;}
  public static IEnumerable<T> Descendants<T>(DependencyObject root) where T:DependencyObject {foreach(object child in LogicalTreeHelper.GetChildren(root)){var node=child as DependencyObject;if(node==null)continue;if(node is T)yield return (T)node;foreach(var nested in Descendants<T>(node))yield return nested;}}
  public static BitmapSource Image(byte[] bytes){using(var s=new MemoryStream(bytes)){var image=new BitmapImage();image.BeginInit();image.CacheOption=BitmapCacheOption.OnLoad;image.StreamSource=s;image.EndInit();image.Freeze();return image;}}
  public static BitmapSource Image(D.Bitmap bitmap){var r=new D.Rectangle(0,0,bitmap.Width,bitmap.Height);var data=bitmap.LockBits(r,Imaging.ImageLockMode.ReadOnly,Imaging.PixelFormat.Format32bppArgb);try{var result=BitmapSource.Create(bitmap.Width,bitmap.Height,96,96,PixelFormats.Bgra32,null,data.Scan0,data.Stride*data.Height,data.Stride);result.Freeze();return result;}finally{bitmap.UnlockBits(data);}}
  public static void SaveImage(FrameworkElement element,string path){element.UpdateLayout();var bitmap=new RenderTargetBitmap((int)element.ActualWidth,(int)element.ActualHeight,96,96,PixelFormats.Pbgra32);var visual=new DrawingVisual();using(var dc=visual.RenderOpen()){dc.DrawRectangle(Brushes.White,null,new Rect(0,0,element.ActualWidth,element.ActualHeight));dc.DrawRectangle(new VisualBrush(element),null,new Rect(0,0,element.ActualWidth,element.ActualHeight));}bitmap.Render(visual);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using(var f=File.Create(path))encoder.Save(f);}
  public static string Time(double t){return TimeSpan.FromSeconds(Math.Max(0,t)).ToString(@"mm\:ss\.ff");}
  public static FrameworkElement Icon(string name,double size=18){
   var shapes=new Dictionary<string,string>{
    {"folder","M2,6 L9,6 11,8 22,8 22,20 2,20 Z M2,6 L2,4 9,4 11,6 20,6 20,8"},
    {"picture","M3,5 L21,5 21,20 3,20 Z M5,17 L10,11 14,15 17,12 21,17 M7,8 L7.1,8"},
    {"opening","M4,6 L20,6 20,21 4,21 Z M7,3 L17,3 M12,10 L12,17 M9,13.5 L15,13.5"},
    {"motion","M8,3 L3,3 3,8 M16,3 L21,3 21,8 M3,16 L3,21 8,21 M21,16 L21,21 16,21"},
    {"cursor","M4,2 L19,15 12,15 9,22 Z"},
    {"camera","M3,6 L15,6 15,18 3,18 Z M15,10 L22,6 22,18 15,14"},
    {"sound","M3,9 L7,9 12,4 12,20 7,15 3,15 Z M16,8 Q20,12 16,16 M19,4 Q26,12 19,20"},
    {"mic","M9,4 Q12,-1 15,4 L15,12 Q12,17 9,12 Z M6,10 L6,13 Q12,23 18,13 L18,10 M12,19 L12,23 M8,23 L16,23"},
    {"monitor","M2,3 L22,3 22,17 2,17 Z M12,17 L12,22 M7,22 L17,22"},
    {"window","M3,4 L21,4 21,21 3,21 Z M3,9 L21,9 M6,6.5 L6.1,6.5 M9,6.5 L9.1,6.5"},
    {"export","M8,9 L4,9 4,22 20,22 20,9 16,9 M12,16 L12,1 M8,5 L12,1 16,5"},
    {"undo","M9,5 L3,11 9,17 M3,11 L15,11 Q24,11 21,19"},
    {"redo","M15,5 L21,11 15,17 M21,11 L9,11 Q0,11 3,19"},
    {"play","M7,3 L21,12 7,21 Z"}, {"pause","M8,4 L8,20 M16,4 L16,20"},
    {"cut","M10,10 L21,3 M10,14 L21,21 M3,5 C-1,5 -1,11 4,11 C9,11 9,5 3,5 M3,13 C-1,13 -1,19 4,19 C9,19 9,13 3,13"},
    {"trash","M5,7 L6,22 18,22 19,7 M3,5 L21,5 M9,5 L9,2 15,2 15,5 M10,10 L10,18 M14,10 L14,18"},
    {"sun","M8,12 A4,4 0 1 0 16,12 A4,4 0 1 0 8,12 M12,1 L12,4 M12,20 L12,23 M1,12 L4,12 M20,12 L23,12 M4,4 L6,6 M18,18 L20,20 M4,20 L6,18 M18,6 L20,4"},
    {"previous","M5,5 L5,19 M19,5 L8,12 19,19 Z"},{"next","M19,5 L19,19 M5,5 L16,12 5,19 Z"},
    {"pencil","M4,17 L4,21 8,21 21,8 17,4 Z M15,6 L19,10"},{"info","M2,12 A10,10 0 1 0 22,12 A10,10 0 1 0 2,12 M12,11 L12,17 M12,7 L12,7.1"},{"close","M5,5 L19,19 M19,5 L5,19"},
    {"minimize","M5,12 L19,12"},{"maximize","M5,5 L19,5 19,19 5,19 Z"},{"plus","M12,5 L12,19 M5,12 L19,12"},
    {"chevron","M6,9 L12,15 18,9"},{"left","M15,5 L8,12 15,19"},{"right","M9,5 L16,12 9,19"},
    {"layout","M3,5 L21,5 21,19 3,19 Z M8,5 L8,19"},{"background","M12,3 L22,8 12,13 2,8 Z M2,12 L12,17 22,12 M2,16 L12,21 22,16"},
    {"frame","M3,5 L21,5 21,19 3,19 Z M3,9 L21,9 M6,7 L6.1,7 M9,7 L9.1,7"},
    {"sticker","M4,4 L20,4 20,14 14,20 4,20 Z M14,20 L14,14 20,14 M7,8 L7.1,8 M8,15 L11,11 14,13"},
    {"soften","M8,3 L3,3 3,8 M16,3 L21,3 21,8 M3,16 L3,21 8,21 M21,16 L21,21 16,21 M9,9 L15,9 15,15 9,15 Z"},
    {"sliders","M3,6 L9,6 M15,6 L21,6 M3,12 L14,12 M18,12 L21,12 M3,18 L5,18 M11,18 L21,18 M9,3 L9,9 15,9 15,3 Z M14,9 L14,15 18,15 18,9 Z M5,15 L5,21 11,21 11,15 Z"},
    {"presets","M3,5 L11,5 11,13 3,13 Z M15,5 L22,5 22,10 15,10 Z M15,14 L22,14 22,20 15,20 Z M3,17 L11,17"},
    {"snap","M6,4 L6,13 Q6,21 12,21 Q18,21 18,13 L18,4 M4,4 L8,4 M16,4 L20,4 M6,8 L6,11 M18,8 L18,11"},
    {"target","M5,12 A7,7 0 1 0 19,12 A7,7 0 1 0 5,12 M12,1 L12,7 M12,17 L12,23 M1,12 L7,12 M17,12 L23,12"},
    {"cube","M12,2 L22,7 22,17 12,22 2,17 2,7 Z M2,7 L12,12 22,7 M12,12 L12,22 M12,2 L12,12"},
    {"device","M7,2 L17,2 17,22 7,22 Z M10,5 L14,5 M11,19 L13,19"},{"record","M6,12 A6,6 0 1 0 18,12 A6,6 0 1 0 6,12"},{"stop","M5,5 L19,5 19,19 5,19 Z"}
   };string geometry; if(!shapes.TryGetValue(name,out geometry))geometry=shapes["window"];
   var path=new System.Windows.Shapes.Path {Data=Geometry.Parse(geometry),StrokeThickness=1.5,StrokeStartLineCap=PenLineCap.Round,StrokeEndLineCap=PenLineCap.Round,StrokeLineJoin=PenLineJoin.Round};path.SetBinding(System.Windows.Shapes.Path.StrokeProperty,new System.Windows.Data.Binding("Foreground"){RelativeSource=new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.FindAncestor,typeof(Control),1)});if(name=="play"||name=="record")path.SetBinding(System.Windows.Shapes.Path.FillProperty,new System.Windows.Data.Binding("Stroke"){Source=path});
   var canvas=new Canvas {Width=24,Height=24};canvas.Children.Add(path);return new Viewbox {Width=size,Height=size,Child=canvas,Margin=new Thickness(0,0,0,0)};
  }
  public static object IconLabel(string kind,string text="",double size=16){var panel=new StackPanel {Orientation=Orientation.Horizontal};panel.Children.Add(Icon(kind,size));if(text!="")panel.Children.Add(new TextBlock {Text=text,Margin=new Thickness(7,0,0,0),VerticalAlignment=VerticalAlignment.Center});return panel;}
 }
 public partial class Studio {
  public Window Window; public EditDocument Doc; public string FilePath;
  PreviewSurface previewSurface;
  readonly Stack<string> undo=new Stack<string>(),redo=new Stack<string>();
  readonly System.Windows.Controls.Image preview;readonly StackPanel inspector;readonly Canvas timeline;
  readonly List<BitmapSource> thumbs=new List<BitmapSource>(); readonly MediaPlayer audio=new MediaPlayer(); readonly MediaPlayer musicPlayer=new MediaPlayer();
  double position;int selectedCut=-1,selectedZoom=-1;string tab="画面",frameTab="布局";bool dirty,dark,playing,snap=true,ripple=true,closing;
  CancellationTokenSource playback;RecorderWindow recorder;MotionEvaluator motion;
  readonly DispatcherTimer autosaveTimer=new DispatcherTimer();bool recoveryChecked;
  int renderVersion;bool rendering;byte[] cachedFrame;double cachedTime=-100;string cachedSource="";internal int playbackTestDelay;
  public Studio() {
   string interfaceFile=Path.GetFullPath(Path.Combine(Media.Root,"Editor.xaml"));using(var source=File.OpenRead(interfaceFile))Window=(Window)XamlReader.Load(source,new ParserContext {BaseUri=new Uri(interfaceFile)});
   try {var fonts=Fonts.GetFontFamilies(new Uri(Path.GetFullPath(Path.Combine(Media.Root,"../Resources/Fonts"))+"/"));var font=fonts.FirstOrDefault();if(font!=null)Window.FontFamily=font;}catch{}
   preview=Find<System.Windows.Controls.Image>("Preview");inspector=Find<StackPanel>("Inspector");timeline=Find<Canvas>("TimelineHost");
   InitializeEffects();
   Find<Border>("TitleBar").MouseLeftButtonDown+=(s,e)=>{if(!UI.InteractiveSource(e.OriginalSource as DependencyObject)&&(e.Source is TextBlock||e.Source is Border||e.Source is Grid)){if(e.ClickCount==2)ToggleMax();else Window.DragMove();}};
   Bind("Close",()=>Window.Close());Bind("Minimize",()=>Window.WindowState=WindowState.Minimized);Bind("Maximize",ToggleMax);
   Bind("EmptyImport",Open);Bind("EmptyRecord",Record);Bind("NewRecording",Record);Bind("ProjectMenu",ProjectMenu);Bind("Rename",Rename);
   Bind("Undo",()=>History(false));Bind("Redo",()=>History(true));Bind("Play",()=>{if(playing)Pause();else Play();});Bind("Previous",()=>Seek(0));Bind("Next",()=>{if(Doc!=null)Seek(Math.Max(0,Doc.Length-.04));});
   Bind("Split",Split);Bind("Delete",Delete);Bind("MoveLeft",()=>MoveCut(-1));Bind("MoveRight",()=>MoveCut(1));Bind("AddZoom",AddZoom);
   Bind("Export",Export);Bind("Presets",Presets);Bind("Ratio",Ratios);Bind("FitCanvas",()=>{if(Doc!=null){Checkpoint();Doc.Style.Scale=1;Doc.Style.X=Doc.Style.Y=.5;Changed();BuildInspector();}});
   Bind("Theme",Theme);Bind("Snap",()=>{snap=!snap;Find<Button>("Snap").Background=UI.Brush(snap?"#E3F2EB":"#F4F4F5");});
   // W3：波纹开关（原 RipplePlaceholder 占位按钮，现真正接上）+ 时间线拖放 + 音乐床循环。
   Bind("Ripple",()=>{ripple=!ripple;Find<Button>("Ripple").Background=UI.Brush(ripple?"#E3F2EB":"#F4F4F5");Status(ripple?"波纹编辑：开（删除片段后后续跟进）":"波纹编辑：关（删除片段留空隙）");});
   timeline.AllowDrop=true;timeline.Drop+=TimelineDrop;
   musicPlayer.MediaEnded+=(s,e)=>{if(playing){try{musicPlayer.Position=TimeSpan.Zero;musicPlayer.Play();}catch{}}};
   Find<Slider>("TimelineScale").ValueChanged+=(s,e)=>DrawTimeline();
   Window.SizeChanged+=(s,e)=>DrawTimeline();Find<Grid>("Stage").SizeChanged+=(s,e)=>{if(Doc!=null&&!playing)RefreshPreview();};Window.AllowDrop=true;Window.Drop+=async(s,e)=>{var files=e.Data.GetData(DataFormats.FileDrop) as string[];if(files!=null&&files.Length>0)await Load(files[0]);};
   Window.PreviewKeyDown+=(s,e)=>{
    if(Keyboard.FocusedElement is TextBox||Keyboard.FocusedElement is Slider||Keyboard.FocusedElement is ComboBox||UI.PresentedKeyTarget(Keyboard.FocusedElement))return;
    if(Keyboard.FocusedElement is Button&&e.Key==Key.Space)return;
    if((Keyboard.Modifiers&ModifierKeys.Control)!=0){if(e.Key==Key.O)Open();else if(e.Key==Key.S)Save();else if(e.Key==Key.Z)History(false);else if(e.Key==Key.Y)History(true);else if(e.Key==Key.B)Split();else return;e.Handled=true;}
    else if(e.Key==Key.Space){if(playing)Pause();else Play();e.Handled=true;}else if(e.Key==Key.Delete){Delete();e.Handled=true;}else if(e.Key==Key.Left){Seek(position-1.0/30);e.Handled=true;}else if(e.Key==Key.Right){Seek(position+1.0/30);e.Handled=true;}
   };
   Window.Closing+=(s,e)=>{if(closing)return;if(recorder!=null&&recorder.IsRecording){e.Cancel=true;AppDialogs.Notice(Window,"正在录制","请先停止录制，素材保存完成后再关闭。 ");return;}if(!MayDiscard()){e.Cancel=true;return;}Pause();audio.Close();if(previewSurface!=null)previewSurface.Dispose();if(recorder!=null)recorder.Close();AutoSave.ClearUnclean();closing=true;};
   foreach(string name in new[]{"ProjectMenu","Ratio","Presets"})UI.MenuKeyboardEntry(Find<Button>(name));
   Find<Button>("ProjectMenu").Content=UI.IconLabel("folder");Find<Button>("Undo").Content=UI.IconLabel("undo");Find<Button>("Redo").Content=UI.IconLabel("redo");Find<Button>("Export").Content=UI.IconLabel("export","导出");Find<Button>("Split").Content=UI.IconLabel("cut");Find<Button>("Delete").Content=UI.IconLabel("trash");Find<Button>("Theme").Content=UI.IconLabel("sun");
   timeline.MouseMove+=(s,e)=>{if(Doc!=null&&e.LeftButton==MouseButtonState.Pressed&&Mouse.Captured==null){Pause();position=EditDocument.Clamp(e.GetPosition(timeline).X/TimelineWidth*Doc.Length,0,Math.Max(0,Doc.Length-.001));Update();DrawPlayhead();RefreshPreview();}};
   InitializePolish();BuildRail();BuildInspector();Update();
   // W4：自动保存定时器 + 崩溃标记（启动时写、正常退出时清）+ 启动恢复检查。
   AutoSave.LoadSettings();
   autosaveTimer.Interval=TimeSpan.FromMinutes(AutoSave.IntervalMinutes);
   autosaveTimer.Tick+=(s,e)=>AutoSaveTick();
   autosaveTimer.Start();
   AutoSave.MarkUnclean();
   Window.Loaded+=(s,e)=>CheckCrashRecovery();
  }
  public T Find<T>(string name) where T:class{return Window.FindName(name) as T;}
  void Bind(string name,Action action){Find<Button>(name).Click+=(s,e)=>{try{action();}catch(Exception ex){Error(ex);}};}
  void ToggleMax(){Window.WindowState=Window.WindowState==WindowState.Maximized?WindowState.Normal:WindowState.Maximized;}
  void Status(string s){Find<TextBlock>("Status").Text=s;}
  void Error(Exception ex){Status("操作失败："+ex.Message);AppDialogs.Notice(Window,"操作失败",ex.Message);}
  bool MayDiscard(){if(!dirty)return true;var r=AppDialogs.Unsaved(Window,Doc==null?"未命名项目":Doc.Name);return r=="save"?Save():r=="discard";}
  void Checkpoint(){if(Doc==null)return;Pause();undo.Push(Doc.Serialize());redo.Clear();dirty=true;}
  void Changed(){if(Doc==null)return;cachedFrame=null;cachedTime=-100;RefreshInspectorSummaries();dirty=true;Doc.ScreenMotions.RemoveAll(c=>c.Start>=Doc.Length);foreach(var c in Doc.ScreenMotions)c.End=Math.Min(c.End,Doc.Length);if(selectedScreen>=Doc.ScreenMotions.Count)selectedScreen=-1;Doc.Zooms.RemoveAll(z=>z.Start>=Doc.Length);foreach(var z in Doc.Zooms)z.End=Math.Min(z.End,Doc.Length);Doc.Overlays.RemoveAll(o=>o.Start>=Doc.Length);foreach(var o in Doc.Overlays)o.End=Math.Min(o.End,Doc.Length);if(selectedOverlay>=Doc.Overlays.Count)selectedOverlay=-1;if(Doc.RecordingMarkers==null)Doc.RecordingMarkers=new List<RecordingMarker>();Doc.RecordingMarkers.RemoveAll(m=>m.Time>=Doc.Length);if(motion!=null)motion.Dispose();motion=new MotionEvaluator(Doc);position=Math.Min(position,Math.Max(0,Doc.Length-.001));Update();DrawTimeline();RefreshPreview();DrawEffectGuides();}
  void History(bool forward){var from=forward?redo:undo;var to=forward?undo:redo;if(Doc==null||from.Count==0)return;Pause();to.Push(Doc.Serialize());Doc=EditDocument.Deserialize(from.Pop());selectedCut=selectedZoom=selectedOverlay=selectedScreen=-1;Changed();BuildInspector();}
  public async Task Load(string path){
   if(!MayDiscard())return;Pause();Status("正在打开…");try{
    EditDocument d;string saved=null;
    if(Path.GetExtension(path).Equals(".dogscwin",StringComparison.OrdinalIgnoreCase)){
     string json=File.ReadAllText(path);if(json.Contains("dogsc-windows-editor")){d=EditDocument.Deserialize(json);d.Validate();saved=path;}
     else {var old=Project.Load(path);d=await Task.Run(()=>StudioMedia.Import(Path.Combine(Path.GetDirectoryName(path),old.Video)));d.Pointer=old.Pointer;d.GenerateZooms();}
    }else d=await Task.Run(()=>StudioMedia.Import(path));
    Doc=d;FilePath=saved;undo.Clear();redo.Clear();dirty=false;position=0;selectedCut=selectedZoom=selectedOverlay=selectedScreen=-1;cachedFrame=null;thumbs.Clear();waveform=null;waveformView=false;if(motion!=null)motion.Dispose();motion=new MotionEvaluator(Doc);
    audio.Open(new Uri(Doc.Source));audio.Volume=Doc.Style.Volume;audio.MediaFailed+=(s,e)=>Status("音频预览不可用；视频预览与导出仍可使用。");
    Update();BuildInspector();RefreshMediaLibrary();DrawTimeline();await RequestPreview();Status("已打开 · "+Doc.Width+" × "+Doc.Height+" · "+UI.Time(Doc.Duration));try{AutoSave.NoteSession(AutoSave.BackupDirFor(FilePath,Doc));}catch{}LoadThumbnails();
   }catch(Exception ex){Error(ex);}
  }
  public void SetDocument(EditDocument d){Doc=d;motion=new MotionEvaluator(d);position=0;dirty=false;thumbs.Clear();waveform=null;waveformView=false;musicPlayer.Close();Update();BuildInspector();RefreshMediaLibrary();DrawTimeline();RefreshPreview();LoadThumbnails();}
  async void LoadThumbnails(){if(Doc==null||recordingWorkSuspended)return;if(thumbnailWork!=null)thumbnailWork.Cancel();var work=new CancellationTokenSource();thumbnailWork=work;var token=work.Token;thumbnailJobs++;var doc=Doc;try{for(int i=thumbs.Count;i<8;i++){token.ThrowIfCancellationRequested();double t=Math.Min(doc.Duration-.05,doc.Duration*i/8);var b=await Task.Run(()=>UI.Image(StudioMedia.Frame(doc.EffectiveSource(),t,200,token,doc.Grade.VideoFilter())));token.ThrowIfCancellationRequested();if(Doc==null||Doc.Source!=doc.Source)return;thumbs.Add(b);DrawTimeline();}var wave=await Task.Run(()=>ReadWaveform(doc,token));token.ThrowIfCancellationRequested();if(Doc!=null&&Doc.Source==doc.Source){waveform=wave;DrawTimeline();}}catch{}finally{thumbnailJobs--;if(thumbnailWork==work)thumbnailWork=null;work.Dispose();}}
  async void Open(){var dlg=new Microsoft.Win32.OpenFileDialog {Filter="视频或 Windows 项目|*.mp4;*.mov;*.mkv;*.webm;*.dogscwin|所有文件|*.*"};if(dlg.ShowDialog(Window)==true)await Load(dlg.FileName);}
  bool Save(){if(Doc==null)return true;try{if(FilePath==null){var dlg=new Microsoft.Win32.SaveFileDialog {Filter="DogSC Windows 项目|*.dogscwin",FileName=Doc.Name+".dogscwin"};if(dlg.ShowDialog(Window)!=true)return false;FilePath=dlg.FileName;}Doc.Save(FilePath);dirty=false;Update();try{AutoSave.NoteSession(AutoSave.BackupDirFor(FilePath,Doc));}catch{}Status("项目已保存 · "+FilePath);return true;}catch(Exception ex){Error(ex);return false;}}
  static bool HeadlessArgs(){foreach(var a in Environment.GetCommandLineArgs())if(a.StartsWith("--")&&(a.Contains("test")||a.Contains("snapshot")))return true;return false;}
  void AutoSaveTick(){
   if(Doc==null||!dirty)return;
   try{
    string path=AutoSave.WriteBackup(Doc,FilePath);
    AutoSave.Prune(AutoSave.BackupDirFor(FilePath,Doc),AutoSave.KeepCount);
    Status("已自动保存 · "+DateTime.Now.ToString("HH:mm:ss")+" · 备份在项目目录");
    if(tab=="备份")BuildInspector();
   }catch(Exception ex){Status("自动保存失败："+ex.Message);}
  }
  void CheckCrashRecovery(){
   if(recoveryChecked||HeadlessArgs())return;recoveryChecked=true;
   CrashInfo info;
   try{info=AutoSave.DetectCrash();}catch{return;}
   if(info==null||!info.Crashed)return;
   bool restore=false;
   try{restore=AppDialogs.CrashRecovery(Window,info.Backup);}catch{return;}
   if(!restore){try{AutoSave.ClearUnclean();}catch{}Status("已放弃崩溃恢复；自动保存备份仍保留在原目录。");return;}
   try{
    var d=EditDocument.Deserialize(File.ReadAllText(info.Backup));d.Validate();
    SetDocument(d);FilePath=null;dirty=true;Update();
    AutoSave.ClearUnclean();
    Status("已从自动保存恢复 · "+Path.GetFileName(info.Backup)+"（请另存为新项目）");
   }catch(Exception ex){try{AutoSave.ClearUnclean();}catch{}Error(ex);}
  }
  void ProjectMenu(){Menu(Find<Button>("ProjectMenu"),new[]{"打开视频或项目…","保存项目","另存为…","新建录制","打开项目目录","检查更新…"},i=>{if(i==0)Open();if(i==1)Save();if(i==2){string old=FilePath;FilePath=null;if(!Save())FilePath=old;}if(i==3)Record();if(i==4&&Doc!=null)Process.Start("explorer.exe",Media.Q(Path.GetDirectoryName(FilePath??Doc.Source)));if(i==5)CheckUpdates();});}
  void Menu(Button target,string[] items,Action<int> action){var menu=UI.PopupMenu(Window,target);for(int i=0;i<items.Length;i++){int n=i;var item=new MenuItem {Header=items[i]};if(target.Name=="ProjectMenu"){item.InputGestureText=i==0?"Ctrl+O":i==1?"Ctrl+S":"";item.IsEnabled=Doc!=null||i==0||i==3||i==5;}if(target.Name=="Ratio"){item.IsCheckable=true;item.IsChecked=Doc!=null&&Doc.Style.Ratio==items[i];}item.Click+=(s,e)=>{try{action(n);}catch(Exception ex){Error(ex);}};menu.Items.Add(item);}target.ContextMenu=menu;menu.IsOpen=true;}
  void Rename(){if(Doc==null)return;string name=AppDialogs.Rename(Window,Doc.Name);if(name!=null&&name!=Doc.Name){Checkpoint();Doc.Name=name;Changed();}}
  void Record(){Pause();if(recorder!=null){recorder.Activate();return;}recorder=new RecorderWindow(this);recorder.Closed+=(s,e)=>recorder=null;recorder.Show();}
  public async Task Recorded(string path,List<PointerSample> points,List<RecordingMarker> markers=null){string project=Path.Combine(Path.GetDirectoryName(path),"project.dogscwin");await Task.Run(()=>{var doc=StudioMedia.Import(path);doc.Pointer=points;doc.IndependentCursor=true;doc.GenerateZooms();if(markers!=null)doc.RecordingMarkers=markers;doc.Save(project);});await Load(project);if(Doc==null||Doc.Source!=path)Status("新录制已保存 · "+project);else{string cam=Path.Combine(Path.GetDirectoryName(path),"camera.mp4");if(File.Exists(cam)){string device="";try{string devFile=Path.Combine(Path.GetDirectoryName(path),"camera-device.txt");if(File.Exists(devFile))device=File.ReadAllText(devFile).Trim();}catch{}Doc.Camera=new CameraClip {Enabled=true,SourcePath=cam,Device=device};dirty=true;Update();Status("新录制已保存 · "+project+"（摄像头画中画已挂接）");}}}
  void Update(){bool has=Doc!=null;Find<TextBlock>("ProjectTitle").Text=(has?Doc.Name:"未命名项目")+(dirty?" ·":"");Window.Title="DogSC · "+(has?Doc.Name:"Windows");Find<StackPanel>("EmptyState").Visibility=has?Visibility.Collapsed:Visibility.Visible;
   foreach(string key in new[]{"Export","Presets","Ratio","FitCanvas","AddZoom","Play","Previous","Next","Split","Delete","MoveLeft","MoveRight","Rename"})Find<Button>(key).IsEnabled=has;
   Find<Button>("Waveforms").IsEnabled=has&&Doc.Audio;Find<Button>("Undo").IsEnabled=undo.Count>0;Find<Button>("Redo").IsEnabled=redo.Count>0;
   Find<TextBlock>("Timecode").Text=UI.Time(position)+"  /  "+UI.Time(has?Doc.Length:0);if(has)Find<Button>("Ratio").Content=UI.MenuLabel("layout",Doc.Style.Ratio);
   // W3：吸附/波纹开关态 + 混音台预览音量/声像（主音轨走 MediaPlayer，音乐床走第二路）。
   Find<Button>("Snap").Background=UI.Brush(snap?"#E3F2EB":"#F4F4F5");Find<Button>("Ripple").Background=UI.Brush(ripple?"#E3F2EB":"#F4F4F5");
   ApplyMixerPreview();AdaptiveChrome();
  }
  void ApplyMixerPreview(){
   if(Doc==null)return;
   var src=MixerAudio.SourceChannel(Doc);
   if(src!=null){audio.Volume=Math.Max(0,Math.Min(1,Doc.Style.Volume*MixerAudio.DbToLinear(Doc.MasterGainDb+src.GainDb)));audio.Balance=src.Pan;}
   else audio.Volume=0;
   var bed=MixerAudio.MusicChannels(Doc).FirstOrDefault(c=>!string.IsNullOrEmpty(c.SourcePath));
   if(bed!=null){musicPlayer.Volume=Math.Max(0,Math.Min(1,MixerAudio.DbToLinear(Doc.MasterGainDb+bed.GainDb)));musicPlayer.Balance=bed.Pan;}
  }
  void Theme(){dark=!dark;PolishedTheme();}
  void BuildRail(){PolishedRail();}
  void Section(string text){PolishedSection(text);}
  void Note(string text){PolishedNote(text);}
  void Buttons(string[] labels,string selected,Action<string> change){PolishedButtons(labels,selected,change);}
  void Slider(string label,double min,double max,double value,string suffix,Action<double> set){PolishedSlider(label,min,max,value,suffix,set);}
  void Toggle(string label,bool value,Action<bool> set){var check=new CheckBox {FontSize=13,Content=label,IsChecked=value,Foreground=UI.Brush(dark?"#DCE0E0":"#545D62")};check.Click+=(s,e)=>{Checkpoint();set(check.IsChecked==true);Changed();};inspector.Children.Add(check);}
  void Number(string label,double value,Action<double> change){PolishedNumber(label,value,change);}
  void PositionPad(double x,double y,Action<double,double> set){PolishedPosition(x,y,set);}
  void BuildInspector(){PrepareInspector();inspector.Children.Clear();UpdateInspectorHeading();if(Doc==null){Note("打开视频或完成录制后，在这里调整画面和运镜。");return;}var a=Doc.Style;if(tab=="贴图"||tab=="柔化"){BuildOverlayInspector();return;}if(tab=="光标"){BuildCursorInspector();return;}
   // W3 新增面板。
   if(tab=="字幕"){BuildSubtitleInspector();return;}
   if(tab=="混音"){BuildMixerInspector();return;}
   if(tab=="代理"){BuildProxyInspector();return;}
   if(tab=="多机位"){BuildMulticamInspector();return;}
   if(tab=="摄像头"){BuildCameraInspector();return;}
   if(tab=="备份"){BuildAutosaveInspector();return;}
   if(tab=="缓存"){BuildRenderCacheInspector();return;}
   // W5 新增面板。
   if(tab=="美颜"){BuildBeautyInspector();return;}
   if(tab=="标记"){BuildMarkerInspector();return;}
   if(selectedCut>=0&&selectedCut<Doc.Cuts.Count){var c=Doc.Cuts[selectedCut];
    if(c.Gap){Section("空隙片段");Number("空隙时长 / 秒",c.GapDuration,v=>{c.GapDuration=EditDocument.Clamp(v,.05,Doc.Length);});Note("空隙是黑场 + 静音；波纹关闭时删除片段会留空隙。");inspector.Children.Add(UI.Button("删除空隙",()=>{Delete();}));inspector.Children.Add(UI.Button("返回画面设置",()=>{selectedCut=-1;tab="画面";BuildInspector();}));return;}
    Section("片段范围");Number("素材起点 / 秒",c.Start,v=>{c.Start=EditDocument.Clamp(v,0,c.End-.05);Doc.GenerateZooms();});Number("素材终点 / 秒",c.End,v=>{c.End=EditDocument.Clamp(v,c.Start+.05,Doc.Duration);Doc.GenerateZooms();});Section("播放速度");Buttons(new[]{"0.5×","1×","1.5×","2×"},c.Speed+"×",v=>{Checkpoint();c.Speed=double.Parse(v.TrimEnd('×'),CultureInfo.InvariantCulture);Doc.GenerateZooms();Changed();BuildInspector();});BuildSpeedSection(c);Note("拖动时间线片段两端可裁短；分割后可删除或左右重排。");inspector.Children.Add(UI.Button("返回画面设置",()=>{selectedCut=-1;tab="画面";BuildInspector();}));return;}
   if(tab=="画面"){
    Buttons(new[]{"背景","布局","样机","调色"},frameTab,v=>{frameTab=v;BuildInspector();});
    if(frameTab=="布局"){Section("画面留白");Slider("边距",0,180,a.Padding,"",v=>a.Padding=v);Section("位置与大小");PositionPad(a.X,a.Y,SetStylePosition);Slider("素材缩放",.5,1.5,a.Scale,"×",v=>a.Scale=v);InspectorResetLayout(()=>{Checkpoint();SetStylePosition(.5,.5);a.Scale=1;Changed();BuildInspector();});Section("圆角、描边与阴影");Slider("内容圆角",0,60,a.Radius,"",v=>a.Radius=v);Slider("外描边",0,8,a.Border,"",v=>a.Border=v);Slider("阴影强度",0,60,a.Shadow,"",v=>a.Shadow=v);}
    else if(frameTab=="调色"){BuildColorInspector();}
    else if(frameTab=="样机"){Section("屏幕外框");Buttons(new[]{"无","浅色窗口","深色窗口"},a.Frame=="none"?"无":a.Frame=="dark"?"深色窗口":"浅色窗口",v=>{Checkpoint();a.Frame=v=="无"?"none":v=="深色窗口"?"dark":"window";Changed();BuildInspector();});Note("窗口外框与预览、导出保持一致。");}
    else BuildBackgroundInspector();
   }else if(tab=="运镜"){
    Buttons(new[]{"缩放","屏幕 3D"},motionTab,v=>{motionTab=v;selectedScreen=selectedZoom=-1;DrawTimeline();BuildInspector();});if(motionTab=="屏幕 3D"){BuildScreenMotionInspector();return;}
    Toggle("启用自动缩放",a.AutoZoom,v=>a.AutoZoom=v);Toggle("自动跟随鼠标",a.Follow,v=>a.Follow=v);Slider("自动缩放倍率",1,3,a.ZoomScale,"×",v=>{a.ZoomScale=v;foreach(var z in Doc.Zooms.Where(z=>z.Automatic))z.Scale=v;});inspector.Children.Add(UI.Button("重新生成自动运镜",()=>{Checkpoint();Doc.GenerateZooms();Changed();BuildInspector();}));
    if(selectedZoom>=0&&selectedZoom<Doc.Zooms.Count){var z=Doc.Zooms[selectedZoom];Section(z.Automatic?"自动缩放片段":"手动缩放片段");Number("开始 / 秒",z.Start,v=>z.Start=EditDocument.Clamp(v,0,z.End-.05));Number("结束 / 秒",z.End,v=>z.End=EditDocument.Clamp(v,z.Start+.05,Doc.Length));Slider("目标大小",1,3,z.Scale,"×",v=>z.Scale=v);Slider("过渡时长",.05,2,z.Transition," 秒",v=>z.Transition=v);if(!z.Automatic){Section("缩放焦点");PositionPad(z.X,z.Y,(x,y)=>{z.X=x;z.Y=y;});}}
    else{Note(Doc.Pointer.Count==0?"当前素材没有鼠标轨迹，可添加手动缩放，并调整焦点。":"点击时间线上的缩放片段，可以修改范围、倍率和过渡时长。");inspector.Children.Add(UI.Button("＋ 添加手动缩放",AddZoom));}
   }else if(tab=="开场"){Section("开场动效");Buttons(new[]{"无","轻柔进入"},a.Opening>0?"轻柔进入":"无",v=>{Checkpoint();a.Opening=v=="无"?0:.8;Changed();BuildInspector();});if(a.Opening>0)Slider("动效时长",.2,2,a.Opening," 秒",v=>a.Opening=v);Note("淡入与轻微缩放会同时用于播放预览和导出。");}
   else if(tab=="声音"){Section("素材音轨");if(Doc.Audio){Slider("音量",0,1,a.Volume,"",v=>{a.Volume=v;audio.Volume=v;});Note("音轨随片段裁剪、重排和变速同步导出。");}else Note("当前素材没有音轨。新录制时可从录制条选择麦克风。");}
  }
  void Ratios(){if(Doc==null)return;Menu(Find<Button>("Ratio"),new[]{"适应","16:9","4:3","1:1","9:16"},i=>{Checkpoint();Doc.Style.Ratio=new[]{"适应","16:9","4:3","1:1","9:16"}[i];Changed();});}
  void Presets(){PresetGallery();}
  void Split(){if(Doc==null)return;if(selectedScreen>=0){SplitScreenMotion();return;}int i;double source=Doc.SourceTime(position,out i);var c=Doc.Cuts[i];
   if(c.Gap){double offset=0;for(int k=0;k<i;k++)offset+=Doc.Cuts[k].Length;double at=position-offset;if(at<.05||c.GapDuration-at<.05){Status("请将播放头放在空隙中间再分割。");return;}Checkpoint();double rest=c.GapDuration-at;c.GapDuration=at;Doc.Cuts.Insert(i+1,new Cut {Gap=true,GapDuration=rest,Start=c.Start,End=c.Start});selectedCut=i;selectedZoom=selectedOverlay=selectedScreen=-1;Changed();BuildInspector();return;}
   if(source-c.Start<.05||c.End-source<.05){Status("请将播放头放在片段中间再分割。");return;}Checkpoint();double end=c.End;c.End=source;Doc.Cuts.Insert(i+1,new Cut {Start=source,End=end,Speed=c.Speed});selectedCut=i;selectedZoom=selectedOverlay=selectedScreen=-1;Changed();BuildInspector();}
  void Delete(){if(Doc==null)return;if(selectedScreen>=0&&selectedScreen<Doc.ScreenMotions.Count){Checkpoint();Doc.ScreenMotions.RemoveAt(selectedScreen);selectedScreen=-1;}else if(selectedOverlay>=0&&selectedOverlay<Doc.Overlays.Count){Checkpoint();Doc.Overlays.RemoveAt(selectedOverlay);selectedOverlay=-1;}else if(selectedZoom>=0&&selectedZoom<Doc.Zooms.Count){Checkpoint();Doc.Zooms.RemoveAt(selectedZoom);selectedZoom=-1;}else if(selectedCut>=0&&Doc.Cuts.Count>1){Checkpoint();var cut=Doc.Cuts[selectedCut];
   // W3 波纹：开 = 删掉片段、后续自动跟进（Cut 首尾相接，本来就这样）；
   // 关 = 留一段同等时长的空隙（黑场 + 静音）；空隙本身删除时直接去掉。
   if(cut.Gap||ripple)Doc.Cuts.RemoveAt(selectedCut);
   else Doc.Cuts[selectedCut]=new Cut {Gap=true,GapDuration=cut.Length,Start=cut.Start,End=cut.Start,Speed=cut.Speed};
   selectedCut=-1;Doc.GenerateZooms();}else{Status("选择要删除的片段；至少保留一个录屏片段。");return;}Changed();BuildInspector();}
  void MoveCut(int direction){if(Doc==null||selectedCut<0)return;int target=selectedCut+direction;if(target<0||target>=Doc.Cuts.Count)return;Checkpoint();var c=Doc.Cuts[selectedCut];Doc.Cuts.RemoveAt(selectedCut);Doc.Cuts.Insert(target,c);selectedCut=target;Doc.GenerateZooms();Changed();}
  void AddZoom(){if(Doc==null)return;Checkpoint();double start=Math.Min(position,Math.Max(0,Doc.Length-.2));Doc.Zooms.Add(new Zoom {Start=start,End=Math.Min(Doc.Length,start+3),Scale=1.6});selectedZoom=Doc.Zooms.Count-1;position=start+Math.Min(1,(Doc.Zooms.Last().End-start)/2);selectedCut=selectedScreen=selectedOverlay=-1;motionTab="缩放";tab="运镜";Changed();BuildRail();BuildInspector();}
  void Seek(double t){Pause();if(Doc==null)return;position=EditDocument.Clamp(t,0,Math.Max(0,Doc.Length-.001));Update();DrawTimeline();RefreshPreview();}
  async void RefreshPreview(){await RequestPreview();}
  void Pause(){if(playback!=null){playback.Cancel();playback=null;}playing=false;audio.Pause();musicPlayer.Pause();try{levelMeter.Stop();}catch{}Find<Button>("Play").Content=UI.Icon("play",16);if(Doc!=null)RefreshPreview();}
  public Task PreviewNow(){return RequestPreview();}
  D.Size PreviewSize(EditDocument doc){var stage=Find<Grid>("Stage");var source=PresentationSource.FromVisual(stage);var transform=source!=null&&source.CompositionTarget!=null?source.CompositionTarget.TransformToDevice:Matrix.Identity;return PreviewPixels(SceneLayout.Aspect(doc),Math.Max(1,stage.ActualWidth)*transform.M11,Math.Max(1,stage.ActualHeight)*transform.M22);}
  internal static D.Size PreviewPixels(double ratio,double availableWidth,double availableHeight){double width=Math.Min(availableWidth,availableHeight*ratio);return new D.Size(Math.Max(2,(int)Math.Ceiling(width*1.25/2)*2),Math.Max(2,(int)Math.Ceiling(width/ratio*1.25/2)*2));}
  PreviewSurface EnsurePreviewSurface(){
   if(previewSurface!=null)return previewSurface;
   IntPtr focus=new WindowInteropHelper(Window).Handle;
   if(focus==IntPtr.Zero)focus=GpuPreviewNative.GetDesktopWindow();
   previewSurface=new PreviewSurface(preview,focus);return previewSurface;
  }
  // W1：GPU 合成只接管静态铬层 + 视频四边形；时间相关的东西（贴图/柔化/聚光、光标、开场、屏幕 3D）
  // 仍走 GDI+ Compose（合成好的帧再经 D3D/WriteableBitmap 呈现）。
  // W3：烧录字幕也是 GDI+ 画的，有字幕时同样不能走 GPU 直通，否则字幕会被跳过。
  static bool IsGpuEligible(EditDocument doc){
   return doc.Overlays.Count==0&&!doc.IndependentCursor&&doc.Style.Opening==0&&doc.ScreenMotions.Count==0&&doc.ScreenBase==null&&!(doc.SubtitleBurnIn&&doc.Subtitles!=null&&doc.Subtitles.Count>0)&&(doc.Camera==null||!doc.Camera.Enabled);
  }
  async Task RequestPreview(){renderVersion++;if(Doc==null||playing||rendering||recordingWorkSuspended)return;rendering=true;var work=new CancellationTokenSource();previewWork=work;var token=work.Token;try{int version;do{token.ThrowIfCancellationRequested();version=renderVersion;var snapshot=EditDocument.Deserialize(Doc.Serialize());var size=PreviewSize(snapshot);double time=position;int i;double source=snapshot.SourceTime(time,out i);
    // W3：预览解码源 = 代理（开时，缺失会抛错）→ 当前机位角度文件；空隙画黑场；调色走解码器 vf。
    double cutOffset;var cutAt=snapshot.CutAt(time,out cutOffset);
    string frameSource=MulticamModel.Active(snapshot)?MulticamModel.AngleSource(snapshot,MulticamModel.AngleAt(snapshot,time)):snapshot.EffectiveSource();
    string colorVf=snapshot.Grade.VideoFilter();
    // W5：降噪拼进解码 vf；美颜有遮罩时走遮罩图（单帧预览按源时间取遮罩，
    // 变速也不错位；多机位时遮罩与角度文件不对齐，回退未美颜）。
    string effectVf="";bool masked=false;
    try{effectVf=W5Effects.VideoFilter(snapshot);masked=BeautyFilter.IsMasked(snapshot)&&!MulticamModel.Active(snapshot);}catch(Exception ex){Status("美颜/降噪未生效："+ex.Message);}
    CameraStillProvider stillCam=null;
    try{if(snapshot.Camera!=null&&snapshot.Camera.Enabled&&File.Exists(snapshot.Camera.SourcePath))stillCam=new CameraStillProvider(snapshot.Camera.SourcePath);}catch{}
    var result=await Task.Run(()=>{
     byte[] frameBytes;
     if(cutAt.Gap)frameBytes=BlackFrame(snapshot.Width,snapshot.Height);
     else{
      // Keep the native source pixels for paused inspection and zoomed text.
      if(cachedFrame==null||cachedSource!=frameSource||Math.Abs(cachedTime-source)>.015){
       if(masked){
        try{cachedFrame=W5Media.FrameMasked(frameSource,Math.Min(source,snapshot.Duration-.03),snapshot.Width,token,"scale="+snapshot.Width+":-2"+effectVf,snapshot);}
        catch(Exception ex){Status("遮罩预览失败，已回退未美颜画面："+ex.Message);masked=false;cachedFrame=StudioMedia.Frame(frameSource,Math.Min(source,snapshot.Duration-.03),snapshot.Width,token,colorVf+effectVf);}
       }else cachedFrame=StudioMedia.Frame(frameSource,Math.Min(source,snapshot.Duration-.03),snapshot.Width,token,colorVf+effectVf);
       cachedSource=frameSource;cachedTime=source;
      }
      frameBytes=cachedFrame;
     }
     token.ThrowIfCancellationRequested();using(var stream=new MemoryStream(frameBytes))using(var frame=new D.Bitmap(stream))using(var composed=ComposeBitmap(frame,snapshot,time,size,null,null,null,stillCam==null?(Func<double,D.Bitmap>)null:(t=>stillCam.FrameAt(t))))return Tuple.Create(PreviewSurface.BitmapBytes(composed),size.Width,size.Height);
    });if(stillCam!=null)stillCam.Dispose();token.ThrowIfCancellationRequested();if(version==renderVersion&&!playing&&!recordingWorkSuspended){EnsurePreviewSurface().PresentComposed(result.Item1,result.Item2,result.Item3);DrawEffectGuides();}
    }while(version!=renderVersion&&!playing&&!closing&&!recordingWorkSuspended);}catch(OperationCanceledException){}catch(Exception ex){Status("预览暂不可用："+ex.Message);}finally{rendering=false;if(previewWork==work)previewWork=null;work.Dispose();}}
  static byte[] BlackFrame(int w,int h){using(var b=new D.Bitmap(w,h))using(var g=D.Graphics.FromImage(b))using(var ms=new MemoryStream()){g.Clear(D.Color.Black);b.Save(ms,Imaging.ImageFormat.Png);return ms.ToArray();}}
  static BitmapSource Compose(D.Bitmap frame,EditDocument doc,double time,D.Size size,MotionEvaluator evaluator=null,D.Image loadedWallpaper=null,StudioRenderer.SceneCache cache=null,Func<double,D.Bitmap> cameraFrame=null){using(var canvas=ComposeBitmap(frame,doc,time,size,evaluator,loadedWallpaper,cache,cameraFrame))return UI.Image(canvas);}
  static D.Bitmap ComposeBitmap(D.Bitmap frame,EditDocument doc,double time,D.Size size,MotionEvaluator evaluator=null,D.Image loadedWallpaper=null,StudioRenderer.SceneCache cache=null,Func<double,D.Bitmap> cameraFrame=null){int w=size.Width,h=size.Height;var canvas=new D.Bitmap(w,h,Imaging.PixelFormat.Format32bppArgb);using(var own=evaluator==null?new MotionEvaluator(doc):null)using(var g=D.Graphics.FromImage(canvas))using(var wallpaper=loadedWallpaper==null&&doc.Style.Background=="image"&&File.Exists(doc.Style.ImagePath)?D.Image.FromFile(doc.Style.ImagePath):null){g.InterpolationMode=D.Drawing2D.InterpolationMode.HighQualityBicubic;g.SmoothingMode=D.Drawing2D.SmoothingMode.AntiAlias;if(cache==null)StudioRenderer.Draw(g,frame,doc,evaluator??own,time,w,h,loadedWallpaper??wallpaper,canvas,cameraFrame);else cache.Render(g,frame,doc,evaluator??own,time,w,h,loadedWallpaper??wallpaper,canvas,cameraFrame);}return canvas;}
  async void Play(){if(Doc==null||playing||recordingWorkSuspended)return;if(position>=Doc.Length-.05)position=0;playing=true;playbackJobs++;overlayGuides.Children.Clear();Find<Button>("Play").Content=UI.Icon("pause",16);var tokenSource=new CancellationTokenSource();playback=tokenSource;var token=tokenSource.Token;CameraFrameStream playCam=null;
   try{var doc=EditDocument.Deserialize(Doc.Serialize());var size=PreviewSize(doc);int playbackFps=Math.Min(90,Math.Max(1,(int)Math.Round(doc.FrameRate)));double start=position;
    // W3：音乐床（有可听音乐轨时）随播放启动，播完循环；文件缺失只报状态，不拦播放。
    var bed=MixerAudio.MusicChannels(Doc).FirstOrDefault(c=>!string.IsNullOrEmpty(c.SourcePath));
    if(bed!=null){try{musicPlayer.Open(new Uri(bed.SourcePath));ApplyMixerPreview();musicPlayer.Position=TimeSpan.Zero;musicPlayer.Play();}catch(Exception ex){Status("音乐床预览不可用："+ex.Message);}}
    // W1：预览面在 UI 线程建一次（D3D 建不起来就 WriteableBitmap），GPU 合成资格按文档定。
    var surface=EnsurePreviewSurface();bool gpuPath=surface.IsHardware&&IsGpuEligible(doc);
    try{if(doc.Camera!=null&&doc.Camera.Enabled&&File.Exists(doc.Camera.SourcePath))playCam=new CameraFrameStream(doc.Camera.SourcePath,playbackFps);}catch{}
    await Task.Run(()=>{
    // W3：播放按“段”走（Cut × 多机位切换点切出来的段，见 MulticamModel.BuildSegments）；
    // 无多机位/无空隙时一段就是一个 Cut，与老行为一致。主源文件走代理（开时）。
    var segs=MulticamModel.BuildSegments(doc);
    int firstSeg=segs.Count-1;for(int s=0;s<segs.Count;s++)if(start>=segs[s].TimelineStart&&start<segs[s].TimelineEnd){firstSeg=s;break;}
    string colorVf=doc.Grade.VideoFilter();
    // W5：降噪拼进播放解码 vf；美颜有遮罩时走遮罩图。遮罩按源帧算，变速
    // （setpts 会改时间映射）或多机位（角度文件与源遮罩不对齐）时不生效，
    // 回退未美颜播放并报状态，不拦播放。
    string effectVf="";bool masked=false;
    try{effectVf=W5Effects.VideoFilter(doc);masked=BeautyFilter.IsMasked(doc)&&doc.Cuts.All(c=>c.Gap||Math.Abs(c.Speed-1)<.000001)&&!MulticamModel.Active(doc);if(BeautyFilter.IsMasked(doc)&&!masked)Status("美颜在变速/多机位片段上不生效（遮罩按源帧算），已回退未美颜播放。");}catch(Exception ex){Status("美颜/降噪未生效："+ex.Message);}
    string mainFile=MulticamModel.Active(doc)?doc.Source:doc.EffectiveSource();
    using(var evaluator=new MotionEvaluator(doc))using(var wallpaper=doc.Style.Background=="image"&&File.Exists(doc.Style.ImagePath)?D.Image.FromFile(doc.Style.ImagePath):null)using(var cache=new StudioRenderer.SceneCache(doc,size.Width,size.Height,wallpaper)){
    if(gpuPath){
     // 静态铬层只烤一次；烤失败/设备没了就回退到 GDI+ Compose 路径。
     using(var chrome=StudioRenderer.RenderChrome(doc,size.Width,size.Height,wallpaper)){var bits=PreviewSurface.BitmapBytes(chrome);bool ok=false;Window.Dispatcher.Invoke(new Action(()=>{if(!token.IsCancellationRequested)ok=surface.SetChrome(bits,size.Width,size.Height)&&surface.IsHardware;}));if(!ok)gpuPath=false;}
    }
    for(int si=firstSeg;si<segs.Count;si++){token.ThrowIfCancellationRequested();var seg=segs[si];double time=si==firstSeg?start:seg.TimelineStart;double offset=seg.TimelineStart;double from=seg.SourceStart+(time-seg.TimelineStart)*seg.Speed;
     double zoom=doc.Zooms.Count>0?doc.Zooms.Max(z=>z.Scale):1;int dw=Math.Min(doc.Width,(int)Math.Ceiling(size.Width*Math.Max(1,zoom*doc.Style.Scale)));dw=Math.Max(2,dw-dw%2);int dh=Math.Max(2,(int)Math.Round((double)dw*doc.Height/doc.Width/2)*2);
     if(seg.Gap){
      // 空隙：黑场 + 静音，按帧节拍呈现（无解码器）。
      audio.Pause();var gapClock=new Stopwatch();gapClock.Start();double gapRemaining=seg.TimelineEnd-time;int gn=0;
      using(var black=new D.Bitmap(dw,dh,Imaging.PixelFormat.Format32bppArgb)){using(var gb=D.Graphics.FromImage(black))gb.Clear(D.Color.Black);
       while(true){token.ThrowIfCancellationRequested();double elapsed=gapClock.Elapsed.TotalSeconds;if(elapsed>=gapRemaining)break;
        double t=time+gn/(double)playbackFps;if(t>=seg.TimelineEnd)break;
        int wait=(int)(gn*1000.0/playbackFps-gapClock.Elapsed.TotalMilliseconds);if(wait>0&&token.WaitHandle.WaitOne(wait))token.ThrowIfCancellationRequested();
        using(var composed=ComposeBitmap(black,doc,t,size,evaluator,wallpaper,cache,playCam==null?(Func<double,D.Bitmap>)null:(tt=>playCam.FrameAt(tt)))){var bits=PreviewSurface.BitmapBytes(composed);Window.Dispatcher.Invoke(new Action(()=>{if(!token.IsCancellationRequested)surface.PresentComposed(bits,size.Width,size.Height);}));}
        double now=Math.Min(seg.TimelineEnd,time+gapClock.Elapsed.TotalSeconds);Window.Dispatcher.Invoke(new Action(()=>{if(!token.IsCancellationRequested){position=now;Update();DrawPlayhead();}}));gn++;
       }
      }
      Window.Dispatcher.Invoke(new Action(()=>{if(!token.IsCancellationRequested){position=Math.Min(doc.Length-.001,seg.TimelineEnd);Update();DrawPlayhead();}}));
      continue;
     }
     string segFile=seg.File==doc.Source?mainFile:seg.File;
     Process p;
     if(masked){
      // 遮罩图：第二输入是遮罩文件，两路同裁（遮罩按源帧算，变速/多机位已在上头排除）。
      string graph=W5Media.MaskedFilterComplex("setpts=(PTS-STARTPTS)/"+Media.N(seg.Speed)+",fps="+playbackFps+",scale="+dw+":"+dh+":flags=lanczos"+effectVf,doc.FrameRate,dw.ToString(CultureInfo.InvariantCulture),dh.ToString(CultureInfo.InvariantCulture),doc);
      p=Media.Start("ffmpeg","-v error -ss "+Media.N(from)+" -t "+Media.N(seg.SourceEnd-from)+" -i "+Media.Q(segFile)+" -ss "+Media.N(from)+" -t "+Media.N(seg.SourceEnd-from)+" -i "+Media.Q(doc.BeautyMaskPath)+" -filter_complex "+Media.Q(graph)+" -map [out] -an -pix_fmt bgra -f rawvideo pipe:1",true);
     }else{
      p=Media.Start("ffmpeg","-v error -ss "+Media.N(from)+" -t "+Media.N(seg.SourceEnd-from)+" -i "+Media.Q(segFile)+" -an -vf setpts=(PTS-STARTPTS)/"+Media.N(seg.Speed)+",fps="+playbackFps+",scale="+dw+":"+dh+":flags=lanczos"+colorVf+effectVf+" -pix_fmt bgra -f rawvideo pipe:1",true);
     }
     using(p)using(token.Register(()=>{try{p.Kill();}catch{}}))using(var frame=new D.Bitmap(dw,dh,Imaging.PixelFormat.Format32bppArgb)){
      // W5：混音台电平表打开时，电平跟随本段播放（-re 实时解码，段尾/暂停/取消时停）。
      if(levelSubscribed)try{levelMeter.Start(segFile,from,seg.SourceEnd-from);}catch{}
      var errors=p.StandardError.ReadToEndAsync();var bytes=new byte[dw*dh*4];int n=0;var clock=new Stopwatch();double remaining=seg.TimelineEnd-time;
      while(true){token.ThrowIfCancellationRequested();int filled=0,count;while(filled<bytes.Length&&(count=p.StandardOutput.BaseStream.Read(bytes,filled,bytes.Length-filled))>0)filled+=count;if(filled==0)break;if(filled!=bytes.Length)throw new Exception("预览帧不完整。");
       if(!clock.IsRunning){Window.Dispatcher.Invoke(new Action(()=>{if(!token.IsCancellationRequested){audio.Position=TimeSpan.FromSeconds(from);audio.SpeedRatio=seg.Speed;var srcCh=MixerAudio.SourceChannel(doc);audio.Volume=srcCh==null?0:Math.Max(0,Math.Min(1,doc.Style.Volume*MixerAudio.DbToLinear(doc.MasterGainDb+srcCh.GainDb)));audio.Balance=srcCh==null?0:srcCh.Pan;audio.Play();}}));clock.Start();}
       double elapsed=clock.Elapsed.TotalSeconds;if(elapsed>=remaining)break;
       double t=time+n/(double)playbackFps;if(t>=seg.TimelineEnd)break;
       // 先按帧时刻等一拍（原来是 Compose 之后等，效果相同：每帧在 n/fps 时刻呈现）。
       int wait=(int)(n*1000.0/playbackFps-clock.Elapsed.TotalMilliseconds);if(wait>0&&token.WaitHandle.WaitOne(wait))token.ThrowIfCancellationRequested();
       if(playbackTestDelay>0&&token.WaitHandle.WaitOne(playbackTestDelay))token.ThrowIfCancellationRequested();
       // 旧逻辑：只要落后一帧就丢帧——60fps 下呈现稍慢就每帧都丢，画面抖。
       // 新逻辑：只在落后超过 2 帧时跳过呈现（仍解码、仍计 n，音画同步不断），瞬时抖动不再丢帧。
       elapsed=clock.Elapsed.TotalSeconds;
       if(elapsed-(n+1.0)/playbackFps<=2.0/playbackFps){
        bool shown=false;
        if(gpuPath){
         // 运镜裁剪与 DrawScreen 同一套数学，只是把裁剪区当 UV、把视频区当目标矩形交给 GPU。
         var pose=evaluator.At(t);var layout=SceneLayout.Make(doc,size.Width,size.Height,pose);
         float u0=(float)(pose.X-.5/pose.Zoom),v0=(float)(pose.Y-.5/pose.Zoom),u1=(float)(pose.X+.5/pose.Zoom),v1=(float)(pose.Y+.5/pose.Zoom);
         Window.Dispatcher.Invoke(new Action(()=>{if(!token.IsCancellationRequested)shown=surface.TryPresentVideo(bytes,dw,dh,layout.Video.X,layout.Video.Y,layout.Video.Width,layout.Video.Height,u0,v0,u1,v1,(float)pose.Opacity);}));
         if(!shown)gpuPath=false;
        }
        if(!shown&&!token.IsCancellationRequested){
         // 回退：GDI+ Compose 逐帧合成，但合成帧仍经 D3D 纹理/WriteableBitmap 呈现，不再走 BitmapSource。
         var data=frame.LockBits(new D.Rectangle(0,0,dw,dh),Imaging.ImageLockMode.WriteOnly,Imaging.PixelFormat.Format32bppArgb);try{Marshal.Copy(bytes,0,data.Scan0,bytes.Length);}finally{frame.UnlockBits(data);}
         using(var composed=ComposeBitmap(frame,doc,t,size,evaluator,wallpaper,cache,playCam==null?(Func<double,D.Bitmap>)null:(tt=>playCam.FrameAt(tt)))){var bits=PreviewSurface.BitmapBytes(composed);Window.Dispatcher.Invoke(new Action(()=>{if(!token.IsCancellationRequested)surface.PresentComposed(bits,size.Width,size.Height);}));}
        }
       }
       double now=Math.Min(seg.TimelineEnd,time+clock.Elapsed.TotalSeconds);Window.Dispatcher.Invoke(new Action(()=>{if(!token.IsCancellationRequested){position=now;Update();DrawPlayhead();}}));n++;
      }try{levelMeter.Stop();}catch{}try{if(!p.HasExited)p.Kill();p.WaitForExit();}catch{}if(clock.IsRunning){int wait=(int)((remaining-clock.Elapsed.TotalSeconds)*1000);if(wait>0&&token.WaitHandle.WaitOne(wait))token.ThrowIfCancellationRequested();double end=Math.Min(doc.Length-.001,seg.TimelineEnd);Window.Dispatcher.Invoke(new Action(()=>{if(!token.IsCancellationRequested){position=end;Update();DrawPlayhead();}}));}
     }
    }}
   });}catch(OperationCanceledException){}catch(Exception ex){if(!token.IsCancellationRequested)Status("播放失败："+ex.Message);}finally{playbackJobs--;if(playback==tokenSource){playback=null;playing=false;audio.Pause();musicPlayer.Pause();Find<Button>("Play").Content=UI.Icon("play",16);RefreshPreview();}try{levelMeter.Stop();}catch{}if(playCam!=null)playCam.Dispose();tokenSource.Dispose();}
  }
  double TimelineWidth {get {return Math.Max(600,Find<ScrollViewer>("TimelineScroll").ActualWidth-8)*Find<Slider>("TimelineScale").Value;}}
  Line playhead;Ellipse head;
  void DrawPlayhead(){if(playhead==null||Doc==null)return;double x=position/Doc.Length*TimelineWidth;playhead.X1=playhead.X2=x;Canvas.SetLeft(head,x-3);}
  void DrawTimeline(){if(timeline==null)return;timeline.Children.Clear();double width=TimelineWidth;timeline.Width=width;if(Doc==null)return;double px=width/Math.Max(.001,Doc.Length);int steps=Math.Max(2,(int)(width/100));double step=Math.Max(.25,Math.Pow(10,Math.Floor(Math.Log10(Doc.Length/steps))));while(Doc.Length/step>steps*1.8)step*=2;
   for(double t=0;t<Doc.Length;t+=step){var text=UI.Text(UI.Time(t),10,"#8C9498");Canvas.SetLeft(text,t*px+3);Canvas.SetTop(text,5);timeline.Children.Add(text);timeline.Children.Add(new Line {X1=t*px,X2=t*px,Y1=24,Y2=170,Stroke=UI.Brush(dark?"#2D3135":"#F0F1F2"),StrokeThickness=1});}
   double offset=0;for(int i=0;i<Doc.Cuts.Count;i++){int index=i;var cut=Doc.Cuts[i];double start=offset;var box=new Border {Width=Math.Max(4,cut.Length*px-3),Height=60,CornerRadius=new CornerRadius(9),BorderThickness=new Thickness(selectedCut==i?2:1),BorderBrush=UI.Brush(selectedCut==i?"#667870":"#D2D7D8"),Background=UI.Brush(cut.Gap?(dark?"#3A3E41":"#8B9093"):"#D8DEDB"),ClipToBounds=true};var film=new Canvas {ClipToBounds=true};box.Child=film;
    if(!cut.Gap)PaintFilm(film,box,cut,px);
    var label=new Border {Background=UI.Brush("#AA343A3D"),CornerRadius=new CornerRadius(4),Padding=new Thickness(5,2,5,2),Child=UI.Text(cut.Gap?"空隙 · "+UI.Time(cut.Length):UI.Time(cut.Length),10,"#FFFFFF")};Canvas.SetLeft(label,Math.Max(0,box.Width-66));Canvas.SetTop(label,5);film.Children.Add(label);Canvas.SetLeft(box,start*px);Canvas.SetTop(box,34);timeline.Children.Add(box);
    box.MouseLeftButtonDown+=(s,e)=>{selectedCut=index;selectedZoom=selectedOverlay=selectedScreen=-1;Seek(start+e.GetPosition(box).X/px);BuildInspector();e.Handled=true;};
    AddHandle(start*px,34,60,delta=>{var c=Doc.Cuts[index];if(c.Gap)return;c.Start=EditDocument.Clamp(c.Start+delta*c.Speed,0,c.End-.05);Doc.GenerateZooms();},selectedCut==i);
    AddHandle((start+cut.Length)*px-5,34,60,delta=>{var c=Doc.Cuts[index];if(c.Gap)c.GapDuration=EditDocument.Clamp(c.GapDuration+delta,.05,Doc.Length);else{c.End=EditDocument.Clamp(c.End+delta*c.Speed,c.Start+.05,Doc.Duration);Doc.GenerateZooms();}},selectedCut==i,()=>Doc.Cuts.Take(index).Sum(c=>c.Length)+Doc.Cuts[index].Length);
    offset+=cut.Length;
   }
   for(int i=0;i<Doc.Zooms.Count;i++){int index=i;var z=Doc.Zooms[i];var b=new Border {Width=Math.Max(4,(z.End-z.Start)*px),Height=32,CornerRadius=new CornerRadius(7),Background=UI.Brush(dark?(z.Automatic?"#665641":"#594832"):(z.Automatic?"#E7D7B9":"#D9C7A6")),BorderThickness=new Thickness(selectedZoom==i?2:1),BorderBrush=UI.Brush(selectedZoom==i?"#AE8F5C":"#D9C7A6"),Child=new TextBlock {Text="缩放 "+z.Scale.ToString("0.0")+"× · "+(z.Automatic?"自动":"手动"),FontSize=10,Foreground=UI.Brush(dark?"#F3EADF":"#5D5140"),VerticalAlignment=VerticalAlignment.Center,HorizontalAlignment=HorizontalAlignment.Center,TextTrimming=TextTrimming.CharacterEllipsis}};Canvas.SetLeft(b,z.Start*px);Canvas.SetTop(b,110);timeline.Children.Add(b);b.MouseLeftButtonDown+=(s,e)=>{selectedZoom=index;selectedCut=selectedOverlay=selectedScreen=-1;tab="运镜";motionTab="缩放";Seek(z.Start+e.GetPosition(b).X/px);BuildRail();BuildInspector();e.Handled=true;};AddHandle(z.Start*px,110,32,d=>z.Start=EditDocument.Clamp(z.Start+d,0,z.End-.1),selectedZoom==i,()=>Doc.Zooms[index].Start);AddHandle(z.End*px-5,110,32,d=>z.End=EditDocument.Clamp(z.End+d,z.Start+.1,Doc.Length),selectedZoom==i,()=>Doc.Zooms[index].End);}
   // W3：多机位切换点标记（时间线时间 + 角度号）。
   if(MulticamModel.Active(Doc)&&Doc.MulticamSwitches!=null)foreach(var sw in Doc.MulticamSwitches){timeline.Children.Add(new Line {X1=sw.Time*px,X2=sw.Time*px,Y1=24,Y2=170,Stroke=UI.Brush("#AE8F5C"),StrokeThickness=1.5,IsHitTestVisible=false});var tag=UI.Text("机位"+(sw.Angle+1),10,"#8C6D2F");Canvas.SetLeft(tag,sw.Time*px+3);Canvas.SetTop(tag,24);timeline.Children.Add(tag);}
   // W5：录制标记（红线 + 可点标签，点标签跳到标记点；拖动红线可改时间）。
   if(Doc.RecordingMarkers!=null)foreach(var m in Doc.RecordingMarkers){var mark=m;timeline.Children.Add(new Line {X1=mark.Time*px,X2=mark.Time*px,Y1=24,Y2=170,Stroke=UI.Brush("#DE5E57"),StrokeThickness=1.5,IsHitTestVisible=false});var tag=new Border {Background=UI.Brush("#AADE5E57"),CornerRadius=new CornerRadius(4),Padding=new Thickness(5,2,5,2),Child=UI.Text(mark.Label,10,"#FFFFFF"),Cursor=Cursors.Hand};Canvas.SetLeft(tag,mark.Time*px+3);Canvas.SetTop(tag,24);timeline.Children.Add(tag);tag.MouseLeftButtonDown+=(s,e)=>{Seek(mark.Time);e.Handled=true;};AddHandle(mark.Time*px,24,146,d=>{mark.Time=EditDocument.Clamp(mark.Time+d,0,Doc.Length);},true);}
   AddEffectTracks(px);foreach(var gridLine in timeline.Children.OfType<Line>())gridLine.Y2=timeline.Height-8;playhead=new Line {X1=0,X2=0,Y1=20,Y2=timeline.Height-9,Stroke=UI.Brush(dark?"#F3F5F4":"#34393B"),StrokeThickness=1.2,IsHitTestVisible=false};head=new Ellipse {Width=6,Height=6,Fill=playhead.Stroke,IsHitTestVisible=false};Canvas.SetTop(head,19);timeline.Children.Add(playhead);timeline.Children.Add(head);
   // W3：吸附线（拖动中吸到候选点时亮起，平时隐藏）。
   snapLine=new Line {X1=0,X2=0,Y1=20,Y2=timeline.Height-9,Stroke=UI.Brush("#DE5E57"),StrokeThickness=1.5,IsHitTestVisible=false,Visibility=Visibility.Collapsed};timeline.Children.Add(snapLine);
   DrawPlayhead();timeline.MouseLeftButtonDown-=TimelineSeek;timeline.MouseLeftButtonDown+=TimelineSeek;
  }
  void TimelineSeek(object s,MouseButtonEventArgs e){if(Doc==null)return;double t=e.GetPosition(timeline).X/TimelineWidth*Doc.Length;if(snap)t=SnapTime(t);Seek(t);e.Handled=true;}
  void AddHandle(double x,double y,double h,Action<double> adjust,bool visible,Func<double> edge=null){if(!visible)return;var handle=new Border {Width=6,Height=h,Background=UI.Brush("#B1A18A"),Cursor=Cursors.SizeWE};Canvas.SetLeft(handle,x);Canvas.SetTop(handle,y);timeline.Children.Add(handle);double previous=0;bool dragging=false;handle.MouseLeftButtonDown+=(s,e)=>{Checkpoint();previous=e.GetPosition(timeline).X;dragging=true;handle.CaptureMouse();e.Handled=true;};handle.MouseMove+=(s,e)=>{if(!dragging)return;double current=e.GetPosition(timeline).X;double delta=(current-previous)/TimelineWidth*Doc.Length;if(snap)delta=edge!=null?SnapDelta(edge(),delta):Math.Round(delta*Doc.FrameRate)/Doc.FrameRate;adjust(delta);previous=current;Canvas.SetLeft(handle,Math.Max(0,current-3));motion=new MotionEvaluator(Doc);RefreshPreview();};handle.MouseLeftButtonUp+=(s,e)=>{dragging=false;handle.ReleaseMouseCapture();HideSnapLine();Changed();BuildInspector();e.Handled=true;};}
  void Export(){if(Doc==null||recordingWorkSuspended)return;Pause();var dialog=new ExportWindow(this,Doc,preview.Source);dialog.ShowDialog();}
  static void VerifyPreviewDetail(string folder){
   var landscape=PreviewPixels(16.0/9,1280,900);var portrait=PreviewPixels(9.0/16,1280,900);
   if(landscape.Width<1600||portrait.Height<1124)throw new Exception("高 DPI／竖屏预览仍被固定低分辨率限制");
   string image=Path.Combine(folder,"preview-detail-source.png");using(var chart=new D.Bitmap(2560,1440))using(var g=D.Graphics.FromImage(chart)){g.Clear(D.Color.White);for(int x=0;x<chart.Width;x+=4)g.FillRectangle(D.Brushes.Black,x,0,2,chart.Height);chart.Save(image,Imaging.ImageFormat.Png);}
   var doc=new EditDocument {Source=image,Width=2560,Height=1440,Duration=3};doc.Cuts.Add(new Cut {Start=0,End=3});doc.Style.Padding=0;doc.Style.Frame="none";doc.Style.Radius=0;doc.Style.Shadow=0;doc.Style.Follow=false;doc.Style.AutoZoom=false;doc.Zooms.Add(new Zoom {Start=0,End=3,Scale=3,Transition=.05});
   BitmapSource sharp,legacy;using(var s=new MemoryStream(StudioMedia.Frame(image,0,doc.Width)))using(var frame=new D.Bitmap(s)){if(frame.Width!=2560)throw new Exception("暂停预览解码丢失素材像素");sharp=Compose(frame,doc,1,landscape);}
   using(var s=new MemoryStream(StudioMedia.Frame(image,0,960)))using(var frame=new D.Bitmap(s))legacy=Compose(frame,doc,1,landscape);
   double nativeContrast=PreviewContrast(sharp),oldContrast=PreviewContrast(legacy);if(nativeContrast<30||nativeContrast<oldContrast*2)throw new Exception("高频细节测试失败：高清 "+nativeContrast+"，旧预览 "+oldContrast);
   File.WriteAllText(Path.Combine(folder,"preview-quality-results.txt"),"PASS: native 2560px source; 1600px canvas at display width 1280; zoomed fine-line contrast "+nativeContrast.ToString("F1")+" vs legacy "+oldContrast.ToString("F1")+"; portrait follows physical display height.\n");
  }
  static double PreviewContrast(BitmapSource image){var pixels=new byte[512*4];image.CopyPixels(new Int32Rect((image.PixelWidth-512)/2,image.PixelHeight/2,512,1),pixels,512*4,0);double average=0,sum=0;for(int i=0;i<512;i++)average+=pixels[i*4];average/=512;for(int i=0;i<512;i++)sum+=Math.Pow(pixels[i*4]-average,2);return Math.Sqrt(sum/512);}
  public async Task VerifyInterface(){
   string folder=Path.Combine(Media.Root,"bin","editor-test");await Task.Run(()=>VerifyPreviewDetail(folder));await Load(Path.Combine(folder,"project.dogscwin"));
   if(Doc==null)throw new Exception("项目未能加载");int count=Doc.Cuts.Count;Seek(1);Find<Button>("Split").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));if(Doc.Cuts.Count!=count+1)throw new Exception("分割按钮未生效");
   Find<Button>("Undo").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));if(Doc.Cuts.Count!=count)throw new Exception("撤销未恢复片段");
   Find<Button>("Redo").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));if(Doc.Cuts.Count!=count+1)throw new Exception("重做未恢复分割");History(false);
   Seek(1);int zoomCount=Doc.Zooms.Count;Find<Button>("AddZoom").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));if(Doc.Zooms.Count!=zoomCount+1)throw new Exception("手动缩放未添加");History(false);
   Seek(0);audio.Volume=0;Doc.Style.Volume=0;Play();await Task.Delay(1200);if(position<.2)throw new Exception("播放头未前进");Pause();Doc.Style.Volume=1;Seek(0);await RequestPreview();await Task.Delay(700);
   tab="画面";selectedCut=selectedZoom=selectedScreen=-1;BuildRail();BuildInspector();dirty=false;Update();UI.SaveImage((FrameworkElement)Window.Content,Path.Combine(Media.Root,"bin","editor-preview.png"));
   var export=new ExportWindow(this,Doc,preview.Source);export.Show();await Task.Delay(150);UI.SaveImage((FrameworkElement)export.Content,Path.Combine(Media.Root,"bin","export-preview-v2.png"));export.Close();
   var recording=new RecorderWindow(this);recording.Show();await Task.Delay(150);UI.SaveImage((FrameworkElement)recording.Content,Path.Combine(Media.Root,"bin","recorder-preview.png"));await recording.VerifyCapture();
   File.WriteAllText(Path.Combine(folder,"interface-results.txt"),"PASS\nActual UI commands: load, split, undo, redo, add manual zoom, playback advance, pause, seek; editor/export/recorder rendered.\nNew recorder captured only a synthetic test window, stopped, saved a project and reopened it in the editor. No desktop or microphone captured.\n");
  }
 }
}
