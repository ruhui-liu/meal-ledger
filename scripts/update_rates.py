#!/usr/bin/env python3
"""从银联国际 (UnionPay International) 拉取每日 JPY→CNY 汇率，写入 data/rates.json。

银联每天发布一个文件：https://www.unionpayintl.com/upload/jfimg/YYYYMMDD.json
其中 transCur=JPY, baseCur=CNY 的 rateData 即「1 日元 = 多少人民币」
（银联卡在日本刷日元时按这个汇率扣人民币）。

用法：python3 scripts/update_rates.py [--from 2026-05-01]
只用标准库，GitHub Actions 每天自动运行（见 .github/workflows/update-rates.yml）。
"""
import argparse
import datetime as dt
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "rates.json"
URL = "https://www.unionpayintl.com/upload/jfimg/{}.json"
JST = dt.timezone(dt.timedelta(hours=9))


def fetch(day: dt.date):
    req = urllib.request.Request(URL.format(day.strftime("%Y%m%d")), headers={"User-Agent": "meal-ledger-rates/1.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r)
            for x in data.get("exchangeRateJson", []):
                if x.get("transCur") == "JPY" and x.get("baseCur") == "CNY":
                    return float(x["rateData"])
            return None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None  # 当天还没发布
            err = e
        except Exception as e:  # 网络抖动，重试
            err = e
        time.sleep(2 * (attempt + 1))
    print(f"  ! {day}: {err}", file=sys.stderr)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", help="从这一天开始补（默认：表里最后一天的后一天）")
    args = ap.parse_args()

    doc = {"source": "UnionPay International", "pair": "JPY->CNY", "note": "rates[date] = 1 JPY 兑多少 CNY（银联当日汇率）", "rates": {}}
    if OUT.exists():
        doc = json.loads(OUT.read_text(encoding="utf-8"))
    rates = doc.setdefault("rates", {})

    today = dt.datetime.now(JST).date()
    if args.start:
        start = dt.date.fromisoformat(args.start)
    elif rates:
        start = dt.date.fromisoformat(max(rates)) + dt.timedelta(days=1)
    else:
        start = today - dt.timedelta(days=7)

    added = 0
    day = start
    while day <= today + dt.timedelta(days=1):
        key = day.isoformat()
        if key not in rates:
            v = fetch(day)
            if v:
                rates[key] = v
                added += 1
                print(f"  {key}: {v}")
        day += dt.timedelta(days=1)

    if added:
        doc["rates"] = dict(sorted(rates.items()))
        doc["updatedAt"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"added {added} day(s); latest = {max(rates) if rates else None}")


if __name__ == "__main__":
    main()
