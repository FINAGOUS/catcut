# CatCut v2 — S1 media pipeline (Qt 6 + C++20 + FFmpeg LGPL shared).
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
  src/core/ProjectModel.h
  src/core/ProjectModel.cpp
)

target_include_directories(CatCut-v2 PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

target_compile_definitions(CatCut-v2 PRIVATE
  CATCUT_VERSION_STRING="${CATCUT_VERSION}"
)

target_link_libraries(CatCut-v2 PRIVATE catcut_media Qt6::Widgets)

# Preview shaders, compiled at build time by qsb and embedded as
# resources (":/shaders/texture.vert.qsb", ":/shaders/texture.frag.qsb").
# NOTE: BASE strips the "shaders/" directory from the alias; without it
# the alias doubles to ":/shaders/shaders/..." (run 45231564114), and
# with PREFIX "/" alone it becomes "://shaders/..." (run 45232433853).
qt_add_shaders(CatCut-v2 "catcut_preview_shaders"
  PREFIX "/shaders"
  BASE "shaders"
  FILES
    shaders/texture.vert
    shaders/texture.frag
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
