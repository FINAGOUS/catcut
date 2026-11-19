// CatCut VST3 桥：纯 C 导出，供 C#（以后）或 Vst3BridgeHost.exe（现在）调用。
// W10 插件宿主 A 级（2026-11-19）：原生桥 + AGain 实测。
//
// 设计（见 docs/windows/plugins.md §4.3）：
// - 桥用 VST3 SDK 3.8.0（MIT）的 hosting 层（Module / PlugProvider）加载模块，
//   自己实现最小 IHostApplication + IComponentHandler，不做编辑器窗口。
// - 插件代码只在调用方进程里跑：现在 C# 侧调的是 Vst3BridgeHost.exe 子进程，
//   插件崩了只死子进程，不拖垮 CatCut 主程序。本 DLL 是同一份桥代码的
//   共享库形态，供以后进程内加载用；已验证的路径是子进程那条。
// - 离线处理只接 48kHz 立体声 float（先只接 stereo in/out）：
//   单声道 / 多声道 / 采样率不匹配一律报错，绝不静默下混或重采样冒充。
// - 返回值：0 成功；非 0 失败，错误文本写 errBuf（总以 '\0' 结尾）。
//   任何失败都不留半截输出文件。
#pragma once

#include <stdint.h>

#ifdef _WIN32
#if defined(VST3BRIDGE_SHARED) && defined(VST3BRIDGE_BUILDING_DLL)
#define VST3BRIDGE_API __declspec(dllexport)
#else
#define VST3BRIDGE_API
#endif
#else
#define VST3BRIDGE_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

// 桥协议版本（整数 1 起）。C# 侧可据此拒绝不匹配的桥。
VST3BRIDGE_API int32_t vst3_bridge_version (void);
// 人类可读版本，如 "CatCut.Vst3Bridge 1.0 (VST3 SDK 3.8.0)"。
VST3BRIDGE_API const char* vst3_bridge_version_string (void);

// 加载一个 .vst3 模块（bundle 目录或单文件），成功出句柄（>0）。
// 句柄只在调用方进程内有效；跨进程传句柄没有意义。
VST3BRIDGE_API int32_t vst3_load (const char* utf8Path, int64_t* outHandle,
                                  char* errBuf, int32_t errBufSize);
// 列出模块工厂里的类：{"classes":[{"cid":"...","category":"Audio Module Class",
// "name":"AGain","vendor":"...","version":"...","sdkVersion":"VST 3.8.0",
// "subCategories":["Fx"],"classFlags":0,"cardinality":1}]}。
// 只有 category 为 "Audio Module Class" 的类才是效果。
VST3BRIDGE_API int32_t vst3_classes (int64_t handle, char* outJson, int32_t outJsonSize,
                                     char* errBuf, int32_t errBufSize);
// 列出效果的参数：{"params":[{"id":0,"title":"Gain","shortTitle":"Gain",
// "units":"dB","stepCount":0,"defaultNormalizedValue":0.5,"flags":1,"current":0.5}]}。
// current 是控制器当前值；真正进 DSP 的是 process 时每块排队的点（见 vst3_set_param）。
VST3BRIDGE_API int32_t vst3_params (int64_t handle, char* outJson, int32_t outJsonSize,
                                    char* errBuf, int32_t errBufSize);
// 设参数（归一化 0..1）。立即同步控制器状态，并在之后每块 process 里
// 以 offset 0 的点排进 inputParameterChanges（AGain 只认这里的点）。
// id 不存在或值越界都报错，不静默吞掉。
VST3BRIDGE_API int32_t vst3_set_param (int64_t handle, int32_t paramId, double normalized,
                                       char* errBuf, int32_t errBufSize);
// 离线处理一个 wav 文件：inWav 必须是立体声、采样率 == sampleRate
//（PCM16 或 float32）；outWav 写 float32 立体声，同采样率、同帧数。
// 处理失败时删除半截 outWav。成功时 outJson 可选填处理摘要
// {"frames":N,"sampleRate":48000,"channels":2,"peak":0.5}，可传 NULL。
VST3BRIDGE_API int32_t vst3_process_file (int64_t handle, const char* inWav,
                                          const char* outWav, double sampleRate,
                                          char* outJson, int32_t outJsonSize,
                                          char* errBuf, int32_t errBufSize);
// 卸载句柄。重复卸载返回错误，不崩。
VST3BRIDGE_API int32_t vst3_unload (int64_t handle, char* errBuf, int32_t errBufSize);

#ifdef __cplusplus
}
#endif
