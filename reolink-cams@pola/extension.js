import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'reolink-cams']);
const CONFIG_PATH = GLib.build_filenamev([CONFIG_DIR, 'config.json']);
const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'reolink-cams']);
const PYTHON = GLib.build_filenamev([DATA_DIR, 'venv', 'bin', 'python']);   // venv with reolink_aio
const SNAP_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'reolink-cams']);
const RTSP_PORT = 554;
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
    rtsp: {},                // {"<uid or mac>": "rtsp://127.0.0.1:8554/fountain"} stream base (…/main, …/sub), e.g. Neolink
};
// MAC prefixes registered to Reolink; other hosts with the port open are shown as "unknown".
const REOLINK_OUI = ['ec:71:db'];

// thumbnail size (16:9) per number of grid columns
const THUMB = {1: [320, 180], 2: [288, 162], 3: [256, 144]};

// St.BoxLayout swapped `vertical` for `orientation` in GNOME 48
const vbox = params => {
    const box = new St.BoxLayout(params);
    if ('orientation' in box) box.orientation = Clutter.Orientation.VERTICAL;
    else box.vertical = true;
    return box;
};

const setPointer = on =>
    global.display.set_cursor(on ? Meta.Cursor.POINTING_HAND : Meta.Cursor.DEFAULT);

const pulse = dot => {
    if (!dot || dot.get_transition('opacity')) return;
    dot.set_pivot_point(0.5, 0.5);
    dot.ease({opacity: 70, scale_x: 1.3, scale_y: 1.3, duration: 600, repeatCount: -1, autoReverse: true,
        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE});
};

