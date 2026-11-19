# 插件宿主：评估与路线图（W9，2026-11-19）

结论先行：**本批做到 B 级——发现/扫描 + 元数据展示，不加载插件。**
完整宿主（A 级）不是一批能诚实做完的量，见 §4 的卡点清单。

## 1. 本批已做到的（B 级，可验证）

- VST3 扫描：默认路径 `%CommonProgramFiles%\VST3`、
  `%CommonProgramFiles(x86)%\VST3`、`%LOCALAPPDATA%\Programs\Common\VST3`、
  `%LOCALAPPDATA%\Programs\VST3`；扫两层（根目录 + 厂商子目录）。
- VST3 元数据：只读 bundle 里的 `moduleinfo.json`，不加载二进制。
  字段名逐字对照 SDK 源码
  `steinbergmedia/vst3_public_sdk` 的
  `source/vst/moduleinfo/moduleinfoparser.cpp`（2026-11-19 拉取核对）：
  顶层 `Name` / `Version` / `Factory Info`（`Vendor`、`URL`、`E-Mail`、`Flags`）/
  `Classes` / `Compatibility`（可选）；每类 `CID`、`Category`、`Name`、`Vendor`、
  `Version`、`SDKVersion`、`Sub Categories`、`Class Flags`、`Cardinality` 必填，
  `Snapshots` 可选。规范位置是 `Contents/Resources/moduleinfo.json`
  （`module_win32.cpp` 的 `getModuleInfoPath`），3.7 老位置
  `Contents/moduleinfo.json` 也认。扫描器比 SDK 宽松：SDK 缺必填键就整文件
  拒掉，扫描器只要求每类有 `CID`/`Category`/`Name`，其余缺了照样列出。
  只有 `Category` 为 `Audio Module Class` 的类才是效果；配对的
  `Component Controller Class` 不当效果列。
- OFX 扫描：默认路径 `%CommonProgramFiles%\OFX\Plugins`，另读 `OFX_PLUGIN_PATH`
  环境变量（分号分隔，按规范先于默认路径）。只认 bundle 结构
  `NAME.ofx.bundle/Contents/Win64/NAME.ofx` 并报二进制在不在。
  OFX 没有 `moduleinfo.json` 这类元数据文件，名称/参数只能加载后读取，
  所以 OFX 项的元数据一律标“未知”，不是 bug。
- 诚实护栏：`PluginHostSeam.RequireHostReady()` 一律抛“宿主未建”；
  UI（声音 tab 底部“插件”区）第一行就写“宿主加载开发中”，每项都带“未加载”；
  不提供“挂载/启用”按钮。`--w9plugin-test` 的夹具里“二进制”是文本文件，
  本身就是证明：扫描从不加载。
- 测试夹具里有一份真实数据复刻：Steinberg 论坛 validator 实测输出的
  GVst（`Audio Module Class`，`Fx`，`1.0.0.1`，`VST 3.7.5`，
  CID `0CDBB66985D548A9BFD8371909D24BB3`），不是现编的。

## 2. 许可（2026-11-19 核对，纠正旧说法）

- **VST3 SDK：MIT，不用签协议。**VST 3.8.0（2025-10 发布）起，
  `steinbergmedia/vst3sdk` 的 `LICENSE.txt` 原文就是 MIT；
  旧的 GPLv3 / Steinberg 专有许可双轨已停止，
  官网说法是 "Licensing under GPLv3 and the Steinberg proprietary license
  is no longer available"。任务简报里“商用发行前要签免费许可协议”是
  3.8 之前的旧规则，本批按 3.8 的 MIT 执行，不再要求签约。
  但 **"VST" 仍是 Steinberg 的注册商标**：只作格式名称使用，
  不声称 Steinberg 背书或关联；发版物里保留
  "VST is a registered trademark of Steinberg Media Technologies GmbH"。
  本仓库没有引入 SDK 代码（连头文件都没有），只有本文档的说明。
- **OFX API 与 Support 库：BSD-3-Clause**
  （`AcademySoftwareFoundation/openfx`，`Support/LICENSE`）。
  本仓库同样没有引入其代码。
- **排除项**：VST2 已废弃——Steinberg 自 2018-10 起不再发新 VST2 许可，
  不做；AAX 是 Pro Tools 专用、AU 是苹果专用，不做。

## 3. 为什么 A 级本批做不了（卡点，不是借口）

