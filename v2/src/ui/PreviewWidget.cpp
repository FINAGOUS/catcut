// CatCut v2 — S3 colour & picture: GPU preview widget (QRhi textured quad).

#include "ui/PreviewWidget.h"

#include <QFile>
#include <algorithm>
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

uint8_t floatToByte(float v)
{
    return static_cast<uint8_t>(std::clamp(v, 0.0f, 1.0f) * 255.0f + 0.5f);
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
    m_useGrade = false;
    m_pendingUpload = true;
    update();
}

void PreviewWidget::setGradedImage(const QImage& image, const ColorGrade& grade)
{
    if (image.isNull())
        return;
    m_image = image.format() == QImage::Format_RGBA8888
        ? image : image.convertToFormat(QImage::Format_RGBA8888);
    m_grade = grade;
    m_useGrade = true;
    m_gradeDirty = true;
    m_pendingUpload = true;
    update();
}

GradeUniforms PreviewWidget::buildUniforms() const
{
    GradeUniforms u{};
    u.whiteBalance[0] = static_cast<float>(m_grade.temperature);
    u.whiteBalance[1] = static_cast<float>(m_grade.tint);
    for (int i = 0; i < 4; ++i) {
        u.wheels[i][0] = static_cast<float>(m_grade.wheels[i].r);
        u.wheels[i][1] = static_cast<float>(m_grade.wheels[i].g);
        u.wheels[i][2] = static_cast<float>(m_grade.wheels[i].b);
    }
    for (int i = 0; i < 7; ++i) {
        u.hslZones[i][0] = static_cast<float>(m_grade.hslZones[static_cast<size_t>(i)].hueShift);
        u.hslZones[i][1] = static_cast<float>(m_grade.hslZones[static_cast<size_t>(i)].saturation);
        u.hslZones[i][2] = static_cast<float>(m_grade.hslZones[static_cast<size_t>(i)].lightness);
    }
    const bool lutOk = m_grade.lutEnabled && m_grade.lut.isValid();
    u.flags[0] = lutOk ? 1.0f : 0.0f;
    u.flags[1] = lutOk ? static_cast<float>(m_grade.lut.size) : 0.0f;
    return u;
}

QImage PreviewWidget::buildCurveImage() const
{
    // 256x1, texel i = (master, R, G, B) curve values at i/255.
    const std::array<float, 1024> table = m_grade.curves.buildTable();
    QImage img(256, 1, QImage::Format_RGBA8888);
    uint8_t* row = img.scanLine(0);
    for (int i = 0; i < 256; ++i) {
        row[i * 4 + 0] = floatToByte(table[static_cast<size_t>(0 * 256 + i)]);
        row[i * 4 + 1] = floatToByte(table[static_cast<size_t>(1 * 256 + i)]);
        row[i * 4 + 2] = floatToByte(table[static_cast<size_t>(2 * 256 + i)]);
        row[i * 4 + 3] = floatToByte(table[static_cast<size_t>(3 * 256 + i)]);
    }
    return img;
}

