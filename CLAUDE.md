# Reolink Cameras (GNOME Shell extension)

<!-- Public repo: keep this file free of credentials, IPs, MACs/UIDs and local paths. -->

## What this is
Top-bar indicator that discovers Reolink cameras on the local network and shows which
are online, with snapshots, live streams, pinned floating live views and motion alerts
for people and vehicles. Repo `stylebarltd/reolink-gnome` (public).

## Stack & layout
- GNOME Shell extension (GJS), uuid `reolink-cams@pola`, shell 46–50.
- `reolink-cams@pola/extension.js`: discovery (MAC vendor prefix + Baichuan port),
  panel, menu, pinned views.
- Python helpers run from the extension, using a venv with `reolink_aio`:
  `info.py` (camera info), `snapshot.py`, `live.py` (stream), `events.py` (motion
  events over one Baichuan connection per camera).
- Config: `~/.config/reolink-cams/config.json` (optional; template `config.example.json`).
  Credentials only there, `chmod 600`.

## Commands
```bash
python3 -m venv ~/.local/share/reolink-cams/venv
~/.local/share/reolink-cams/venv/bin/pip install reolink_aio
ln -s "$PWD/reolink-cams@pola" ~/.local/share/gnome-shell/extensions/reolink-cams@pola   # once
journalctl -f -o cat /usr/bin/gnome-shell
```
Reload after a change: X11 `Alt+F2`, `r`; Wayland: log out and back in.

## Gotchas
- The top bar shows the camera icon alone while every camera is online; the `x/y` count
  only appears when one is down or none were found. Notices still show.
- Cameras are matched by Reolink UID, not MAC, so LAN/Wi-Fi moves keep one entry.
- Some cameras (seen on the plain E1) only speak Baichuan and refuse snapshots; they
  need Neolink as a bridge (see README).
- After a shell restart, a new event listener replaces the leftover one. Keep that,
  or motion alerts double up.
- Never commit a real config, camera names, MACs or UIDs.
