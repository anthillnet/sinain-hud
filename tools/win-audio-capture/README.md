# win-audio-capture

Windows audio capture binary using WASAPI. Drop-in replacement for `sck-capture` on Windows.

## Build

```powershell
mkdir build && cd build
cmake ..
cmake --build . --config Release
```

## Usage

```
win-audio-capture.exe [--sample-rate 16000] [--channels 1] [--mic] [--mic-device "Device Name"]
```

Outputs raw 16-bit little-endian PCM on stdout. Log messages on stderr.

### Modes

- **System audio** (default): WASAPI loopback capture on the default render device
- **Mic mode** (`--mic`): WASAPI capture on the default or specified input device
