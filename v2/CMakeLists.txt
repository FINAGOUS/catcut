# CatCut v2 — S0 skeleton (Qt 6 + C++20)
# Top-level build. S1+ will add media/, tests/ and platform subdirs.

cmake_minimum_required(VERSION 3.21)
project(CatCut-v2 VERSION 2.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Widgets)

# The version string comes from version.txt so the exe, the installer
# and --version always agree.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/version.txt" CATCUT_VERSION_RAW)
string(STRIP "${CATCUT_VERSION_RAW}" CATCUT_VERSION)

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

target_link_libraries(CatCut-v2 PRIVATE Qt6::Widgets)

# NOTE (S0): console subsystem on Windows, deliberately. --version and
# --smoke-test must be able to write to stdout in CI; a WIN32 GUI
# subsystem exe has no console attached. A console window behind the GUI
# is acceptable for the alpha skeleton.
install(TARGETS CatCut-v2 RUNTIME DESTINATION .)
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/version.txt" DESTINATION .)
