#!/usr/bin/env python3
"""Print a camera's stable identity as JSON over the Baichuan protocol: info.py IP"""
import asyncio
import json
import os
import sys

from reolink_aio.api import Host


async def main(ip):
    with open(os.path.expanduser('~/.config/reolink-cams/config.json')) as f:
        cfg = json.load(f)
    host = Host(ip, cfg['user'], cfg['password'], bc_port=cfg.get('port', 9000), bc_only=True)
    try:
        await host.baichuan.login()
        info = await host.baichuan.get_info()
        await host.baichuan.get_uid()
        print(json.dumps({'uid': host.uid, 'name': info.get('name'), 'model': info.get('type')}))
    finally:
        await host.baichuan.logout()


asyncio.run(asyncio.wait_for(main(sys.argv[1]), 20))
