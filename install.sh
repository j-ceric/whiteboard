#!/usr/bin/env bash
# Installs the whiteboard on Ubuntu 24.04 (Desktop or Server).
# Run it as the normal user (not root), from inside this folder:
#     ./install.sh               # keep the current hostname
#     ./install.sh whiteboard    # also rename the PC  ->  http://whiteboard.local
#
# Ubuntu Desktop: logs this user in automatically and opens the board full-screen.
# Ubuntu Server:  no desktop needed. The board runs full-screen on the TV inside
#                 "cage", a tiny kiosk window manager, started straight from boot.
# Force a mode with MODE=desktop or MODE=server.
set -euo pipefail

APP=/opt/whiteboard
ME=$(id -un)
NEW_HOST="${1:-}"
[ "$ME" = root ] && { echo "Run this as your normal user (it uses sudo when needed)."; exit 1; }
cd "$(dirname "$0")"

if [ -z "${MODE:-}" ]; then
  if command -v gnome-shell >/dev/null; then MODE=desktop; else MODE=server; fi
fi
echo "==> Setting up for Ubuntu $MODE"

echo "==> Installing packages"
sudo apt-get update -q
sudo apt-get install -y -q nodejs curl avahi-daemon libnss-mdns
[ "$MODE" = server ] && sudo apt-get install -y -q cage
command -v chromium >/dev/null || [ -x /snap/bin/chromium ] || sudo snap install chromium
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || { echo "Node 18+ needed (found $(node -v))."; exit 1; }

echo "==> Copying app to $APP"
sudo mkdir -p "$APP/data"
sudo cp -r server.js kiosk.sh public README.md "$APP/"
sudo chown -R "$ME:$ME" "$APP"
chmod +x "$APP/kiosk.sh" "$APP/server.js"

echo "==> Server service (port 80, starts on boot)"
sudo tee /etc/systemd/system/whiteboard.service >/dev/null <<EOF
[Unit]
Description=Whiteboard server
After=network-online.target
Wants=network-online.target

[Service]
User=$ME
WorkingDirectory=$APP
Environment=PORT=80
ExecStart=$(command -v node) $APP/server.js
Restart=always
RestartSec=2
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now whiteboard

if [ "$MODE" = desktop ]; then
  echo "==> Opening the board on the TV at login"
  mkdir -p "$HOME/.config/autostart"
  cat > "$HOME/.config/autostart/whiteboard-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Whiteboard TV
Exec=$APP/kiosk.sh
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=3
EOF
  echo "==> Turning on automatic login for $ME"
  sudo sed -i '/^\s*#\?\s*AutomaticLogin\(Enable\)\?\s*=/d' /etc/gdm3/custom.conf
  sudo sed -i "/^\[daemon\]/a AutomaticLoginEnable=true\nAutomaticLogin=$ME" /etc/gdm3/custom.conf
else
  echo "==> Kiosk service on the TV (tty1)"
  sudo usermod -aG video,render,input "$ME"
  sudo tee /etc/systemd/system/whiteboard-kiosk.service >/dev/null <<EOF
[Unit]
Description=Whiteboard on the TV
After=whiteboard.service systemd-user-sessions.service getty@tty1.service
Wants=whiteboard.service
Conflicts=getty@tty1.service

[Service]
User=$ME
PAMName=login
TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal
StandardError=journal
TTYReset=yes
TTYVHangup=yes
UtmpIdentifier=tty1
Environment=XDG_SESSION_TYPE=wayland
ExecStart=/usr/bin/cage -- $APP/kiosk.sh
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable whiteboard-kiosk
fi

# Let other devices reach port 80 if the firewall is on
if command -v ufw >/dev/null && sudo ufw status | grep -q "Status: active"; then
  echo "==> Opening port 80 in the firewall"
  sudo ufw allow 80/tcp
fi

if [ -n "$NEW_HOST" ]; then
  echo "==> Renaming this PC to $NEW_HOST"
  OLD_HOST=$(hostname)
  sudo hostnamectl set-hostname "$NEW_HOST"
  sudo sed -i "s/\b$OLD_HOST\b/$NEW_HOST/g" /etc/hosts
  # Ubuntu Server's cloud-init would otherwise reset the name on reboot
  if [ -f /etc/cloud/cloud.cfg ]; then
    echo "preserve_hostname: true" | sudo tee /etc/cloud/cloud.cfg.d/99-whiteboard-hostname.cfg >/dev/null
  fi
fi
sudo systemctl enable avahi-daemon >/dev/null 2>&1 || true
sudo systemctl restart avahi-daemon || true

echo
echo "Done. After a reboot, draw from any device on the network at:"
echo "    http://$(hostname).local"
for ip in $(hostname -I); do case $ip in *:*) ;; *) echo "    http://$ip";; esac; done
echo
echo "Reboot now with:  sudo reboot"