QImage PreviewWidget::buildLutImage() const
{
    // Packed 2D: width N*N, height N; pixel (blueSlice*N + red, green)
    // holds LUT(red, green, blueSlice) — matches grade.frag sampleLut.
    if (!m_grade.lutEnabled || !m_grade.lut.isValid())
        return QImage(1, 1, QImage::Format_RGBA8888);
    const int n = m_grade.lut.size;
    QImage img(n * n, n, QImage::Format_RGBA8888);
    img.fill(Qt::black);
    const CubeLut& lut = m_grade.lut;
    for (int b = 0; b < n; ++b) {
        for (int g = 0; g < n; ++g) {
            uint8_t* row = img.scanLine(g);
            for (int r = 0; r < n; ++r) {
                const int idx = (r + g * n + b * n * n) * 3;
                uint8_t* px = row + (b * n + r) * 4;
                px[0] = floatToByte(lut.data[idx]);
                px[1] = floatToByte(lut.data[idx + 1]);
                px[2] = floatToByte(lut.data[idx + 2]);
                px[3] = 255;
            }
        }
    }
    return img;
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
    recreateGradeResources();
    createGradePipeline();
    // The grade resources may have been rebuilt: re-upload the frame
    // so it goes through the (possibly new) pipeline selection.
    m_pendingUpload = true;
    m_gradeDirty = m_useGrade;
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

bool PreviewWidget::createGradePipeline()
{
    if (!m_rhi || !m_vertexBuffer || !m_gradeSrb || !m_gradeUbo)
        return false;

    const QShader vertexShader = loadShader(QStringLiteral(":/shaders/texture.vert.qsb"));
    const QShader fragmentShader = loadShader(QStringLiteral(":/shaders/grade.frag.qsb"));
    if (!vertexShader.isValid() || !fragmentShader.isValid())
        return false; // grade falls back to the CPU path in render()

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
    pipeline->setShaderResourceBindings(m_gradeSrb);
    if (!pipeline->create()) {
        delete pipeline;
        return false;
    }
    m_gradePipeline = pipeline;
    return true;
}

void PreviewWidget::recreateGradeResources()
{
    if (!m_rhi || !m_texture || !m_sampler)
        return;
    // Unbind before release (hard rule 2): pipeline first, then SRB.
    delete m_gradePipeline;
    m_gradePipeline = nullptr;
    delete m_gradeSrb;
    m_gradeSrb = nullptr;
    delete m_gradeUbo;
    m_gradeUbo = nullptr;
    delete m_curveTexture;
    m_curveTexture = nullptr;
    delete m_lutTexture;
    m_lutTexture = nullptr;

    m_gradeUbo = m_rhi->newBuffer(QRhiBuffer::Dynamic, QRhiBuffer::UniformBuffer,
                                  static_cast<quint32>(sizeof(GradeUniforms)));
    m_gradeUbo->create();

    m_curveTexture = m_rhi->newTexture(QRhiTexture::RGBA8, QSize(256, 1));
    m_curveTexture->create();
    m_curveTextureSize = QSize(256, 1);

    m_lutTexture = m_rhi->newTexture(QRhiTexture::RGBA8, QSize(1, 1));
    m_lutTexture->create();
    m_lutTextureSize = QSize(1, 1);

    m_gradeSrb = m_rhi->newShaderResourceBindings();
    m_gradeSrb->setBindings({
        QRhiShaderResourceBinding::sampledTexture(0, QRhiShaderResourceBinding::FragmentStage,
                                                  m_texture, m_sampler),
        QRhiShaderResourceBinding::uniformBuffer(1, QRhiShaderResourceBinding::FragmentStage,
                                                 m_gradeUbo),
        QRhiShaderResourceBinding::sampledTexture(2, QRhiShaderResourceBinding::FragmentStage,
                                                  m_curveTexture, m_sampler),
        QRhiShaderResourceBinding::sampledTexture(3, QRhiShaderResourceBinding::FragmentStage,
                                                  m_lutTexture, m_sampler),
    });
    m_gradeSrb->create();
    m_gradeDirty = m_useGrade;
}

void PreviewWidget::rebuildGradeSrb()
{
    // Rebuilds ONLY the grade SRB (and drops the grade pipeline, which
    // references it) from the current textures. Used when the frame
    // texture or a grade texture was recreated; unlike
    // recreateGradeResources() it never touches the UBO or the curve /
    // LUT textures themselves.
    if (!m_rhi || !m_gradeUbo || !m_texture || !m_curveTexture || !m_lutTexture)
        return;
    delete m_gradePipeline;
    m_gradePipeline = nullptr;
    delete m_gradeSrb;
    m_gradeSrb = nullptr;
    m_gradeSrb = m_rhi->newShaderResourceBindings();
    m_gradeSrb->setBindings({
        QRhiShaderResourceBinding::sampledTexture(0, QRhiShaderResourceBinding::FragmentStage,
                                                  m_texture, m_sampler),
        QRhiShaderResourceBinding::uniformBuffer(1, QRhiShaderResourceBinding::FragmentStage,
                                                 m_gradeUbo),
        QRhiShaderResourceBinding::sampledTexture(2, QRhiShaderResourceBinding::FragmentStage,
                                                  m_curveTexture, m_sampler),
        QRhiShaderResourceBinding::sampledTexture(3, QRhiShaderResourceBinding::FragmentStage,
                                                  m_lutTexture, m_sampler),
    });
    m_gradeSrb->create();
    m_gradeDirty = m_useGrade;
    createGradePipeline();
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
    // The grade SRB also references this texture: rebuild it (and the
    // grade pipeline) so the grade path keeps pointing at the current
    // frame texture.
    rebuildGradeSrb();
}

void PreviewWidget::render(QRhiCommandBuffer* cb)
{
    if (!m_rhi)
        return;

    const bool gpuGrade = m_useGrade && m_gradePipeline && m_gradeSrb;

    if (m_pendingUpload && !m_image.isNull()) {
        m_pendingUpload = false;
        if (!m_texture || m_texture->pixelSize() != m_image.size())
            recreateTexture(m_image.size());
        if (m_texture) {
            QRhiResourceUpdateBatch* rub = m_rhi->nextResourceUpdateBatch();
            if (gpuGrade) {
                rub->uploadTexture(m_texture, m_image);
            } else if (m_useGrade) {
                // Grade pipeline unavailable: grade on the CPU so the
                // preview is never wrong-coloured.
                QImage graded = m_image;
                m_grade.applyToImage(graded);
                rub->uploadTexture(m_texture, graded);
            } else {
                rub->uploadTexture(m_texture, m_image);
            }
            cb->resourceUpdate(rub);
        }
    }

    if (gpuGrade && m_gradeDirty) {
        m_gradeDirty = false;
        // Resize grade textures FIRST (a resize rebuilds the SRB +
        // pipeline), then upload uniforms + texture contents in one batch.
        const QImage curveImage = buildCurveImage();
        if (!m_curveTexture || m_curveTexture->pixelSize() != curveImage.size()) {
            delete m_curveTexture;
            m_curveTexture = m_rhi->newTexture(QRhiTexture::RGBA8, curveImage.size());
            m_curveTexture->create();
            m_curveTextureSize = curveImage.size();
            rebuildGradeSrb();
        }
        const QImage lutImage = buildLutImage();
        if (!m_lutTexture || m_lutTexture->pixelSize() != lutImage.size()) {
            delete m_lutTexture;
            m_lutTexture = m_rhi->newTexture(QRhiTexture::RGBA8, lutImage.size());
            m_lutTexture->create();
            m_lutTextureSize = lutImage.size();
            rebuildGradeSrb();
        }
        if (m_gradeUbo && m_curveTexture && m_lutTexture) {
            QRhiResourceUpdateBatch* rub = m_rhi->nextResourceUpdateBatch();
            const GradeUniforms uniforms = buildUniforms();
            rub->updateDynamicBuffer(m_gradeUbo, 0, static_cast<quint32>(sizeof(GradeUniforms)),
                                     &uniforms);
            rub->uploadTexture(m_curveTexture, curveImage);
            rub->uploadTexture(m_lutTexture, lutImage);
            cb->resourceUpdate(rub);
        }
    }

    QRhiRenderTarget* rt = renderTarget();
    cb->beginPass(rt, QColor(0, 0, 0), { 1.0f, 0 });
    // Recompute: the upload / grade-update blocks above may have
    // rebuilt (or failed to rebuild) the grade pipeline.
    const bool gpuGradeNow = m_useGrade && m_gradePipeline && m_gradeSrb;
    QRhiGraphicsPipeline* pipeline = gpuGradeNow ? m_gradePipeline : m_pipeline;
    QRhiShaderResourceBindings* srb = gpuGradeNow ? m_gradeSrb : m_srb;
    if (pipeline && m_texture && srb) {
        cb->setGraphicsPipeline(pipeline);
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
    // Release in dependency order: pipelines first (they reference the
    // SRBs), then SRBs, then textures, sampler, buffers.
    delete m_gradePipeline;
    m_gradePipeline = nullptr;
    delete m_pipeline;
    m_pipeline = nullptr;
    delete m_gradeSrb;
    m_gradeSrb = nullptr;
    delete m_srb;
    m_srb = nullptr;
    delete m_texture;
    m_texture = nullptr;
    delete m_curveTexture;
    m_curveTexture = nullptr;
    delete m_lutTexture;
    m_lutTexture = nullptr;
    delete m_gradeUbo;
    m_gradeUbo = nullptr;
    delete m_sampler;
    m_sampler = nullptr;
    delete m_vertexBuffer;
    m_vertexBuffer = nullptr;
}

} // namespace catcut
