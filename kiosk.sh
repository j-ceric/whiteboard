#!/usr/bin/env bash
# Opens the whiteboard full-screen on the TV.
# Ubuntu Desktop: started at login (GNOME autostart).
# Ubuntu Server:  started by whiteboard-kiosk.service inside the "cage" kiosk compositor.
URL="${WHITEBOARD_URL:-http://localhost/display}"

# --- keep the screen awake ---
if command -v gsettings >/dev/null && [ -n "$DBUS_SESSION_BUS_ADDRESS" ]; then
  # GNOME (Wayland or X11): no idle blanking, no lock screen, no sleep, no popups
  gsettings set org.gnome.desktop.session idle-delay 0
  gsettings set org.gnome.desktop.screensaver lock-enabled false
  gsettings set org.gnome.desktop.screensaver idle-activation-enabled false
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
  gsettings set org.gnome.settings-daemon.plugins.power idle-dim false
  gsettings set org.gnome.desktop.notifications show-banners false
fi 2>/dev/null
if [ "$XDG_SESSION_TYPE" = x11 ] && command -v xset >/dev/null; then
  xset s off; xset s noblank; xset -dpms
fi 2>/dev/null
# (the mouse cursor is hidden by the TV page itself)

# --- wait for the server ---
for _ in $(seq 1 90); do curl -fs -o /dev/null "$URL" && break; sleep 1; done

BROWSER=$(command -v chromium || command -v chromium-browser || command -v google-chrome || echo /snap/bin/chromium)
# The Chromium snap may only write inside ~/snap/chromium, so keep the profile there
if [[ "$BROWSER" == /snap/* ]]; then PROFILE="$HOME/snap/chromium/common/whiteboard-kiosk"
else PROFILE="$HOME/.config/whiteboard-kiosk"; fi
mkdir -p "$PROFILE"

while true; do
  # Stop Chromium from offering to "restore pages" after a power cut
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' \
    "$PROFILE/Default/Preferences" 2>/dev/null
  "$BROWSER" --kiosk --user-data-dir="$PROFILE" --ozone-platform-hint=auto \
    --noerrdialogs --disable-infobars --disable-session-crashed-bubble --no-first-run \
    --disable-features=Translate --check-for-update-interval=31536000 --password-store=basic "$URL"
  sleep 3  # relaunch if it crashes, gets closed, or the snap auto-updates
done
