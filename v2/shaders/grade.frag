// CatCut v2 — S3 colour: GPU grade fragment shader.
//
// This is the GPU implementation of the fixed ordered chain in
// core/ColorGrade.h (ColorGrade::applyPixel). Step for step, same
// constants, same order — the two must never drift apart:
//
//   1. input conversion  : pow(c, 2.2)            (sRGB -> linear approx)
//   2. white balance     : temp/tint linear gains (see below)
//   3. HSL zones         : 7 zones, triangular weights, half-width 1/12 turn
//   4. colour wheels     : shadow=(1-l)^2, highlight=l^2, mid=1-s-h
//   5. curves            : curveTex, one texel = (master, R, G, B)
//   6. .cube LUT         : lutTex, packed 2D (width N*N, height N)
//   7. output conversion : pow(c, 1/2.2)           (linear -> sRGB approx)
//
// Uniforms (std140, binding 1) mirror the C++ GradeUniforms struct
// in ui/PreviewWidget.h field for field — change one, change both.
// Curve texture: 256x1 RGBA8, R=master, G=R, B=G, A=B, built from
// RgbCurves::buildTable(). LUT texture: width N*N, height N, RGBA8;
// pixel (blueSlice*N + red, green) holds LUT(red, green, blueSlice).
// 8-bit textures quantise to 1/255 (~0.4%); the CPU reference path
// is the authority and verify-s3 pins it — the shader is the live
// preview accelerator, not a second truth.
//
// Why a shader and not FFmpeg lut3d: lut3d would need a fresh 17^3
// LUT baked on the CPU for every slider tick (rebuild cost +
// quantisation), cannot express the HSL-zone weights or the wheel
// zone weights without baking, and cannot share parameters with the
// scopes/beauty/mask stages. The shader takes parameters as
// uniforms, so a slider move is a uniform update.
#version 440
layout(location = 0) in vec2 vTexCoord;
layout(location = 0) out vec4 fragColor;

layout(binding = 0) uniform sampler2D tex;
layout(binding = 2) uniform sampler2D curveTex;
layout(binding = 3) uniform sampler2D lutTex;

layout(std140, binding = 1) uniform GradeBlock {
    vec4 whiteBalance; // temp, tint, 0, 0
    vec4 wheels[4];    // shadows, midtones, highlights, global (rgb, 0)
    vec4 hslZones[7];  // hueShift, saturation, lightness, 0
    vec4 flags;        // lutEnabled, lutSize, 0, 0
};

const float kZoneHues[7] = float[7](
    0.0, 0.0833333333, 0.1666666667, 0.3333333333,
    0.5, 0.6666666667, 0.8333333333);

float zoneWeight(float hue, int zone)
{
    float d = abs(hue - kZoneHues[zone]);
    if (d > 0.5) d = 1.0 - d;
    return clamp(1.0 - d / 0.0833333333, 0.0, 1.0);
}

vec3 rgbToHsl(vec3 c)
{
    float mx = max(max(c.r, c.g), c.b);
    float mn = min(min(c.r, c.g), c.b);
    float l = (mx + mn) * 0.5;
    float h = 0.0, s = 0.0;
    if (mx != mn) {
        float d = mx - mn;
        s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
        if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
        else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
        else h = (c.r - c.g) / d + 4.0;
        h /= 6.0;
    }
    return vec3(h, s, l);
}

float hue2rgb(float p, float q, float t)
{
    if (t < 0.0) t += 1.0;
    if (t > 1.0) t -= 1.0;
    if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
    if (t < 1.0 / 2.0) return q;
    if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    return p;
}

vec3 hslToRgb(vec3 hsl)
{
    float h = hsl.x, s = hsl.y, l = hsl.z;
    if (s == 0.0) return vec3(l);
    float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
    float p = 2.0 * l - q;
    return vec3(hue2rgb(p, q, h + 1.0 / 3.0),
                hue2rgb(p, q, h),
                hue2rgb(p, q, h - 1.0 / 3.0));
}

float sampleCurve(float x, int channel)
{
    // curveTex is 256x1; channel selects the texel component.
    vec4 t = texture(curveTex, vec2((clamp(x, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5));
    if (channel == 0) return t.r;
    if (channel == 1) return t.g;
    if (channel == 2) return t.b;
    return t.a;
}

vec3 sampleLut(vec3 c)
{
    float n = flags.y;
    if (n < 2.0) return c;
    vec3 scaled = clamp(c, 0.0, 1.0) * (n - 1.0);
    float b0 = floor(scaled.b);
    float b1 = min(b0 + 1.0, n - 1.0);
    float fb = scaled.b - b0;
    vec2 tileSize = vec2(n, n);
    vec2 texSize = vec2(n * n, n);
    vec3 slice0 = texture(lutTex, vec2((b0 * n + scaled.r + 0.5) / texSize.x,
                                       (scaled.g + 0.5) / texSize.y)).rgb;
    vec3 slice1 = texture(lutTex, vec2((b1 * n + scaled.r + 0.5) / texSize.x,
                                       (scaled.g + 0.5) / texSize.y)).rgb;
    // NOTE: this samples the packed tiles bilinearly in R/G and mixes
    // linearly in B — the standard packed-2D approximation of the
    // CPU trilinear sample. Within 1/255 per stage by construction.
    return mix(slice0, slice1, fb);
}

void main()
{
    vec3 c = texture(tex, vTexCoord).rgb;

    // 1. Input conversion.
    c = pow(clamp(c, 0.0, 1.0), vec3(2.2));

    // 2. White balance.
    float temp = clamp(whiteBalance.x, -1.0, 1.0);
    float tint = clamp(whiteBalance.y, -1.0, 1.0);
    c.r *= (1.0 + 0.4 * temp) * (1.0 - 0.15 * tint);
    c.g *= (1.0 + 0.3 * tint);
    c.b *= (1.0 - 0.4 * temp) * (1.0 - 0.15 * tint);

    // 3. HSL zones.
    vec3 hsl = rgbToHsl(clamp(c, 0.0, 1.0));
    float hueShift = 0.0, satDelta = 0.0, lightDelta = 0.0;
    for (int z = 0; z < 7; ++z) {
        float w = zoneWeight(hsl.x, z);
        hueShift += w * hslZones[z].x;
        satDelta += w * hslZones[z].y;
        lightDelta += w * hslZones[z].z;
    }
    if (hueShift != 0.0 || satDelta != 0.0 || lightDelta != 0.0) {
        hsl.x = mod(hsl.x + hueShift + 1.0, 1.0);
        hsl.y = clamp(hsl.y * (1.0 + satDelta), 0.0, 1.0);
        hsl.z = clamp(hsl.z + lightDelta, 0.0, 1.0);
        c = hslToRgb(hsl);
    }

    // 4. Colour wheels.
    float luma = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    float shadowW = (1.0 - luma) * (1.0 - luma);
    float highW = luma * luma;
    float midW = max(0.0, 1.0 - shadowW - highW);
    c += wheels[3].rgb
        + shadowW * wheels[0].rgb
        + midW * wheels[1].rgb
        + highW * wheels[2].rgb;

    // 5. Curves: per-channel first, then master.
    c.r = sampleCurve(sampleCurve(clamp(c.r, 0.0, 1.0), 1), 0);
    c.g = sampleCurve(sampleCurve(clamp(c.g, 0.0, 1.0), 2), 0);
    c.b = sampleCurve(sampleCurve(clamp(c.b, 0.0, 1.0), 3), 0);

    // 6. LUT.
    if (flags.x > 0.5)
        c = sampleLut(clamp(c, 0.0, 1.0));

    // 7. Output conversion.
    fragColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}
