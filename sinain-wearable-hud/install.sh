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
    git \
    autossh

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

# --- Python venv (--system-site-packages so picamera2 is accessible) ---
echo "[3/7] Creating Python virtual environment..."
python3 -m venv --system-site-packages "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$SCRIPT_DIR/requirements.txt"

# --- Config ---
echo "[4/7] Setting up config..."
if [ ! -f "$SCRIPT_DIR/config.yaml" ]; then
    cp "$SCRIPT_DIR/config.example.yaml" "$SCRIPT_DIR/config.yaml"
    echo "Created config.yaml from template — edit it with your gateway token"
else
    echo "config.yaml already exists, skipping"
fi

# --- SSH key for tunnel ---
echo "[5/7] Setting up SSH tunnel key..."
TUNNEL_KEY="/home/pi/.ssh/sinain_tunnel"
if [ -f "$TUNNEL_KEY" ]; then
    echo "Tunnel key already exists"
else
    ssh-keygen -t ed25519 -f "$TUNNEL_KEY" -N "" -C "sinain-hud-tunnel"
    echo "Generated tunnel key: $TUNNEL_KEY"
fi

# --- Tunnel config ---
echo "[5.5/7] Setting up tunnel config..."
if [ ! -f "$SCRIPT_DIR/tunnel.env" ]; then
    cp "$SCRIPT_DIR/tunnel.env.example" "$SCRIPT_DIR/tunnel.env"
    echo "Created tunnel.env from template — edit it with your VPS IP"
else
    echo "tunnel.env already exists, skipping"
fi

# --- Systemd services ---
echo "[6/7] Installing systemd services..."
sudo cp "$SCRIPT_DIR/systemd/$SERVICE_NAME.service" "/etc/systemd/system/"
sudo cp "$SCRIPT_DIR/systemd/sinain-tunnel.service" "/etc/systemd/system/"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl enable sinain-tunnel

echo "[7/7] Setup complete!"
echo ""
echo "=== Pi public key (copy this to VPS) ==="
cat "$TUNNEL_KEY.pub"
echo "========================================="
echo ""
echo "Next steps:"
echo "  1. Edit config.yaml with your OPENCLAW_TOKEN and OPENROUTER_API_KEY"
echo "  2. Edit tunnel.env with your VPS_HOST"
echo "  3. Add the public key above to VPS: /home/sinain-tunnel/.ssh/authorized_keys"
echo "  4. Wire the SSD1327 OLED (see SETUP.md for wiring diagram)"
echo "  5. Connect Pi Camera Module 3 via CSI ribbon cable"
echo "  6. sudo systemctl start sinain-tunnel"
echo "  7. sudo systemctl start $SERVICE_NAME"
echo ""
echo "After tunnel is up, from anywhere:"
echo "  ssh -p 2222 pi@<your-vps-ip>"
echo "  http://<your-vps-ip>:8080  (debug UI)"
echo ""
echo "Logs: journalctl -u $SERVICE_NAME -f"
echo "       journalctl -u sinain-tunnel -f"