| 卡点 | 说明 |
|---|---|
| VST3 是 C++ COM 式接口 | `IComponent` / `IAudioProcessor` / `IEditController` 等是 C++ 虚表类，C# 无法直接 P/Invoke。必须写原生 C++ 桥接 DLL（或 C++/CLI），用 SDK 的 hosting 层（`Module` / `PlugProvider`）加载模块，再以纯 C 导出给 C# 调。桥本身约千行级：`IHostApplication`、`IComponentHandler`、参数读写、事件列表、总线配置、process 调用、状态保存/恢复，缺一不可。 |
| OFX 宿主同样要成套实现 | OFX API 本身是纯 C（`OfxPlugin` 结构体 + 函数指针），理论上可 P/Invoke；但宿主侧仍需实现 property / memory / image-effect / parameter / multi-thread 等全套 suite，还要处理 `kOfxImageEffectActionRender` 的图像进出。工作量与 VST3 桥同级。 |
| 测试插件要现编 | 验证用插件是 SDK 自带的 AGain（`public.sdk/samples/vst/again`，用 VSTGUI）：要 `git clone --recursive https://github.com/steinbergmedia/vst3sdk.git`、CMake 配出 `vstsdk.sln`、编 `again` 目标，产物在 `build/VST3/Release/again.vst3`；OFX 测试插件则要编 `openfx-misc` 里一个小插件（同样 CMake + OFX 头文件）。两样都没进过本仓库的云端构建，构建时间与失败面都未知。 |
| 云端构建能编桥，但时限紧 | `windows-2025` runner 有 VS Build Tools + MSVC `cl.exe` + CMake（经 `vswhere.exe` 定位，不在 PATH 上），编桥技术上可行。但本仓库 `build-test.yml` 的 job 超时是 20 分钟；SDK clone + AGain 编译 + 桥编译 + 全量旧测试，很可能超限，要先在分支上实测，不能拍脑袋保证。 |
| 编辑器 UI 是另一座山 | 离线处理（本批设计的 stem 路线）可以不做编辑器；但用户期待的“打开插件界面调参数”要把插件的 HWND 嵌进 WPF 窗口（`IPlugView::attached`），涉及窗口父子关系与消息循环，是独立的一批工作，不在离线宿主里。 |

## 4. A 级路线图（下一步清单，按顺序做）

1. **取 SDK**：`git clone --recursive https://github.com/steinbergmedia/vst3sdk.git`
   （注意是 umbrella 仓，`vst3_public_sdk` 等是子模块；或直接用
   `steinbergmedia/vst3_public_sdk`）。只取，不改 SDK，不把 SDK 整个
   塞进本仓库——CI 里现取现编，或用 `vcpkg`/git submodule 钉住版本。
   钉版本建议：SDK 3.8.x（MIT）或更新的 MIT 版，绝不用 3.7.x（旧双轨）。
2. **编 AGain**：CMake 配 `vstsdk.sln`，Release x64 编 `again` 目标；
   另编 `moduleinfotool` 与 `validator`（SDK 自带工具）。
   验收：`build/VST3/Release/again.vst3` 生成，且 `validator` 跑过；
   本批扫描器对它跑一遍，`moduleinfo.json` 必须解析出 AGain 两类。
3. **写桥 `CatCut.Vst3Bridge.dll`**（C++，MSVC，纯 C 导出）：
   `bridge_load(path)` → 句柄；`bridge_classes(handle)` → 类列表；
   `bridge_params(handle)` → 参数（id、标题、单位、范围、默认值）；
   `bridge_set_param(handle, id, normalized)`；
   `bridge_process_file(handle, inWav, outWav, sampleRate)`（离线，
   48kHz 立体声 float，先只接 stereo in/out，拒绝多声道而不是静默下混）；
   `bridge_unload(handle)`。桥崩溃不能拖垮主程序：加载与处理放独立进程
   或至少独立 AppDomain 之外——C# 侧用子进程调桥更稳妥（插件是第三方
   代码，崩了只死子进程）；这点要在设计时定死，不能事后补。
4. **C# 接线**：`PluginHost.ProcessStem()`，复用 `VocalSep.Separate()` 的
   同款语义（缺桥/缺插件/处理失败都抛错，绝不返回静音冒充）；
   挂进 `EditorCore.AudioArgs`：VST3 stem 在 W8 链
   （变声→EQ→压缩→修复）之后、混音之前，参考
   `W8AudioChain.AudioSourceForExport` 的单片段直通路子，
   多段项目先只支持“整条时间线混音后过一遍插件”或明确拒绝，
   不要硬套单片段逻辑。
5. **OFX 宿主**：取 `AcademySoftwareFoundation/openfx`（BSD-3），
   用 `Support/HostSupport` 搭宿主；测试插件用 `openfx-misc` 的一个
   简单滤镜（如 `Test` 或 `Checkerboard` 类小插件）；
   渲染走导出前视频预处理（与防抖/对象跟踪同一位置，见
   `EditorCore.Export` 的 `Stabilizer`/`ObjectTracker` 段），
   先只做 Filter context，General context 以后再说。
6. **UI**：扫描列表里的项出现“加载”按钮；参数面板用插件自报的参数表
   动态生成滑杆（0–1 归一化 + 单位显示）；编辑器窗口（HWND 嵌入）
   单独立项，不与离线处理混在同一批验收。
7. **许可与署名**：桥与测试插件进仓库时更新 `THIRD_PARTY_NOTICES.md`
   （VST3 SDK MIT、OFX BSD-3、AGain 示例的 Steinberg 版权头）；
   发版物保留 VST 商标声明；不反编译任何闭源插件，
   不从剪映/CapCut/FCP/Prisma 扒 UI、音乐、字体（老红线不变）。

## 5. 已知限制（本批）

- 扫描只认两层目录；装在更深自定义目录的插件扫不到（下一步加自定义目录设置）。
- 32 位 VST3（`x86-win`）只列不加载——x64 宿主本来就不能直接加载 32 位插件，
  要加载得另做桥接进程，不在本批范围。
- 没有装插件的机器上扫描结果为空是正常的；云端 runner 上就是空，
  `--w9plugin-test` 只断言“不抛错”，不断言扫到数量。
- 本批没有碰音频链、视频链、静音压缩、美颜/调色链、脚本转视频、
  引擎 TS、setup-tools.ps1 与编码器默认值。
