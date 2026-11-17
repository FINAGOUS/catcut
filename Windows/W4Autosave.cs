// W4 自动保存 + 崩溃恢复 + 后台渲染缓存（2026-11-18）：C# 原生实现，
// TS 引擎只作规格/参照（桥接路线与 W3 相同，不走 node CLI）。
//
// 规格出处（参数逐一照抄，出处写在各节注释里）：
// - 自动保存 / 崩溃恢复：product/engine/src/medialib.ts 的 autosave 节——
//   AUTOSAVE_PREFIX='project-autosave-'、UNCLEAN_FLAG='.unclean'、
//   writeAutosaveBackup（时间戳备份）、markUncleanExit / clearUncleanExit、
//   latestAutosaveBackup、detectCrashRecovery（flag 存在 AND 有备份才算
//   崩溃，二者缺一都不提示恢复）、readAutosaveBackup。
//   区别：TS 的备份是 project JSON（.json），C# 侧备份就是工程文件本身
//   （.dogscwin，EditDocument.Save 的同一格式、同一原子写盘 .tmp+Replace，
//   不另发明格式）。备份目录是工程所在目录（TS 的“next to the project”）；
//   还没保存过的工程（FilePath==null）放 %LocalAppData%\DogSC.Windows\autosave\。
//   崩溃标记是全局的（%LocalAppData%\DogSC.Windows\.unclean，启动时写、
//   正常退出时清），因为启动时还不知道上次打开的是哪个工程；
//   上次工程的目录由 last-session.txt 指过去（每次备份/打开/保存时更新）。
// - 渲染缓存：product/engine/src/rendercache.ts——任务模型（段落 + 状态 +
//   缓存文件路径）、分段渲染复用导出管线、缓存命中判断（文件在 + 时长
//   误差 ≤0.05s，命中时不碰 mtime、不重新渲染）、清理接口（只删缓存
//   目录里的文件）。键是 span + 切片后工程 JSON 的 SHA256 前 16 位十六
//   进制（TS 同款）；任何段落内的改动都会改键，旧文件不再命中。
//   限制（沿用 P3f）：只支持全切项目——段落内有变速片段（Speed != 1）
//   不能切片；TS 还拒 speedCurve/beatSpeed/reverse/freeze，C# 侧对应
//   的就是 Speed != 1。空隙片段可以切片（黑场 + 静音，导出管线本来
//   就支持）。缓存是 720p/30 的中间片，只用于预览加速，不影响导出画质。
//
// 限制（诚实写清）：自动保存只在工程有未保存改动时写（dirty 才写）；
// 缓存命中只认时长，不校验文件内容——键相同但文件被外部改坏时，
// 时长对得上仍会命中（与 TS 同款语义）；缓存键含源文件绝对路径，
// 工程或素材挪位置后旧缓存不再命中（需重新渲染）。本机 Linux 跑不了
// WPF，验证全靠云端 windows-2025 构建 + 新增的 --w4-test（W4Tests.cs）。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using DogSC.Windows;

