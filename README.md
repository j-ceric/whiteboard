# Whiteboard

A small shared whiteboard for the TV. The PC behind the TV runs the server and shows the board full-screen. Everyone else draws on it from a browser on the same network: a laptop, phone or tablet.

- **No dependencies.** Plain Node 18+ and four small front-end files (about 1,300 lines in total). Nothing to `npm install`.
- **Live and multi-user.** Strokes appear on the TV while they're being drawn. You can see everyone's cursor and name, and the toolbar shows when a TV is connected.
- **Markdown and images.** Paste Markdown text or an image (Ctrl+V) and it lands where your mouse is. You can also drag image files onto the board.
- **Persistent.** The board is saved to `data/board.json` and images to `data/uploads/`, so it survives reboots.

## Pages

| URL | What |
|---|---|
| `http://whiteboard.local/` | Drawing page, for any device |
| `http://whiteboard.local/display` | TV view: no UI, fills the screen |
| `http://whiteboard.local/export` | Download a JSON backup of the board |

## Tools

| Key | Tool |
|---|---|
| `V` | **Select.** Move and resize notes and images, tick checkboxes in notes. Double-click or press Enter to edit a note, Del to delete. |
| `P` / `H` | Pen / highlighter |
| `E` | Eraser (removes whole strokes) |
| `T` | Text. Click to write a Markdown note, or click an existing note to edit it. Ctrl+Enter places it, Esc cancels. |
| `L` | Laser pointer. A glowing dot in your colour shows on the TV and fades out. |
| `I` | Insert an image from a file (handy on phones) |
| `1`–`7` | Colours. The first colour is "ink", which is white on the dark board and black on the light board. |
| `[` `]` | Stroke size, or font size for a selected note |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo your own actions |
| PgUp / PgDn | Change page. Pages change for everyone, including the TV. |

With a note selected, clicking a colour or size changes that note. **Card** gives the note a background panel.

**Supported Markdown:** headings, bold, italic, strikethrough, inline code and code blocks, links, lists (including nested), `- [ ]` task lists, quotes, tables and horizontal rules. Raw HTML is shown as plain text, so pasted content can't run scripts.

## Install on the TV PC (Ubuntu 24.04)

```bash
git clone https://github.com/j-ceric/whiteboard.git && cd whiteboard
bash install.sh whiteboard  # optional argument renames the PC → http://whiteboard.local
sudo reboot
```

The script works out whether the PC runs Ubuntu **Desktop** or **Server** and sets it up to match. You can force one with `MODE=desktop ./install.sh` or `MODE=server ./install.sh`.

On both editions, the script:
- installs Node (from apt), Chromium (a snap) and `avahi-daemon` (for `.local` names);
- copies the app to `/opt/whiteboard`;
- creates a `whiteboard` service on port 80 that starts on boot;
- opens port 80 if the `ufw` firewall is on.

**Ubuntu Desktop.** The script:
- turns on automatic login for your user;
- opens the board full-screen at login;
- switches off GNOME's screen blanking, lock screen, sleep and notification pop-ups.

**Ubuntu Server.** There's no desktop to install. A `whiteboard-kiosk` service runs Chromium full-screen inside `cage`, a tiny kiosk compositor, directly on the TV from boot. To get a normal console back, run `sudo systemctl disable --now whiteboard-kiosk`.

**Updating** after you push changes: on the TV PC run `git pull && bash install.sh`. Your board data in `/opt/whiteboard/data` is kept.

**Tips:**
- Reserve the PC's IP address in your router so the numeric address never changes. `whiteboard.local` works on macOS, iOS and Linux out of the box, and on Windows 10/11 in most networks.
- Set the TV's picture mode to **PC** or **Game** (or turn off overscan) so the edges aren't cropped.
- The board is 16:9 (1920×1080 units). The drawing page shows exactly what the TV shows.

**Useful commands:**
```bash
sudo systemctl status whiteboard      # is it running?
journalctl -u whiteboard -f           # logs
sudo systemctl restart whiteboard     # after editing files in /opt/whiteboard
journalctl -u whiteboard-kiosk -f     # TV browser logs (Server edition)
```
Edits to the `public/` files only need a browser refresh, not a server restart.

## Run it anywhere for testing

```bash
node server.js            # http://localhost:8080   (PORT=… and DATA_DIR=… to change)
```

## How it works

```
server.js            HTTP server. Live updates go out over Server-Sent Events; changes come in as batched POSTs.
public/common.js     The board model and its operations (put / app / upd / del / clear / pages). Shared by server and browser.
public/app.js        Rendering (canvas for ink, DOM for notes and images), tools, paste/drop, undo, presence.
public/markdown.js   Tiny Markdown renderer with HTML escaped.
public/app.css       Styles.
public/draw.html     Drawing page.
public/display.html  TV page.
kiosk.sh             Launches Chromium full-screen on /display.
install.sh           One-shot setup for the TV PC.
```

Every change is a small JSON operation, such as `{t:'app', id, pts:[[x,y],…]}` for adding points to a stroke. The browser applies the op locally, sends it to the server, and the server applies it and relays it to everyone else. When a browser connects or reconnects, it gets the whole board, so a rebooted TV comes back exactly as it was.

There's no login. Anyone on your network can draw, which is the point. Don't expose this port to the internet.
