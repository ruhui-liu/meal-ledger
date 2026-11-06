#!/usr/bin/env python3
"""更新 index.html 里静态文件的版本号，让手机浏览器马上拿到新代码（GitHub Pages 默认缓存 10 分钟）。
每次改了 js/ 或 css/ 之后运行一次：python3 scripts/bump_version.py"""
import datetime as dt, pathlib, re
p = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
v = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d%H%M%S')
s = p.read_text(encoding='utf-8')
s, n = re.subn(r'\?v=\d+', f'?v={v}', s)
p.write_text(s, encoding='utf-8')
print(f'version {v}, {n} references updated')
