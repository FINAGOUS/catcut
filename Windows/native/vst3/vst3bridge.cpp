// CatCut VST3 桥实现：SDK hosting 层加载 + 离线立体声处理。
// 依据（VST3 SDK 3.8.0，tag v3.8.0_build_66，MIT）：
// - 加载序列照 public.sdk/samples/vst-hosting/audiohost（Module::create →
//   工厂里找 Audio Module Class → PlugProvider::initialize → getComponent /
//   getController）；PlugProvider 内部完成组件/控制器初始化与 ConnectionProxy
//   对接，析构时 terminatePlugin。
// - 离线处理序列照 VST3 规范与 AGain 自身的 process（again.cpp）：
//   setIoMode(kOfflineProcessing) → 查 bus（只认立体声）→ activateBus →
//   setBusArrangements(kStereo) → setupProcessing(kOffline/kSample32) →
//   setActive(true) → setProcessing(true) → 按 1024 帧分块 process；
//   每块都把已设参数以 offset 0 的点排进 inputParameterChanges
//   （AGain 只认这里的点，控制器里的值它不读）。
// - 本文件不做编辑器窗口、不碰 MIDI、不做重采样/下混：不符合
//   “立体声 + 指定采样率”的输入一律报错。
#include "vst3bridge.h"
#include "wavfile.h"

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/utility/stringconvert.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace {

using namespace Steinberg;
using namespace Steinberg::Vst;

constexpr int32_t kOk = 0;
constexpr int32_t kErrGeneric = 1;
constexpr int32_t kErrNotFound = 2;
constexpr int32_t kErrArg = 3;
constexpr int32_t kErrLoad = 4;
constexpr int32_t kErrProcess = 5;
constexpr int32_t kBlockFrames = 1024;

void setErr (char* errBuf, int32_t errBufSize, const std::string& msg)
{
    if (!errBuf || errBufSize <= 0)
        return;
    std::string m = msg;
    if ((int32_t)m.size () >= errBufSize)
        m.resize ((size_t)errBufSize - 1);
    std::memcpy (errBuf, m.c_str (), m.size () + 1);
}

void setJson (char* outJson, int32_t outJsonSize, const std::string& json, char* errBuf,
              int32_t errBufSize, int32_t& code)
{
    if (!outJson || outJsonSize <= 0)
    {
        setErr (errBuf, errBufSize, "输出缓冲区为空。");
        code = kErrArg;
        return;
    }
    if ((int32_t)json.size () >= outJsonSize)
    {
        setErr (errBuf, errBufSize,
                "输出缓冲区太小（需要 " + std::to_string (json.size () + 1) + " 字节）。");
        code = kErrArg;
        return;
    }
    std::memcpy (outJson, json.c_str (), json.size () + 1);
    code = kOk;
}

std::string jsonEscape (const std::string& s)
{
    std::string out;
    out.reserve (s.size () + 2);
    for (size_t i = 0; i < s.size (); ++i)
    {
        unsigned char c = (unsigned char)s[i];
        if (c == '"')
            out += "\\\"";
        else if (c == '\\')
            out += "\\\\";
        else if (c == '\n')
            out += "\\n";
        else if (c == '\r')
            out += "\\r";
        else if (c == '\t')
            out += "\\t";
        else if (c < 0x20)
        {
            char buf[8];
            std::snprintf (buf, sizeof (buf), "\\u%04x", c);
            out += buf;
        }
        else
            out += (char)c;
    }
    return out;
}

std::string jsonStr (const std::string& s)
{
    return "\"" + jsonEscape (s) + "\"";
}

// 最小 IComponentHandler：只给控制器用（IEditController::setComponentHandler）。
// 离线宿主不需要 UI 编辑回调，全部返回 kResultOk；插件从 UI 发起的 performEdit
// 在离线模式下不会发生。组件侧没有 setComponentHandler，AGain 的 sendTextMessage
// 走 ConnectionProxy 到控制器，不经过 handler。
class BridgeComponentHandler : public U::Implements<U::Directly<IComponentHandler>>
{
public:
    tresult PLUGIN_API beginEdit (ParamID) SMTG_OVERRIDE { return kResultOk; }
    tresult PLUGIN_API performEdit (ParamID, ParamValue) SMTG_OVERRIDE { return kResultOk; }
    tresult PLUGIN_API endEdit (ParamID) SMTG_OVERRIDE { return kResultOk; }
    tresult PLUGIN_API restartComponent (int32) SMTG_OVERRIDE { return kResultOk; }
};

// 全局宿主上下文（audiohost 的做法：new 出来就不释放，避免退出时序问题）。
IPtr<HostApplication> gHost;
std::once_flag gHostOnce;

void ensureHost ()
{
    std::call_once (gHostOnce, [] {
        gHost = owned (new HostApplication ());
        PlugProvider::setErrorStream (nullptr);
        PluginContextFactory::instance ().setPluginContext (gHost);
    });
}

struct Bridge
{
    std::string path;
    VST3::Hosting::Module::Ptr module;
    std::unique_ptr<PlugProvider> provider;
    IComponent* component = nullptr;       // getComponent() 已 addRef，归我释放
    IEditController* controller = nullptr; // 同上；单组件插件时与 component 同一对象
    IAudioProcessor* processor = nullptr;  // 不持有引用，随 component 走
    IPtr<BridgeComponentHandler> handler;
    VST3::Hosting::ClassInfo classInfo;
    std::map<int32_t, double> params; // id -> 归一化值（每块 process 都排队）
    bool processingActive = false;
    double activeSampleRate = 0;

    ~Bridge ()
    {
        teardownProcessing ();
        // getComponent()/getController() 各自 addRef 一次，哪怕单组件插件里
        // 两者是同一对象也要各释放一次（引用计数按 addRef 次数算，不按对象个数）。
        if (controller)
        {
            controller->release ();
            controller = nullptr;
        }
        if (component)
        {
            component->release ();
            component = nullptr;
        }
        processor = nullptr;
        provider.reset (); // 析构调 terminatePlugin：断开连接 + terminate
        module.reset ();
    }

    void teardownProcessing ()
    {
        if (!processingActive)
            return;
        processingActive = false;
        if (processor)
            processor->setProcessing (false);
        if (component)
            component->setActive (false);
    }

    // 激活一次（或采样率变了就重建）。只认立体声 in/out。
    bool ensureActive (double sampleRate, std::string& error)
    {
        if (processingActive && activeSampleRate == sampleRate)
            return true;
        teardownProcessing ();
        if (!component || !processor)
        {
            error = "桥内部错误：组件未就绪。";
            return false;
        }
        // setIoMode 有的插件返回 kNotImplemented，不卡死在这里，只要求调用过。
        // 注意：枚举叫 IoModes，值是 kOfflineProcessing（不是 kOffline）。
        component->setIoMode (IoModes::kOfflineProcessing);
        if (component->getBusCount (MediaTypes::kAudio, BusDirections::kInput) < 1 ||
            component->getBusCount (MediaTypes::kAudio, BusDirections::kOutput) < 1)
        {
            error = "插件没有音频输入/输出总线。";
            return false;
        }
        BusInfo inInfo {}, outInfo {};
        if (component->getBusInfo (MediaTypes::kAudio, BusDirections::kInput, 0, inInfo) !=
                kResultTrue ||
            component->getBusInfo (MediaTypes::kAudio, BusDirections::kOutput, 0, outInfo) !=
                kResultTrue)
        {
            error = "读插件总线信息失败。";
            return false;
        }
        if (inInfo.channelCount != 2 || outInfo.channelCount != 2)
        {
            error = "只接立体声插件：输入 " + std::to_string (inInfo.channelCount) + " 声道，输出 " +
                    std::to_string (outInfo.channelCount) + " 声道。";
            return false;
        }
        if (component->activateBus (MediaTypes::kAudio, BusDirections::kInput, 0, true) !=
                kResultTrue ||
            component->activateBus (MediaTypes::kAudio, BusDirections::kOutput, 0, true) !=
                kResultTrue)
        {
            error = "激活插件音频总线失败。";
            return false;
        }
        if (processor->canProcessSampleSize (SymbolicSampleSizes::kSample32) != kResultTrue)
        {
            error = "插件不支持 32 位浮点处理。";
            return false;
        }
        SpeakerArrangement inArr = SpeakerArr::kStereo;
        SpeakerArrangement outArr = SpeakerArr::kStereo;
        processor->setBusArrangements (&inArr, 1, &outArr, 1);
        SpeakerArrangement gotIn = 0, gotOut = 0;
        if (processor->getBusArrangement (BusDirections::kInput, 0, gotIn) == kResultTrue &&
            processor->getBusArrangement (BusDirections::kOutput, 0, gotOut) == kResultTrue)
        {
            if (gotIn != SpeakerArr::kStereo || gotOut != SpeakerArr::kStereo)
            {
                error = "插件拒绝立体声总线编排。";
                return false;
            }
        }
        ProcessSetup setup {};
        setup.processMode = ProcessModes::kOffline;
        setup.symbolicSampleSize = SymbolicSampleSizes::kSample32;
        setup.maxSamplesPerBlock = kBlockFrames;
        setup.sampleRate = sampleRate;
        if (processor->setupProcessing (setup) != kResultOk)
        {
            error = "setupProcessing 失败（离线 / 32 位 / 块 1024 / 采样率 " +
                    std::to_string ((int)sampleRate) + "）。";
            return false;
        }
        if (component->setActive (true) != kResultOk)
        {
            error = "激活插件组件失败。";
            return false;
        }
        // 注意：AudioEffect::setProcessing 默认返回 kNotImplemented，AGain 没有重写它，
        // 所以这里 kNotImplemented 也算成功（VST3 规范：setProcessing 是可选的，
        // 插件不实现就照常处理）。只认 kResultOk 会把所有没重写它的插件全拒掉。
        {
            tresult pr = processor->setProcessing (true);
            if (pr != kResultOk && pr != kNotImplemented)
            {
                component->setActive (false);
                error = "开始插件处理失败。";
                return false;
            }
        }
        processingActive = true;
        activeSampleRate = sampleRate;
        return true;
    }
};

std::mutex gRegistryMutex;
std::map<int64_t, std::unique_ptr<Bridge>> gRegistry;
int64_t gNextHandle = 1;

Bridge* findBridge (int64_t handle)
{
    std::lock_guard<std::mutex> lock (gRegistryMutex);
    auto it = gRegistry.find (handle);
    return it == gRegistry.end () ? nullptr : it->second.get ();
}

bool paramExists (Bridge* b, int32_t id)
{
    if (!b->controller)
        return false;
    int32_t count = b->controller->getParameterCount ();
    for (int32_t i = 0; i < count; ++i)
    {
        ParameterInfo info {};
        if (b->controller->getParameterInfo (i, info) == kResultTrue && info.id == id)
            return true;
    }
    return false;
}

std::string utf16ToUtf8 (const TChar* s)
{
    if (!s)
        return "";
    return Vst::StringConvert::convert (s);
}

} // namespace

