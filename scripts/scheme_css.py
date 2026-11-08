#!/usr/bin/env python3
"""把 CSS 里的 @media (prefers-color-scheme: dark) 改写成「可手动切换」的形式：
- 跟随系统时：媒体查询里的规则加上 :root:not([data-scheme="light"]) 守卫（选了浅色就不生效）
- 选了深色时：复制一份规则，挂在 :root[data-scheme="dark"] 下，不依赖系统设置
只处理还没改写过的块（有 /*scheme*/ 标记的跳过），可以重复运行。"""
import re, sys, pathlib

MQ = '@media (prefers-color-scheme: dark)'

def find_block(s, i):
    j = s.index('{', i)
    depth, k = 0, j
    while True:
        if s[k] == '{': depth += 1
        elif s[k] == '}':
            depth -= 1
            if depth == 0: return j, k
        k += 1

def rules(inner):
    out, i = [], 0
    while True:
        j = inner.find('{', i)
        if j < 0: break
        k = inner.index('}', j)
        out.append((inner[i:j].strip(), inner[j + 1:k].strip()))
        i = k + 1
    return out

def guard(sel, g):
    sel = sel.strip()
    m = re.match(r'^:root((?:\[[^\]]*\])*)(.*)$', sel, re.S)
    if m: return ':root' + m.group(1) + g + m.group(2)
    m = re.match(r'^((?:\[[^\]]*\])+)(.*)$', sel, re.S)   # [data-theme="x"] 写在 html 上
    if m: return ':root' + m.group(1) + g + m.group(2)
    return ':root' + g + ' ' + sel

def convert(css):
    out, pos = [], 0
    while True:
        i = css.find(MQ, pos)
        if i < 0: out.append(css[pos:]); break
        j, k = find_block(css, i)
        if css[i:j].strip().endswith('/*scheme*/'):
            out.append(css[pos:k + 1]); pos = k + 1; continue
        out.append(css[pos:i])
        rs = rules(css[j + 1:k])
        auto = '\n'.join(f"  {', '.join(guard(x, ':not([data-scheme=\"light\"])') for x in sel.split(','))} {{ {body} }}" for sel, body in rs)
        forced = '\n'.join(f"{', '.join(guard(x, '[data-scheme=\"dark\"]') for x in sel.split(','))} {{ {body} }}" for sel, body in rs)
        out.append(f"{MQ} /*scheme*/ {{\n{auto}\n}}\n{forced}")
        pos = k + 1
    return ''.join(out)

for f in sys.argv[1:]:
    p = pathlib.Path(f)
    p.write_text(convert(p.read_text(encoding='utf-8')), encoding='utf-8')
    print('converted', f)
