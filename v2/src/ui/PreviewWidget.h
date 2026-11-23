// CatCut v2 — S3 colour & picture: GPU preview widget.
//
// A QRhiWidget that uploads decoded frames as RHI textures and draws
// them as a full-screen textured quad. The shaders are compiled at
// build time by qt_add_shaders (qsb) and embedded as resources
// (":/shaders/texture.vert.qsb", ":/shaders/texture.frag.qsb",
// ":/shaders/grade.frag.qsb").
//
// Two pipelines share one vertex buffer and one texture:
//   * plain pipeline (texture.frag): passthrough, shows the image as-is.
//   * grade pipeline (grade.frag): applies the S3 colour grade on the
//     GPU — the same fixed chain as ColorGrade::applyPixel, with the
//     parameters as a uniform block + a 256x1 curve texture + a packed
//     .cube LUT texture. setGradedImage() selects it; setImage()
//     selects the plain one. If the grade pipeline cannot be created
//     (shader load failure, no RHI), setGradedImage() falls back to
//     grading on the CPU so the preview is never wrong-coloured.
//
// Hard rules honoured here:
//   * No hand-written native strides: the vertex layout stride is
//     sizeof(Vertex), computed by the compiler.
//   * RHI resources are released in release() before the RHI itself
//     goes away (shared native resources are unbound before release).
//   * If the shaders fail to load (or no RHI is available, e.g. in a
//     headless run), the widget stays black and never crashes — the
//     offscreen self-test uses PreviewRenderer's QImage path instead,
//     which does not need a widget at all.

#pragma once

#include <QImage>
#include <QSize>
#include <QRhiWidget>

#include "core/ColorGrade.h"

class QRhiBuffer;
class QRhiCommandBuffer;
class QRhiGraphicsPipeline;
class QRhiSampler;
class QRhiShaderResourceBindings;
class QRhiTexture;
class QRhi;

namespace catcut {

// Uniform block for grade.frag (std140, binding 1). Must mirror the
// GLSL GradeBlock field for field — change one, change both. All
// vec4s are 16-byte aligned; the struct size is a multiple of 16.
struct GradeUniforms {
    float whiteBalance[4]; // temp, tint, 0, 0
    float wheels[4][4];    // shadows, midtones, highlights, global (rgb, 0)
    float hslZones[7][4];  // hueShift, saturation, lightness, 0
    float flags[4];        // lutEnabled, lutSize, 0, 0
};
static_assert(sizeof(GradeUniforms) % 16 == 0, "GradeUniforms must be std140 sized");

class PreviewWidget : public QRhiWidget {
    Q_OBJECT
public:
    explicit PreviewWidget(QWidget* parent = nullptr);
    ~PreviewWidget() override;

    // Shows a decoded frame. Call from the GUI thread. The image is
    // copied; the next render() uploads it as a texture.
    void setImage(const QImage& image);
    // Shows a frame WITH the S3 grade applied on the GPU (grade.frag).
    // Falls back to CPU grading when the grade pipeline is unavailable.
    void setGradedImage(const QImage& image, const ColorGrade& grade);
    const QImage& currentImage() const { return m_image; }
    bool hasImage() const { return !m_image.isNull(); }
    // True once the grade pipeline was created successfully.
    bool gpuGradeReady() const { return m_gradePipeline != nullptr; }

protected:
    void initialize(QRhiCommandBuffer* cb) override;
    void render(QRhiCommandBuffer* cb) override;
    // QRhiWidget calls this when the RHI is about to go away (and the
    // docs expect the same cleanup in the destructor).
    void releaseResources() override;

private:
    bool createPipeline();
    bool createGradePipeline();
    void recreateTexture(const QSize& size);
    void recreateGradeResources();
    void rebuildGradeSrb();
    void releaseRhiResources();
    GradeUniforms buildUniforms() const;
    QImage buildCurveImage() const;
    QImage buildLutImage() const;

    QImage m_image;
    bool m_pendingUpload = false;

    // Grade state (set by setGradedImage; plain setImage clears it).
    bool m_useGrade = false;
    ColorGrade m_grade;
    bool m_gradeDirty = false;

    QRhi* m_rhi = nullptr;
    QRhiTexture* m_texture = nullptr;
    QRhiSampler* m_sampler = nullptr;
    QRhiShaderResourceBindings* m_srb = nullptr;
    QRhiGraphicsPipeline* m_pipeline = nullptr;
    QRhiBuffer* m_vertexBuffer = nullptr;

    // Grade pipeline resources (null when the grade shader failed).
    QRhiGraphicsPipeline* m_gradePipeline = nullptr;
    QRhiShaderResourceBindings* m_gradeSrb = nullptr;
    QRhiBuffer* m_gradeUbo = nullptr;
    QRhiTexture* m_curveTexture = nullptr;
    QRhiTexture* m_lutTexture = nullptr;
    QSize m_curveTextureSize;
    QSize m_lutTextureSize;
};

} // namespace catcut
