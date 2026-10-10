# Reolink Cameras (GNOME Shell extension)

Top-bar indicator that discovers Reolink cameras on the local network (by MAC vendor prefix and the Baichuan port) and shows which are online.

Works without configuration. Optional `~/.config/reolink-cams/config.json`:

```json
{"subnet": "192.168.1", "port": 9000, "refreshSeconds": 120,
 "names": {"ec:71:db:02:c9:43": "balcony"}}
```

Install:

```sh
ln -s "$PWD/reolink-cams@pola" ~/.local/share/gnome-shell/extensions/reolink-cams@pola
```

Targets GNOME Shell 50.
