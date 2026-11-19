# 插件宿主：评估与路线图（W9 B 级 → W10 A 级，2026-11-19）

结论先行：**W10 做到 A 级——原生桥 + AGain 测试插件，音频真过插件链。**
VST3 SDK 3.8.0（MIT，tag v3.8.0_build_66）CI 现取现编；`again` 目标编出真
AGain bundle；`CatCut.Vst3Bridge.dll`（纯 C 导出）+ `Vst3BridgeHost.exe`
（子进程壳）离线处理 48kHz 立体声；`--w10plugin-test` 验证增益 0.5 / 1.0 / 0
三档 RMS（见 §6）。OFX 宿主、导出链挂接、参数面板、编辑器窗口仍未做（§4 的 4–7）。

## 1. W9 已做到的（B 级，可验证）

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

## 3. 为什么 W9 只做到 B 级（当时的卡点，W10 已逐个过掉 1–3）

| 卡点 | 说明 |
|---|---|
| VST3 是 C++ COM 式接口 | `IComponent` / `IAudioProcessor` / `IEditController` 等是 C++ 虚表类，C# 无法直接 P/Invoke。必须写原生 C++ 桥接 DLL（或 C++/CLI），用 SDK 的 hosting 层（`Module` / `PlugProvider`）加载模块，再以纯 C 导出给 C# 调。桥本身约千行级：`IHostApplication`、`IComponentHandler`、参数读写、事件列表、总线配置、process 调用、状态保存/恢复，缺一不可。 |
| OFX 宿主同样要成套实现 | OFX API 本身是纯 C（`OfxPlugin` 结构体 + 函数指针），理论上可 P/Invoke；但宿主侧仍需实现 property / memory / image-effect / parameter / multi-thread 等全套 suite，还要处理 `kOfxImageEffectActionRender` 的图像进出。工作量与 VST3 桥同级。 |
| 测试插件要现编 | 验证用插件是 SDK 自带的 AGain（`public.sdk/samples/vst/again`，用 VSTGUI）：要 `git clone --recursive https://github.com/steinbergmedia/vst3sdk.git`、CMake 配出 `vstsdk.sln`、编 `again` 目标，产物在 `build/VST3/Release/again.vst3`；OFX 测试插件则要编 `openfx-misc` 里一个小插件（同样 CMake + OFX 头文件）。两样都没进过本仓库的云端构建，构建时间与失败面都未知。 |
| 云端构建能编桥，但时限紧 | `windows-2025` runner 有 VS Build Tools + MSVC `cl.exe` + CMake（经 `vswhere.exe` 定位，不在 PATH 上），编桥技术上可行。但本仓库 `build-test.yml` 的 job 超时是 20 分钟；SDK clone + AGain 编译 + 桥编译 + 全量旧测试，很可能超限，要先在分支上实测，不能拍脑袋保证。 |
| 编辑器 UI 是另一座山 | 离线处理（本批设计的 stem 路线）可以不做编辑器；但用户期待的“打开插件界面调参数”要把插件的 HWND 嵌进 WPF 窗口（`IPlugView::attached`），涉及窗口父子关系与消息循环，是独立的一批工作，不在离线宿主里。 |

## 4. A 级路线图（下一步清单，按顺序做）

W10 进展：1–3 已做（见 §5），4–7 未做。

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

## 5. W10 已做到的（A 级：原生桥 + AGain，可验证）

- **取 SDK**：CI 里 `git clone --depth 1 --branch v3.8.0_build_66
  https://github.com/steinbergmedia/vst3sdk.git` 再
  `git submodule update --init base cmake pluginterfaces public.sdk vstgui4`
  （只取编 AGain 要的 5 个子模块，不取 doc/tutorials；`--depth 1 --recursive`
  实测会在 doc 子模块上 checkout 失败，别用）。SDK 不进仓库，CI 现取现编。
- **编 AGain**：SDK 自带 CMake 编 `again` 目标（Release x64，VSTGUI 一起编）；
  产物 `build/VST3/Release/again.vst3`，moduleinfotool 在 post-build 步生成
  `Contents/Resources/moduleinfo.json`；CI 把它拷成 `Windows/bin/Plugins/AGain.vst3`
  随包分发。AGain 模块里有 3 个类：AGain VST3（Audio Module Class，Fx，
  CID `84E8DE5F92554F5396FAE4133C935A18`）、AGain SideChain VST3（同类）、
  AGain VST3Controller（Component Controller Class，CID `D39D5B65D7AF42FA843F4AC841EB04F0`）。
  注意类名带 "VST3" 后缀（againentry.cpp 的 `stringPluginName` 就是 "AGain VST3"），
  自测按全名断言，别写成 "AGain"。