extern "C" {

VST3BRIDGE_API int32_t vst3_bridge_version (void)
{
    return 1;
}

VST3BRIDGE_API const char* vst3_bridge_version_string (void)
{
    return "CatCut.Vst3Bridge 1.0 (VST3 SDK 3.8.0, MIT)";
}

VST3BRIDGE_API int32_t vst3_load (const char* utf8Path, int64_t* outHandle, char* errBuf,
                                  int32_t errBufSize)
{
    if (!utf8Path || !*utf8Path || !outHandle)
    {
        setErr (errBuf, errBufSize, "插件路径为空。");
        return kErrArg;
    }
    try
    {
        ensureHost ();
        std::string error;
        auto module = VST3::Hosting::Module::create (utf8Path, error);
        if (!module)
        {
            setErr (errBuf, errBufSize, std::string ("加载 VST3 模块失败：") + utf8Path + "。" + error);
            return kErrLoad;
        }
        auto factory = module->getFactory ();
        bool found = false;
        VST3::Hosting::ClassInfo chosen;
        for (auto& info : factory.classInfos ())
        {
            if (info.category () == kVstAudioEffectClass)
            {
                chosen = info;
                found = true;
                break;
            }
        }
        if (!found)
        {
            setErr (errBuf, errBufSize,
                    "模块里没有 Audio Module Class（不是音频效果插件）：" + std::string (utf8Path));
            return kErrLoad;
        }
        auto bridge = std::make_unique<Bridge> ();
        bridge->path = utf8Path;
        bridge->module = module;
        bridge->classInfo = chosen;
        bridge->provider = std::make_unique<PlugProvider> (factory, chosen, true);
        if (!bridge->provider->initialize ())
        {
            setErr (errBuf, errBufSize,
                    "初始化插件失败（PlugProvider::initialize）：" + std::string (utf8Path));
            return kErrLoad;
        }
        bridge->component = bridge->provider->getComponent (); // 已 addRef
        bridge->controller = bridge->provider->getController (); // 已 addRef（可为空）
        if (!bridge->component)
        {
            setErr (errBuf, errBufSize, "取不到插件组件：" + std::string (utf8Path));
            return kErrLoad;
        }
        bridge->handler = owned (new BridgeComponentHandler ());
        // 注意：setComponentHandler 只在 IEditController 接口上有，IComponent 没有。
        // 组件侧发消息（AGain::setActive 的 sendTextMessage）走 PlugProvider 已接好的
        // ConnectionProxy 到控制器，不需要 handler；handler 只给控制器。
        if (bridge->controller)
            bridge->controller->setComponentHandler (bridge->handler);
        bridge->processor = U::cast<IAudioProcessor> (bridge->component);
        if (!bridge->processor)
        {
            setErr (errBuf, errBufSize, "插件组件不是 IAudioProcessor：" + std::string (utf8Path));
            return kErrLoad;
        }
        // 记下参数默认值：之后 process 每块都按这张表排队。
        if (bridge->controller)
        {
            int32_t count = bridge->controller->getParameterCount ();
            for (int32_t i = 0; i < count; ++i)
            {
                ParameterInfo info {};
                if (bridge->controller->getParameterInfo (i, info) == kResultTrue)
                    bridge->params[info.id] = info.defaultNormalizedValue;
            }
        }
        int64_t handle = 0;
        {
            std::lock_guard<std::mutex> lock (gRegistryMutex);
            handle = gNextHandle++;
            gRegistry[handle] = std::move (bridge);
        }
        *outHandle = handle;
        return kOk;
    }
    catch (const std::exception& ex)
    {
        setErr (errBuf, errBufSize, std::string ("加载插件时抛错：") + ex.what ());
        return kErrLoad;
    }
    catch (...)
    {
        setErr (errBuf, errBufSize, "加载插件时抛未知错误。");
        return kErrLoad;
    }
}

VST3BRIDGE_API int32_t vst3_classes (int64_t handle, char* outJson, int32_t outJsonSize,
                                     char* errBuf, int32_t errBufSize)
{
    Bridge* b = findBridge (handle);
    if (!b)
    {
        setErr (errBuf, errBufSize, "句柄无效（插件未加载或已卸载）。");
        return kErrArg;
    }
    try
    {
        std::string json = "{\"classes\":[";
        bool first = true;
        for (auto& info : b->module->getFactory ().classInfos ())
        {
            if (!first)
                json += ",";
            first = false;
            // CID 字符串用 SDK 默认 toString()，与 moduleinfotool 写 moduleinfo.json
            // 的格式一致；Windows 上默认是 GUID 字节序，与源码 FUID 字面量不同序。
            json += "{\"cid\":" + jsonStr (info.ID ().toString ());
            json += ",\"category\":" + jsonStr (info.category ());
            json += ",\"name\":" + jsonStr (info.name ());
            json += ",\"vendor\":" + jsonStr (info.vendor ());
            json += ",\"version\":" + jsonStr (info.version ());
            json += ",\"sdkVersion\":" + jsonStr (info.sdkVersion ());
            json += ",\"subCategories\":[";
            bool firstSub = true;
            for (auto& sub : info.subCategories ())
            {
                if (!firstSub)
                    json += ",";
                firstSub = false;
                json += jsonStr (sub);
            }
            json += "]";
            json += ",\"classFlags\":" + std::to_string (info.classFlags ());
            json += ",\"cardinality\":" + std::to_string (info.cardinality ());
            json += "}";
        }
        json += "]}";
        int32_t code = kOk;
        setJson (outJson, outJsonSize, json, errBuf, errBufSize, code);
        return code;
    }
    catch (const std::exception& ex)
    {
        setErr (errBuf, errBufSize, std::string ("列类失败：") + ex.what ());
        return kErrGeneric;
    }
}

VST3BRIDGE_API int32_t vst3_params (int64_t handle, char* outJson, int32_t outJsonSize,
                                    char* errBuf, int32_t errBufSize)
{
    Bridge* b = findBridge (handle);
    if (!b)
    {
        setErr (errBuf, errBufSize, "句柄无效（插件未加载或已卸载）。");
        return kErrArg;
    }
    if (!b->controller)
    {
        setErr (errBuf, errBufSize, "插件没有控制器，读不到参数表。");
        return kErrGeneric;
    }
    try
    {
        std::string json = "{\"params\":[";
        int32_t count = b->controller->getParameterCount ();
        for (int32_t i = 0; i < count; ++i)
        {
            ParameterInfo info {};
            if (b->controller->getParameterInfo (i, info) != kResultTrue)
                continue;
            if (i > 0)
                json += ",";
            char num[64];
            std::snprintf (num, sizeof (num), "%.17g", info.defaultNormalizedValue);
            json += "{\"id\":" + std::to_string (info.id);
            json += ",\"title\":" + jsonStr (utf16ToUtf8 (info.title));
            json += ",\"shortTitle\":" + jsonStr (utf16ToUtf8 (info.shortTitle));
            json += ",\"units\":" + jsonStr (utf16ToUtf8 (info.units));
            json += ",\"stepCount\":" + std::to_string (info.stepCount);
            json += ",\"defaultNormalizedValue\":" + std::string (num);
            json += ",\"flags\":" + std::to_string (info.flags);
            std::snprintf (num, sizeof (num), "%.17g", b->controller->getParamNormalized (info.id));
            json += ",\"current\":" + std::string (num);
            json += "}";
        }
        json += "]}";
        int32_t code = kOk;
        setJson (outJson, outJsonSize, json, errBuf, errBufSize, code);
        return code;
    }
    catch (const std::exception& ex)
    {
        setErr (errBuf, errBufSize, std::string ("列参数失败：") + ex.what ());
        return kErrGeneric;
    }
}

VST3BRIDGE_API int32_t vst3_set_param (int64_t handle, int32_t paramId, double normalized,
                                       char* errBuf, int32_t errBufSize)
{
    Bridge* b = findBridge (handle);
    if (!b)
    {
        setErr (errBuf, errBufSize, "句柄无效（插件未加载或已卸载）。");
        return kErrArg;
    }
    if (!b->controller)
    {
        setErr (errBuf, errBufSize, "插件没有控制器，不能设参数。");
        return kErrGeneric;
    }
    if (!(normalized >= 0.0 && normalized <= 1.0))
    {
        setErr (errBuf, errBufSize,
                "参数值越界（归一化 0..1，收到 " + std::to_string (normalized) + "）。");
        return kErrArg;
    }
    if (!paramExists (b, paramId))
    {
        setErr (errBuf, errBufSize, "插件没有这个参数 id：" + std::to_string (paramId) + "。");
        return kErrArg;
    }
    try
    {
        // 同步控制器状态（以后做状态保存/恢复靠它），同时记下来每块排队。
        // begin/endEditFromHost 在 IEditControllerHostEditing 可选接口上，不在
        // IEditController 上；插件没实现它时只调 setParamNormalized。
        FUnknownPtr<IEditControllerHostEditing> hostEditing (b->controller);
        if (hostEditing.getInterface () != nullptr)
        {
            hostEditing->beginEditFromHost (paramId);
            b->controller->setParamNormalized (paramId, normalized);
            hostEditing->endEditFromHost (paramId);
        }
        else
        {
            b->controller->setParamNormalized (paramId, normalized);
        }
        b->params[paramId] = normalized;
        return kOk;
    }
    catch (const std::exception& ex)
    {
        setErr (errBuf, errBufSize, std::string ("设参数失败：") + ex.what ());
        return kErrGeneric;
    }
}

VST3BRIDGE_API int32_t vst3_process_file (int64_t handle, const char* inWav, const char* outWav,
                                          double sampleRate, char* outJson, int32_t outJsonSize,
                                          char* errBuf, int32_t errBufSize)
{
    Bridge* b = findBridge (handle);
    if (!b)
    {
        setErr (errBuf, errBufSize, "句柄无效（插件未加载或已卸载）。");
        return kErrArg;
    }
    if (!inWav || !*inWav || !outWav || !*outWav)
    {
        setErr (errBuf, errBufSize, "输入/输出 wav 路径为空。");
        return kErrArg;
    }
    if (!(sampleRate >= 8000 && sampleRate <= 192000))
    {
        setErr (errBuf, errBufSize,
                "采样率无效（8000..192000，收到 " + std::to_string (sampleRate) + "）。");
        return kErrArg;
    }
    try
    {
        catcut::WavData wav;
        std::string error;
        if (!catcut::readWav (inWav, wav, error))
        {
            setErr (errBuf, errBufSize, error);
            return kErrProcess;
        }
        if (wav.channels != 2)
        {
            setErr (errBuf, errBufSize,
                    "只接立体声 wav（收到 " + std::to_string (wav.channels) +
                        " 声道）：不静默下混，请先转成立体声。");
            return kErrProcess;
        }
        if (wav.sampleRate != (int32_t)sampleRate)
        {
            setErr (errBuf, errBufSize,
                    "采样率不匹配：文件是 " + std::to_string (wav.sampleRate) + " Hz，要求 " +
                        std::to_string ((int)sampleRate) + " Hz：不重采样，请先转好。");
            return kErrProcess;
        }
        if (!b->ensureActive (sampleRate, error))
        {
            setErr (errBuf, errBufSize, error);
            return kErrProcess;
        }

        const int64_t frames = wav.frames ();
        std::vector<float> outInterleaved ((size_t)frames * 2);
        std::vector<float> inL (kBlockFrames), inR (kBlockFrames), outL (kBlockFrames),
            outR (kBlockFrames);
        double peak = 0;
        int64_t done = 0;
        while (done < frames)
        {
            int32_t block = (int32_t)std::min<int64_t> (kBlockFrames, frames - done);
            for (int32_t i = 0; i < block; ++i)
            {
                inL[(size_t)i] = wav.samples[(size_t)(done + i) * 2];
                inR[(size_t)i] = wav.samples[(size_t)(done + i) * 2 + 1];
                outL[(size_t)i] = 0;
                outR[(size_t)i] = 0;
            }
            Sample32* inPtrs[2] = {inL.data (), inR.data ()};
            Sample32* outPtrs[2] = {outL.data (), outR.data ()};
            AudioBusBuffers inBus {};
            inBus.numChannels = 2;
            inBus.silenceFlags = 0;
            inBus.channelBuffers32 = inPtrs;
            AudioBusBuffers outBus {};
            outBus.numChannels = 2;
            outBus.silenceFlags = 0;
            outBus.channelBuffers32 = outPtrs;

            ParameterChanges inChanges;
            for (auto& kv : b->params)
            {
                int32_t index = 0;
                if (IParamValueQueue* q = inChanges.addParameterData (kv.first, index))
                {
                    int32_t pointIndex = 0;
                    q->addPoint (0, kv.second, pointIndex);
                }
            }
            ParameterChanges outChanges;

            ProcessData data {};
            data.processMode = ProcessModes::kOffline;
            data.symbolicSampleSize = SymbolicSampleSizes::kSample32;
            data.numSamples = block;
            data.numInputs = 1;
            data.numOutputs = 1;
            data.inputs = &inBus;
            data.outputs = &outBus;
            data.inputParameterChanges = &inChanges;
            data.outputParameterChanges = &outChanges;
            data.inputEvents = nullptr;
            data.outputEvents = nullptr;
            data.processContext = nullptr;

            if (b->processor->process (data) != kResultOk)
            {
                std::remove (outWav);
                setErr (errBuf, errBufSize,
                        "插件 process 失败（第 " + std::to_string (done) + " 帧起的块）。");
                return kErrProcess;
            }
            for (int32_t i = 0; i < block; ++i)
            {
                float l = outL[(size_t)i], r = outR[(size_t)i];
                if (!std::isfinite (l))
                    l = 0;
                if (!std::isfinite (r))
                    r = 0;
                outInterleaved[(size_t)(done + i) * 2] = l;
                outInterleaved[(size_t)(done + i) * 2 + 1] = r;
                peak = std::max (peak, (double)std::max (std::fabs (l), std::fabs (r)));
            }
            done += block;
        }
        if (!catcut::writeWavFloat32 (outWav, (int32_t)sampleRate, 2, outInterleaved.data (),
                                      frames, error))
        {
            std::remove (outWav);
            setErr (errBuf, errBufSize, error);
            return kErrProcess;
        }
        if (outJson && outJsonSize > 0)
        {
            char num[64];
            std::snprintf (num, sizeof (num), "%.17g", peak);
            std::string json = "{\"frames\":" + std::to_string (frames) +
                               ",\"sampleRate\":" + std::to_string ((int)sampleRate) +
                               ",\"channels\":2,\"peak\":" + std::string (num) + "}";
            int32_t code = kOk;
            setJson (outJson, outJsonSize, json, errBuf, errBufSize, code);
            if (code != kOk)
                return code;
        }
        return kOk;
    }
    catch (const std::exception& ex)
    {
        std::remove (outWav);
        setErr (errBuf, errBufSize, std::string ("处理失败：") + ex.what ());
        return kErrProcess;
    }
    catch (...)
    {
        std::remove (outWav);
        setErr (errBuf, errBufSize, "处理时抛未知错误。");
        return kErrProcess;
    }
}

VST3BRIDGE_API int32_t vst3_unload (int64_t handle, char* errBuf, int32_t errBufSize)
{
    std::unique_ptr<Bridge> owned;
    {
        std::lock_guard<std::mutex> lock (gRegistryMutex);
        auto it = gRegistry.find (handle);
        if (it == gRegistry.end ())
        {
            setErr (errBuf, errBufSize, "句柄无效（插件未加载或已卸载）。");
            return kErrArg;
        }
        owned = std::move (it->second);
        gRegistry.erase (it);
    }
    try
    {
        // 析构里做全部收尾：停处理 → 各释放一次引用 → PlugProvider 析构 terminate。
        owned.reset ();
        return kOk;
    }
    catch (const std::exception& ex)
    {
        setErr (errBuf, errBufSize, std::string ("卸载失败：") + ex.what ());
        return kErrGeneric;
    }
}

} // extern "C"
