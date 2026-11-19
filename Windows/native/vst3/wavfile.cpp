// 最小 WAV 读写实现（见 wavfile.h 的约定）。
#include "wavfile.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace catcut {
namespace {

bool readU32 (FILE* f, uint32_t& v)
{
    uint8_t b[4];
    if (std::fread (b, 1, 4, f) != 4)
        return false;
    v = (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24);
    return true;
}

bool readU16 (FILE* f, uint16_t& v)
{
    uint8_t b[2];
    if (std::fread (b, 1, 2, f) != 2)
        return false;
    v = (uint16_t)(b[0] | (b[1] << 8));
    return true;
}

void writeU32 (FILE* f, uint32_t v)
{
    uint8_t b[4] = {(uint8_t)(v & 0xff), (uint8_t)((v >> 8) & 0xff), (uint8_t)((v >> 16) & 0xff),
                    (uint8_t)((v >> 24) & 0xff)};
    std::fwrite (b, 1, 4, f);
}

void writeU16 (FILE* f, uint16_t v)
{
    uint8_t b[2] = {(uint8_t)(v & 0xff), (uint8_t)((v >> 8) & 0xff)};
    std::fwrite (b, 1, 2, f);
}

void writeFourCC (FILE* f, const char* s)
{
    std::fwrite (s, 1, 4, f);
}

// 跳过 chunk 体（含奇数长度后的 1 字节 pad）。
bool skipChunk (FILE* f, uint32_t size)
{
    if (std::fseek (f, (long)size + (size & 1), SEEK_CUR) != 0)
        return false;
    return true;
}

} // namespace