const stopPulse = dot => {
    if (!dot) return;
    dot.remove_all_transitions();
    dot.set({opacity: 255, scale_x: 1, scale_y: 1});
};

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
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box reolink-chip'});
        this._icon = new St.Icon({icon_name: 'camera-web-symbolic', style_class: 'system-status-icon'});
        box.add_child(this._icon);
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
        this._pics = new Map();   // mac -> {widget, w, h}
        this._dots = new Map();   // mac -> online dot (pulses while live)
        this._playBtns = new Map();   // mac -> play/stop button
    }

    onOpen(cb) { this.menu.connect('open-state-changed', (_m, open) => cb(open)); }

    setSnapshot(mac, path) {
        // unique file name per frame, so St does not serve a stale cached texture
        const p = this._pics.get(mac);
        p?.widget.set_style(
            `background-image: url("file://${path}"); background-size: cover; width: ${p.w}px; height: ${p.h}px; border-radius: 6px;`);
    }

    onRescan(cb) { this._rescan.connect('activate', cb); }
    onRefresh(cb) { this._refreshCb = cb; }
    onLive(cb) { this._liveCb = cb; }
    onPlay(cb) { this._playCb = cb; }

    // Swap the play button of the camera playing in its tile to a stop button.
    setPlaying(mac) {
        this._playingMac = mac;
        for (const [m, btn] of this._playBtns)
            btn.child.icon_name = m === mac ? 'media-playback-stop-symbolic' : 'media-playback-start-symbolic';
    }

    // Temporary top-bar text (e.g. while a live view starts); null restores the camera count.
    setNotice(text) {
        this._notice = text;
        this._label.set_text(text ?? this._count ?? '…');
        if (text) pulse(this._icon);
        else stopPulse(this._icon);
    }

    // Pulse the camera's green dot while its thumbnail plays live video.
    setLive(mac) {
        if (this._liveMac && this._liveMac !== mac) stopPulse(this._dots.get(this._liveMac));
        this._liveMac = mac;
        if (mac) pulse(this._dots.get(mac));
    }

    _openLive(c) {
        setPointer(false);
        this.menu.close();
        this._liveCb?.(c.mac, c.name);
    }

    _iconButton(icon, onClick) {
        const btn = new St.Button({
            child: new St.Icon({icon_name: icon, icon_size: 14}),
            style_class: 'button', reactive: true, can_focus: true, track_hover: true,
            y_align: Clutter.ActorAlign.CENTER, style: 'margin-left: 6px; padding: 2px 6px;',
        });
        btn.connect('clicked', onClick);
        return btn;
    }
    setStatus(text) { this._status.label.set_text(text); }

    render(cams) {
        this._list.removeAll();
        this._pics.clear();
        this._dots.clear();
        this._playBtns.clear();
        const live = cams.filter(c => c.online);
        this._count = cams.length ? `${live.length}/${cams.length}` : '0';
        if (!this._notice) this._label.set_text(this._count);
        if (!cams.length) {
            this._list.addMenuItem(new PopupMenu.PopupMenuItem('No cameras found', {reactive: false}));
            return;
        }
        // Up to three cameras stack; four go 2×2, five or more 3 across.
        const cols = live.length <= 3 ? 1 : live.length === 4 ? 2 : 3;
        const [w, h] = THUMB[cols];
        if (live.length) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
            const grid = vbox({style: 'spacing: 12px;'});
            for (let i = 0; i < live.length; i += cols) {
                const row = new St.BoxLayout({style: 'spacing: 12px;'});
                for (const c of live.slice(i, i + cols)) {
                    const tile = vbox({style: `spacing: 4px; width: ${w}px;`});
                    tile.add_child(this._header(c));
                    const pic = new St.Widget({
                        style: `width: ${w}px; height: ${h}px; background-color: #222; border-radius: 6px;`,
                        reactive: true, track_hover: true,
                    });
                    // clicking the picture plays/stops it in place; fullscreen has its own button
                    pic.connect('button-release-event', () => {
                        this._playCb?.(c.mac);
                        return Clutter.EVENT_STOP;
                    });
                    pic.connect('notify::hover', () => setPointer(pic.hover));
                    pic.connect('destroy', () => { if (pic.hover) setPointer(false); });
                    tile.add_child(pic);
                    this._pics.set(c.mac, {widget: pic, w, h});
                    row.add_child(tile);
                }
                grid.add_child(row);
            }
            item.add_child(grid);
            this._list.addMenuItem(item);
        }
        for (const c of cams.filter(c => !c.online)) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
            item.add_child(this._header(c));
            this._list.addMenuItem(item);
        }
    }

    _header(c) {
        const box = new St.BoxLayout({x_expand: true});
        const dot = new St.Label({
            text: '●', y_align: Clutter.ActorAlign.CENTER, style: 'margin-right: 6px;',
            style_class: c.online ? 'reolink-online' : 'reolink-offline',
        });
        box.add_child(dot);
        if (c.online) {
            this._dots.set(c.mac, dot);
            if (c.mac === this._liveMac) pulse(dot);
        }
        box.add_child(new St.Label({text: c.name, style_class: 'reolink-key', y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Label({
            text: `${c.ip ?? '?'}${c.reolink ? '' : ' (unverified)'}`,
            style_class: 'reolink-sub', x_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER,
        }));
        if (c.online) {
            const refresh = this._iconButton('view-refresh-symbolic', () => {
                // spin until the new snapshot is in (at least a moment, so a fast one still registers)
                const icon = refresh.child;
                let alive = true;
                icon.connect('destroy', () => { alive = false; });
                refresh.reactive = false;
                icon.set_pivot_point(0.5, 0.5);
                icon.rotation_angle_z = 0;
                icon.ease({rotation_angle_z: 360, duration: 800, repeatCount: -1, mode: Clutter.AnimationMode.LINEAR});
                const minSpin = new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => { r(); return GLib.SOURCE_REMOVE; }));
                Promise.all([Promise.resolve(this._refreshCb?.(c.mac)), minSpin]).finally(() => {
                    if (!alive) return;
                    icon.remove_all_transitions();
                    icon.rotation_angle_z = 0;
                    refresh.reactive = true;
                });
            });
            box.add_child(refresh);
            const play = this._iconButton(
                c.mac === this._playingMac ? 'media-playback-stop-symbolic' : 'media-playback-start-symbolic',
                () => this._playCb?.(c.mac));
            this._playBtns.set(c.mac, play);
            box.add_child(play);
            box.add_child(this._iconButton('view-fullscreen-symbolic', () => this._openLive(c)));
        }
        return box;
    }
});

