#!/usr/bin/env python3
"""Watch cameras for motion over Baichuan push events: events.py IP [IP ...]

Prints one JSON line per change: {"ip": ..., "motion": true/false, "types": ["people", ...]}.
"types" holds the AI detections (people, vehicle, dog_cat, ...) the camera reports with the
motion. Reconnects on its own, so cameras on weak Wi-Fi or asleep come back by themselves.
"""
import asyncio
import ctypes
import json
import logging
import os
import signal
import sys
import xml.etree.ElementTree as XML

from reolink_aio.api import Host

CHECK = 30      # seconds between connection checks
RETRY = 30      # seconds before retrying a camera that can't be reached


def emit(**msg):
    print(json.dumps(msg), flush=True)


async def watch(ip, cfg):
    last = None
    while True:
        host = Host(ip, cfg['user'], cfg['password'], bc_port=cfg.get('port', 9000), bc_only=True)
        bc = host.baichuan
        parse = bc._parse_xml

        def on_xml(cmd_id, xml, *args, **kw):
            nonlocal last
            if cmd_id == 33:
                try:
                    for ev in XML.fromstring(xml).iter('AlarmEvent'):
                        status = (ev.findtext('status') or '').split(',')
                        types = [t for t in (ev.findtext('AItype') or '').split(',')
                                 if t and t not in ('none', 'other')]
                        state = ('MD' in status or bool(types), sorted(types))
                        if state != last:
                            last = state
                            emit(ip=ip, motion=state[0], types=state[1])
                except XML.ParseError:
                    pass
            return parse(cmd_id, xml, *args, **kw)

        bc._parse_xml = on_xml
        try:
            await bc.login()
            await bc.subscribe_events()
            emit(ip=ip, connected=True)
            while True:
                await asyncio.sleep(CHECK)
                await bc.check_subscribe_events()
        except asyncio.CancelledError:
            raise
        except Exception as err:
            emit(ip=ip, connected=False, error=type(err).__name__)
        finally:
            try:
                await asyncio.wait_for(bc.unsubscribe_events(), 5)
            except Exception:
                pass
        if last and last[0]:
            last = None
            emit(ip=ip, motion=False, types=[])
        await asyncio.sleep(RETRY)


async def main(ips):
    with open(os.path.expanduser('~/.config/reolink-cams/config.json')) as f:
        cfg = json.load(f)
    await asyncio.gather(*(watch(ip, cfg) for ip in ips))


if __name__ == '__main__':
    logging.basicConfig(level=logging.CRITICAL)   # the library warns about every AI type it didn't expect
    ctypes.CDLL(None).prctl(1, signal.SIGTERM)   # PR_SET_PDEATHSIG: die with gnome-shell
    try:
        asyncio.run(main(sys.argv[1:]))
    except KeyboardInterrupt:
        pass
