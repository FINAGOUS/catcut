// W10 插件桥状态区（2026-11-19）：只显示桥与 AGain 测试插件的就绪状态，
// 不提供“挂载/启用”按钮——离线 stem 处理 API（PluginHost.ProcessStem）
// 已就绪且有自测覆盖，但导出链挂接与参数面板是下一步，不在这里
// 给用户一个点下去没接线的开关。
using System;
using System.Windows.Controls;
using DogSC.Windows;

namespace DogSC.Replica {
 public partial class Studio {
  void BuildPluginBridgeSection() {
   Section("插件桥（VST3 原生桥）");
   Note(PluginHost.StatusLine());
   Note("已验证的路：AGain 测试插件（SDK 自带示例，MIT）离线过一遍立体声音频——增益 0.5 / 1.0 / 0 均有自测（--w10plugin-test）。插件跑在 Vst3BridgeHost.exe 子进程里，崩了不拖垮主程序。");
   Note("还没做的：导出时自动过插件（挂接 EditorCore.AudioArgs）、参数滑杆面板、插件编辑器窗口（HWND 嵌入）、OFX 宿主。见 docs/windows/plugins.md。");
  }
 }
}