bool readWav (const std::string& path, WavData& out, std::string& error)
{
    FILE* f = nullptr;
#ifdef _WIN32
    if (fopen_s (&f, path.c_str (), "rb") != 0 || !f)
    {
        error = "打不开输入 wav：";
        error += path;
        return false;
    }
#else
    f = std::fopen (path.c_str (), "rb");
    if (!f)
    {
        error = "打不开输入 wav：";
        error += path;
        return false;
    }
#endif
    struct Closer
    {
        FILE* f;
        ~Closer () { std::fclose (f); }
    } closer{f};

    char riff[4];
    if (std::fread (riff, 1, 4, f) != 4 || std::memcmp (riff, "RIFF", 4) != 0)
    {
        error = "不是 RIFF/WAVE 文件：";
        error += path;
        return false;
    }
    uint32_t riffSize = 0;
    if (!readU32 (f, riffSize))
    {
        error = "RIFF 头截断：";
        error += path;
        return false;
    }
    char wave[4];
    if (std::fread (wave, 1, 4, f) != 4 || std::memcmp (wave, "WAVE", 4) != 0)
    {
        error = "不是 WAVE 文件：";
        error += path;
        return false;
    }

    bool haveFmt = false;
    uint16_t audioFormat = 0, channels = 0, bitsPerSample = 0;
    uint32_t sampleRate = 0;
    long dataPos = -1;
    uint32_t dataSize = 0;

    while (true)
    {
        char id[4];
        if (std::fread (id, 1, 4, f) != 4)
            break; // 文件结束
        uint32_t size = 0;
        if (!readU32 (f, size))
        {
            error = "chunk 头截断：";
            error += path;
            return false;
        }
        if (std::memcmp (id, "fmt ", 4) == 0)
        {
            if (size < 16)
            {
                error = "fmt chunk 太短（<16 字节）：";
                error += path;
                return false;
            }
            if (!readU16 (f, audioFormat) || !readU16 (f, channels) || !readU32 (f, sampleRate))
            {
                error = "fmt chunk 截断：";
                error += path;
                return false;
            }
            uint32_t byteRate = 0;
            uint16_t blockAlign = 0;
            if (!readU32 (f, byteRate) || !readU16 (f, blockAlign) || !readU16 (f, bitsPerSample))
            {
                error = "fmt chunk 截断：";
                error += path;
                return false;
            }
            if (size > 16 && !skipChunk (f, size - 16))
            {
                error = "fmt chunk 扩展区截断：";
                error += path;
                return false;
            }
            haveFmt = true;
        }
        else if (std::memcmp (id, "data", 4) == 0)
        {
            dataPos = std::ftell (f);
            dataSize = size;
            if (!skipChunk (f, size))
            {
                error = "data chunk 截断：";
                error += path;
                return false;
            }
        }
        else
        {
            if (!skipChunk (f, size))
            {
                error = "未知 chunk 截断：";
                error += path;
                return false;
            }
        }
    }

    if (!haveFmt)
    {
        error = "wav 缺少 fmt chunk：";
        error += path;
        return false;
    }
    if (dataPos < 0)
    {
        error = "wav 缺少 data chunk：";
        error += path;
        return false;
    }
    if (channels < 1 || channels > 8 || sampleRate == 0)
    {
        error = "wav 声道数或采样率无效（声道 ";
        error += std::to_string (channels);
        error += "，采样率 ";
        error += std::to_string (sampleRate);
        error += "）：";
        error += path;
        return false;
    }
    int bytesPerSample = 0;
    if (audioFormat == 1)
    { // PCM
        if (bitsPerSample == 16)
            bytesPerSample = 2;
        else if (bitsPerSample == 24)
            bytesPerSample = 3;
        else if (bitsPerSample == 32)
            bytesPerSample = 4;
        else
        {
            error = "不支持的 PCM 位深（只认 16/24/32）：";
            error += std::to_string (bitsPerSample);
            return false;
        }
    }
    else if (audioFormat == 3)
    { // IEEE float
        if (bitsPerSample != 32)
        {
            error = "不支持的 float 位深（只认 32）：";
            error += std::to_string (bitsPerSample);
            return false;
        }
        bytesPerSample = 4;
    }
    else
    {
        error = "不支持的 wav 编码（只认 PCM / IEEE float，format=";
        error += std::to_string (audioFormat);
        error += "）：";
        error += path;
        return false;
    }

    uint32_t frameBytes = (uint32_t)channels * (uint32_t)bytesPerSample;
    if (frameBytes == 0 || dataSize % frameBytes != 0)
    {
        error = "data 长度不是整帧：";
        error += path;
        return false;
    }
    int64_t frames = dataSize / frameBytes;
    if (frames <= 0)
    {
        error = "wav 是空的（0 帧）：";
        error += path;
        return false;
    }
    if (std::fseek (f, dataPos, SEEK_SET) != 0)
    {
        error = "回跳 data 失败：";
        error += path;
        return false;
    }
    std::vector<uint8_t> raw (dataSize);
    if (dataSize > 0 && std::fread (raw.data (), 1, dataSize, f) != dataSize)
    {
        error = "data 读取截断：";
        error += path;
        return false;
    }

    out.sampleRate = (int32_t)sampleRate;
    out.channels = channels;
    out.samples.resize ((size_t)frames * channels);
    const uint8_t* p = raw.data ();
    for (int64_t i = 0; i < frames * channels; ++i)
    {
        if (audioFormat == 1 && bytesPerSample == 2)
        {
            int16_t v = (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
            out.samples[(size_t)i] = (float)v / 32768.f;
            p += 2;
        }
        else if (audioFormat == 1 && bytesPerSample == 3)
        {
            int32_t v = (int32_t)p[0] | ((int32_t)p[1] << 8) | ((int32_t)p[2] << 16);
            if (v & 0x800000)
                v |= ~0xffffff;
            out.samples[(size_t)i] = (float)v / 8388608.f;
            p += 3;
        }
        else if (audioFormat == 1 && bytesPerSample == 4)
        {
            int32_t v;
            std::memcpy (&v, p, 4);
            out.samples[(size_t)i] = (float)((double)v / 2147483648.0);
            p += 4;
        }
        else // float32
        {
            float v;
            std::memcpy (&v, p, 4);
            out.samples[(size_t)i] = std::isfinite (v) ? v : 0.f;
            p += 4;
        }
    }
    return true;
}

bool writeWavFloat32 (const std::string& path, int32_t sampleRate, int32_t channels,
                      const float* interleaved, int64_t frames, std::string& error)
{
    if (sampleRate <= 0 || channels < 1 || channels > 8 || frames < 0 || (frames > 0 && !interleaved))
    {
        error = "写 wav 参数无效。";
        return false;
    }
    FILE* f = nullptr;
#ifdef _WIN32
    if (fopen_s (&f, path.c_str (), "wb") != 0 || !f)
    {
        error = "打不开输出 wav：";
        error += path;
        return false;
    }
#else
    f = std::fopen (path.c_str (), "wb");
    if (!f)
    {
        error = "打不开输出 wav：";
        error += path;
        return false;
    }
#endif
    struct Closer
    {
        FILE* f;
        ~Closer () { std::fclose (f); }
    } closer{f};

    uint32_t dataBytes = (uint32_t)(frames * channels * 4);
    uint32_t byteRate = (uint32_t)sampleRate * (uint32_t)channels * 4;
    writeFourCC (f, "RIFF");
    writeU32 (f, 36 + dataBytes);
    writeFourCC (f, "WAVE");
    writeFourCC (f, "fmt ");
    writeU32 (f, 16);
    writeU16 (f, 3); // IEEE float
    writeU16 (f, (uint16_t)channels);
    writeU32 (f, (uint32_t)sampleRate);
    writeU32 (f, byteRate);
    writeU16 (f, (uint16_t)(channels * 4));
    writeU16 (f, 32);
    writeFourCC (f, "data");
    writeU32 (f, dataBytes);
    if (frames > 0)
    {
        if (std::fwrite (interleaved, 4, (size_t)(frames * channels), f) != (size_t)(frames * channels))
        {
            error = "写 wav 数据失败：";
            error += path;
            return false;
        }
    }
    return true;
}

} // namespace catcut
