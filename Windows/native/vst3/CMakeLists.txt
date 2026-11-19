# CatCut VST3 桥构建（W10 插件宿主 A 级）。
# 产物：
#   CatCut.Vst3Bridge.dll — 桥的共享库形态（纯 C 导出，供以后进程内加载）。
#   Vst3BridgeHost.exe    — 桥的进程壳（现在 C# 调的就这条路，插件崩只死子进程）。
# 两者编同一份桥代码（vst3bridge.cpp + wavfile.cpp）。
#
# 输入（CI 传进来）：
#   VST3_SDK_ROOT      — vst3sdk umbrella 仓根目录（pluginterfaces / base /
#                         public.sdk 的父目录，SDK 头文件按此寻址）。
#   VST3_SDK_BUILD_DIR — SDK umbrella 构建目录，里面已编好的
#                         sdk_hosting.lib / sdk.lib / sdk_common.lib / base.lib
#                         由本文件自动定位（不硬编码输出路径）。
# 要求：SDK 3.8.x（MIT，tag v3.8.0_build_66 钉死）；C++17；MSVC /MD（与 SDK 一致，
#   SDK 默认 SMTG_USE_STATIC_CRT=OFF 即 /MD）。
cmake_minimum_required(VERSION 3.25)
project(CatCutVst3Bridge CXX)

if(NOT DEFINED VST3_SDK_ROOT OR NOT DEFINED VST3_SDK_BUILD_DIR)
  message(FATAL_ERROR "需要 -DVST3_SDK_ROOT=<vst3sdk 根目录> -DVST3_SDK_BUILD_DIR=<SDK 构建目录>。")
endif()

# pluginterfaces 也是静态库（funknown.cpp / coreiids.cpp / ustring.cpp 有编译出的符号，
# 桥的 queryInterface / IID / UString 全靠它——漏了会在链接时报 LNK2001/LNK2019。
# 链接顺序按依赖排：被依赖的在后（MSVC 单遍扫描，顺序错了也解不出符号）。
foreach(lib sdk_hosting sdk sdk_common base pluginterfaces)
  file(GLOB_RECURSE _found "${VST3_SDK_BUILD_DIR}/${lib}.lib")
  if(NOT _found)
    message(FATAL_ERROR "在 ${VST3_SDK_BUILD_DIR} 下找不到已编好的 ${lib}.lib（先编 SDK：cmake --build <sdk-build> --config Release --target again sdk_hosting）。")
  endif()
  list(GET _found 0 VST3_SDK_LIB_${lib})
  message(STATUS "VST3 SDK lib ${lib}: ${VST3_SDK_LIB_${lib}}")
endforeach()

set(VST3_SDK_LIBS
  ${VST3_SDK_LIB_sdk_hosting}
  ${VST3_SDK_LIB_sdk}
  ${VST3_SDK_LIB_sdk_common}
  ${VST3_SDK_LIB_base}
  ${VST3_SDK_LIB_pluginterfaces})

# 注意：sdk_hosting.lib 里没有 PlugProvider 和 Module::create——
# 3.8.0 的 smtg_create_public_sdk_hosting_target 只编了 connectionproxy /
# eventlist / hostclasses / module / parameterchanges / pluginterfacesupport /
# processdata / stringconvert / vstinitiids；PlugProvider 在 plugprovider.cpp，
# Module::create 在平台文件 module_win32.cpp（Windows）里。SDK 自己的 audiohost
# 和 editorhost 也是把这两个文件直接编进可执行文件，照抄这个做法。
set(SDK_HOSTING_EXTRA_SOURCES
  ${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/plugprovider.cpp)
if(WIN32)
  list(APPEND SDK_HOSTING_EXTRA_SOURCES
    ${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_win32.cpp)
elseif(APPLE)
  list(APPEND SDK_HOSTING_EXTRA_SOURCES
    ${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_mac.mm)
else()
  list(APPEND SDK_HOSTING_EXTRA_SOURCES
    ${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_linux.cpp)
endif()

set(BRIDGE_SOURCES vst3bridge.cpp wavfile.cpp ${SDK_HOSTING_EXTRA_SOURCES})

# 静态形态：给宿主 exe 链接（不依赖 DLL 搜索路径）。
add_library(vst3bridge_static STATIC ${BRIDGE_SOURCES})
target_include_directories(vst3bridge_static PRIVATE ${VST3_SDK_ROOT})
target_compile_features(vst3bridge_static PRIVATE cxx_std_17)
target_compile_options(vst3bridge_static PRIVATE /EHsc /MP /W3 /utf-8)
target_compile_definitions(vst3bridge_static PRIVATE _CRT_SECURE_NO_WARNINGS)
target_link_libraries(vst3bridge_static PRIVATE ${VST3_SDK_LIBS})
set_property(TARGET vst3bridge_static PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")

# 共享库形态：以后进程内加载用；现在只验证它能编出来并随包分发。
add_library(CatCut.Vst3Bridge SHARED ${BRIDGE_SOURCES})
target_include_directories(CatCut.Vst3Bridge PRIVATE ${VST3_SDK_ROOT})
target_compile_features(CatCut.Vst3Bridge PRIVATE cxx_std_17)
target_compile_options(CatCut.Vst3Bridge PRIVATE /EHsc /MP /W3 /utf-8)
target_compile_definitions(CatCut.Vst3Bridge PRIVATE _CRT_SECURE_NO_WARNINGS VST3BRIDGE_SHARED VST3BRIDGE_BUILDING_DLL)
target_link_libraries(CatCut.Vst3Bridge PRIVATE ${VST3_SDK_LIBS})
set_property(TARGET CatCut.Vst3Bridge PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")

add_executable(Vst3BridgeHost vst3host_main.cpp)
target_include_directories(Vst3BridgeHost PRIVATE ${VST3_SDK_ROOT})
target_compile_features(Vst3BridgeHost PRIVATE cxx_std_17)
target_compile_options(Vst3BridgeHost PRIVATE /EHsc /MP /W3 /utf-8)
target_compile_definitions(Vst3BridgeHost PRIVATE _CRT_SECURE_NO_WARNINGS)
target_link_libraries(Vst3BridgeHost PRIVATE vst3bridge_static)
set_property(TARGET Vst3BridgeHost PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")

set_target_properties(vst3bridge_static CatCut.Vst3Bridge Vst3BridgeHost
  PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
    ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
