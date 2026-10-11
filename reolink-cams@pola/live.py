#!/usr/bin/env python3
"""Show a camera fullscreen in ffplay: live.py IP TITLE [RTSP_BASE]

Plays the RTSP stream (switching RTSP on first if needed). Models without RTSP,
like the plain E1, fall back to a fast Baichuan snapshot feed. RTSP_BASE (e.g. a Neolink
URL) replaces the camera's own RTSP: RTSP_BASE/main and RTSP_BASE/sub.
"""
import asyncio
import ctypes
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.parse

from reolink_aio.api import Host
from reolink_aio.baichuan.util import PortType

RTSP_PORT = 554
FFPLAY = ['ffplay', '-loglevel', 'error', '-fs', '-autoexit']


def die_with_parent():
    """Run in the ffplay child: exit when this script is killed (e.g. the extension restarts the view)."""
    ctypes.CDLL(None).prctl(1, signal.SIGTERM)   # PR_SET_PDEATHSIG


def rtsp_open(ip):
    try:
        socket.create_connection((ip, RTSP_PORT), 3).close()
        return True
    except OSError:
        return False


def has_video(url, wait=8):
    """True if the stream delivers a video packet in time; Wi-Fi cameras can connect and then send nothing."""
    try:
        out = subprocess.run(['ffprobe', '-v', 'error', '-rtsp_transport', 'tcp', '-select_streams', 'v',
                              '-read_intervals', '%+#1', '-show_entries', 'packet=pts', '-of', 'csv', url],
                             capture_output=True, text=True, timeout=wait).stdout
        return 'packet' in out
    except subprocess.TimeoutExpired:
        return False


async def snapshots(host, out):
    """Write main-stream JPEGs to ffplay's stdin until the window is closed."""
    while True:
        start = time.monotonic()
        try:
            img = await host.baichuan.snapshot(0, snapType='main')
        except Exception:
            await asyncio.sleep(1)
            continue
        out.write(img)
        out.flush()
        await asyncio.sleep(max(0, 0.5 - (time.monotonic() - start)))


def play(main_url, sub_url, title):
    url = main_url if has_video(main_url) else sub_url
    subprocess.call(FFPLAY + ['-window_title', title, '-rtsp_transport', 'tcp', '-fflags', 'nobuffer',
                              '-flags', 'low_delay', '-framedrop', url], preexec_fn=die_with_parent)


async def main(ip, title, base=None):
    if base:
        play(f'{base}/main', f'{base}/sub', title)
        return
    with open(os.path.expanduser('~/.config/reolink-cams/config.json')) as f:
        cfg = json.load(f)
    host = Host(ip, cfg['user'], cfg['password'], bc_port=cfg.get('port', 9000), bc_only=True)
    await host.baichuan.login()
    try:
        if not rtsp_open(ip) and not (await host.baichuan.get_ports())['rtsp']['enable']:
            await host.baichuan.set_port_enabled(PortType.rtsp, True)
            await asyncio.sleep(2)
        if rtsp_open(ip):
            await host.baichuan.logout()
            auth = f"{urllib.parse.quote(cfg['user'], safe='')}:{urllib.parse.quote(cfg['password'], safe='')}"
            url = f'rtsp://{auth}@{ip}:{RTSP_PORT}/h264Preview_01_'
            play(url + 'main', url + 'sub', title)
            return
        player = subprocess.Popen(FFPLAY + ['-window_title', f'{title} (snapshots)', '-f', 'image2pipe',
                                            '-framerate', '2', '-vcodec', 'mjpeg', '-i', '-'],
                                  stdin=subprocess.PIPE, preexec_fn=die_with_parent)
        feed = asyncio.ensure_future(snapshots(host, player.stdin))
        while player.poll() is None and not feed.done():
            await asyncio.sleep(0.5)
        feed.cancel()
        player.kill()
    finally:
        try:
            await host.baichuan.logout()
        except Exception:
            pass


try:
    asyncio.run(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else sys.argv[1], sys.argv[3] if len(sys.argv) > 3 else None))
except (BrokenPipeError, KeyboardInterrupt):
    pass
