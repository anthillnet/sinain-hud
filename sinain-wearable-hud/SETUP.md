# Sinain Wearable HUD — Setup & Architecture Guide

Complete guide for assembling, configuring, and understanding the wearable HUD pipeline on a Raspberry Pi Zero 2W with SSD1327 OLED and Pi Camera Module 3.

## Architecture Overview

```
┌──────────────┐    ┌────────────┐    ┌─────────────────┐    ┌───────────────┐
│  Pi Camera   │───▶│ Scene Gate │───▶│ OCR (OpenRouter) │───▶│  Observation   │
│  Module 3    │    │ classify   │    │ Gemini Flash     │    │  Builder       │
│  1280x720    │    │ DROP/SCENE │    │ vision API       │    │  markdown msg  │
│  @ 10fps     │    │ /TEXT/etc  │    │ ~1-2s latency    │    │                │
└──────────────┘    └────────────┘    └─────────────────┘    └───────┬───────┘
                                                                     │
                    ┌────────────┐    ┌─────────────────┐    ┌───────▼───────┐
                    │  SSD1327   │◀───│  DisplayState   │◀───│   Gateway     │
                    │  128x128   │    │  (shared state) │    │  OpenClaw WS  │
                    │  OLED      │    │                 │    │  agent RPC    │
                    └────────────┘    └────────┬────────┘    └───────────────┘
                                               │
                                      ┌────────▼────────┐
                                      │  Debug Server   │
                                      │  :8080 WebSocket│
                                      │  3-panel UI     │
                                      └─────────────────┘
```

### Pipeline Flow

1. **Camera Capture** (`camera.py`): Pi Camera Module 3 captures 1280x720 BGR frames at 10fps in a dedicated thread.
2. **Scene Gate** (`scene_gate.py`): Classifies each frame — DROP (static/blurry), AMBIENT (30s heartbeat), SCENE (new scene), TEXT (text regions), MOTION (movement). Most frames are dropped.
3. **OCR** (`ocr.py`): Non-dropped frames are sent to OpenRouter's Gemini Flash vision API for text extraction. Frames are downscaled to 640px and JPEG-encoded before upload. ~1-2s latency.
4. **Observation Builder** (`observation.py`): Combines frame metadata, OCR text, and rolling history (last 20 observations, 5min window) into a structured markdown message with context-aware instructions.
5. **Gateway** (`gateway.py`): Sends the observation message to the OpenClaw agent via WebSocket RPC. The agent responds with a concise text suitable for the 128x128 OLED.
6. **Display** (`display.py`): Agent response is rendered on the physical SSD1327 OLED (~18 chars wide, 8 lines).
7. **Debug Server** (`display_server.py`): Broadcasts all pipeline state via WebSocket to a browser-based 3-panel debug UI at `:8080`.

### Key Design Decisions

- **Server-side OCR**: Tesseract runs ~20s per frame on Pi Zero 2W. OpenRouter Gemini Flash does it in ~1-2s via API.
- **Text-only RPC**: The agent RPC `message` field is text-only (no images). OCR bridges the visual gap.
- **In-flight guard**: Only one agent RPC at a time. Frames arriving while an RPC is pending are skipped.
- **Circuit breaker**: 5 consecutive RPC failures within 120s opens the circuit for 300s.

---

## Hardware Required

| Component | Model | Notes |
|-----------|-------|-------|
| SBC | Raspberry Pi Zero 2W | Must be 2W (has WiFi + quad-core) |
| OLED | Waveshare 1.5" SSD1327 (128x128) | Greyscale, SPI interface |
| Camera | Pi Camera Module 3 | CSI ribbon cable (22→15 pin adapter included) |
| Mic | USB microphone | Any USB mic works |
| OTG Hub | Micro-USB OTG hub | For USB mic (Pi Zero has micro-USB) |
| Power | 5V/2.5A micro-USB supply | Official Pi supply recommended |
| MicroSD | 16GB+ Class 10 | 32GB recommended |
| Wires | 7x female-to-female jumper wires | For OLED connection |

---

## Step 1: Flash MicroSD (on Mac)

