# CatCut v2 — S3 colour & picture (Qt 6 + C++20 + FFmpeg LGPL shared).
#
# FFmpeg is linked in-process as dynamic libraries (libavformat,
# libavcodec, libavfilter, libavutil, libswscale, libswresample).
# No FFmpeg CLI subprocess is ever started by this build.
#
# FFMPEG_ROOT must point at an LGPL shared build extract, e.g. the BtbN
# ffmpeg-master-latest-win64-lgpl-shared.zip (contains include/ + lib/
# + bin/). Pass -DFFMPEG_ROOT=<path> or set the FFMPEG_ROOT env var.
# libx264/libx265 are GPL and are refused at configure time if they
# show up in the FFmpeg tree.

cmake_minimum_required(VERSION 3.21)
project(CatCut-v2 VERSION 2.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Widgets ShaderTools)

# The version string comes from version.txt so the exe, the installer
# and --version always agree.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/version.txt" CATCUT_VERSION_RAW)
string(STRIP "${CATCUT_VERSION_RAW}" CATCUT_VERSION)

# ---------------------------------------------------------------- FFmpeg
set(FFMPEG_ROOT "" CACHE PATH "FFmpeg LGPL shared build root (include/ + lib/ + bin/)")
if(NOT FFMPEG_ROOT AND DEFINED ENV{FFMPEG_ROOT})
  set(FFMPEG_ROOT "$ENV{FFMPEG_ROOT}")
endif()
if(NOT FFMPEG_ROOT)
  message(FATAL_ERROR
    "FFMPEG_ROOT is required (S1). Point it at a BtbN "
    "ffmpeg-master-latest-win64-lgpl-shared extract, e.g. "
    "-DFFMPEG_ROOT=C:/ffmpeg-master-latest-win64-lgpl-shared")
endif()

foreach(_header
    include/libavcodec/avcodec.h
    include/libavformat/avformat.h
    include/libavfilter/avfilter.h
    include/libavfilter/buffersrc.h
    include/libavfilter/buffersink.h
    include/libavutil/avutil.h
    include/libavutil/hwcontext.h
    include/libswscale/swscale.h
    include/libswresample/swresample.h)
  if(NOT EXISTS "${FFMPEG_ROOT}/${_header}")
    message(FATAL_ERROR "FFMPEG_ROOT layout check failed: missing ${FFMPEG_ROOT}/${_header}")
  endif()
endforeach()

foreach(_lib avcodec avformat avfilter avutil swscale swresample)
  find_library(FFMPEG_${_lib}_LIBRARY
    NAMES ${_lib}
    HINTS "${FFMPEG_ROOT}/lib"
    NO_DEFAULT_PATH)
  if(NOT FFMPEG_${_lib}_LIBRARY)
    message(FATAL_ERROR "FFMPEG_ROOT layout check failed: missing lib/${_lib}.lib")
  endif()
endforeach()

# GPL guard: libx264/libx265 must never enter the build. If the FFmpeg
# tree contains them, stop here instead of silently shipping GPL code.
file(GLOB _gpl_files
  "${FFMPEG_ROOT}/lib/*x264*" "${FFMPEG_ROOT}/lib/*x265*"
  "${FFMPEG_ROOT}/bin/*x264*" "${FFMPEG_ROOT}/bin/*x265*")
if(_gpl_files)
  message(FATAL_ERROR
    "GPL encoder libraries found in the FFmpeg tree, refusing to build: ${_gpl_files}. "
    "Use an LGPL build (BtbN ffmpeg-master-latest-win64-lgpl-shared).")
endif()

# ---------------------------------------------------------------- core lib
# catcut_core: platform-free timeline core (model, keyframes,
# transitions, evaluator, frame renderer). The UI and the self-tests
# link it; S4 export will reuse the evaluator from here.
add_library(catcut_core STATIC
  src/core/Roles.h
  src/core/Roles.cpp
  src/core/Keyframes.h
  src/core/Keyframes.cpp
  src/core/Transitions.h
  src/core/Transitions.cpp
  src/core/TimelineModel.h
  src/core/TimelineModel.cpp
  src/core/TimelineEvaluator.h
  src/core/TimelineEvaluator.cpp
  src/core/TimelineFrameRenderer.h
  src/core/TimelineFrameRenderer.cpp
  src/core/ColorGrade.h
  src/core/ColorGrade.cpp
  src/core/BeautyKeying.h
  src/core/BeautyKeying.cpp
  src/core/CameraMotion.h
  src/core/CameraMotion.cpp
  src/core/CanvasStyle.h
  src/core/CanvasStyle.cpp
  src/core/ProjectModel.h
  src/core/ProjectModel.cpp
  src/core/ExportPreset.h
  src/core/ExportPreset.cpp
  src/core/AudioMix.h
  src/core/AudioMix.cpp
  src/core/Subtitles.h
  src/core/Subtitles.cpp
)

