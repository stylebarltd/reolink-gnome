import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'reolink-cams']);
const CONFIG_PATH = GLib.build_filenamev([CONFIG_DIR, 'config.json']);
const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'reolink-cams']);
const PYTHON = GLib.build_filenamev([DATA_DIR, 'venv', 'bin', 'python']);   // venv with reolink_aio
const SNAP_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'reolink-cams']);
const CACHE_PATH = GLib.build_filenamev([GLib.get_user_cache_dir(), 'reolink-cams.json']);
const DEFAULTS = {
    port: 9000,              // Reolink Baichuan/media port (HTTP API is off on these cameras)
    subnet: '',              // e.g. "192.168.1"; empty = auto-detect from default route
    refreshSeconds: 120,
    connectTimeoutSeconds: 3,   // WiFi cameras in power-save can take >1s to accept
    concurrency: 48,
    snapshotSeconds: 3,      // refresh interval for thumbnails while the menu is open
    snapshotStream: 'sub',
    names: {},               // {"ec:71:db:02:c9:43": "balcony"} optional friendly names
};
// MAC prefixes registered to Reolink; other hosts with the port open are shown as "unknown".
const REOLINK_OUI = ['ec:71:db'];

const readJson = path => {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (_e) { return null; }
};

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Reolink Cameras');
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({icon_name: 'camera-web-symbolic', style_class: 'system-status-icon'}));
        this._label = new St.Label({text: '…', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._label);
        this.add_child(box);

        this._list = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._list);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._status = new PopupMenu.PopupMenuItem('Scanning…', {reactive: false});
        this.menu.addMenuItem(this._status);
        this._rescan = new PopupMenu.PopupMenuItem('Rescan now');
        this.menu.addMenuItem(this._rescan);
        this._pics = new Map();   // mac -> St.Widget
    }

    onOpen(cb) { this.menu.connect('open-state-changed', (_m, open) => cb(open)); }

    setSnapshot(mac, path) {
        // unique file name per frame, so St does not serve a stale cached texture
        this._pics.get(mac)?.set_style(
            `background-image: url("file://${path}"); background-size: cover; width: 320px; height: 180px; border-radius: 6px;`);
    }

    onRescan(cb) { this._rescan.connect('activate', cb); }
    onRefresh(cb) { this._refreshCb = cb; }
    setStatus(text) { this._status.label.set_text(text); }

    render(cams) {
        this._list.removeAll();
        this._pics.clear();
        const online = cams.filter(c => c.online).length;
        this._label.set_text(cams.length ? `${online}/${cams.length}` : '0');
        if (!cams.length) {
            this._list.addMenuItem(new PopupMenu.PopupMenuItem('No cameras found', {reactive: false}));
            return;
        }
        for (const c of cams) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
            const dot = new St.Label({
                text: '●', y_align: Clutter.ActorAlign.CENTER,
                style_class: c.online ? 'reolink-online' : 'reolink-offline',
            });
            const name = new St.Label({text: c.name, style_class: 'reolink-key', y_align: Clutter.ActorAlign.CENTER});
            const info = new St.Label({
                text: `${c.ip ?? '?'}${c.reolink ? '' : ' (unverified)'}`,
                style_class: 'reolink-sub', x_expand: true, x_align: Clutter.ActorAlign.END,
            });
            item.add_child(dot); item.add_child(name); item.add_child(info);
            if (c.online) {
                const btn = new St.Button({
                    child: new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 14}),
                    style_class: 'button', reactive: true, can_focus: true, track_hover: true,
                    y_align: Clutter.ActorAlign.CENTER, style: 'margin-left: 8px; padding: 2px 6px;',
                });
                btn.connect('clicked', () => this._refreshCb?.(c.mac));
                item.add_child(btn);
            }
            this._list.addMenuItem(item);
            if (c.online) {
                const row = new PopupMenu.PopupBaseMenuItem({reactive: false});
                const pic = new St.Widget({style: 'width: 320px; height: 180px; background-color: #222; border-radius: 6px;'});
                row.add_child(pic);
                this._pics.set(c.mac, pic);
                this._list.addMenuItem(row);
            }
        }
    }
});

export default class ReolinkExtension extends Extension {
    enable() {
        this._cancel = new Gio.Cancellable();
        this._cfg = {...DEFAULTS, ...(readJson(CONFIG_PATH) ?? {})};
        this._known = readJson(CACHE_PATH) ?? {};   // mac -> {ip, reolink, lastSeen}
        this._indicator = new Indicator();
        this._indicator.onRescan(() => this._scan());
        this._indicator.onRefresh(mac => this._snapshot(mac, true));
        this._indicator.onOpen(open => open ? this._startSnapshots() : this._stopSnapshots());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.render(this._cams());
        this._scan();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._cfg.refreshSeconds, () => {
            this._scan();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        this._stopSnapshots();
        this._cancel?.cancel();
        this._cancel = null;
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._known = null;
        this._lastOnline = null;
        this._frames = null;
    }

    _cams(onlineMacs = new Set()) {
        return Object.entries(this._known).map(([mac, k]) => ({
            mac, ip: k.ip, reolink: k.reolink,
            name: this._cfg.names[mac] ?? (k.reolink ? `Reolink ${mac.slice(-5)}` : `Camera ${mac.slice(-5)}`),
            online: onlineMacs.has(mac),
        })).sort((a, b) => a.name.localeCompare(b.name));
    }

    _startSnapshots() {
        if (this._snapLoop) return;
        const cancel = this._cancel;
        this._snapLoop = true;
        (async () => {
            GLib.mkdir_with_parents(SNAP_DIR, 0o755);
            while (this._snapLoop && !cancel.is_cancelled()) {
                const online = this._lastOnline ?? new Set();
                await Promise.all([...online].map(mac => this._snapshot(mac)));
                await new Promise(r => GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._cfg.snapshotSeconds, () => { r(); return GLib.SOURCE_REMOVE; }));
            }
        })().catch(e => console.error(`reolink-cams: ${e.message}`));
    }

