/**
 * win-audio-capture — WASAPI audio capture for sinain on Windows.
 *
 * Captures system audio (loopback) or microphone input via WASAPI,
 * resamples to the requested format, and writes raw 16-bit PCM to stdout.
 *
 * This is the Windows equivalent of sck-capture (macOS ScreenCaptureKit).
 *
 * Usage:
 *   win-audio-capture.exe [--sample-rate 16000] [--channels 1] [--mic] [--mic-device "name"]
 */

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
// avrt.h excluded — AvSetMmThreadCharacteristics loaded dynamically

#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <io.h>
#include <fcntl.h>
#include <signal.h>

// REFERENCE_TIME units per second and per millisecond
#define REFTIMES_PER_SEC  10000000
#define REFTIMES_PER_MS   10000


static volatile bool g_running = true;

static void signalHandler(int) {
    g_running = false;
}

static void logErr(const char* msg) {
    fprintf(stderr, "[win-audio-capture] ERROR: %s\n", msg);
    fflush(stderr);
}

static void logInfo(const char* msg) {
    fprintf(stderr, "[win-audio-capture] %s\n", msg);
    fflush(stderr);
}

static void logInfoF(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    fprintf(stderr, "[win-audio-capture] ");
    vfprintf(stderr, fmt, args);
    fprintf(stderr, "\n");
    va_end(args);
    fflush(stderr);
}

// Safe COM release helper
template<class T>
static void safeRelease(T** pp) {
    if (*pp) {
        (*pp)->Release();
        *pp = nullptr;
    }
}

struct Config {
    int sampleRate = 16000;
    int channels = 1;
    bool micMode = false;
    std::wstring micDevice; // empty = default
};

static Config parseArgs(int argc, char* argv[]) {
    Config cfg;
    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--sample-rate" && i + 1 < argc) {
            cfg.sampleRate = atoi(argv[++i]);
        } else if (arg == "--channels" && i + 1 < argc) {
            cfg.channels = atoi(argv[++i]);
        } else if (arg == "--mic") {
            cfg.micMode = true;
        } else if (arg == "--mic-device" && i + 1 < argc) {
            i++;
            int len = MultiByteToWideChar(CP_UTF8, 0, argv[i], -1, nullptr, 0);
            cfg.micDevice.resize(len - 1);
            MultiByteToWideChar(CP_UTF8, 0, argv[i], -1, &cfg.micDevice[0], len);
        }
    }
    return cfg;
}

/**
 * Find a device by friendly name substring match.
 * Returns nullptr if not found (caller should use default).
 */
static IMMDevice* findDeviceByName(IMMDeviceEnumerator* enumerator,
                                    EDataFlow dataFlow,
                                    const std::wstring& name) {
    IMMDeviceCollection* collection = nullptr;
    HRESULT hr = enumerator->EnumAudioEndpoints(dataFlow, DEVICE_STATE_ACTIVE, &collection);
    if (FAILED(hr)) return nullptr;

    UINT count = 0;
    collection->GetCount(&count);

    IMMDevice* found = nullptr;
    for (UINT i = 0; i < count; i++) {
        IMMDevice* device = nullptr;
        collection->Item(i, &device);
        if (!device) continue;

        IPropertyStore* props = nullptr;
        device->OpenPropertyStore(STGM_READ, &props);
        if (props) {
            PROPVARIANT varName;
            PropVariantInit(&varName);
            props->GetValue(PKEY_Device_FriendlyName, &varName);
            if (varName.vt == VT_LPWSTR && varName.pwszVal) {
                std::wstring friendlyName(varName.pwszVal);
                if (friendlyName.find(name) != std::wstring::npos) {
                    found = device;
                    PropVariantClear(&varName);
                    props->Release();
                    break;
                }
            }
            PropVariantClear(&varName);
            props->Release();
        }
        device->Release();
    }

    collection->Release();
    return found;
}

/**
 * Resample a buffer of float samples from one sample rate to another using
 * simple linear interpolation. Operates on interleaved channels.
 */