- **桥 `CatCut.Vst3Bridge.dll` + `Vst3BridgeHost.exe`**（`Windows/native/vst3/`）：
  C++17 / MSVC /MD，与 SDK 默认一致；纯 C 导出（`vst3_load / classes / params /
  set_param / process_file / unload`）；用 SDK hosting 层（`Module` /
  `PlugProvider`）加载，最小 `IHostApplication` + `IComponentHandler`；
  离线 `kOffline / kSample32 / 块 1024`，每块把已设参数以 offset 0 的点排进
  `inputParameterChanges`（AGain 只认这里的点）；只接立体声、采样率必须与
  文件一致，单声道/多声道/采样率不匹配一律报错，不静默下混或重采样。
  C# 只 spawn 子进程调桥（`PluginHost`，见 `Windows/W10PluginHost.cs`），
  插件崩只死子进程；DLL 是同一份桥代码的共享库形态，供以后进程内加载，
  现在已验证的路径是子进程那条。
- **C# 接线（本批只做到 API + 自测）**：`PluginHost.ProcessStem()`（缺桥/
  缺插件/处理失败都抛错，绝不返回静音冒充）+ `--w10plugin-test`：
  扫描器读真 AGain 的 moduleinfo.json → 桥真实加载列类/列参数
  （Gain #0 默认 0.5 dB、VuPPM #1、Bypass #2）→ 立体声正弦过 DSP 三档验证
  （增益 0.5 / 1.0 / 0）。导出链挂接（`EditorCore.AudioArgs`）没接，
  是下一步，不是本批漏了没写——要先有插件/参数选择 UI 才接得上。
- **许可**：VST3 SDK 3.8.0 MIT（Copyright (c) 2025 Steinberg Media
  Technologies GmbH），AGain 示例与 VSTGUI 同属该 MIT；OFX 仍是 BSD-3
  （本批没引入 OFX 代码）。详见 `THIRD_PARTY_NOTICES.md`。
  “VST” 仍是 Steinberg 注册商标，只作格式名称使用。

## 6. 已知限制（W10 更新）

- 进程内加载仍未建：`PluginHostSeam.RequireHostReady()` 继续抛“宿主未建”
  （它是进程内宿主的接缝，与已建的子进程桥是两回事，别混用）。
- 桥只接立体声 48kHz（采样率参数可变，但必须与文件一致）；单声道/
  多声道/采样率不匹配都拒绝，不做下混与重采样。导出链、参数面板、
  编辑器窗口（HWND 嵌入）、OFX 宿主均未做，见 §4 的 4–7。
- 桥只取工厂里第一个 Audio Module Class（AGain 模块里是 AGain VST3 本体，
  不含 sidechain 总线）；AGain SideChain VST3 变体与 sidechain 总线没接，
  需要 sidechain 的插件不在本批范围（以后按 CID 选类再做）。
- 云端 runner 上没有音频硬件：链路验证靠离线文件 + RMS 断言，
  不宣称“在真机上听过”。用户 PC 上的实测（面板、导出挂接后）仍待补。
- 32 位 VST3（`x86-win`）只列不加载（W9 旧限制不变）。
- 扫描只认两层目录；装在更深自定义目录的插件扫不到（W9 旧限制不变）。
- 没有装插件的机器上扫描结果为空是正常的；云端 runner 上就是空，
  `--w9plugin-test` 只断言“不抛错”，不断言扫到数量。


- 扫描只认两层目录；装在更深自定义目录的插件扫不到（下一步加自定义目录设置）。
- 32 位 VST3（`x86-win`）只列不加载——x64 宿主本来就不能直接加载 32 位插件，
  要加载得另做桥接进程，不在本批范围。
- 没有装插件的机器上扫描结果为空是正常的；云端 runner 上就是空，
  `--w9plugin-test` 只断言“不抛错”，不断言扫到数量。
- 本批没有碰音频链、视频链、静音压缩、美颜/调色链、脚本转视频、
  引擎 TS、setup-tools.ps1 与编码器默认值。
