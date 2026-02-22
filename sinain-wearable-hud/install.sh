#!/usr/bin/env bash
# One-shot setup script for Raspberry Pi Zero 2W
# Run as: bash install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
SERVICE_NAME="sinain-wearable-hud"

echo "=== Sinain Wearable HUD Setup ==="

# --- System dependencies ---
echo "[1/7] Installing system packages..."
sudo apt update
sudo apt install -y \
    python3-pip python3-venv python3-dev \
    python3-picamera2 \
    rpicam-apps-core \
    libopencv-dev python3-opencv \
    portaudio19-dev \
    libjpeg-dev libfreetype6-dev \
    fonts-dejavu-core \
    git

# --- Expand root filesystem if needed ---
ROOT_SIZE=$(df --output=size / | tail -1 | tr -d ' ')
if [ "$ROOT_SIZE" -lt 10000000 ]; then
    echo "[1.5/7] Expanding root filesystem..."
    sudo raspi-config nonint do_expand_rootfs
    echo "Filesystem expansion scheduled — will take effect after reboot"
fi

# --- Enable SPI (non-interactive) ---
echo "[2/7] Enabling SPI interface..."
if ! grep -q "^dtparam=spi=on" /boot/firmware/config.txt 2>/dev/null; then
    sudo raspi-config nonint do_spi 0
    echo "SPI enabled (reboot may be needed)"
else
    echo "SPI already enabled"
fi

# --- zram swap for memory headroom ---
echo "[3/7] Configuring zram compressed swap..."
sudo apt install -y zram-tools
# 256 MB zram ≈ 512 MB effective with ~2:1 compression ratio.
# Much faster than SD card swap; critical for the ~416 MB Pi Zero 2W.
sudo tee /etc/default/zramswap > /dev/null <<'ZRAM'
ALGO=lz4
PERCENT=60
PRIORITY=100
ZRAM
sudo systemctl restart zramswap
echo "zram swap active ($(swapon --show=NAME,SIZE --noheadings | grep zram || echo 'pending reboot'))"

# --- Python venv (--system-site-packages so picamera2 is accessible) ---
echo "[4/7] Creating Python virtual environment..."
python3 -m venv --system-site-packages "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$SCRIPT_DIR/requirements.txt"

# --- Config ---
echo "[5/7] Setting up config..."
if [ ! -f "$SCRIPT_DIR/config.yaml" ]; then
    cp "$SCRIPT_DIR/config.example.yaml" "$SCRIPT_DIR/config.yaml"
    echo "Created config.yaml from template — edit it with your gateway token"
else
    echo "config.yaml already exists, skipping"
fi

# --- Systemd service ---
echo "[6/7] Installing systemd service..."
sudo cp "$SCRIPT_DIR/systemd/$SERVICE_NAME.service" "/etc/systemd/system/"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

echo "=== Setup complete! ==="
echo ""
echo "Next steps:"
echo "  1. Edit config.yaml with your OPENCLAW_TOKEN"
echo "  2. Wire the SSD1327 OLED (see SETUP.md for wiring diagram)"
echo "  3. Connect Pi Camera Module 3 via CSI ribbon cable"
echo "  4. sudo systemctl start $SERVICE_NAME"
echo "  5. Open http://sinain-wearable.local:8080 on Mac browser"
echo ""
echo "Logs: journalctl -u $SERVICE_NAME -f"