    _stopSnapshots() { this._snapLoop = false; }

    async _snapshot(mac, manual = false) {
        const ip = this._known?.[mac]?.ip;
        if (!ip) return;
        const tmp = GLib.build_filenamev([SNAP_DIR, `${mac.replaceAll(':', '')}.jpg`]);
        try {
            const proc = new Gio.Subprocess({
                argv: [PYTHON, GLib.build_filenamev([this.path, 'snapshot.py']), ip, tmp, this._cfg.snapshotStream],
                flags: Gio.SubprocessFlags.STDERR_SILENCE,
            });
            proc.init(null);
            await new Promise((res, rej) => proc.wait_check_async(this._cancel, (p, r) => {
                try { res(p.wait_check_finish(r)); } catch (e) { rej(e); }
            }));
            // a snapshot needs a Baichuan login, so this host is a Reolink whatever its MAC vendor
            if (!this._known[mac].reolink) {
                this._known[mac].reolink = true;
                this._saveKnown();
                this._indicator?.render(this._cams(this._lastOnline ?? undefined));
            }
            if ((!manual && !this._snapLoop) || !this._indicator) return;
            // hand St a fresh path every frame (copy), and drop the previous one
            const frame = tmp.replace(/\.jpg$/, `-${Date.now()}.jpg`);
            Gio.File.new_for_path(tmp).move(Gio.File.new_for_path(frame), Gio.FileCopyFlags.OVERWRITE, null, null);
            const prev = this._frames?.get(mac);
            this._frames ??= new Map();
            this._frames.set(mac, frame);
            this._indicator.setSnapshot(mac, frame);
            if (prev) try { Gio.File.new_for_path(prev).delete(null); } catch (_e) { /* gone */ }
        } catch (_e) { /* camera busy or asleep; keep last frame */ }
    }

    _saveKnown() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(CACHE_PATH), 0o755);
            GLib.file_set_contents(CACHE_PATH, JSON.stringify(this._known));
        } catch (_e) { /* cache is optional */ }
    }

    async _detectSubnet() {
        if (this._cfg.subnet) return this._cfg.subnet;
        const proc = new Gio.Subprocess({
            argv: ['ip', '-4', '-o', 'route', 'get', '1.1.1.1'],
            flags: Gio.SubprocessFlags.STDOUT_PIPE,
        });
        proc.init(null);
        const [, out] = await new Promise((res, rej) => proc.communicate_utf8_async(null, this._cancel, (p, r) => {
            try { res(p.communicate_utf8_finish(r)); } catch (e) { rej(e); }
        }));
        const m = out?.match(/src (\d+\.\d+\.\d+)\.\d+/);
        if (!m) throw new Error('could not detect local subnet');
        return m[1];
    }

    _probe(ip) {
        return new Promise(resolve => {
            const client = new Gio.SocketClient({timeout: this._cfg.connectTimeoutSeconds});
            client.connect_async(new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_from_string(ip), port: this._cfg.port,
            }), this._cancel, (c, res) => {
                try { c.connect_finish(res).close(null); resolve(true); } catch (_e) { resolve(false); }
            });
        });
    }

    _arpTable() {
        const table = {};
        try {
            const [, bytes] = GLib.file_get_contents('/proc/net/arp');
            for (const line of new TextDecoder().decode(bytes).split('\n').slice(1)) {
                const f = line.trim().split(/\s+/);
                if (f.length >= 4 && f[3] !== '00:00:00:00:00:00') table[f[0]] = f[3].toLowerCase();
            }
        } catch (_e) { /* no arp table */ }
        return table;
    }

    async _scan() {
        if (this._scanning) return;
        this._scanning = true;
        const cancel = this._cancel;
        try {
            this._indicator.setStatus('Scanning…');
            const subnet = await this._detectSubnet();
            const ips = Array.from({length: 254}, (_v, i) => `${subnet}.${i + 1}`);
            const open = [];
            let next = 0;
            const worker = async () => {
                while (next < ips.length && !cancel.is_cancelled()) {
                    const ip = ips[next++];
                    if (await this._probe(ip)) open.push(ip);
                }
            };
            await Promise.all(Array.from({length: this._cfg.concurrency}, worker));
            if (cancel.is_cancelled()) return;

            const arp = this._arpTable();
            const online = new Set();
            for (const ip of open) {
                const mac = arp[ip];
                if (!mac) continue;
                online.add(mac);
                this._known[mac] = {
                    ip, reolink: REOLINK_OUI.some(p => mac.startsWith(p)) || this._known[mac]?.reolink === true,
                    lastSeen: Date.now(),
                };
            }
            this._saveKnown();

            this._lastOnline = online;
            this._indicator.render(this._cams(online));
            this._indicator.setStatus(`Scanned ${subnet}.0/24 · ${new Date().toLocaleTimeString()}`);
        } catch (e) {
            if (!cancel.is_cancelled()) this._indicator?.setStatus(`Scan failed: ${e.message}`);
        } finally {
            this._scanning = false;
        }
    }
}
