// 通用小工具
export const CUR = {
  JPY: { code: 'JPY', name: '日元', unit: '円', dp: 0, eps: 0.5 },
  CNY: { code: 'CNY', name: '人民币', unit: '元', dp: 2, eps: 0.005 },
};
export const CURS = ['JPY', 'CNY'];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const pad = (n) => String(n).padStart(2, '0');
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const nowISO = () => new Date().toISOString();

const WD = ['日', '一', '二', '三', '四', '五', '六'];
export function fmtDate(s, withYear = false) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  const showY = withYear || y !== new Date().getFullYear();
  return `${showY ? y + '年' : ''}${m}月${d}日 周${WD[wd]}`;
}
export function fmtDateShort(s) {
  if (!s) return '';
  const [, m, d] = s.split('-').map(Number);
  return `${m}/${d}`;
}
export function weekday(s) {
  const [y, m, d] = s.split('-').map(Number);
  return '周' + WD[new Date(y, m - 1, d).getDay()];
}
export const monthKey = (s) => s.slice(0, 7);
export function fmtMonth(k) {
  const [y, m] = k.split('-').map(Number);
  return `${y}年${m}月`;
}

export function roundCur(n, cur) {
  const f = 10 ** CUR[cur].dp;
  return Math.round(n * f) / f;
}
export const isZero = (n, cur) => !(Math.abs(n) >= CUR[cur].eps);

export function num(n, cur) {
  if (!Number.isFinite(n)) return '—';
  let v = roundCur(n, cur);
  if (Object.is(v, -0)) v = 0;
  const dp = CUR[cur].dp;
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
// 带单位的金额 HTML
export function money(n, cur, cls = '') {
  return `<span class="money ${cls}">${num(n, cur)}<i class="u u-${cur}">${CUR[cur].unit}</i></span>`;
}
export function moneyText(n, cur) {
  return `${num(n, cur)}${CUR[cur].unit}`;
}

// 解析金额，支持 "1,200"、全角数字、以及 "1090+330"、"23580/3" 这样的简单算式
export function parseNum(s) {
  if (typeof s === 'number') return s;
  s = String(s ?? '')
    .replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/＋/g, '+').replace(/－/g, '-').replace(/[×＊xX]/g, '*').replace(/[÷／]/g, '/')
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/[,，\s円元¥￥]/g, '');
  if (!s || !/^[\d.+\-*/()]+$/.test(s)) return NaN;
  let i = 0;
  const peek = () => s[i];
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = s[i++]; const t = term(); v = op === '+' ? v + t : v - t; }
    return v;
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') { const op = s[i++]; const t = factor(); v = op === '*' ? v * t : v / t; }
    return v;
  }
  function factor() {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '(') { i++; const v = expr(); if (peek() !== ')') throw 0; i++; return v; }
    const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (!m) throw 0;
    i += m[0].length;
    return parseFloat(m[0]);
  }
  try {
    const v = expr();
    return i === s.length && Number.isFinite(v) ? v : NaN;
  } catch { return NaN; }
}

// UTF-8 安全的 base64
export function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function readLS(k, d) {
  try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; }
}
export function writeLS(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隐私模式等 */ }
}
export const clone = (o) => JSON.parse(JSON.stringify(o));
