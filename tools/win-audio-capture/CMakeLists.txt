cmake_minimum_required(VERSION 3.16)
project(win-audio-capture LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(win-audio-capture main.cpp)

# Static link MinGW runtime to avoid libgcc_s_seh-1.dll / libstdc++-6.dll deps
if(MINGW)
    target_link_options(win-audio-capture PRIVATE -static -static-libgcc -static-libstdc++)
endif()

# Link Windows audio and COM libraries
target_link_libraries(win-audio-capture PRIVATE
    ole32
)
