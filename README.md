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

Install:

```sh
ln -s "$PWD/reolink-cams@pola" ~/.local/share/gnome-shell/extensions/reolink-cams@pola
```

Targets GNOME Shell 50.
