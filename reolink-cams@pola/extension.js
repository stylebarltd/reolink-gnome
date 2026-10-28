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
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'reolink-cams']);
const CONFIG_PATH = GLib.build_filenamev([CONFIG_DIR, 'config.json']);
const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'reolink-cams']);
const PYTHON = GLib.build_filenamev([DATA_DIR, 'venv', 'bin', 'python']);   // venv with reolink_aio
const SNAP_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'reolink-cams']);
const RTSP_PORT = 554;
const CACHE_PATH = GLib.build_filenamev([GLib.get_user_cache_dir(), 'reolink-cams.json']);
const PINS_PATH = GLib.build_filenamev([CONFIG_DIR, 'pinned.json']);   // {cams: [uid or mac], x, y}
const PIN_SIZE = [384, 216];
const PIN_FPS = 2;
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
    alertTypes: ['people', 'vehicle'],   // AI detections that alert; add 'dog_cat', or 'motion' for any motion
    alertCameras: [],        // names, uids or MACs that alert; empty = all
    alertCooldownSeconds: 120,   // at most one notification per camera in this time
    alertQuietHours: '',     // e.g. "23:00-06:00": no notifications (the menu still shows motion)
};
// MAC prefixes registered to Reolink; other hosts with the port open are shown as "unknown".
const REOLINK_OUI = ['ec:71:db'];

// thumbnail size (16:9) per number of grid columns
const THUMB = {1: [320, 180], 2: [288, 162], 3: [256, 144]};

// how long the last detection stays listed under a camera
const MOTION_SHOWN_MS = 30 * 60 * 1000;
const TYPE_NAMES = {people: 'Person', vehicle: 'Vehicle', dog_cat: 'Animal', face: 'Face', package: 'Package', motion: 'Motion'};
const typeText = types => types.map(t => TYPE_NAMES[t] ?? t).join(', ');
const clock = ms => GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).format('%H:%M');

// "23:00-06:00" (may wrap midnight) contains the current local time
const inQuietHours = range => {
    const m = range?.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) return false;
    const now = new Date(), cur = now.getHours() * 60 + now.getMinutes();
    const from = +m[1] * 60 + +m[2], to = +m[3] * 60 + +m[4];
    return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
};

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
        this.add_style_class_name('reolink-button');
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box reolink-chip'});
        this._icon = new St.Icon({icon_name: 'camera-web-symbolic', style_class: 'system-status-icon'});
        box.add_child(this._icon);
        // only speaks up when there is something to say: a notice, or a camera that is down
        this._label = new St.Label({text: '', y_align: Clutter.ActorAlign.CENTER, visible: false});
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
        this._subs = new Map();   // mac -> IP label, which shows the last detection instead
        this._motion = new Map();   // mac -> {active, types, time}
        this._pinBtns = new Map();   // mac -> pin button
        this._pinned = new Set();
    }

    onPin(cb) { this._pinCb = cb; }

    setPinned(macs) {
        this._pinned = macs;
        for (const [mac, btn] of this._pinBtns) {
            if (macs.has(mac)) btn.add_style_class_name('reolink-pinned');
            else btn.remove_style_class_name('reolink-pinned');
        }
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
        this._updateLabel();
        this._updateIcon();
    }

    // Top-bar text next to the icon: a notice while one is set, else the online count only
    // while a camera is down or none were found. All cameras up shows the icon alone.
    _updateLabel() {
        const text = this._notice ?? (this._down ? this._count : null);
        this._label.set_text(text ?? '');
        this._label.visible = text != null;
    }

    // Motion state of a camera: red pulsing dot while active, last detection under its name.
    setMotion(mac, m) {
        this._motion.set(mac, m);
        this._showMotion(mac);
        this._updateIcon();
    }

    _showMotion(mac) {
        const m = this._motion.get(mac);
        const dot = this._dots.get(mac);
        if (dot) {
            dot.style_class = m?.active ? 'reolink-motion' : 'reolink-online';
            if (m?.active || mac === this._liveMac) pulse(dot);
            else stopPulse(dot);
        }
        const sub = this._subs.get(mac);
        if (sub) {
            const recent = m && Date.now() - m.time < MOTION_SHOWN_MS;
            sub.text = recent ? `${typeText(m.types)} · ${clock(m.time)}` : sub._ipText;
            sub.style_class = recent ? 'reolink-alert-text' : 'reolink-sub';
        }
    }

    _updateIcon() {
        const alert = [...this._motion.values()].some(m => m.active);
        if (alert) this._icon.add_style_class_name('reolink-motion');
        else this._icon.remove_style_class_name('reolink-motion');
        if (alert || this._notice) pulse(this._icon);
        else stopPulse(this._icon);
    }

    // Pulse the camera's green dot while its thumbnail plays live video.
    setLive(mac) {
        const prev = this._liveMac;
        this._liveMac = mac;
        if (prev && prev !== mac) this._showMotion(prev);
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
        this._subs.clear();
        this._pinBtns.clear();
        const live = cams.filter(c => c.online);
        this._count = cams.length ? `${live.length}/${cams.length}` : '0';
        this._down = !cams.length || live.length < cams.length;
        this._updateLabel();
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
        }
        box.add_child(new St.Label({text: c.name, style_class: 'reolink-key', y_align: Clutter.ActorAlign.CENTER}));
        const sub = new St.Label({
            text: `${c.ip ?? '?'}${c.reolink ? '' : ' (unverified)'}`,
            style_class: 'reolink-sub', x_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER,
        });
        sub._ipText = sub.text;
        box.add_child(sub);
        if (c.online) {
            this._subs.set(c.mac, sub);
            this._showMotion(c.mac);
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
            const pin = this._iconButton('view-pin-symbolic', () => this._pinCb?.(c.mac));
            if (this._pinned.has(c.mac)) pin.add_style_class_name('reolink-pinned');
            this._pinBtns.set(c.mac, pin);
            box.add_child(pin);
        }
        return box;
    }
});

