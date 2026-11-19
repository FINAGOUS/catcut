// W9 插件面板 UI（2026-11-19）：只做扫描结果展示。面板第一行就写明
// “宿主加载开发中”，列表里每一项也带“未加载”状态，不提供任何“挂载/启用”
// 按钮——没有加载能力，就不给用户一个点下去没反应的开关。
// 扫描只在点按钮时跑一次，不在每次 BuildInspector 时自动扫（默认路径遍历
// 可能是慢盘操作）；结果存在 Studio 实例字段里，重建面板时直接复用。
using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows.Controls;
using DogSC.Windows;

namespace DogSC.Replica {
 public partial class Studio {
  List<PluginInfo> pluginScan;
  string pluginScanNote = "还没扫描。";
  void BuildPluginSection() {
   Section("插件（VST3 / OFX）");
   Note("宿主加载开发中：本版只扫描本机已装插件、列出元数据，不加载、不处理音频/画面。VST3 读 bundle 里的 moduleinfo.json；OFX 没有元数据文件，名称与参数只能等宿主建好、加载后才知道。");
   if (pluginScan != null) {
    Note(pluginScanNote);
    foreach (var p in pluginScan.Take(20)) Note(p.DisplayLine() + "\n" + p.BundlePath);
    if (pluginScan.Count > 20) Note("……共 " + pluginScan.Count + " 个，只显示前 20 个。");
    if (pluginScan.Count == 0) Note("一个都没扫到：可能本机没装 VST3/OFX 插件，或装在了自定义目录（自定义目录扫描是下一步，见 docs/windows/plugins.md）。");
   }
   BuildPluginBridgeSection();
   inspector.Children.Add(UI.Button("扫描已装插件", () => {
    try {
     pluginScan = PluginScanner.ScanDefault();
     int vst3 = 0, ofx = 0;
     foreach (var p in pluginScan) if (p.Format == PluginFormat.Vst3) vst3++; else ofx++;
     pluginScanNote = "扫到 " + pluginScan.Count + " 个（VST3 " + vst3 + " 个，OFX " + ofx + " 个），只列元数据，未加载。";
    } catch (Exception ex) {
     pluginScan = new List<PluginInfo>();
     pluginScanNote = "扫描失败：" + ex.Message;
    }
    BuildInspector();
   }));
  }
 }
}
