#!/usr/bin/env bash
# VPS setup for Sinain Wearable HUD reverse SSH tunnel.
# Run on VPS: bash setup-vps.sh
set -euo pipefail

TUNNEL_USER="sinain-tunnel"
SSH_TUNNEL_PORT=2222
DEBUG_TUNNEL_PORT=8080

echo "=== Sinain HUD — VPS Tunnel Setup ==="

# --- Tunnel user ---
echo "[1/3] Creating tunnel user '$TUNNEL_USER'..."
if id "$TUNNEL_USER" &>/dev/null; then
    echo "User '$TUNNEL_USER' already exists"
else
    sudo useradd -m -s /usr/sbin/nologin "$TUNNEL_USER"
    echo "Created user '$TUNNEL_USER'"
fi

sudo mkdir -p "/home/$TUNNEL_USER/.ssh"
sudo chmod 700 "/home/$TUNNEL_USER/.ssh"
sudo touch "/home/$TUNNEL_USER/.ssh/authorized_keys"
sudo chmod 600 "/home/$TUNNEL_USER/.ssh/authorized_keys"
sudo chown -R "$TUNNEL_USER:$TUNNEL_USER" "/home/$TUNNEL_USER/.ssh"

# --- sshd config ---
echo "[2/3] Configuring SSH server..."
SSHD_CONF="/etc/ssh/sshd_config"
CHANGED=false

if ! grep -q "^GatewayPorts" "$SSHD_CONF"; then
    echo "" | sudo tee -a "$SSHD_CONF" >/dev/null
    echo "# Sinain HUD: allow reverse tunnels to bind on 0.0.0.0" | sudo tee -a "$SSHD_CONF" >/dev/null
    echo "GatewayPorts clientspecified" | sudo tee -a "$SSHD_CONF" >/dev/null
    CHANGED=true
fi

if ! grep -q "^ClientAliveInterval" "$SSHD_CONF"; then
    echo "ClientAliveInterval 30" | sudo tee -a "$SSHD_CONF" >/dev/null
    echo "ClientAliveCountMax 3" | sudo tee -a "$SSHD_CONF" >/dev/null
    CHANGED=true
fi

if [ "$CHANGED" = true ]; then
    sudo systemctl restart sshd
    echo "sshd restarted with new config"
else
    echo "sshd already configured"
fi

# --- Firewall ---
echo "[3/3] Opening firewall ports..."
if command -v ufw &>/dev/null && sudo ufw status | grep -q "active"; then
    sudo ufw allow "$SSH_TUNNEL_PORT"/tcp comment "Sinain HUD SSH tunnel" 2>/dev/null || \
        sudo ufw allow "$SSH_TUNNEL_PORT"/tcp
    sudo ufw allow "$DEBUG_TUNNEL_PORT"/tcp comment "Sinain HUD debug UI" 2>/dev/null || \
        sudo ufw allow "$DEBUG_TUNNEL_PORT"/tcp
    echo "ufw: opened ports $SSH_TUNNEL_PORT, $DEBUG_TUNNEL_PORT"
elif command -v firewall-cmd &>/dev/null; then
    sudo firewall-cmd --permanent --add-port="$SSH_TUNNEL_PORT/tcp"
    sudo firewall-cmd --permanent --add-port="$DEBUG_TUNNEL_PORT/tcp"
    sudo firewall-cmd --reload
    echo "firewalld: opened ports $SSH_TUNNEL_PORT, $DEBUG_TUNNEL_PORT"
else
    echo "No firewall detected — make sure ports $SSH_TUNNEL_PORT and $DEBUG_TUNNEL_PORT are open"
fi

VPS_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "=== VPS setup complete ==="
echo ""
echo "Tunnel ports on this VPS:"
echo "  :$SSH_TUNNEL_PORT  →  Pi SSH (port 22)"
echo "  :$DEBUG_TUNNEL_PORT  →  Pi debug UI (port 8080)"
echo ""
echo "Next: run install.sh on the Pi. It will generate an SSH key and print it."
echo "Then add the Pi's public key to this server:"
echo ""
echo "  sudo nano /home/$TUNNEL_USER/.ssh/authorized_keys"
echo "  # paste the Pi's public key there"
echo ""
echo "After that, from anywhere:"
echo "  ssh -p $SSH_TUNNEL_PORT pi@$VPS_IP"
echo "  http://$VPS_IP:$DEBUG_TUNNEL_PORT  (debug UI)"