target_include_directories(catcut_core PUBLIC
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

target_link_libraries(catcut_core PUBLIC
  Qt6::Core
  Qt6::Gui
)

# ---------------------------------------------------------------- media lib
add_library(catcut_media STATIC
  src/media/MediaCommon.h
  src/media/MediaCommon.cpp
  src/media/MediaProbe.h
  src/media/MediaProbe.cpp
  src/media/Decoder.h
  src/media/Decoder.cpp
  src/media/ProxyJob.h
  src/media/ProxyJob.cpp
  src/media/PreviewRenderer.h
  src/media/PreviewRenderer.cpp
  src/media/ExportFrameRenderer.h
  src/media/ExportFrameRenderer.cpp
  src/media/AudioDecoder.h
  src/media/AudioDecoder.cpp
  src/media/Loudness.h
  src/media/Loudness.cpp
  src/media/AudioDenoise.h
  src/media/AudioDenoise.cpp
  src/media/ExportPipeline.h
  src/media/ExportPipeline.cpp
  src/media/VocalSeparation.h
  src/media/VocalSeparation.cpp
  src/media/AutoTranscription.h
  src/media/AutoTranscription.cpp
  src/ui/PreviewWidget.h
  src/ui/PreviewWidget.cpp
)

target_include_directories(catcut_media PUBLIC
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
  "${FFMPEG_ROOT}/include"
)

target_compile_definitions(catcut_media PUBLIC
  __STDC_CONSTANT_MACROS
)

target_link_libraries(catcut_media PUBLIC
  Qt6::Widgets
  Qt6::GuiPrivate
  Qt6::ShaderTools
  ${FFMPEG_avformat_LIBRARY}
  ${FFMPEG_avcodec_LIBRARY}
  ${FFMPEG_avfilter_LIBRARY}
  ${FFMPEG_avutil_LIBRARY}
  ${FFMPEG_swscale_LIBRARY}
  ${FFMPEG_swresample_LIBRARY}
)

if(WIN32)
  # D3D11VA hardware decoding (av_hwdevice_ctx_create). The FFmpeg DLLs
  # load d3d11.dll themselves; linking here keeps the symbol set explicit.
  target_link_libraries(catcut_media PUBLIC d3d11)
endif()

# ---------------------------------------------------------------- main app
add_executable(CatCut-v2
  src/main.cpp
  src/ui/MainWindow.h
  src/ui/MainWindow.cpp
  src/ui/ExportDialog.h
  src/ui/ExportDialog.cpp
  src/ui/TimelineWidget.h
  src/ui/TimelineWidget.cpp
  src/ui/KeyframeChartWidget.h
  src/ui/KeyframeChartWidget.cpp
  src/ui/InspectorWidget.h
  src/ui/InspectorWidget.cpp
  src/ui/ColorPanelWidget.h
  src/ui/ColorPanelWidget.cpp
)

target_include_directories(CatCut-v2 PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

target_compile_definitions(CatCut-v2 PRIVATE
  CATCUT_VERSION_STRING="${CATCUT_VERSION}"
)

target_link_libraries(CatCut-v2 PRIVATE catcut_core catcut_media Qt6::Widgets)

# Preview shaders, compiled at build time by qsb and embedded as
# resources (":/shaders/texture.vert.qsb", ":/shaders/texture.frag.qsb",
# ":/shaders/grade.frag.qsb" — S3 GPU grade).
# NOTE: BASE strips the "shaders/" directory from the alias; without it
# the alias doubles to ":/shaders/shaders/..." (run 45231564114), and
# with PREFIX "/" alone it becomes "://shaders/..." (run 45232433853).
qt_add_shaders(CatCut-v2 "catcut_preview_shaders"
  PREFIX "/shaders"
  BASE "shaders"
  FILES
    shaders/texture.vert
    shaders/texture.frag
    shaders/grade.frag
)

# NOTE (S0): console subsystem on Windows, deliberately. --version and
# --smoke-test must be able to write to stdout in CI; a WIN32 GUI
# subsystem exe has no console attached. A console window behind the GUI
# is acceptable for the alpha skeleton.
install(TARGETS CatCut-v2 RUNTIME DESTINATION .)
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/version.txt" DESTINATION .)

# ---------------------------------------------------------------- self-test
# verify-s1: probe + decode + proxy + offscreen first-frame render.
# Console program (QGuiApplication, offscreen platform in CI).
# Exit 0 = all checks passed.
add_executable(verify-s1
  tests/verify-s1/main.cpp
)

target_include_directories(verify-s1 PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

target_link_libraries(verify-s1 PRIVATE catcut_media Qt6::Gui)

# ---------------------------------------------------------------- self-test
# verify-s2: timeline model (ripple, connected clips, disconnect,
# roles/lanes, transitions, keyframes, JSON round-trip) + a timeline
# render test (3 clips + 1 transition, first frame + mid-transition
# frame offscreen to PNG via the same evaluator/renderer the preview
# uses). Console program (QGuiApplication, offscreen platform in CI).
# Exit 0 = all checks passed.
add_executable(verify-s2
  tests/verify-s2/main.cpp
)

target_include_directories(verify-s2 PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

target_link_libraries(verify-s2 PRIVATE catcut_core catcut_media Qt6::Gui)

# ---------------------------------------------------------------- self-test
# verify-s3: colour grade math (wheels / curves / HSL / LUT / scopes),
# beauty / keying / masks / mosaic, camera motion (auto-zoom + spring /
# screen 3D / pointer track), canvas composition, evaluator S3 state,
# preview-vs-export consistency (mean error < 1%), and the compiled
# grade.frag.qsb resource. Console program (QGuiApplication, offscreen
# platform in CI). Exit 0 = all checks passed.
add_executable(verify-s3
  tests/verify-s3/main.cpp
)

target_include_directories(verify-s3 PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

target_link_libraries(verify-s3 PRIVATE catcut_core catcut_media Qt6::Gui)

# The grade shader resource, so the self-test can prove the shader
# compiles and loads (the live GPU path itself needs a real machine).
qt_add_shaders(verify-s3 "catcut_grade_shader_check"
  PREFIX "/shaders"
  BASE "shaders"
  FILES
    shaders/grade.frag
)

# ---------------------------------------------------------------- self-test
# verify-s4: export presets + bitrate formula, Roles mix + fades,
# loudness (loudnorm measure + -16 LUFS normalisation), SRT
# import/export + burn-in through the shared renderer, a real MP4
# export (3 clips + 1 transition + grade, 1080p H.264 software
# path), per-role stems, preview-vs-export consistency, the vocal
# separation + auto-transcription honest-error hooks, and cancel.
# Console program (QGuiApplication, offscreen platform in CI).
# Exit 0 = all checks passed.
add_executable(verify-s4
  tests/verify-s4/main.cpp
)

target_include_directories(verify-s4 PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

target_link_libraries(verify-s4 PRIVATE catcut_media catcut_core Qt6::Gui)

# ---------------------------------------------------------------- self-test
# verify-s5: the S5 export dialog (File -> 导出), headless offscreen:
# 6 built-in presets, default 1080p H.264 + S4 recommended bitrate,
# export disabled for an empty timeline, enabled once a clip exists,
# all builtins valid, 8K bitrate clamped to the 130 Mbps cap.
# Console program (QApplication, offscreen platform in CI).
# Exit 0 = all checks passed.
add_executable(verify-s5
  tests/verify-s5/main.cpp
  src/ui/ExportDialog.h
  src/ui/ExportDialog.cpp
)

target_include_directories(verify-s5 PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

target_link_libraries(verify-s5 PRIVATE catcut_media catcut_core Qt6::Widgets)

# ---------------------------------------------------------------- self-test
# verify-s6: S6 denoise (afftdn unit + export twice, quantified noise
# reduction) + vocal separation by centre-channel elimination (Goertzel
# band check: centred voice cancelled, instruments kept; mono/missing
# refusals) + export dialog denoise checkbox default off.
# Console program (QApplication, offscreen platform in CI).
# Exit 0 = all checks passed.
add_executable(verify-s6
  tests/verify-s6/main.cpp
  src/ui/ExportDialog.h
  src/ui/ExportDialog.cpp
)

target_include_directories(verify-s6 PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

target_link_libraries(verify-s6 PRIVATE catcut_media catcut_core Qt6::Widgets)
