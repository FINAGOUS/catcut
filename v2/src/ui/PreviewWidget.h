// CatCut v2 — S1 media pipeline: GPU preview widget.
//
// A QRhiWidget that uploads decoded frames as RHI textures and draws
// them as a full-screen textured quad. The shaders are compiled at
// build time by qt_add_shaders (qsb) and embedded as resources
// (":/shaders/texture.vert.qsb", ":/shaders/texture.frag.qsb").
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

class QRhiBuffer;
class QRhiCommandBuffer;
class QRhiGraphicsPipeline;
class QRhiSampler;
class QRhiShaderResourceBindings;
class QRhiTexture;
class QRhi;

namespace catcut {

class PreviewWidget : public QRhiWidget {
    Q_OBJECT
public:
    explicit PreviewWidget(QWidget* parent = nullptr);
    ~PreviewWidget() override;

    // Shows a decoded frame. Call from the GUI thread. The image is
    // copied; the next render() uploads it as a texture.
    void setImage(const QImage& image);
    const QImage& currentImage() const { return m_image; }
    bool hasImage() const { return !m_image.isNull(); }

protected:
    void initialize(QRhiCommandBuffer* cb) override;
    void render(QRhiCommandBuffer* cb) override;
    void release() override;

private:
    bool createPipeline();
    void recreateTexture(const QSize& size);
    void releaseRhiResources();

    QImage m_image;
    bool m_pendingUpload = false;

    QRhi* m_rhi = nullptr;
    QRhiTexture* m_texture = nullptr;
    QRhiSampler* m_sampler = nullptr;
    QRhiShaderResourceBindings* m_srb = nullptr;
    QRhiGraphicsPipeline* m_pipeline = nullptr;
    QRhiBuffer* m_vertexBuffer = nullptr;
};

} // namespace catcut