// Pinned cameras float on the desktop below the top bar, live, until unpinned. Drag a
// camera's title bar to move the board; it hides itself while a window is fullscreen.
class PinBoard {
    constructor({pos, onUnpin, onFullscreen, onMoved}) {
        this._pos = pos;   // {x, y} once dragged, else top right
        this._cb = {onUnpin, onFullscreen, onMoved};
        this._views = new Map();   // mac -> {view, dot, name, pic}
        this.actor = vbox({style_class: 'reolink-pinboard', reactive: true});
        Main.layoutManager.addChrome(this.actor, {affectsInputRegion: true, trackFullscreen: true});
        this.actor.connect('notify::width', () => this._place());
        Main.layoutManager.connectObject('monitors-changed', () => this._place(), this);
    }

    has(mac) { return this._views.has(mac); }
    get size() { return this._views.size; }

    add(mac, name) {
        const [w, h] = PIN_SIZE;
        const view = vbox({style_class: 'reolink-pin'});
        const head = new St.BoxLayout({style_class: 'reolink-pin-head', reactive: true, track_hover: true});
        const dot = new St.Label({text: '●', style_class: 'reolink-online', y_align: Clutter.ActorAlign.CENTER, style: 'margin-right: 6px;'});
        const label = new St.Label({text: name, style_class: 'reolink-key', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        head.add_child(dot);
        head.add_child(label);
        const button = (icon, tip, cb) => {
            const b = new St.Button({
                child: new St.Icon({icon_name: icon, icon_size: 14}), style_class: 'reolink-pin-btn',
                accessible_name: tip, can_focus: true, track_hover: true, y_align: Clutter.ActorAlign.CENTER,
            });
            b.connect('clicked', cb);
            return b;
        };
        head.add_child(button('view-fullscreen-symbolic', 'Fullscreen', () => this._cb.onFullscreen(mac)));
        head.add_child(button('window-close-symbolic', 'Unpin', () => this._cb.onUnpin(mac)));
        this._dragHandle(head);
        const pic = new St.Widget({
            style: `width: ${w}px; height: ${h}px; background-color: #222; border-radius: 6px;`,
            reactive: true, track_hover: true,
        });
        pic.connect('button-release-event', () => { this._cb.onFullscreen(mac); return Clutter.EVENT_STOP; });
        pic.connect('notify::hover', () => setPointer(pic.hover));
        view.add_child(head);
        view.add_child(pic);
        this.actor.add_child(view);
        this._views.set(mac, {view, dot, label, pic});
    }

    remove(mac) {
        const v = this._views.get(mac);
        if (!v) return;
        if (v.pic.hover) setPointer(false);
        v.view.destroy();
        this._views.delete(mac);
    }

    setName(mac, name) { this._views.get(mac)?.label.set_text(name); }

    setFrame(mac, path) {
        const [w, h] = PIN_SIZE;
        this._views.get(mac)?.pic.set_style(
            `background-image: url("file://${path}"); background-size: cover; width: ${w}px; height: ${h}px; border-radius: 6px;`);
    }

    setMotion(mac, active) {
        const dot = this._views.get(mac)?.dot;
        if (!dot) return;
        dot.style_class = active ? 'reolink-motion' : 'reolink-online';
        if (active) pulse(dot);
        else stopPulse(dot);
    }

    _monitor() { return Main.layoutManager.primaryMonitor; }

    _place() {
        const m = this._monitor();
        if (!m) return;
        const [w, h] = [this.actor.width, this.actor.height];
        let {x, y} = this._pos ?? {x: m.x + m.width - w - 12, y: m.y + Main.panel.height + 8};
        // keep it on screen when monitors or the board size change
        x = Math.max(m.x, Math.min(x, m.x + m.width - w));
        y = Math.max(m.y + Main.panel.height, Math.min(y, m.y + m.height - h));
        this.actor.set_position(Math.round(x), Math.round(y));
    }

    _dragHandle(head) {
        head.connect('button-press-event', (_a, ev) => {
            if (ev.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            const [px, py] = ev.get_coords();
            const [ax, ay] = [this.actor.x, this.actor.y];
            const grab = global.stage.grab(head);
            global.display.set_cursor(Meta.Cursor.MOVE_OR_RESIZE_WINDOW ?? Meta.Cursor.MOVE);   // renamed in GNOME 47
            const motion = head.connect('motion-event', (_b, e) => {
                const [x, y] = e.get_coords();
                this._pos = {x: ax + x - px, y: ay + y - py};
                this._place();
                return Clutter.EVENT_STOP;
            });
            const release = head.connect('button-release-event', () => {
                head.disconnect(motion);
                head.disconnect(release);
                grab.dismiss();
                global.display.set_cursor(Meta.Cursor.DEFAULT);
                this._cb.onMoved({x: this.actor.x, y: this.actor.y});
                return Clutter.EVENT_STOP;
            });
            return Clutter.EVENT_STOP;
        });
    }

    destroy() {
        Main.layoutManager.disconnectObject(this);
        this.actor.destroy();
        this._views.clear();
    }
}

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
        this._indicator.onPin(mac => this._togglePin(mac));
        this._killStrays();
        this._pins = {cams: [], ...(readJson(PINS_PATH) ?? {})};
        this._pinStreams = new Map();
        this._indicator.onOpen(open => {
            if (open) this._startSnapshots();
            else { this._stopSnapshots(); this._stopPlay(); global.display.set_cursor(Meta.Cursor.DEFAULT); }
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator, -1, 'left'); // left side of the top bar, after Activities
        this._indicator.render(this._cams());
        this._syncPins();
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
        this._stopEvents();
        for (const mac of [...(this._pinStreams?.keys() ?? [])]) this._stopPin(mac);
        this._pinStreams = null;
        if (this._pinRetry) GLib.source_remove(this._pinRetry);
        this._pinRetry = null;
        this._pinFrames = null;
        this._board?.destroy();
        this._board = null;
        this._source?.destroy();
        this._source = null;
        this._alerted = null;
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
        this._motionState = null;
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
                    // pinned cameras already stream; their frames reach the menu too
                    if (mac === this._playMac || this._pinStreams?.has(mac) || this._snapBusy.has(mac)) continue;
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
            // live video owns its tile
            if ((manual || this._snapLoop) && this._indicator && !(this._playMac === mac && this._playLive))
                this._showFrame(mac, tmp);
            return tmp;
        } catch (_e) { /* camera busy or asleep; keep last frame */ }
        return null;
    }

    // One events.py for all online Reolinks; restarted when that set of IPs changes.
    _watchEvents(online) {
        const ips = [...online].filter(mac => this._known[mac]?.reolink).map(mac => this._known[mac].ip).sort();
        const key = ips.join(' ');
        if (this._eventsProc && key === this._eventsKey) return;
        this._stopEvents();
        if (!ips.length) return;
        try {
            const proc = new Gio.Subprocess({
                argv: [PYTHON, GLib.build_filenamev([this.path, 'events.py']), ...ips],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            proc.init(null);
            const cancel = new Gio.Cancellable();
            const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe(), close_base_stream: true});
            const read = () => stream.read_line_async(GLib.PRIORITY_DEFAULT, cancel, (st, res) => {
                let line;
                try { [line] = st.read_line_finish_utf8(res); } catch (_e) { return; }
                if (line === null) {   // helper died; the next scan starts a new one
                    if (this._eventsProc === proc) this._eventsProc = null;
                    return;
                }
                try { this._onEvent(JSON.parse(line)); } catch (e) { console.error(`reolink-cams: event: ${e.message}`); }
                read();
            });
            read();
            this._eventsProc = proc;
            this._eventsCancel = cancel;
            this._eventsKey = key;
        } catch (e) {
            console.error(`reolink-cams: events: ${e.message}`);
        }
    }

    _stopEvents() {
        this._eventsCancel?.cancel();
        this._eventsProc?.force_exit();
        this._eventsProc = this._eventsCancel = this._eventsKey = null;
        // without a listener no "motion over" arrives; don't leave dots red
        for (const [mac, m] of this._motionState ?? []) {
            if (!m.active) continue;
            m.active = false;
            this._indicator?.setMotion(mac, m);
        }
    }

    _onEvent(ev) {
        if (!('motion' in ev) || !this._indicator) return;
        const mac = Object.keys(this._known).find(m => this._known[m].ip === ev.ip && this._lastOnline?.has(m));
        if (!mac) return;
        const wanted = this._cfg.alertTypes;
        const types = ev.types.filter(t => wanted.includes(t));
        if (ev.motion && !types.length && wanted.includes('motion')) types.push('motion');
        const prev = this._motionState?.get(mac);
        this._motionState ??= new Map();
        if (!ev.motion || !types.length) {
            // motion without a wanted detection: just end an alert that was running
            if (prev?.active) {
                const m = {...prev, active: false};
                this._motionState.set(mac, m);
                this._indicator.setMotion(mac, m);
                this._board?.setMotion(mac, false);
            }
            return;
        }
        const m = {active: true, types, time: Date.now()};
        this._motionState.set(mac, m);
        this._indicator.setMotion(mac, m);
        this._board?.setMotion(mac, true);
        this._alert(mac, types).catch(e => console.error(`reolink-cams: alert: ${e.message}`));
    }

    async _alert(mac, types) {
        const k = this._known[mac];
        const name = this._cams(this._lastOnline ?? undefined).find(c => c.mac === mac)?.name ?? k.ip;
        const listed = this._cfg.alertCameras;
        if (listed.length && !listed.some(x => [mac, k.uid, name.toLowerCase()].includes(String(x).toLowerCase())))
            return;
        if (inQuietHours(this._cfg.alertQuietHours)) return;
        this._alerted ??= new Map();
        const now = Date.now();
        if (now - (this._alerted.get(mac) ?? 0) < this._cfg.alertCooldownSeconds * 1000) return;
        this._alerted.set(mac, now);

        // a fresh picture of what triggered it, kept under its own name for the notification
        const snap = await Promise.race([
            this._snapshot(mac, true),
            new Promise(r => GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => { r(null); return GLib.SOURCE_REMOVE; })),
        ]);
        if (!this._indicator) return;
        let gicon = null;
        if (snap) {
            const pic = GLib.build_filenamev([SNAP_DIR, `${mac.replaceAll(':', '')}-alert.jpg`]);
            try {
                Gio.File.new_for_path(snap).copy(Gio.File.new_for_path(pic), Gio.FileCopyFlags.OVERWRITE, null, null);
                gicon = new Gio.FileIcon({file: Gio.File.new_for_path(pic)});
            } catch (_e) { /* no picture then */ }
        }
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Reolink Cameras', iconName: 'camera-web-symbolic'});
            this._source.connect('destroy', () => { this._source = null; });
            Main.messageTray.add(this._source);
        }
        const n = new MessageTray.Notification({
            source: this._source, title: `${typeText(types)} at ${name}`,
            body: `${clock(now)} · click to watch live`, gicon,
        });
        n.connect('activated', () => this._live(mac, name));
        this._source.addNotification(n);
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

