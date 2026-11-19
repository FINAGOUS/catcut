// 最小 WAV 读写（只够桥用，不做通用解码器）。
// 读：RIFF/WAVE，fmt 为 PCM（1）16/24/32 位或 IEEE float（3）32 位，任意声道数；
//   跳过未知 chunk（fact / LIST / bext 等）；data 不在 fmt 后面也能找到。
// 写：float32 立体声/单声道标准 RIFF/WAVE。
// 拒绝的情形一律给原因：不是 RIFF、fmt 缺失或不支持、data 缺失、截断。
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace catcut {

// 交错 float 样本，值域不限（读 PCM16 时按 /32768 换算）。
struct WavData
{
    int32_t sampleRate = 0;
    int32_t channels = 0;
    std::vector<float> samples; // interleaved, frames = samples.size() / channels
    int64_t frames () const
    {
        return channels > 0 ? (int64_t)(samples.size () / (size_t)channels) : 0;
    }
};

bool readWav (const std::string& path, WavData& out, std::string& error);
bool writeWavFloat32 (const std::string& path, int32_t sampleRate, int32_t channels,
                      const float* interleaved, int64_t frames, std::string& error);

} // namespace catcut
