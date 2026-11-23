// CatCut v2 — S1 media pipeline: GPU preview widget (QRhi textured quad).

#include "ui/PreviewWidget.h"

#include <QFile>
#include <rhi/qrhi.h>
#include <rhi/qshader.h>

namespace catcut {

namespace {

// One vertex: 2D position + 2D texture coordinate. The stride is
// sizeof(Vertex) — never a hand-written constant (hard rule 1).
struct Vertex {
    float x, y;
    float u, v;
};

// Full-screen quad, triangle strip. UV (0,0) is the first row of the
// uploaded QImage (top of the frame on the D3D11 backend, which is the
// Windows-first path; verify the flip on a real machine for other
// backends — see the encoding matrix doc).
constexpr Vertex kQuadVertices[] = {
    { -1.0f,  1.0f, 0.0f, 0.0f }, // top-left
    {  1.0f,  1.0f, 1.0f, 0.0f }, // top-right
    { -1.0f, -1.0f, 0.0f, 1.0f }, // bottom-left
    {  1.0f, -1.0f, 1.0f, 1.0f }, // bottom-right
};

QShader loadShader(const QString& resourcePath)
{
    QFile file(resourcePath);
    if (!file.open(QIODevice::ReadOnly))
        return QShader();
    return QShader::fromSerialized(file.readAll());
}

} // namespace

PreviewWidget::PreviewWidget(QWidget* parent)
    : QRhiWidget(parent)
{
    // The clear colour is passed to beginPass() in render(); QRhiWidget
    // 6.8 has no setClearColor/clearColor of its own.
}

PreviewWidget::~PreviewWidget()
{
    releaseRhiResources();
}

void PreviewWidget::setImage(const QImage& image)
{
    if (image.isNull())
        return;
    m_image = image.format() == QImage::Format_RGBA8888
        ? image : image.convertToFormat(QImage::Format_RGBA8888);
    m_pendingUpload = true;
    update();
}

void PreviewWidget::initialize(QRhiCommandBuffer* cb)
{
    // initialize() is re-invoked when the widget moves to a new QRhi
    // (resize, reparent, new top-level window). Drop resources owned by
    // the old QRhi first; if the QRhi is unchanged and we already have
    // a pipeline, there is nothing to do.
    if (m_rhi && m_rhi != rhi())
        releaseRhiResources();
    if (m_rhi && m_rhi == rhi() && m_pipeline)
        return;
    m_rhi = rhi();
    if (!m_rhi)
        return;

    m_sampler = m_rhi->newSampler(QRhiSampler::Linear, QRhiSampler::Linear, QRhiSampler::None,
                                  QRhiSampler::ClampToEdge, QRhiSampler::ClampToEdge);
    m_sampler->create();

    m_vertexBuffer = m_rhi->newBuffer(QRhiBuffer::Immutable, QRhiBuffer::VertexBuffer,
                                      sizeof(kQuadVertices));
    m_vertexBuffer->create();
    QRhiResourceUpdateBatch* rub = m_rhi->nextResourceUpdateBatch();
    // Qt 6.8 signature: (buffer, offset, size, data) — size before data.
    rub->uploadStaticBuffer(m_vertexBuffer, 0, static_cast<quint32>(sizeof(kQuadVertices)), kQuadVertices);
    cb->resourceUpdate(rub);

    // The pipeline needs shader resource bindings at creation time, so
    // start with a 1x1 black placeholder texture. The first real frame
    // replaces it (recreateTexture) with identical binding layout.
    recreateTexture(QSize(1, 1));
    {
        QRhiResourceUpdateBatch* clearRub = m_rhi->nextResourceUpdateBatch();
        clearRub->uploadTexture(m_texture, QImage(1, 1, QImage::Format_RGBA8888));
        cb->resourceUpdate(clearRub);
    }

    createPipeline();
}

bool PreviewWidget::createPipeline()
{
    if (!m_rhi || !m_vertexBuffer)
        return false;

    const QShader vertexShader = loadShader(QStringLiteral(":/shaders/texture.vert.qsb"));
    const QShader fragmentShader = loadShader(QStringLiteral(":/shaders/texture.frag.qsb"));
    if (!vertexShader.isValid() || !fragmentShader.isValid())
        return false; // widget stays black; render() clears only

    QRhiGraphicsPipeline* pipeline = m_rhi->newGraphicsPipeline();
    pipeline->setShaderStages({
        { QRhiShaderStage::Vertex, vertexShader },
        { QRhiShaderStage::Fragment, fragmentShader },
    });

    QRhiVertexInputLayout inputLayout;
    inputLayout.setBindings({ { static_cast<quint32>(sizeof(Vertex)) } });
    inputLayout.setAttributes({
        { 0, 0, QRhiVertexInputAttribute::Float2, 0 },
        { 0, 1, QRhiVertexInputAttribute::Float2, 2 * sizeof(float) },
    });
    pipeline->setVertexInputLayout(inputLayout);
    pipeline->setTopology(QRhiGraphicsPipeline::TriangleStrip);
    pipeline->setRenderPassDescriptor(renderTarget()->renderPassDescriptor());
    // Bindings must be set before create(); the placeholder SRB from
    // initialize() has the same layout as every later texture's SRB.
    pipeline->setShaderResourceBindings(m_srb);
    if (!pipeline->create()) {
        delete pipeline;
        return false;
    }
    m_pipeline = pipeline;
    return true;
}

void PreviewWidget::recreateTexture(const QSize& size)
{
    if (!m_rhi)
        return;
    // Unbind before release: drop the SRB (which references the texture)
    // first, then the texture itself (hard rule 2).
    delete m_srb;
    m_srb = nullptr;
    delete m_texture;
    m_texture = nullptr;

    m_texture = m_rhi->newTexture(QRhiTexture::RGBA8, size);
    m_texture->create();

    m_srb = m_rhi->newShaderResourceBindings();
    m_srb->setBindings({
        QRhiShaderResourceBinding::sampledTexture(0, QRhiShaderResourceBinding::FragmentStage,
                                                  m_texture, m_sampler),
    });
    m_srb->create();

    if (m_pipeline)
        m_pipeline->setShaderResourceBindings(m_srb);
}

void PreviewWidget::render(QRhiCommandBuffer* cb)
{
    if (!m_rhi)
        return;

    if (m_pendingUpload && !m_image.isNull()) {
        m_pendingUpload = false;
        if (!m_texture || m_texture->pixelSize() != m_image.size())
            recreateTexture(m_image.size());
        if (m_texture) {
            QRhiResourceUpdateBatch* rub = m_rhi->nextResourceUpdateBatch();
            rub->uploadTexture(m_texture, m_image);
            cb->resourceUpdate(rub);
        }
    }

    QRhiRenderTarget* rt = renderTarget();
    cb->beginPass(rt, QColor(0, 0, 0), { 1.0f, 0 });
    if (m_pipeline && m_texture && m_srb) {
        cb->setGraphicsPipeline(m_pipeline);
        const QSize outputSize = rt->pixelSize();
        cb->setViewport(QRhiViewport(0, 0, static_cast<float>(outputSize.width()),
                                     static_cast<float>(outputSize.height())));
        cb->setShaderResources();
        QRhiCommandBuffer::VertexInput vertexInput(m_vertexBuffer, 0);
        cb->setVertexInput(0, 1, &vertexInput);
        cb->draw(4);
    }
    cb->endPass();
}

void PreviewWidget::releaseResources()
{
    releaseRhiResources();
    m_rhi = nullptr;
}

void PreviewWidget::releaseRhiResources()
{
    // Release in dependency order: pipeline first (it references the SRB),
    // then SRB, then texture, sampler, vertex buffer.
    delete m_pipeline;
    m_pipeline = nullptr;
    delete m_srb;
    m_srb = nullptr;
    delete m_texture;
    m_texture = nullptr;
    delete m_sampler;
    m_sampler = nullptr;
    delete m_vertexBuffer;
    m_vertexBuffer = nullptr;
}

} // namespace catcut
