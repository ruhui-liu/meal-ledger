// 记账计算：分摊、欠款、换算、统计
import { CUR, CURS, isZero } from './util.js';
import { t } from './i18n.js';

const DEFAULT_RATE = 0.047; // 完全没有汇率数据时的兜底（1円≈0.047元）

// ---------- 银联汇率表 ----------
// data/rates.json 由 GitHub Actions 每天从银联拉取：{ "2026-05-29": 0.042692, ... }（1円 = 多少元）
let TABLE = {};
let DATES = [];
export function setRateTable(t) {
  if (t === TABLE) return;
  TABLE = t || {};
  DATES = Object.keys(TABLE).sort();
}
/** 某一天的银联汇率；当天的还没发布时用之前最近一天的（exact=false） */
export function rateInfo(date) {
  if (!date) return null;
  if (TABLE[date] > 0) return { rate: TABLE[date], date, exact: true };
  if (!DATES.length) return null;
  let lo = 0, hi = DATES.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (DATES[mid] <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const d = DATES[best < 0 ? 0 : best];
  return { rate: TABLE[d], date: d, exact: false };
}
export const latestRateDate = () => DATES[DATES.length - 1] || '';

/** 每位参与人在这笔账里应承担的金额（账单原币种） */
export function sharesOf(bill) {
  const sp = bill.split || {};
  const ids = sp.members || [];
  const out = {};
  const n = ids.length;
  if (!n) return out;
  const amt = +bill.amount || 0;
  const val = (id) => {
    const v = +(sp.values || {})[id];
    return Number.isFinite(v) ? v : 0;
  };
  if (sp.mode === 'amount') {
    // 指定金额：没分配完的部分由所有参与人平均分摊
    let sum = 0;
    ids.forEach((id) => (sum += val(id)));
    const rem = (amt - sum) / n;
    ids.forEach((id) => (out[id] = val(id) + rem));
  } else if (sp.mode === 'ratio') {
    let w = 0;
    ids.forEach((id) => (w += Math.max(0, val(id))));
    ids.forEach((id) => (out[id] = w > 0 ? (amt * Math.max(0, val(id))) / w : 0));
  } else {
    ids.forEach((id) => (out[id] = amt / n));
  }
  return out;
}

export function billError(bill, nameOf = (id) => id) {
  if (!bill.date) return t('请选择日期');
  if (!(bill.amount > 0)) return t('请输入正确的金额');
  if (!bill.payer) return t('请选择付款人');
  const sp = bill.split;
  if (!sp.members.length) return t('请至少选一位参与人');
  if (sp.mode !== 'equal') {
    for (const id of sp.members) {
      if (!Number.isFinite(sp.values?.[id])) return t('{name} 的数字格式不对', { name: nameOf(id) });
    }
  }
  if (sp.mode === 'amount') {
    const sum = sp.members.reduce((s, id) => s + (sp.values[id] || 0), 0);
    if (sum - bill.amount > CUR[bill.currency].eps) return t('指定金额的合计超过了总额');
  }
  if (sp.mode === 'ratio') {
    const w = sp.members.reduce((s, id) => s + Math.max(0, sp.values[id] || 0), 0);
    if (!(w > 0)) return t('请填写每个人的比例（或各自点单金额）');
  }
  return null;
}

export function convert(x, from, to, rate) {
  if (from === to) return x;
  if (!(rate > 0)) rate = DEFAULT_RATE;
  return from === 'JPY' ? x * rate : x / rate;
}

/** 汇率表不可用时：用账目里存过的汇率兜底 */
function rateFinder(data) {
  const known = [...data.bills, ...data.payments]
    .filter((r) => r.rate > 0)
    .map((r) => [r.date, r.rate])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return (date) => {
    if (!known.length) return DEFAULT_RATE;
    let best = known[0];
    for (const k of known) {
      if (k[0] <= date) best = k;
      else break;
    }
    return best[1];
  };
}
/** 一条记录用的汇率：手动填写 > 银联当日 > 记录里存的 > 兜底 */
function resolver(data) {
  let find = null;
  return (rec) => {
    if (rec.rateSource === 'manual' && rec.rate > 0) return rec.rate;
    const info = rateInfo(rec.date);
    if (info) return info.rate;
    if (rec.rate > 0) return rec.rate;
    find = find || rateFinder(data);
    return find(rec.date);
  };
}
export function rateOf(rec, data) {
  return resolver(data)(rec);
}

/**
 * 把所有账目拆成“欠款流”：from 欠 to 多少钱。
 * 还款 A→B 记为 B 欠 A（抵消 A 原来欠 B 的钱）。
 */
export function flows(data) {
  const R = resolver(data);
  const out = [];
  for (const b of data.bills) {
    const rate = R(b);
    const sh = sharesOf(b);
    for (const [id, v] of Object.entries(sh)) {
      if (id === b.payer || !(Math.abs(v) > 1e-9)) continue;
      out.push({ type: 'bill', ref: b, date: b.date, from: id, to: b.payer, cur: b.currency, amt: v, rate });
    }
  }
  for (const p of data.payments) {
    const rate = R(p);
    const credited = creditOf(p, rate);
    out.push({ type: 'payment', ref: p, date: p.date, from: p.to, to: p.from, cur: credited.cur, amt: credited.amt, rate });
  }
  return out;
}

/** 还款实际抵扣的币种和金额（可以付人民币抵日元欠款） */
export function creditOf(p, rate = p.rate) {
  if (p.creditCurrency && p.creditCurrency !== p.currency) {
    const amt = Number.isFinite(p.creditAmount) ? p.creditAmount : convert(p.amount, p.currency, p.creditCurrency, rate);
    return { cur: p.creditCurrency, amt };
  }
  return { cur: p.currency, amt: p.amount };
}

/** mode: 'split' 分币种；'CNY' / 'JPY' 按每笔账自己的汇率换算 */
export function valueIn(f, mode) {
  if (mode === 'split' || mode === f.cur) return { cur: f.cur, amt: f.amt };
  return { cur: mode, amt: convert(f.amt, f.cur, mode, f.rate) };
}

function pairNet(data, mode) {
  const m = new Map();
  for (const f of flows(data)) {
    const [a, b] = f.from < f.to ? [f.from, f.to] : [f.to, f.from];
    const sign = f.from === a ? 1 : -1;
    const { cur, amt } = valueIn(f, mode);
    const k = a + '|' + b;
    if (!m.has(k)) m.set(k, { a, b, net: {} });
    const e = m.get(k);
    e.net[cur] = (e.net[cur] || 0) + sign * amt;
  }
  return m;
}

/** 两两净额：每两个人之间互相抵消后的欠款 */
export function debtsPairwise(data, mode) {
  const list = [];
  for (const e of pairNet(data, mode).values()) {
    for (const [cur, v] of Object.entries(e.net)) {
      if (isZero(v, cur)) continue;
      list.push(v > 0 ? { from: e.a, to: e.b, cur, amt: v } : { from: e.b, to: e.a, cur, amt: -v });
    }
  }
  return list;
}

/** 每个人的净额：正数=别人欠他（应收），负数=他欠别人（应付） */
export function netByMember(data, mode) {
  const net = {};
  const add = (id, cur, v) => {
    net[id] = net[id] || {};
    net[id][cur] = (net[id][cur] || 0) + v;
  };
  for (const f of flows(data)) {
    const { cur, amt } = valueIn(f, mode);
    add(f.to, cur, amt);
    add(f.from, cur, -amt);
  }
  return net;
}

/** 最少转账：只看每个人的净额，用贪心算法配对 */
export function debtsSimplified(data, mode) {
  const net = netByMember(data, mode);
  const out = [];
  const curs = mode === 'split' ? CURS : [mode];
  for (const cur of curs) {
    const cred = [], debt = [];
    for (const [id, v] of Object.entries(net)) {
      const x = v[cur] || 0;
      if (isZero(x, cur)) continue;
      (x > 0 ? cred : debt).push({ id, x: Math.abs(x) });
    }
    cred.sort((a, b) => b.x - a.x);
    debt.sort((a, b) => b.x - a.x);
    let i = 0, j = 0;
    while (i < debt.length && j < cred.length) {
      const t = Math.min(debt[i].x, cred[j].x);
      if (!isZero(t, cur)) out.push({ from: debt[i].id, to: cred[j].id, cur, amt: t });
      debt[i].x -= t;
      cred[j].x -= t;
      if (isZero(debt[i].x, cur)) i++;
      if (isZero(cred[j].x, cur)) j++;
    }
  }
  return out;
}

/** 两个人之间的所有往来（正数 = a 欠 b 增加） */
export function pairHistory(data, a, b, mode) {
  return flows(data)
    .filter((f) => (f.from === a && f.to === b) || (f.from === b && f.to === a))
    .map((f) => {
      const { cur, amt } = valueIn(f, mode);
      return { ...f, sign: f.from === a ? 1 : -1, vcur: cur, vamt: amt };
    })
    .sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
}

/** 统计（不含期初结转） */
export function stats(data, range = {}) {
  const blank = () => ({ JPY: 0, CNY: 0, toCNY: 0, toJPY: 0 });
  const addTo = (o, cur, v, rate) => {
    o[cur] += v;
    o.toCNY += convert(v, cur, 'CNY', rate);
    o.toJPY += convert(v, cur, 'JPY', rate);
  };
  const R = resolver(data);
  const per = {};
  const P = (id) => (per[id] = per[id] || { paidCount: 0, joinCount: 0, paid: blank(), used: blank() });
  const total = { count: 0, amt: blank() };
  const methods = {};
  const places = {};
  for (const b of data.bills) {
    if (b.kind === 'carry') continue;
    if (range.from && b.date < range.from) continue;
    if (range.to && b.date > range.to) continue;
    const rate = R(b);
    total.count++;
    addTo(total.amt, b.currency, b.amount, rate);
    const p = P(b.payer);
    p.paidCount++;
    addTo(p.paid, b.currency, b.amount, rate);
    for (const [id, v] of Object.entries(sharesOf(b))) {
      const q = P(id);
      q.joinCount++;
      addTo(q.used, b.currency, v, rate);
    }
    const mk = b.method || '未记录';
    methods[mk] = methods[mk] || { count: 0, amt: blank() };
    methods[mk].count++;
    addTo(methods[mk].amt, b.currency, b.amount, rate);
    const pk = (b.title || '').trim();
    if (pk) {
      places[pk] = places[pk] || { count: 0, amt: blank() };
      places[pk].count++;
      addTo(places[pk].amt, b.currency, b.amount, rate);
    }
  }
  return { per, total, methods, places };
}