1. Open **Raspberry Pi Imager** ([download](https://www.raspberrypi.com/software/))
2. Choose OS: **Raspberry Pi OS Lite (64-bit)** — under "Raspberry Pi OS (other)"
3. Choose Storage: select your MicroSD card
4. Click gear icon (⚙) for **Advanced Options**:
   - Hostname: `sinain-wearable`
   - Enable SSH: **Use password authentication**
   - Username: `pi`, Password: (your choice)
   - Configure WiFi: your SSID + password, Country: DE
5. Click **Write**, wait for completion
6. **Don't eject yet** — run `prep-sdcard.sh` (see Step 1b)

**Verify:** Imager says "Write Successful"

---

## Step 1b: Prep SD Card for Auto-Setup

While the SD card is still inserted, run `prep-sdcard.sh` on your Mac. This writes everything the Pi needs to the boot partition so it sets up automatically on first boot — no SSH access required.

### Prerequisites

1. VPS is ready — run `setup-vps.sh` on VPS first (see Step 6b)
2. Have your OpenClaw token and OpenRouter API key ready

### Run prep

```bash
cd sinain-wearable-hud
bash prep-sdcard.sh
```

The script will:
- Ask for your VPS IP, OpenClaw token, and OpenRouter API key
- Generate an SSH tunnel key pair
- Write all config to the SD card's boot partition
- Hook into the Pi's first-boot sequence

At the end it prints the Pi's **public key** — add it to the VPS:

```bash
ssh root@<your-vps-ip>
echo "<paste the public key>" >> /home/sinain-tunnel/.ssh/authorized_keys
```

### What happens on first boot

```
Power on → WiFi connects → Imager setup runs → reboot
         → sinain-firstboot.service starts
         → apt install (~5 min)
         → git clone + pip install (~10 min)
         → tunnel connects to VPS
         → ssh -p 2222 pi@<vps-ip> works!
```

Total: ~15 minutes from power on to SSH access.

Logs (if you can access the Pi locally):
```bash
cat /var/log/sinain-firstboot.log
```

**Verify:** `ssh -p 2222 pi@<your-vps-ip>` connects

---

## Step 2: Connect Camera Module 3 (BEFORE first boot)

The CSI ribbon cable is easier to connect before mounting in an enclosure.

1. Locate the **mini CSI connector** on Pi Zero 2W (between the HDMI port and the GPIO header)
2. Gently lift the black plastic latch on the connector
3. Insert the **22-pin end** of the adapter cable (contacts facing down, toward the PCB)
4. Press the latch closed to lock the cable
5. Connect the **15-pin end** to the Camera Module 3 (lift latch, insert, close)

> **Note:** The cable is fragile — don't bend sharply at the connector.

---

## Step 3: First Boot + SSH

1. Insert MicroSD into Pi Zero 2W
2. Connect USB OTG hub to the **data** micro-USB port (closer to center, NOT the power port on edge)
3. Connect USB mic to the OTG hub
4. Connect power supply to the **power** micro-USB port (edge port)
5. Wait ~90 seconds for first boot (first boot is slower)

From Mac terminal:
```bash
ping sinain-wearable.local
ssh pi@sinain-wearable.local
```

**Verify:** Shell prompt on the Pi.

---

## Step 4: Enable SPI + Camera (on Pi)

```bash
sudo raspi-config nonint do_spi 0
sudo raspi-config nonint do_camera 0
sudo reboot
```

After reboot, SSH back in:
```bash
ls /dev/spidev*              # Should show /dev/spidev0.0
rpicam-hello --list-cameras  # Should list Camera Module 3 (imx708)
```

**Verify:** SPI device exists AND camera is detected.

---

## Step 5: Wire SSD1327 OLED

**Power off first:** `sudo shutdown -h now`, wait for LED to stop, unplug power.

### Wiring Table

| OLED Pin   | Pi GPIO              | Pi Physical Pin | Wire Color |
|------------|----------------------|-----------------|------------|
| VCC        | 3.3V                 | Pin 1           | Red        |
| GND        | GND                  | Pin 6           | Black      |
| DIN (MOSI) | GPIO 10 (SPI0_MOSI) | Pin 19          | Blue       |
| CLK (SCLK) | GPIO 11 (SPI0_SCLK) | Pin 23          | Yellow     |
| CS         | GPIO 8 (SPI0_CE0)   | Pin 24          | Orange     |
| DC         | GPIO 25              | Pin 22          | Green      |
| RST        | GPIO 27              | Pin 13          | White      |

**7 wires total.** VCC = 3.3V (5V also safe for SSD1327, but 3.3V preferred).

### Pi Zero 2W GPIO Header Diagram

Orientation: USB ports facing you (bottom), GPIO header on top.
Pin 1 is top-left (nearest MicroSD slot). Odd pins on left, even on right.

```
                    Pi Zero 2W GPIO Header
                 (MicroSD slot is above Pin 1)

              Left column          Right column
              ───────────          ────────────
  VCC (Red)  ●  Pin 1  (3V3)      Pin 2  (5V)     ○
             ○  Pin 3  (GPIO2)    Pin 4  (5V)     ○
             ○  Pin 5  (GPIO3)    Pin 6  (GND)    ●  GND (Black)
             ○  Pin 7  (GPIO4)    Pin 8  (GPIO14) ○
             ○  Pin 9  (GND)      Pin 10 (GPIO15) ○
             ○  Pin 11 (GPIO17)   Pin 12 (GPIO18) ○
  RST (Wht)  ●  Pin 13 (GPIO27)   Pin 14 (GND)    ○
             ○  Pin 15 (GPIO22)   Pin 16 (GPIO23) ○
             ○  Pin 17 (3V3)      Pin 18 (GPIO24) ○
  DIN (Blue) ●  Pin 19 (GPIO10)   Pin 20 (GND)    ○
             ○  Pin 21 (GPIO9)    Pin 22 (GPIO25)  ●  DC (Green)
  CLK (Yel)  ●  Pin 23 (GPIO11)   Pin 24 (GPIO8)   ●  CS (Orange)
             ○  Pin 25 (GND)      Pin 26 (GPIO7)  ○
             ○  Pin 27 (GPIO0)    Pin 28 (GPIO1)  ○
             ○  ...               ...             ○
             ○  Pin 39 (GND)      Pin 40 (GPIO21) ○

    ● = connected wire    ○ = unused
```

### Wire Summary

```
OLED          Wire      Pi Pin     GPIO
────          ────      ──────     ────
VCC     ←── Red    ──→ Pin 1      3.3V
GND     ←── Black  ──→ Pin 6      GND
DIN     ←── Blue   ──→ Pin 19     GPIO10 (SPI0 MOSI)
CLK     ←── Yellow ──→ Pin 23     GPIO11 (SPI0 SCLK)
CS      ←── Orange ──→ Pin 24     GPIO8  (SPI0 CE0)
DC      ←── Green  ──→ Pin 22     GPIO25
RST     ←── White  ──→ Pin 13     GPIO27
```

Reconnect power, SSH back in.

**Verify:** Pi boots, SSH works.

---

## Step 6: Clone Repo + Run install.sh

```bash
cd ~
git clone https://github.com/Geravant/sinain-hud.git
cd sinain-hud/sinain-wearable-hud
bash install.sh
```

Takes ~10-15 min on Pi Zero 2W (apt + pip).

> **OOM tip:** Trixie uses zram swap by default (~426MB). If pip still OOMs, add a swap file:
> ```bash
> sudo fallocate -l 512M /swapfile && sudo chmod 600 /swapfile
> sudo mkswap /swapfile && sudo swapon /swapfile
> ```

The install script generates an SSH key for the reverse tunnel and prints it at the end.

**Verify:** "Setup complete!" message + public key printed.

---

## Step 6b: VPS Tunnel (Remote Access)

The Pi maintains a persistent reverse SSH tunnel to your VPS via `autossh`. This gives you SSH and debug UI access from anywhere — no VPN client needed on your laptop/phone.

```
You (anywhere)  ──SSH──▶  VPS :2222  ──tunnel──▶  Pi :22
You (browser)   ──HTTP─▶  VPS :8080  ──tunnel──▶  Pi :8080
```

### VPS setup (once)

Copy `setup-vps.sh` to your VPS and run it:

```bash
scp setup-vps.sh root@<your-vps-ip>:~
ssh root@<your-vps-ip> "bash setup-vps.sh"
```

This creates a `sinain-tunnel` user, configures `sshd` for reverse tunnels, and opens firewall ports.

### Pi setup

1. Edit `tunnel.env` with your VPS IP:

```bash
nano ~/sinain-hud/sinain-wearable-hud/tunnel.env
```

| Key | Value |
|-----|-------|
| `VPS_HOST` | Your VPS IP (e.g. `85.214.180.247`) |
| `VPS_USER` | `sinain-tunnel` (created by `setup-vps.sh`) |
| `VPS_SSH_PORT` | `22` (VPS SSH port) |
| `REMOTE_SSH_PORT` | `2222` (port on VPS → Pi SSH) |
| `REMOTE_DEBUG_PORT` | `8080` (port on VPS → Pi debug UI) |

2. Copy the Pi's public key to VPS (printed by `install.sh`):

```bash
# Show the key again if needed
cat ~/.ssh/sinain_tunnel.pub
```

Add it to `/home/sinain-tunnel/.ssh/authorized_keys` on the VPS.

3. Test the tunnel:

```bash
sudo systemctl start sinain-tunnel
sudo systemctl status sinain-tunnel
```

4. Verify from your laptop:

```bash
ssh -p 2222 pi@<your-vps-ip>
open http://<your-vps-ip>:8080
```

The tunnel auto-starts on boot and reconnects automatically if the connection drops.

---

## Step 7: Test OLED Display

```bash
cd ~/sinain-hud/sinain-wearable-hud
source .venv/bin/activate
python3 -c "
from luma.core.interface.serial import spi
from luma.oled.device import ssd1327
from PIL import Image, ImageDraw

serial = spi(port=0, device=0, gpio_DC=25, gpio_RST=27)
device = ssd1327(serial, width=128, height=128)
img = Image.new('RGB', (128, 128), (0, 0, 0))
draw = ImageDraw.Draw(img)
draw.text((10, 50), 'SinainHUD', fill=(255, 255, 255))
draw.ellipse([118, 3, 124, 9], fill=(255, 255, 255))
device.display(img)
print('OLED test OK — you should see white text')
"
```

**Verify:** White "SinainHUD" text appears on OLED.

---

## Step 8: Test Camera Module 3

```bash
# Quick capture test (Trixie uses rpicam-* commands, not libcamera-*)
rpicam-still -o /tmp/test.jpg --width 1280 --height 720 -t 2000
ls -la /tmp/test.jpg   # Should be ~100-400KB JPEG

# Python test
python3 -c "
from picamera2 import Picamera2
cam = Picamera2()
config = cam.create_still_configuration(main={'size': (1280, 720)})
cam.configure(config)
cam.start()
import time; time.sleep(2)
arr = cam.capture_array()
print(f'Camera: shape={arr.shape}')
cam.stop()
"
```

**Verify:** `Camera: shape=(720, 1280, 3)` (or `(720, 1280, 4)` with alpha).

> If you get 4 channels (XRGB), the code handles this — `config.yaml` uses `format: "RGB888"` in the picamera2 video config to force 3-channel output.

---

## Step 9: Configure Gateway Token + OCR API Key

```bash
cd ~/sinain-hud/sinain-wearable-hud
nano config.yaml
```

Set the following keys:

| Key | Source | Description |
|-----|--------|-------------|
| `gateway.token` | OpenClaw server `/opt/openclaw/openclaw.json` → `gateway.auth.token` | 48-char hex token for WebSocket auth |
| `gateway.ws_url` | Your OpenClaw server | WebSocket URL, e.g. `ws://85.214.180.247:18789` |
| `gateway.session_key` | Your agent session | e.g. `agent:main:sinain` |
| `ocr.api_key` | [OpenRouter](https://openrouter.ai/keys) | API key for vision OCR (starts with `sk-or-v1-`) |

The OCR engine uses OpenRouter's Gemini Flash model (`google/gemini-2.5-flash`) for server-side text extraction from camera frames. Without an API key, OCR is silently disabled and the agent gets observation messages without extracted text.

---

## Step 10: Test Full Stack (foreground)

```bash
cd ~/sinain-hud/sinain-wearable-hud
source .venv/bin/activate
python3 -m sinain_wearable_hud.main -c config.yaml -v
```

### Debug Interface (3-panel view)

The debug server at `:8080` shows a 3-panel live view of the entire pipeline:

| Panel | Color | Content |
|-------|-------|---------|
| **Observation Sent** (left) | Green | Full structured markdown message sent to the agent via RPC |
| **OCR Text** (center) | Blue | Raw text extracted from camera frames by OpenRouter Gemini Flash |
| **Agent Response** (right) | Amber | Agent's reply + small OLED mirror showing what's on the physical display |

The bottom bar shows camera classification debug info and timestamps.

**Access from Mac:**

```bash
# Option 1: Via VPS tunnel (works from anywhere, see Step 6b)
open http://<your-vps-ip>:8080

# Option 2: Local network (mDNS, same WiFi only)
open http://sinain-wearable.local:8080

# Option 3: SSH tunnel (manual fallback)
ssh -f -N -L 8080:localhost:8080 pi@sinain-wearable.local
open http://localhost:8080
```

**Verify:** OLED shows agent response, browser shows all 3 pipeline streams, logs show:
- `OCR engine ready (model=google/gemini-2.5-flash)`
- `OCR extracted N chars in X.Xs`
- `[sender] p50=NNNNms ok=N fail=0`

---

## Step 11: Enable Systemd Service

```bash
sudo systemctl start sinain-wearable-hud
sudo systemctl status sinain-wearable-hud
journalctl -u sinain-wearable-hud -f
```

The service is already enabled (from install.sh), so it will auto-start on boot.

---

## File Map

```
sinain-wearable-hud/
├── config.example.yaml          # Template config (copy to config.yaml)
├── tunnel.env.example           # Template tunnel config (copy to tunnel.env)
├── install.sh                   # One-shot Pi setup script (manual SSH path)
├── prep-sdcard.sh               # Mac: auto-prep SD card for headless first boot
├── setup-vps.sh                 # VPS setup for reverse SSH tunnel
├── requirements.txt             # Python dependencies
├── SETUP.md                     # This file
├── sinain_wearable_hud/
│   ├── main.py                  # Async orchestrator — wires all components
│   ├── camera.py                # Pi Camera capture → scene gate → OCR → sender
│   ├── scene_gate.py            # Frame classifier (DROP/SCENE/TEXT/MOTION/AMBIENT)
│   ├── ocr.py                   # OpenRouter vision API OCR (Gemini Flash)
│   ├── observation.py           # Rolling history buffer + markdown message builder
│   ├── sender.py                # Agent RPC sender with in-flight guard + stats
│   ├── gateway.py               # OpenClaw WebSocket client (auth, RPC, reconnect)
│   ├── audio.py                 # Microphone capture + VAD
│   ├── display.py               # SSD1327 OLED rendering
│   ├── display_server.py        # HTTP/WebSocket debug server (:8080)
│   ├── protocol.py              # Dataclasses: RoomFrame, DisplayState, enums
│   └── config.py                # Config loader with defaults
├── static/
│   ├── index.html               # 3-panel debug UI
│   ├── hud.css                  # Debug UI styles (dark theme, 3-column layout)
│   └── hud.js                   # WebSocket client for live state updates
└── systemd/
    ├── sinain-wearable-hud.service  # Systemd unit file
    └── sinain-tunnel.service        # Reverse SSH tunnel (autossh)
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Can't ping `sinain-wearable.local` | Check WiFi creds in Imager settings. Find IP via router DHCP list. |
| No `/dev/spidev*` | `sudo raspi-config nonint do_spi 0 && sudo reboot` |
| OLED blank | Verify wiring (esp RST=Pin 13/GPIO 27). Check VCC on Pin 1. |
| `rpicam-hello` shows no cameras | Re-seat CSI cable, check latch is closed. `sudo raspi-config nonint do_camera 0 && sudo reboot` |
| `pip install` OOM on Pi Zero | Trixie uses zram; add swap file if needed (see Step 6 tip) |
| HTTP POST 401 to gateway | Wrong gateway token in config.yaml |
| Root partition only 2GB on 128GB card | Run `sudo raspi-config nonint do_expand_rootfs && sudo reboot` |
| `No module named 'pkg_resources'` | `pip install 'setuptools<82'` — Python 3.13/setuptools 82 removed it |
| Port 8080 unreachable from Mac | Use VPS tunnel (see Step 6b), or SSH tunnel (see Step 10) |
| Tunnel won't connect | Check `tunnel.env` VPS_HOST. Verify key is in VPS `authorized_keys`. Try: `ssh -i ~/.ssh/sinain_tunnel sinain-tunnel@<vps-ip>` |
| Tunnel drops frequently | Check VPS `ClientAliveInterval` in sshd_config. `journalctl -u sinain-tunnel -f` for errors |
| Port 2222 refused on VPS | Check firewall (`ufw status`). Verify `GatewayPorts clientspecified` in sshd_config |
| OCR always returns empty | Check `ocr.api_key` in config.yaml. Logs should show `OCR engine ready`. |
| OCR timeout (>15s) | OpenRouter may be slow; increase `ocr.timeout_s` or check API key quota. |
| Agent gets only motion info | Verify OCR is running: logs should show `OCR extracted N chars`. Scene gate may drop frames; static scenes only trigger AMBIENT every 30s. |
| Debug UI panels empty | Open browser dev tools → Network → WS. Check that WebSocket connects to `/ws` and receives JSON with `observation_sent`, `ocr_text`, `response_text` fields. |
| `SSLCertVerificationError` on macOS | Install certifi: `pip install certifi`. The OCR engine uses it for CA certs on macOS. |
| Camera RGBA (4 channels) | picamera2 may return XRGB — code uses `format: "RGB888"` to force 3-channel |
| `ModuleNotFoundError: picamera2` | Venv needs `--system-site-packages` (install.sh does this). Or: `pip install picamera2` inside venv. |
| OLED garbled/wrong colors | Confirm OLED is SSD1327 (not SSD1306). Check `driver: "ssd1327"` in config.yaml. |
