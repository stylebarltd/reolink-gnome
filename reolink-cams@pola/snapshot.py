#!/usr/bin/env python3
"""Fetch one JPEG snapshot over the Baichuan protocol: snapshot.py IP OUT.jpg [main|sub]"""
import asyncio
import json
import os
import sys

from reolink_aio.api import Host


async def main(ip, out, stream):
    with open(os.path.expanduser('~/.config/reolink-cams/config.json')) as f:
        cfg = json.load(f)
    host = Host(ip, cfg['user'], cfg['password'], bc_port=cfg.get('port', 9000), bc_only=True)
    try:
        await host.baichuan.login()
        img = await host.baichuan.snapshot(0, snapType=stream)
        tmp = out + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(img)
        os.replace(tmp, out)
    finally:
        await host.baichuan.logout()


asyncio.run(asyncio.wait_for(main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'sub'), 20))
