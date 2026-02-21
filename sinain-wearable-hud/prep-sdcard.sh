#!/usr/bin/env bash
# Add reverse SSH tunnel to an already-flashed SD card.
# Run on Mac while the SD card is inserted.
#
#   1. Run setup-vps.sh on VPS
#   2. Take SD card out of Pi, insert into Mac
#   3. bash prep-sdcard.sh
#   4. Add printed public key to VPS authorized_keys
#   5. Put SD card back into Pi, power on
#   6. Wait ~2 min, then: ssh -p 2222 pi@<vps-ip>
set -euo pipefail

# --- Find boot partition ---
BOOT=""
for dir in "/Volumes/bootfs" "/Volumes/boot"; do
    if [ -d "$dir" ]; then
        BOOT="$dir"
        break
    fi
done

if [ -z "$BOOT" ]; then
    echo "ERROR: SD card boot partition not found."
    echo "Insert the SD card and try again."
    exit 1
fi

echo "=== Sinain HUD — Add SSH Tunnel ==="
echo "Boot partition: $BOOT"
echo ""

read -rp "VPS IP address: " VPS_HOST

STAGING="$BOOT/sinain-setup"
mkdir -p "$STAGING"

# --- Generate SSH tunnel key ---
if [ -f "$STAGING/sinain_tunnel" ]; then
    echo "Tunnel key already exists on card, reusing"
else
    echo "Generating SSH tunnel key..."
    ssh-keygen -t ed25519 -f "$STAGING/sinain_tunnel" -N "" -C "sinain-hud-tunnel"
fi

# --- Write tunnel.env ---
cat > "$STAGING/tunnel.env" <<EOF
VPS_HOST=$VPS_HOST
VPS_USER=sinain-tunnel
VPS_SSH_PORT=22
REMOTE_SSH_PORT=2222
REMOTE_DEBUG_PORT=8080
EOF

# --- Write setup script (runs on Pi at next boot) ---
cat > "$STAGING/setup.sh" <<'PISETUP'
#!/usr/bin/env bash
set -euo pipefail

SETUP_DIR="/boot/firmware/sinain-setup"
PI_HOME="/home/pi"
PROJECT="$PI_HOME/sinain-hud/sinain-wearable-hud"

echo "sinain-setup: installing SSH tunnel..."

# Install autossh if missing
if ! command -v autossh &>/dev/null; then
    apt-get update
    apt-get install -y autossh
fi

# SSH key
mkdir -p "$PI_HOME/.ssh"
cp "$SETUP_DIR/sinain_tunnel" "$PI_HOME/.ssh/sinain_tunnel"
cp "$SETUP_DIR/sinain_tunnel.pub" "$PI_HOME/.ssh/sinain_tunnel.pub"
chmod 700 "$PI_HOME/.ssh"
chmod 600 "$PI_HOME/.ssh/sinain_tunnel"
chown -R pi:pi "$PI_HOME/.ssh"

# Tunnel config
mkdir -p "$PROJECT"
cp "$SETUP_DIR/tunnel.env" "$PROJECT/tunnel.env"
chown pi:pi "$PROJECT/tunnel.env"

# Tunnel systemd service
cat > /etc/systemd/system/sinain-tunnel.service <<'SVC'
[Unit]
Description=Sinain HUD Reverse SSH Tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
EnvironmentFile=/home/pi/sinain-hud/sinain-wearable-hud/tunnel.env
ExecStart=/usr/bin/autossh -M 0 -N \
    -o "ServerAliveInterval=30" \
    -o "ServerAliveCountMax=3" \
    -o "ExitOnForwardFailure=yes" \
    -o "StrictHostKeyChecking=accept-new" \
    -i /home/pi/.ssh/sinain_tunnel \
    -p ${VPS_SSH_PORT} \
    -R 0.0.0.0:${REMOTE_SSH_PORT}:localhost:22 \
    -R 0.0.0.0:${REMOTE_DEBUG_PORT}:localhost:8080 \
    ${VPS_USER}@${VPS_HOST}
Restart=always
RestartSec=10
Environment=AUTOSSH_GATETIME=0

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable sinain-tunnel
systemctl start sinain-tunnel

# Wipe private key from boot partition
rm -f "$SETUP_DIR/sinain_tunnel"

# Remove self from cmdline.txt so this doesn't run again
sed -i 's| systemd.run=/boot/firmware/sinain-setup/setup.sh||g' /boot/firmware/cmdline.txt
sed -i 's| systemd.run_success_action=none||g' /boot/firmware/cmdline.txt

echo "sinain-setup: tunnel installed and started"
PISETUP
chmod +x "$STAGING/setup.sh"

# --- Add to cmdline.txt so it runs on next boot ---
CMDLINE="$BOOT/cmdline.txt"
if [ ! -f "$CMDLINE" ]; then
    echo "ERROR: cmdline.txt not found on boot partition"
    exit 1
fi

if grep -q "sinain-setup" "$CMDLINE"; then
    echo "cmdline.txt already has sinain-setup hook"
else
    CURRENT=$(tr -d '\n' < "$CMDLINE")
    echo "${CURRENT} systemd.run=/boot/firmware/sinain-setup/setup.sh systemd.run_success_action=none" > "$CMDLINE"
fi

echo ""
echo "=== SD card ready ==="
echo ""
echo "Pi's tunnel public key:"
echo "───────────────────────────────────────────────"
cat "$STAGING/sinain_tunnel.pub"
echo "───────────────────────────────────────────────"
echo ""
echo ">>> Add this key to VPS:"
echo "    /home/sinain-tunnel/.ssh/authorized_keys"
echo ""
echo "Then:"
echo "  1. Eject SD card, put it back in Pi, power on"
echo "  2. Pi boots, installs tunnel (~1-2 min)"
echo "  3. ssh -p 2222 pi@$VPS_HOST"