namespace DogSC.Replica {
 // ---- 自动保存 + 崩溃恢复（medialib.ts 的 autosave 节）----
 public class CrashInfo { public bool Crashed; public string Backup; public string Dir; }
 public static class AutoSave {
  public const string Prefix="project-autosave-";
  public const string FlagName=".unclean";
  public const int DefaultIntervalMinutes=5;
  public const int DefaultKeepCount=5;
  // 测试可注入（W4Tests 把 AppData 指到临时目录，不污染跑手本机状态）。
  internal static string AppDataOverride;
  public static string AppDataDir {get{return AppDataOverride??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"DogSC.Windows");}}
  public static int IntervalMinutes=DefaultIntervalMinutes;
  public static int KeepCount=DefaultKeepCount;
  public static DateTime? LastSavedAt;
  public static string LastBackupPath;
  static string SettingsPath(){return Path.Combine(AppDataDir,"autosave-settings.txt");}
  public static void LoadSettings(){
   IntervalMinutes=DefaultIntervalMinutes;KeepCount=DefaultKeepCount;
   try{
    if(!File.Exists(SettingsPath()))return;
    foreach(var line in File.ReadAllLines(SettingsPath())){
     var parts=line.Split(new[]{'='},2);if(parts.Length<2)continue;
     int v;if(!int.TryParse(parts[1].Trim(),NumberStyles.Integer,CultureInfo.InvariantCulture,out v))continue;
     if(parts[0].Trim()=="interval")IntervalMinutes=Math.Max(1,Math.Min(60,v));
     else if(parts[0].Trim()=="keep")KeepCount=Math.Max(1,Math.Min(20,v));
    }
   }catch{}
  }
  public static void SaveSettings(){
   try{Directory.CreateDirectory(AppDataDir);File.WriteAllText(SettingsPath(),"interval="+IntervalMinutes.ToString(CultureInfo.InvariantCulture)+"\nkeep="+KeepCount.ToString(CultureInfo.InvariantCulture)+"\n",new UTF8Encoding(false));}catch{}
  }
  static string SafeName(string name){
   var clean=new StringBuilder();
   foreach(char c in (name??"未命名项目"))clean.Append(Path.GetInvalidFileNameChars().Contains(c)?'_':c);
   string s=clean.ToString().Trim();return s.Length==0?"未命名项目":s;
  }
  // 备份目录：有工程路径就放工程目录；没保存过的工程放 AppData 下按工程名分的目录。
  public static string BackupDirFor(string projectPath,EditDocument doc){
   if(!string.IsNullOrEmpty(projectPath))return Path.GetDirectoryName(Path.GetFullPath(projectPath));
   return Path.Combine(AppDataDir,"autosave",SafeName(doc==null?null:doc.Name));
  }
  static string BackupName(DateTime now){return Prefix+now.ToString("yyyyMMdd-HHmmssfff",CultureInfo.InvariantCulture)+".dogscwin";}
  // 写一份备份（与工程文件同一格式），返回备份路径。now 可注入（测试用）。
  public static string WriteBackup(EditDocument doc,string projectPath,DateTime? now=null){
   if(doc==null)throw new Exception("没有可备份的工程。");
   string dir=BackupDirFor(projectPath,doc);Directory.CreateDirectory(dir);
   string path=Path.Combine(dir,BackupName(now??DateTime.Now));
   doc.Save(path);
   LastSavedAt=DateTime.Now;LastBackupPath=path;
   NoteSession(dir);
   return path;
  }
  public static List<string> ListBackups(string dir){
   if(string.IsNullOrEmpty(dir)||!Directory.Exists(dir))return new List<string>();
   return Directory.GetFiles(dir,Prefix+"*.dogscwin").OrderBy(f=>f,StringComparer.Ordinal).ToList();
  }
  public static string LatestBackup(string dir){var all=ListBackups(dir);return all.Count==0?null:all[all.Count-1];}
  // 只留最近 keep 份，返回删掉的份数（只删本前缀的备份文件）。
  public static int Prune(string dir,int keep){
   var all=ListBackups(dir);int removed=0;
   for(int i=0;i+keep<all.Count;i++){try{File.Delete(all[i]);removed++;}catch{}}
   return removed;
  }
  static string FlagPath(){return Path.Combine(AppDataDir,FlagName);}
  static string SessionPath(){return Path.Combine(AppDataDir,"last-session.txt");}
  // 启动时标记“未正常退出”；正常退出或恢复成功后清除。
  public static void MarkUnclean(){
   try{Directory.CreateDirectory(AppDataDir);File.WriteAllText(FlagPath(),DateTime.Now.ToString("o",CultureInfo.InvariantCulture),new UTF8Encoding(false));}catch{}
  }
  public static void ClearUnclean(){try{if(File.Exists(FlagPath()))File.Delete(FlagPath());}catch{}}
  public static void NoteSession(string dir){
   try{Directory.CreateDirectory(AppDataDir);File.WriteAllText(SessionPath(),dir,new UTF8Encoding(false));}catch{}
  }
  // TS detectCrashRecovery 的语义：flag 存在 AND 有备份才算崩溃。
  public static CrashInfo DetectCrash(){
   var info=new CrashInfo {Crashed=false};
   try{
    if(!File.Exists(FlagPath())||!File.Exists(SessionPath()))return info;
    string dir=File.ReadAllText(SessionPath()).Trim();
    if(dir.Length==0)return info;
    string backup=LatestBackup(dir);
    if(backup==null)return info;
    info.Crashed=true;info.Backup=backup;info.Dir=dir;return info;
   }catch{return new CrashInfo {Crashed=false};}
  }
 }
 // ---- 后台渲染缓存（rendercache.ts）----
 public class RenderCacheTask { public string Id; public double Start; public double End; public string Status; public string File; }
 public class RenderCacheResult { public bool Hit; public RenderCacheTask Task; public double Duration; }
 public static class RenderCache {
  public const double DurationTolerance=0.05;
  public const int CacheHeight=720;
  public const int CacheFps=30;
  public static string CacheDirFor(string projectPath,EditDocument doc){
   string dir=!string.IsNullOrEmpty(projectPath)?Path.GetDirectoryName(Path.GetFullPath(projectPath)):Path.GetDirectoryName(Path.GetFullPath(doc.Source));
   return Path.Combine(dir,"rendercache");
  }
  public static void ValidateCacheSpan(EditDocument doc,double start,double end){
   if(doc==null)throw new Exception("渲染缓存：没有工程。");
   if(!EditDocument.Finite(start)||!EditDocument.Finite(end)||start<0||end<=start)throw new Exception("渲染缓存：段落 ["+start+", "+end+") 为空或无效。");
   if(end>doc.Length+DurationTolerance)throw new Exception("渲染缓存：段落超出项目时长（"+doc.Length.ToString("0.00")+"s）。");
   double offset=0;
   foreach(var c in doc.Cuts){
    double cs=offset,ce=offset+c.Length;offset=ce;
    if(ce<=start||cs>=end)continue;
    // TS 拒 speedCurve/beatSpeed/reverse/freeze——C# 侧对应的就是变速片段。
    if(!c.Gap&&Math.Abs(c.Speed-1)>.000001)throw new Exception("渲染缓存只支持全切项目：段落内有变速片段（"+c.Speed.ToString("0.##",CultureInfo.InvariantCulture)+"×），v1 不能切片（P3f 限制）。");
   }
  }
  // 把工程切到 [start, end)：只保留与段落重叠的片段，重开窗口到重叠部分；
  // 运镜/屏幕 3D/贴图/柔化/字幕/多机位切换点按时间线时间平移并裁剪。
  // Pointer 是源时间，不过滤（TimelinePointer 按新 Cut 范围取，天然一致）。
  public static EditDocument SliceProject(EditDocument doc,double start,double end){
   ValidateCacheSpan(doc,start,end);
   var sliced=EditDocument.Deserialize(doc.Serialize());
   double len=end-start,offset=0;
   var cuts=new List<Cut>();
   foreach(var c in doc.Cuts){
    double cs=offset,ce=offset+c.Length;offset=ce;
    double os=Math.Max(cs,start),oe=Math.Min(ce,end);
    if(oe-os<1e-6)continue;
    if(c.Gap)cuts.Add(new Cut {Gap=true,GapDuration=oe-os,Start=c.Start,End=c.Start,Speed=c.Speed});
    else cuts.Add(new Cut {Start=c.Start+(os-cs)*c.Speed,End=c.Start+(oe-cs)*c.Speed,Speed=1});
   }
   sliced.Cuts=cuts;
   sliced.Zooms=ShiftRange(doc.Zooms,start,len);
   sliced.ScreenMotions=ShiftRange(doc.ScreenMotions,start,len);
   sliced.Overlays=ShiftRange(doc.Overlays,start,len);
   sliced.Subtitles=ShiftRange(doc.Subtitles,start,len);
   sliced.MulticamSwitches=doc.MulticamSwitches==null?new List<MulticamSwitch>():doc.MulticamSwitches.Where(s=>s.Time>=start&&s.Time<end).Select(s=>new MulticamSwitch {Time=s.Time-start,Angle=s.Angle}).ToList();
   return sliced;
  }
  // 通用平移裁剪：Start/End 按时间线时间平移，裁到 [0, len]，不重叠的丢掉。
  // 用反射取 Start/End 是为了 Zooms/ScreenMotions/Overlays/Subtitles 四种
  // 类型共用一段代码；这些类型都没有公共接口，逐个重载反而容易漏字段。
  static List<T> ShiftRange<T>(List<T> items,double start,double len) where T:new(){
   var result=new List<T>();
   if(items==null)return result;
   var type=typeof(T);
   var startProp=type.GetField("Start");var endProp=type.GetField("End");
   foreach(var item in items){
    double s=(double)startProp.GetValue(item),e=(double)endProp.GetValue(item);
    double ns=Math.Max(0,s-start),ne=Math.Min(len,e-start);
    if(ne-ns<.001)continue;
    var copy=new T();
    foreach(var f in type.GetFields())f.SetValue(copy,f.GetValue(item));
    startProp.SetValue(copy,ns);endProp.SetValue(copy,ne);
    result.Add(copy);
   }
   return result;
  }
  // 缓存键：span + 切片后工程 JSON 的 SHA256 前 16 位（TS renderCacheKey 同款）。
  public static string CacheKey(EditDocument doc,double start,double end){
   var sliced=SliceProject(doc,start,end);
   using(var sha=SHA256.Create()){
    string text=start.ToString("R",CultureInfo.InvariantCulture)+"|"+end.ToString("R",CultureInfo.InvariantCulture)+"|"+sliced.Serialize();
    return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-","").ToLowerInvariant().Substring(0,16);
   }
  }
  public static string CacheFile(string cacheDir,string key){return Path.Combine(cacheDir,key+".mp4");}
  // 渲染一段（或命中）：命中时不重新渲染、不碰 mtime；未命中时走导出管线
  // （StudioRenderer.Export，720p/30 中间片）写缓存文件。
  public static RenderCacheResult RenderSegment(EditDocument doc,double start,double end,string cacheDir,Action<double,string> progress,CancellationToken token){
   string key=CacheKey(doc,start,end);
   string file=CacheFile(cacheDir,key);
   Directory.CreateDirectory(cacheDir);
   if(File.Exists(file)){
    try{
     double actual=Media.Duration(file);
     if(Math.Abs(actual-(end-start))<=DurationTolerance)
      return new RenderCacheResult {Hit=true,Task=new RenderCacheTask {Id=key,Start=start,End=end,Status="ready",File=file},Duration=actual};
    // 时长对不上：内容与键不符，不 serve 错误长度的缓存，先删再重渲。
    File.Delete(file);
   }catch{}
  }
  var sliced=SliceProject(doc,start,end);
   // Export 拒绝覆盖已存在的文件；上面的 stale 文件已删，这里一定是新文件。
   StudioRenderer.Export(sliced,file,CacheHeight,CacheFps,progress,token);
   double duration=Media.Duration(file);
   return new RenderCacheResult {Hit=false,Task=new RenderCacheTask {Id=key,Start=start,End=end,Status="ready",File=file},Duration=duration};
  }
  // 只删缓存目录里的 *.mp4 及同名边车（.srt/.vtt/.ass，导出时写在缓存文件旁边），
  // 绝不碰目录外的东西。返回删掉的 mp4 份数。
  public static int ClearRenderCache(string cacheDir){
   if(string.IsNullOrEmpty(cacheDir)||!Directory.Exists(cacheDir))return 0;
   int removed=0;
   foreach(var file in Directory.GetFiles(cacheDir,"*.mp4")){
    try{
     File.Delete(file);removed++;
     foreach(var ext in new[]{".srt",".vtt",".ass"}){string side=Path.ChangeExtension(file,ext);try{if(File.Exists(side))File.Delete(side);}catch{}}
    }catch{}
   }
   return removed;
  }
  public static int CacheFileCount(string cacheDir){
   if(string.IsNullOrEmpty(cacheDir)||!Directory.Exists(cacheDir))return 0;
   return Directory.GetFiles(cacheDir,"*.mp4").Length;
  }
  public static long CacheTotalBytes(string cacheDir){
   if(string.IsNullOrEmpty(cacheDir)||!Directory.Exists(cacheDir))return 0;
   long total=0;
   foreach(var file in Directory.GetFiles(cacheDir,"*.mp4")){try{total+=new FileInfo(file).Length;}catch{}}
   return total;
  }
 }
}
