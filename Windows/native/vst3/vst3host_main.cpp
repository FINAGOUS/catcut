// Vst3BridgeHost.exe：桥的进程壳。C# 只调这个 exe，不直接碰插件代码，
// 插件崩了只死这个子进程。
//
// 用法（路径含空格时调用方要加引号；C# 侧用 Media.Q）：
//   Vst3BridgeHost.exe version
//   Vst3BridgeHost.exe classes --plugin <again.vst3 路径>
//   Vst3BridgeHost.exe params  --plugin <again.vst3 路径>
//   Vst3BridgeHost.exe process --plugin <路径> --in <in.wav> --out <out.wav>
//                              --rate 48000 [--param <id>=<0..1> ...]
// 成功：JSON 写 stdout，退出码 0。
// 失败：原因写 stderr，退出码 1（用法错）/ 2（加载错）/ 3（处理错）。
// stdout 只出 JSON，不混日志——C# 侧直接解析。
#include "vst3bridge.h"

#include "public.sdk/source/vst/utility/stringconvert.h"

#include "pluginterfaces/base/fstrdefs.h" // wscast

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

namespace {

void printErr (const std::string& s)
{
    std::fwrite (s.c_str (), 1, s.size (), stderr);
    std::fwrite ("\n", 1, 1, stderr);
}

std::string utf8FromWide (const wchar_t* w)
{
    if (!w)
        return "";
    // wscast：wchar_t* 与 char16_t* 在 Windows 上同宽，直接转。
    return Steinberg::Vst::StringConvert::convert (
        Steinberg::wscast (const_cast<wchar_t*> (w)));
}

bool getOpt (const std::vector<std::string>& args, const char* name, std::string& out)
{
    for (size_t i = 0; i + 1 < args.size (); ++i)
    {
        if (args[i] == name)
        {
            out = args[i + 1];
            return true;
        }
    }
    return false;
}

int fail (int code, const std::string& msg)
{
    printErr (msg);
    return code;
}

int runLoad (const std::string& plugin, int64_t& handle, char* err, int errSize)
{
    int32_t rc = vst3_load (plugin.c_str (), &handle, err, errSize);
    if (rc != 0)
        return fail (2, std::string ("加载插件失败：") + err);
    return 0;
}

} // namespace

#if defined(_WIN32)
int wmain (int argc, wchar_t* argv[])
#else
int main (int argc, char* argv[])
#endif
{
    std::vector<std::string> args;
    for (int i = 1; i < argc; ++i)
    {
#if defined(_WIN32)
        args.push_back (utf8FromWide (argv[i]));
#else
        args.push_back (argv[i]);
#endif
    }
    if (args.empty ())
    {
        printErr ("用法：Vst3BridgeHost.exe version | classes --plugin <路径> | params --plugin "
                  "<路径> | process --plugin <路径> --in <in.wav> --out <out.wav> --rate "
                  "<采样率> [--param <id>=<值> ...]");
        return 1;
    }
    const std::string& cmd = args[0];
    if (cmd == "version")
    {
        std::printf ("%s\n", vst3_bridge_version_string ());
        return 0;
    }
    std::string plugin;
    if (!getOpt (args, "--plugin", plugin) || plugin.empty ())
        return fail (1, "缺少 --plugin <VST3 模块路径>。");

    char err[2048] = {0};
    int64_t handle = 0;
    if (cmd == "classes" || cmd == "params")
    {
        int rc = runLoad (plugin, handle, err, (int)sizeof (err));
        if (rc != 0)
            return rc;
        char json[65536] = {0};
        int32_t r = cmd == "classes" ? vst3_classes (handle, json, (int32_t)sizeof (json), err,
                                                     (int32_t)sizeof (err))
                                     : vst3_params (handle, json, (int32_t)sizeof (json), err,
                                                    (int32_t)sizeof (err));
        if (r != 0)
        {
            vst3_unload (handle, err, (int32_t)sizeof (err));
            return fail (2, std::string ("读插件信息失败：") + err);
        }
        std::printf ("%s\n", json);
        vst3_unload (handle, err, (int32_t)sizeof (err));
        return 0;
    }
    if (cmd == "process")
    {
        std::string inWav, outWav, rateStr;
        if (!getOpt (args, "--in", inWav) || inWav.empty ())
            return fail (1, "缺少 --in <输入 wav>。");
        if (!getOpt (args, "--out", outWav) || outWav.empty ())
            return fail (1, "缺少 --out <输出 wav>。");
        if (!getOpt (args, "--rate", rateStr) || rateStr.empty ())
            return fail (1, "缺少 --rate <采样率>。");
        double rate = std::atof (rateStr.c_str ());
        int rc = runLoad (plugin, handle, err, (int)sizeof (err));
        if (rc != 0)
            return rc;
        for (size_t i = 0; i + 1 < args.size (); ++i)
        {
            if (args[i] != "--param")
                continue;
            const std::string& kv = args[i + 1];
            size_t eq = kv.find ('=');
            if (eq == std::string::npos)
            {
                vst3_unload (handle, err, (int32_t)sizeof (err));
                return fail (1, "参数格式错（应为 --param <id>=<0..1>）： " + kv);
            }
            int32_t id = std::atoi (kv.substr (0, eq).c_str ());
            double value = std::atof (kv.substr (eq + 1).c_str ());
            if (vst3_set_param (handle, id, value, err, (int32_t)sizeof (err)) != 0)
            {
                vst3_unload (handle, err, (int32_t)sizeof (err));
                return fail (2, std::string ("设参数失败：") + err);
            }
        }
        char summary[1024] = {0};
        int32_t r = vst3_process_file (handle, inWav.c_str (), outWav.c_str (), rate, summary,
                                       (int32_t)sizeof (summary), err, (int32_t)sizeof (err));
        if (r != 0)
        {
            vst3_unload (handle, err, (int32_t)sizeof (err));
            return fail (3, std::string ("处理失败：") + err);
        }
        std::printf ("%s\n", summary);
        vst3_unload (handle, err, (int32_t)sizeof (err));
        return 0;
    }
    return fail (1, "未知命令：" + cmd + "（version / classes / params / process）。");
}
