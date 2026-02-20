# Sinain Wearable HUD — Hardware Setup Guide

Complete step-by-step guide for assembling and configuring the wearable HUD on a Raspberry Pi Zero 2W with SSD1327 OLED and Pi Camera Module 3.

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

**Verify:** Imager says "Write Successful"

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

**Verify:** "Setup complete!" message.

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

## Step 9: Configure Gateway Token

```bash
cd ~/sinain-hud/sinain-wearable-hud
nano config.yaml
```

Set `gateway.token` to your 48-char hex token from the OpenClaw server's `/opt/openclaw/openclaw.json` (`gateway.auth.token` field).

---

## Step 10: Test Full Stack (foreground)

```bash
cd ~/sinain-hud/sinain-wearable-hud
source .venv/bin/activate
python3 -m sinain_wearable_hud.main -c config.yaml -v
```

On Mac browser: `http://sinain-wearable.local:8080`

> **Port 8080 blocked?** Some routers block non-standard ports between WiFi clients. Use an SSH tunnel instead:
> ```bash
> ssh -f -N -L 8080:localhost:8080 pi@sinain-wearable.local
> # Then open http://localhost:8080
> ```

**Verify:** OLED shows status, browser mirrors it, logs show frame classifications.

---

## Step 11: Enable Systemd Service

```bash
sudo systemctl start sinain-wearable-hud
sudo systemctl status sinain-wearable-hud
journalctl -u sinain-wearable-hud -f
```

The service is already enabled (from install.sh), so it will auto-start on boot.

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
| Port 8080 unreachable from Mac | Router may block inter-client traffic; use SSH tunnel (see Step 10) |
| Camera RGBA (4 channels) | picamera2 may return XRGB — code uses `format: "RGB888"` to force 3-channel |
| `ModuleNotFoundError: picamera2` | Venv needs `--system-site-packages` (install.sh does this). Or: `pip install picamera2` inside venv. |
| OLED garbled/wrong colors | Confirm OLED is SSD1327 (not SSD1306). Check `driver: "ssd1327"` in config.yaml. |