static void resample(const float* src, int srcFrames, int srcRate,
                     std::vector<float>& dst, int dstRate, int channels) {
    if (srcRate == dstRate) {
        dst.assign(src, src + srcFrames * channels);
        return;
    }

    int dstFrames = (int)((int64_t)srcFrames * dstRate / srcRate);
    dst.resize(dstFrames * channels);

    double ratio = (double)srcRate / dstRate;
    for (int i = 0; i < dstFrames; i++) {
        double srcPos = i * ratio;
        int idx = (int)srcPos;
        double frac = srcPos - idx;

        if (idx + 1 >= srcFrames) idx = srcFrames - 2;
        if (idx < 0) idx = 0;

        for (int ch = 0; ch < channels; ch++) {
            float s0 = src[idx * channels + ch];
            float s1 = src[(idx + 1) * channels + ch];
            dst[i * channels + ch] = (float)(s0 + (s1 - s0) * frac);
        }
    }
}

/**
 * Convert float samples [-1.0, 1.0] to 16-bit signed PCM.
 * Also handles channel conversion (e.g. stereo→mono downmix).
 */
static void floatToPcm16(const float* src, int frames, int srcChannels,
                          int dstChannels, std::vector<int16_t>& out) {
    out.resize(frames * dstChannels);

    for (int i = 0; i < frames; i++) {
        if (srcChannels == dstChannels) {
            for (int ch = 0; ch < dstChannels; ch++) {
                float s = src[i * srcChannels + ch];
                if (s > 1.0f) s = 1.0f;
                if (s < -1.0f) s = -1.0f;
                out[i * dstChannels + ch] = (int16_t)(s * 32767.0f);
            }
        } else if (srcChannels == 2 && dstChannels == 1) {
            // Stereo to mono downmix
            float mix = (src[i * 2] + src[i * 2 + 1]) * 0.5f;
            if (mix > 1.0f) mix = 1.0f;
            if (mix < -1.0f) mix = -1.0f;
            out[i] = (int16_t)(mix * 32767.0f);
        } else if (srcChannels == 1 && dstChannels == 2) {
            // Mono to stereo upmix
            float s = src[i];
            if (s > 1.0f) s = 1.0f;
            if (s < -1.0f) s = -1.0f;
            int16_t val = (int16_t)(s * 32767.0f);
            out[i * 2] = val;
            out[i * 2 + 1] = val;
        }
    }
}