export default class ReolinkExtension extends Extension {
    enable() {
        this._cancel = new Gio.Cancellable();
        this._cfg = {...DEFAULTS, ...(readJson(CONFIG_PATH) ?? {})};
        this._known = readJson(CACHE_PATH) ?? {};   // mac -> {ip, reolink, lastSeen, uid?, devName?}
        this._indicator = new Indicator();
        this._indicator.onRescan(() => this._scan());
        this._indicator.onRefresh(mac => this._snapshot(mac, true));
        this._indicator.onLive((mac, name) => this._live(mac, name));
        this._indicator.onPlay(mac => this._togglePlay(mac));
        this._indicator.onOpen(open => {
            if (open) this._startSnapshots();
            else { this._stopSnapshots(); this._stopPlay(); global.display.set_cursor(Meta.Cursor.DEFAULT); }
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.render(this._cams());
        this._scan();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._cfg.refreshSeconds, () => {
            this._scan();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        this._preparing(null);
        this._stopSnapshots();
        this._stopPlay();
        this._cancel?.cancel();
        this._cancel = null;
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = null;
        this._indicator?.destroy();
        this._indicator = null;
        for (const proc of this._viewers?.values() ?? []) proc.force_exit();
        this._viewers = null;
        this._known = null;
        this._lastOnline = null;
        this._frames = null;
        this._snapBusy = null;
    }

    _cams(onlineMacs = new Set()) {
        return Object.entries(this._known).map(([mac, k]) => ({
            mac, ip: k.ip, reolink: k.reolink,
            name: this._cfg.names[mac] ?? this._cfg.names[k.uid] ?? k.devName
                ?? (k.reolink ? `Reolink ${mac.slice(-5)}` : `Camera ${mac.slice(-5)}`),
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
                // each camera on its own pace: a slow one (stream grab ~7 s) must not hold up the rest
                this._snapBusy ??= new Set();
                for (const mac of online) {
                    if (mac === this._playMac || this._snapBusy.has(mac)) continue;
                    this._snapBusy.add(mac);
                    this._snapshot(mac).finally(() => this._snapBusy?.delete(mac));
                }
                await new Promise(r => GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._cfg.snapshotSeconds, () => { r(); return GLib.SOURCE_REMOVE; }));
            }
        })().catch(e => console.error(`reolink-cams: ${e.message}`));
    }

    _stopSnapshots() { this._snapLoop = false; }

    async _snapshot(mac, manual = false) {
        const ip = this._known?.[mac]?.ip;
        if (!ip) return;
        const tmp = GLib.build_filenamev([SNAP_DIR, `${mac.replaceAll(':', '')}.jpg`]);
        const base = this._rtspBase(mac);
        try {
            const proc = new Gio.Subprocess({
                // cameras that refuse Baichuan snapshots (some E1) get a frame from their stream instead
                argv: base
                    ? ['ffmpeg', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', `${base}/sub`, '-frames:v', '1', '-update', '1', '-y', tmp]
                    : [PYTHON, GLib.build_filenamev([this.path, 'snapshot.py']), ip, tmp, this._cfg.snapshotStream],
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
            if (this._playMac === mac && this._playLive) return;   // live video owns this tile
            this._showFrame(mac, tmp);
        } catch (_e) { /* camera busy or asleep; keep last frame */ }
    }

    // Fullscreen ffplay window; one per camera, closed with Esc or q.
    _live(mac, name) {
        const ip = this._known?.[mac]?.ip;
        if (!ip) return;
        this._preparing(name);
        this._viewers ??= new Map();
        this._viewers.get(mac)?.send_signal(15);   // a stuck or hidden window: start over
        try {
            const proc = new Gio.Subprocess({
                argv: [PYTHON, GLib.build_filenamev([this.path, 'live.py']), ip, name, ...[this._rtspBase(mac)].filter(Boolean)],
                flags: Gio.SubprocessFlags.STDERR_SILENCE,
            });
            proc.init(null);
            this._viewers.set(mac, proc);
            proc.wait_async(null, () => {
                if (this._viewers?.get(mac) !== proc) return;   // replaced by a newer click
                this._viewers.delete(mac);
                // exited before any window appeared: the stream could not be opened
                if (this._prep?.name === name) this._preparing(null, `No stream from ${name}`);
            });
        } catch (e) {
            console.error(`reolink-cams: live view: ${e.message}`);
        }
    }

    // The play button streams a camera live in its tile: RTSP sub stream decoded to JPEG frames
    // ~5 fps, or back-to-back snapshots for models without RTSP. One camera at a time.
    _togglePlay(mac) {
        if (this._playMac === mac) this._stopPlay();
        else this._startPlay(mac).catch(e => console.error(`reolink-cams: play: ${e.message}`));
    }

    async _startPlay(mac) {
        if (this._playMac === mac) return;
        this._stopPlay();
        const ip = this._known?.[mac]?.ip;
        if (!ip) return;
        this._playMac = mac;
        this._indicator?.setPlaying(mac);
        const token = this._playToken = {};
        const base = this._rtspBase(mac);
        if ((base || await this._probe(ip, RTSP_PORT)) && this._playToken === token) {
            const {user, password} = this._cfg;
            const url = base ? `${base}/sub`
                : `rtsp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${ip}:${RTSP_PORT}/h264Preview_01_sub`;
            const out = GLib.build_filenamev([SNAP_DIR, `${mac.replaceAll(':', '')}-play.jpg`]);
            try { Gio.File.new_for_path(out).delete(null); } catch (_e) { /* no old frame */ }
            this._playProc = new Gio.Subprocess({
                argv: ['ffmpeg', '-loglevel', 'error', '-rtsp_transport', 'tcp',
                    '-i', url,
                    '-an', '-vf', 'fps=5', '-q:v', '5', '-update', '1', '-atomic_writing', '1', '-y', out],
                flags: Gio.SubprocessFlags.STDERR_SILENCE,
            });
            this._playProc.init(null);
            let last = 0;
            const snapshotsUntilVideo = async () => {
                // the stream needs ~8 s for its first keyframe; keep snapshots coming meanwhile
                while (this._playToken === token && !last) {
                    await this._snapshot(mac, true);
                    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => { r(); return GLib.SOURCE_REMOVE; }));
                }
            };
            this._playTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                let t = 0;
                try {
                    t = Gio.File.new_for_path(out).query_info('time::modified,time::modified-usec', Gio.FileQueryInfoFlags.NONE, null)
                        .get_modification_date_time().to_unix_usec();
                } catch (_e) { return GLib.SOURCE_CONTINUE; }   // no frame yet
                if (t !== last) {
                    last = t;
                    if (!this._playLive) this._indicator?.setLive(mac);
                    this._playLive = true;
                    this._showFrame(mac, out, Gio.FileCopyFlags.OVERWRITE);
                }
                return GLib.SOURCE_CONTINUE;
            });
            await snapshotsUntilVideo();
        } else {
            while (this._playToken === token) {
                await this._snapshot(mac, true);
                await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => { r(); return GLib.SOURCE_REMOVE; }));
            }
        }
    }

    _stopPlay() {
        if (this._playTimer) GLib.source_remove(this._playTimer);
        this._playProc?.force_exit();
        this._playTimer = this._playProc = this._playMac = this._playToken = null;
        this._indicator?.setPlaying(null);
        this._playLive = false;
        this._indicator?.setLive(null);
    }

    // hand St a fresh path every frame (copy), and drop the previous one
    _showFrame(mac, src, flags = Gio.FileCopyFlags.NONE) {
        if (!this._indicator) return;
        const frame = GLib.build_filenamev([SNAP_DIR, `${mac.replaceAll(':', '')}-${Date.now()}.jpg`]);
        try {
            Gio.File.new_for_path(src).copy(Gio.File.new_for_path(frame), flags, null, null);
        } catch (_e) { return; }   // not written yet
        const prev = this._frames?.get(mac);
        this._frames ??= new Map();
        this._frames.set(mac, frame);
        this._indicator.setSnapshot(mac, frame);
        if (prev) try { Gio.File.new_for_path(prev).delete(null); } catch (_e) { /* gone */ }
    }

    // "Opening <camera>…" in the top bar until ffplay's window shows up (8–10 s for RTSP).
    _preparing(name, failure = null) {
        if (this._prep) {
            global.display.disconnect(this._prep.sig);
            if (this._prep.timer) GLib.source_remove(this._prep.timer);
            this._prep = null;
        }
        if (this._noticeTimer) GLib.source_remove(this._noticeTimer);
        this._noticeTimer = null;
        if (!name) {
            this._indicator?.setNotice(failure);
            if (failure) {
                this._noticeTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
                    this._noticeTimer = null;
                    this._indicator?.setNotice(null);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }
        this._indicator?.setNotice(`Opening ${name}…`);
        const sig = global.display.connect('window-created', (_d, win) => {
            if ((win.get_wm_class() ?? '').toLowerCase() === 'ffplay' || win.get_title()?.startsWith(name))
                this._preparing(null);
        });
        const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._prep.timer = 0;
            this._preparing(null);
            return GLib.SOURCE_REMOVE;
        });
        this._prep = {name, sig, timer};
    }

    _rtspBase(mac) {
        const k = this._known?.[mac];
        return this._cfg.rtsp[k?.uid] ?? this._cfg.rtsp[mac] ?? null;
    }

    async _identify(mac) {
        try {
            const proc = new Gio.Subprocess({
                argv: [PYTHON, GLib.build_filenamev([this.path, 'info.py']), this._known[mac].ip],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            proc.init(null);
            const [, out] = await new Promise((res, rej) => proc.communicate_utf8_async(null, this._cancel, (p, r) => {
                try { res(p.communicate_utf8_finish(r)); } catch (e) { rej(e); }
            }));
            const info = JSON.parse(out);
            if (!info.uid || info.uid === 'Unknown' || !this._known?.[mac]) return;
            Object.assign(this._known[mac], {uid: info.uid, devName: info.name || undefined, reolink: true});
        } catch (_e) { /* asleep or not a Reolink; try again next scan */ }
    }

    // A camera moved between LAN and Wi-Fi shows up under a second MAC; keep only the live one.
    _dedupe(online) {
        const liveUids = new Set([...online].map(mac => this._known[mac].uid).filter(Boolean));
        for (const [mac, k] of Object.entries(this._known)) {
            if (online.has(mac)) continue;
            // offline entries without a uid predate identification and cannot be matched
            if (!k.uid || liveUids.has(k.uid)) delete this._known[mac];
        }
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

    _probe(ip, port = this._cfg.port) {
        return new Promise(resolve => {
            const client = new Gio.SocketClient({timeout: this._cfg.connectTimeoutSeconds});
            client.connect_async(new Gio.InetSocketAddress({
                address: Gio.InetAddress.new_from_string(ip), port,
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
                    ...this._known[mac],
                    ip, reolink: REOLINK_OUI.some(p => mac.startsWith(p)) || this._known[mac]?.reolink === true,
                    lastSeen: Date.now(),
                };
            }
            await Promise.all([...online].filter(mac => !this._known[mac].uid).map(mac => this._identify(mac)));
            if (cancel.is_cancelled()) return;
            this._dedupe(online);
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