    // pinned.json stores the camera's UID when known, so a pin survives a LAN/Wi-Fi switch
    _pinKey(mac) { return this._known?.[mac]?.uid ?? mac; }

    _pinnedMacs() {
        const online = this._lastOnline ?? new Set();
        const macs = new Set();
        for (const key of this._pins.cams) {
            const matches = Object.keys(this._known).filter(m => m === key || this._known[m].uid === key);
            const mac = matches.find(m => online.has(m)) ?? matches[0];
            if (mac) macs.add(mac);
        }
        return macs;
    }

    _savePins() {
        try {
            GLib.mkdir_with_parents(CONFIG_DIR, 0o755);
            GLib.file_set_contents(PINS_PATH, JSON.stringify(this._pins));
        } catch (e) { console.error(`reolink-cams: pins: ${e.message}`); }
    }

    _togglePin(mac) {
        const key = this._pinKey(mac);
        const pinned = this._pinnedMacs().has(mac);
        this._pins.cams = pinned
            ? this._pins.cams.filter(k => k !== key && k !== mac)
            : [...this._pins.cams, key];
        this._savePins();
        this._syncPins();
    }

    // Board views and streams follow the pin list; a pinned camera streams while it is online.
    _syncPins() {
        if (!this._indicator) return;
        const macs = this._pinnedMacs();
        this._indicator.setPinned(macs);
        const names = new Map(this._cams(this._lastOnline ?? undefined).map(c => [c.mac, c.name]));
        if (macs.size && !this._board) {
            this._board = new PinBoard({
                pos: Number.isFinite(this._pins.x) ? {x: this._pins.x, y: this._pins.y} : null,
                onUnpin: mac => this._togglePin(mac),
                onFullscreen: mac => this._live(mac, names.get(mac) ?? mac),
                onMoved: ({x, y}) => { Object.assign(this._pins, {x, y}); this._savePins(); },
            });
        }
        for (const mac of [...this._pinStreams.keys()]) {
            if (!macs.has(mac) || !this._lastOnline?.has(mac)) this._stopPin(mac);
        }
        if (this._board) {
            for (const mac of [...this._board._views.keys()]) if (!macs.has(mac)) this._board.remove(mac);
            for (const mac of macs) {
                if (!this._board.has(mac)) this._board.add(mac, names.get(mac) ?? mac);
                else this._board.setName(mac, names.get(mac) ?? mac);
                if (this._lastOnline?.has(mac) && !this._pinStreams.has(mac))
                    this._startPin(mac).catch(e => console.error(`reolink-cams: pin: ${e.message}`));
            }
            if (!this._board.size) {
                this._board.destroy();
                this._board = null;
            }
        }
    }