int main(int argc, char* argv[]) {
    // Set stdout to binary mode so PCM bytes are not corrupted
    _setmode(_fileno(stdout), _O_BINARY);

    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    Config cfg = parseArgs(argc, argv);

    logInfoF("starting: sampleRate=%d channels=%d mic=%s",
             cfg.sampleRate, cfg.channels, cfg.micMode ? "true" : "false");

    // Initialize COM (apartment-threaded for WASAPI compatibility)
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(hr)) {
        // Retry with MTA if STA fails (e.g., already initialized as MTA)
        hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (FAILED(hr)) {
            logErr("CoInitializeEx failed");
            return 1;
        }
    }
    logInfo("COM initialized");

    IMMDeviceEnumerator* enumerator = nullptr;
    hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator), (void**)&enumerator
    );
    if (FAILED(hr)) {
        logErr("Failed to create device enumerator");
        CoUninitialize();
        return 1;
    }

    // Get the appropriate audio device
    IMMDevice* device = nullptr;
    if (cfg.micMode) {
        if (!cfg.micDevice.empty()) {
            device = findDeviceByName(enumerator, eCapture, cfg.micDevice);
            if (!device) {
                logInfo("Specified mic device not found, using default");
            }
        }
        if (!device) {
            hr = enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &device);
        }
    } else {
        // System audio: loopback capture on the default render device
        hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    }

    if (FAILED(hr) || !device) {
        logErr("Failed to get audio device");
        safeRelease(&enumerator);
        CoUninitialize();
        return 1;
    }

    // Log device name
    {
        IPropertyStore* props = nullptr;
        device->OpenPropertyStore(STGM_READ, &props);
        if (props) {
            PROPVARIANT varName;
            PropVariantInit(&varName);
            props->GetValue(PKEY_Device_FriendlyName, &varName);
            if (varName.vt == VT_LPWSTR) {
                fprintf(stderr, "[win-audio-capture] device: %ls\n", varName.pwszVal);
            }
            PropVariantClear(&varName);
            props->Release();
        }
    }

    // Activate the audio client
    IAudioClient* audioClient = nullptr;
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&audioClient);
    if (FAILED(hr)) {
        logErr("Failed to activate audio client");
        safeRelease(&device);
        safeRelease(&enumerator);
        CoUninitialize();
        return 1;
    }

    // Get the mix format (device's native format)
    WAVEFORMATEX* mixFormat = nullptr;
    hr = audioClient->GetMixFormat(&mixFormat);
    if (FAILED(hr)) {
        logErr("Failed to get mix format");
        safeRelease(&audioClient);
        safeRelease(&device);
        safeRelease(&enumerator);
        CoUninitialize();
        return 1;
    }

    logInfoF("device format: %dHz %dch %dbit",
             mixFormat->nSamplesPerSec, mixFormat->nChannels, mixFormat->wBitsPerSample);

    // Initialize the audio client
    // For loopback, use AUDCLNT_STREAMFLAGS_LOOPBACK
    DWORD streamFlags = cfg.micMode ? 0 : AUDCLNT_STREAMFLAGS_LOOPBACK;
    REFERENCE_TIME bufferDuration = REFTIMES_PER_SEC; // 1 second buffer

    hr = audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        streamFlags,
        bufferDuration,
        0,
        mixFormat,
        nullptr
    );
    if (FAILED(hr)) {
        logErr("Failed to initialize audio client");
        CoTaskMemFree(mixFormat);
        safeRelease(&audioClient);
        safeRelease(&device);
        safeRelease(&enumerator);
        CoUninitialize();
        return 1;
    }

    // Get the capture client
    IAudioCaptureClient* captureClient = nullptr;
    hr = audioClient->GetService(__uuidof(IAudioCaptureClient), (void**)&captureClient);
    if (FAILED(hr)) {
        logErr("Failed to get capture client");
        CoTaskMemFree(mixFormat);
        safeRelease(&audioClient);
        safeRelease(&device);
        safeRelease(&enumerator);
        CoUninitialize();
        return 1;
    }

    // Determine if we need format conversion
    int deviceSampleRate = mixFormat->nSamplesPerSec;
    int deviceChannels = mixFormat->nChannels;
    int deviceBitsPerSample = mixFormat->wBitsPerSample;
    bool isFloat = false;

    // GUID for IEEE float subformat {00000003-0000-0010-8000-00AA00389B71}
    static const GUID kIeeeFloatGuid = {
        0x00000003, 0x0000, 0x0010,
        {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}
    };

    if (mixFormat->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
        isFloat = true;
    } else if (mixFormat->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
        WAVEFORMATEXTENSIBLE* ext = (WAVEFORMATEXTENSIBLE*)mixFormat;
        if (IsEqualGUID(ext->SubFormat, kIeeeFloatGuid)) {
            isFloat = true;
        }
    }

    logInfoF("capture format: %s %dbit, need resample: %s, need channel convert: %s",
             isFloat ? "float" : "pcm",
             deviceBitsPerSample,
             deviceSampleRate != cfg.sampleRate ? "yes" : "no",
             deviceChannels != cfg.channels ? "yes" : "no");

    // Boost thread priority for audio processing (optional — avrt.dll may not exist)
    DWORD taskIndex = 0;
    HANDLE avrtHandle = nullptr;
    {
        HMODULE avrtLib = LoadLibraryW(L"avrt.dll");
        if (avrtLib) {
            typedef HANDLE (WINAPI *AvSetMmThreadFn)(LPCWSTR, LPDWORD);
            auto fn = (AvSetMmThreadFn)GetProcAddress(avrtLib, "AvSetMmThreadCharacteristicsW");
            if (fn) avrtHandle = fn(L"Audio", &taskIndex);
        }
    }

    // Start capturing
    hr = audioClient->Start();
    if (FAILED(hr)) {
        logErr("Failed to start audio capture");
        CoTaskMemFree(mixFormat);
        safeRelease(&captureClient);
        safeRelease(&audioClient);
        safeRelease(&device);
        safeRelease(&enumerator);
        CoUninitialize();
        return 1;
    }

    logInfo("capture started, streaming PCM to stdout...");

    std::vector<float> resampledBuf;
    std::vector<int16_t> pcmBuf;

    while (g_running) {
        // Wait for audio data (10ms poll interval)
        Sleep(10);

        UINT32 packetLength = 0;
        hr = captureClient->GetNextPacketSize(&packetLength);
        if (FAILED(hr)) {
            logErr("GetNextPacketSize failed");
            break;
        }

        while (packetLength > 0 && g_running) {
            BYTE* data = nullptr;
            UINT32 numFrames = 0;
            DWORD flags = 0;

            hr = captureClient->GetBuffer(&data, &numFrames, &flags, nullptr, nullptr);
            if (FAILED(hr)) {
                logErr("GetBuffer failed");
                break;
            }

            if (numFrames > 0) {
                const float* floatData = nullptr;

                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                    // Write silence
                    std::vector<int16_t> silence(numFrames * cfg.channels, 0);

                    // Resample silence length if needed
                    int outFrames = numFrames;
                    if (deviceSampleRate != cfg.sampleRate) {
                        outFrames = (int)((int64_t)numFrames * cfg.sampleRate / deviceSampleRate);
                    }
                    silence.resize(outFrames * cfg.channels, 0);

                    size_t bytes = silence.size() * sizeof(int16_t);
                    fwrite(silence.data(), 1, bytes, stdout);
                    fflush(stdout);
                } else if (isFloat && deviceBitsPerSample == 32) {
                    floatData = (const float*)data;

                    // Resample if device rate differs from target
                    const float* srcData = floatData;
                    int srcFrames = numFrames;

                    if (deviceSampleRate != cfg.sampleRate) {
                        resample(floatData, numFrames, deviceSampleRate,
                                resampledBuf, cfg.sampleRate, deviceChannels);
                        srcData = resampledBuf.data();
                        srcFrames = (int)(resampledBuf.size() / deviceChannels);
                    }

                    // Convert float to 16-bit PCM with channel conversion
                    floatToPcm16(srcData, srcFrames, deviceChannels, cfg.channels, pcmBuf);

                    size_t bytes = pcmBuf.size() * sizeof(int16_t);
                    fwrite(pcmBuf.data(), 1, bytes, stdout);
                    fflush(stdout);
                } else {
                    // Non-float format: treat as 16-bit PCM directly
                    // Just write raw data with potential channel adjustment
                    if (deviceChannels == cfg.channels && deviceSampleRate == cfg.sampleRate) {
                        size_t bytes = numFrames * cfg.channels * sizeof(int16_t);
                        fwrite(data, 1, bytes, stdout);
                        fflush(stdout);
                    } else {
                        // Convert 16-bit PCM to float, resample, then back
                        std::vector<float> tempFloat(numFrames * deviceChannels);
                        const int16_t* pcmData = (const int16_t*)data;
                        for (UINT32 i = 0; i < numFrames * (UINT32)deviceChannels; i++) {
                            tempFloat[i] = pcmData[i] / 32768.0f;
                        }

                        const float* srcData = tempFloat.data();
                        int srcFrames = numFrames;

                        if (deviceSampleRate != cfg.sampleRate) {
                            resample(tempFloat.data(), numFrames, deviceSampleRate,
                                    resampledBuf, cfg.sampleRate, deviceChannels);
                            srcData = resampledBuf.data();
                            srcFrames = (int)(resampledBuf.size() / deviceChannels);
                        }

                        floatToPcm16(srcData, srcFrames, deviceChannels, cfg.channels, pcmBuf);
                        size_t bytes = pcmBuf.size() * sizeof(int16_t);
                        fwrite(pcmBuf.data(), 1, bytes, stdout);
                        fflush(stdout);
                    }
                }
            }

            captureClient->ReleaseBuffer(numFrames);

            hr = captureClient->GetNextPacketSize(&packetLength);
            if (FAILED(hr)) break;
        }
    }

    logInfo("stopping capture...");

    audioClient->Stop();

    if (avrtHandle) {
        HMODULE avrtLib = GetModuleHandleW(L"avrt.dll");
        if (avrtLib) {
            typedef BOOL (WINAPI *AvRevertFn)(HANDLE);
            auto fn = (AvRevertFn)GetProcAddress(avrtLib, "AvRevertMmThreadCharacteristics");
            if (fn) fn(avrtHandle);
        }
    }

    CoTaskMemFree(mixFormat);
    safeRelease(&captureClient);
    safeRelease(&audioClient);
    safeRelease(&device);
    safeRelease(&enumerator);
    CoUninitialize();

    logInfo("done");
    return 0;
}
