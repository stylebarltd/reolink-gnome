# Reolink Cameras (GNOME Shell extension)

Top-bar indicator that discovers Reolink cameras on the local network (by MAC vendor prefix and the Baichuan port) and shows which are online.

Works without configuration. Optional `~/.config/reolink-cams/config.json`:

```json
{"subnet": "192.168.1", "port": 9000, "refreshSeconds": 120,
 "names": {"ec:71:db:02:c9:43": "balcony"}}
```

Live snapshots (shown while the menu is open) need credentials in the config and a venv with `reolink_aio`:

```sh
python3 -m venv ~/.local/share/reolink-cams/venv
~/.local/share/reolink-cams/venv/bin/pip install reolink_aio
```

Config additions: `user`, `password`, `snapshotSeconds` (keep the file `chmod 600`). See [`config.example.json`](config.example.json) for all options:

```sh
mkdir -p ~/.config/reolink-cams
cp config.example.json ~/.config/reolink-cams/config.json
chmod 600 ~/.config/reolink-cams/config.json
```

The play button, or a click on the thumbnail, streams a camera live in its thumbnail (about 5 fps; snapshots fill the first seconds until the stream's first keyframe). The fullscreen button opens a fullscreen live view in `ffplay` (Esc or `q` closes it). It plays the RTSP stream and switches RTSP on in the camera if it is off; models without RTSP (the plain E1) fall back to main-quality snapshots twice a second.

Cameras that move between LAN and Wi-Fi keep one entry: they are matched by their Reolink UID, not their MAC. `names` accepts a UID as well as a MAC.

Some cameras (seen on the plain E1) only speak Baichuan and refuse snapshots. Bridge them with [Neolink](https://github.com/QuantumEntangledAndy/neolink) (needs `libgstrtspserver-1.0-0` and `gstreamer1.0-plugins-bad`) and point the camera's UID at it with `"rtsp": {"<uid>": "rtsp://127.0.0.1:8554/<name>"}`; thumbnails, play and fullscreen then use `<url>/sub` and `<url>/main`.

The pin button keeps a camera on screen: pinned cameras float below the top bar as live views (sub stream, 2 fps) until you unpin them with their ×, also across restarts. Drag a view's title bar to move them; a click on the picture opens fullscreen, and they hide while a window is fullscreen. Pins are kept in `~/.config/reolink-cams/pinned.json` by camera UID.

Motion alerts: the cameras push their detections (the extension keeps one Baichuan connection per camera open). When a camera sees a person or a vehicle, its dot turns red and pulses, the top-bar icon pulses red, the detection and time show under the camera name for 30 minutes, and a notification with a fresh snapshot pops up (click it to watch live). Options: `alertTypes` (default `["people", "vehicle"]`; also `dog_cat`, or `motion` for any motion), `alertCameras` (names, UIDs or MACs; empty = all), `alertCooldownSeconds` (default 120, per camera) and `alertQuietHours` (e.g. `"23:00-06:00"`, no notifications then).

Install:

```sh
ln -s "$PWD/reolink-cams@pola" ~/.local/share/gnome-shell/extensions/reolink-cams@pola
```

Targets GNOME Shell 46–50.