    // Low-rate live stream for a pinned camera (sub stream, PIN_FPS), restarted if it drops;
    // cameras without RTSP get a snapshot every snapshotSeconds instead.
    async _startPin(mac) {
        const st = {};
        this._pinStreams.set(mac, st);
        const ip = this._known?.[mac]?.ip;
        const base = this._rtspBase(mac);
        const rtsp = base || (ip && await this._probe(ip, RTSP_PORT));
        if (this._pinStreams?.get(mac) !== st) return;
        if (!rtsp) {
            while (this._pinStreams?.get(mac) === st) {
                const frame = await this._snapshot(mac, false);
                if (frame && this._pinStreams?.get(mac) === st) this._pinFrame(mac, frame);
                await new Promise(r => GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._cfg.snapshotSeconds, () => { r(); return GLib.SOURCE_REMOVE; }));
            }
            return;
        }
        const {user, password} = this._cfg;
        const url = base ? `${base}/sub`
            : `rtsp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${ip}:${RTSP_PORT}/h264Preview_01_sub`;
        const out = GLib.build_filenamev([SNAP_DIR, `${mac.replaceAll(':', '')}-pin.jpg`]);
        GLib.mkdir_with_parents(SNAP_DIR, 0o755);
        st.proc = new Gio.Subprocess({
            argv: ['ffmpeg', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url,
                '-an', '-vf', `fps=${PIN_FPS}`, '-q:v', '5', '-update', '1', '-atomic_writing', '1', '-y', out],
            flags: Gio.SubprocessFlags.STDERR_SILENCE,
        });
        st.proc.init(null);
        let last = 0;
        st.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            try {
                const t = Gio.File.new_for_path(out).query_info('time::modified,time::modified-usec', Gio.FileQueryInfoFlags.NONE, null)
                    .get_modification_date_time().to_unix_usec();
                if (t !== last) {
                    last = t;
                    this._pinFrame(mac, out);
                }
            } catch (_e) { /* no frame yet */ }
            return GLib.SOURCE_CONTINUE;
        });
        // until the first keyframe arrives (a few seconds), show a snapshot
        if (!this._pinFrames?.has(mac)) {
            this._snapshot(mac, false).then(f => {
                if (f && !last && this._pinStreams?.get(mac) === st) this._pinFrame(mac, f);
            });
        }
        st.proc.wait_async(null, () => {
            if (this._pinStreams?.get(mac) !== st) return;   // stopped on purpose
            // stream dropped (Wi-Fi, camera reboot): try again shortly
            this._stopPin(mac);
            this._pinRetry ??= GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                this._pinRetry = null;
                this._syncPins();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _stopPin(mac) {
        const st = this._pinStreams?.get(mac);
        if (!st) return;
        this._pinStreams.delete(mac);
        if (st.timer) GLib.source_remove(st.timer);
        st.proc?.force_exit();
    }

    _pinFrame(mac, src) {
        if (!this._board) return;
        const frame = GLib.build_filenamev([SNAP_DIR, `${mac.replaceAll(':', '')}-pin-${Date.now()}.jpg`]);
        try {
            Gio.File.new_for_path(src).copy(Gio.File.new_for_path(frame), Gio.FileCopyFlags.OVERWRITE, null, null);
        } catch (_e) { return; }
        this._pinFrames ??= new Map();
        const prev = this._pinFrames.get(mac);
        this._pinFrames.set(mac, frame);
        this._board.setFrame(mac, frame);
        if (prev) try { Gio.File.new_for_path(prev).delete(null); } catch (_e) { /* gone */ }
        // the open menu shows the same picture, unless that tile plays its own video
        if (this._snapLoop && !(this._playMac === mac && this._playLive)) this._showFrame(mac, src, Gio.FileCopyFlags.OVERWRITE);
    }

    // Alt+F2 r re-execs gnome-shell in place: its stream children never get a parent-death
    // signal and would keep a camera connection each. Stop those left from before.
    _killStrays() {
        try {
            const en = Gio.File.new_for_path('/proc').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                const pid = info.get_name();
                if (!/^\d+$/.test(pid)) continue;
                try {
                    const [, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
                    const argv = new TextDecoder().decode(bytes).split('\0');
                    if (GLib.path_get_basename(argv[0]) === 'ffmpeg' && argv.some(a => a.startsWith(SNAP_DIR)))
                        GLib.spawn_command_line_async(`kill ${pid}`);
                } catch (_e) { /* exited meanwhile */ }
            }
        } catch (e) { console.error(`reolink-cams: ${e.message}`); }
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
            this._watchEvents(online);
            this._syncPins();
            this._indicator.setStatus(`Scanned ${subnet}.0/24 · ${new Date().toLocaleTimeString()}`);
        } catch (e) {
            if (!cancel.is_cancelled()) this._indicator?.setStatus(`Scan failed: ${e.message}`);
        } finally {
            this._scanning = false;
        }
    }
}
