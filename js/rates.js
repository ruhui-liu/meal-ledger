// 日元→人民币汇率（按日期）。主源：欧洲央行参考汇率（frankfurter.dev），备用：fawazahmed0/currency-api
import { today, readLS, writeLS } from './util.js';

const KEY = 'fz.rates';
let cache = null;
const inflight = {};

function load() {
  if (!cache) cache = readLS(KEY, {}) || {};
  return cache;
}

/** 返回 { rate: 1円对应多少元, date: 实际采用的汇率日期, source } */
export function getRate(date) {
  const c = load();
  if (c[date]) return Promise.resolve(c[date]);
  if (inflight[date]) return inflight[date];
  inflight[date] = fetchRate(date)
    .then((r) => {
      // 当天的汇率可能还会更新，只缓存过去的日期
      if (date < today()) {
        c[date] = r;
        writeLS(KEY, c);
      }
      return r;
    })
    .finally(() => delete inflight[date]);
  return inflight[date];
}

async function fetchRate(date) {
  const q = date > today() ? 'latest' : date;
  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/${q}?base=JPY&symbols=CNY`);
    if (res.ok) {
      const j = await res.json();
      if (j?.rates?.CNY > 0) return { rate: j.rates.CNY, date: j.date, source: 'ECB' };
    }
  } catch { /* 换备用源 */ }
  try {
    const res = await fetch(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${q}/v1/currencies/jpy.min.json`);
    if (res.ok) {
      const j = await res.json();
      if (j?.jpy?.cny > 0) return { rate: j.jpy.cny, date: j.date || date, source: 'currency-api' };
    }
  } catch { /* 都失败 */ }
  throw new Error('汇率获取失败');
}
