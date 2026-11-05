// 数据存储与同步
// - GitHub 模式：数据是仓库里的 data/ledger.json，每次保存 = 一次 commit（需要 Token）
// - 只读模式：在 GitHub Pages 上打开但没有 Token，只能看
// - 本地模式：不在 github.io 上（比如本机测试），数据存在浏览器里
import { b64encode, b64decode, readLS, writeLS, clone, nowISO } from './util.js';

const LS = { cfg: 'fz.config', cache: 'fz.cache', pending: 'fz.pending', local: 'fz.local' };
export const DEFAULT_METHODS = ['现金', '刷卡', '支付宝', '微信支付', 'PayPay', '其他'];

export const emptyData = () => ({ version: 1, members: [], methods: [...DEFAULT_METHODS], bills: [], payments: [] });

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  return {
    ...d,
    version: 1,
    members: Array.isArray(d.members) ? d.members : [],
    methods: Array.isArray(d.methods) ? d.methods : [...DEFAULT_METHODS],
    bills: Array.isArray(d.bills) ? d.bills : [],
    payments: Array.isArray(d.payments) ? d.payments : [],
  };
}

let base = null; // 最近一次从仓库/本地读到的数据（不含未同步的修改）
let sha = null;
let pending = readLS(LS.pending, []) || [];

export const state = {
  data: emptyData(),
  mode: 'local',
  status: 'idle', // idle | loading | saving | ok | error
  error: '',
  lastSync: null,
  loaded: false,
  pending: pending.length,
};

const subs = new Set();
export const subscribe = (f) => subs.add(f);
const emit = () => subs.forEach((f) => f(state));

// ---------- 配置 ----------
function detectRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (!m) return {};
  const owner = m[1];
  const seg = location.pathname.split('/').filter(Boolean)[0];
  const repo = seg && !seg.includes('.') ? seg : `${owner}.github.io`;
  return { owner, repo };
}
export function getConfig() {
  const saved = readLS(LS.cfg, {}) || {};
  const det = detectRepo();
  return {
    owner: saved.owner || det.owner || '',
    repo: saved.repo || det.repo || '',
    branch: saved.branch || 'main',
    path: saved.path || 'data/ledger.json',
    token: saved.token || '',
    me: saved.me || '',
  };
}
export function saveConfig(patch) {
  const saved = readLS(LS.cfg, {}) || {};
  writeLS(LS.cfg, { ...saved, ...patch });
  state.mode = computeMode();
}
function computeMode() {
  const c = getConfig();
  if (c.owner && c.repo) return c.token ? 'github' : 'readonly';
  return 'local';
}
export const canWrite = () => state.mode !== 'readonly';

// ---------- 操作（可序列化，离线时排队，冲突时在最新数据上重放） ----------
function upsert(arr, v) {
  const i = arr.findIndex((x) => x.id === v.id);
  if (i >= 0) arr[i] = v;
  else arr.push(v);
}
export function applyOp(d, op) {
  switch (op.t) {
    case 'putBill': upsert(d.bills, op.v); break;
    case 'delBill': d.bills = d.bills.filter((x) => x.id !== op.id); break;
    case 'putPayment': upsert(d.payments, op.v); break;
    case 'delPayment': d.payments = d.payments.filter((x) => x.id !== op.id); break;
    case 'putMember': upsert(d.members, op.v); break;
    case 'delMember': d.members = d.members.filter((x) => x.id !== op.id); break;
    case 'setMethods': d.methods = op.v; break;
    case 'replaceAll': return normalize(clone(op.v));
  }
  return d;
}
function recompute() {
  let d = clone(base || emptyData());
  for (const p of pending) d = applyOp(d, p.op);
  state.data = normalize(d);
  state.pending = pending.length;
}
function savePending() {
  writeLS(LS.pending, pending);
  state.pending = pending.length;
}

// ---------- GitHub API ----------
class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
function apiUrl(c) {
  return `https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${c.path.split('/').map(encodeURIComponent).join('/')}`;
}
function headers(c) {
  const h = { Accept: 'application/vnd.github+json' };
  if (c.token) h.Authorization = `Bearer ${c.token}`;
  return h;
}
async function ghGet(c) {
  const res = await fetch(`${apiUrl(c)}?ref=${encodeURIComponent(c.branch)}&_=${Date.now()}`, { headers: headers(c), cache: 'no-store' });
  if (res.status === 404) return { data: null, sha: null, missing: true };
  if (!res.ok) {
    // 没有 Token 时 API 每小时只能请求 60 次，超了就退回 raw 文件
    if (!c.token && (res.status === 403 || res.status === 429)) {
      const raw = await fetch(`https://raw.githubusercontent.com/${c.owner}/${c.repo}/${c.branch}/${c.path}?_=${Date.now()}`, { cache: 'no-store' });
      if (raw.ok) return { data: await raw.json(), sha: null };
    }
    throw new HttpError(res.status, await errText(res));
  }
  const j = await res.json();
  let text;
  if (j.content) text = b64decode(j.content);
  else {
    // 文件超过 1MB 时 contents API 不返回内容
    const raw = await fetch(j.download_url, { cache: 'no-store' });
    text = await raw.text();
  }
  return { data: JSON.parse(text), sha: j.sha };
}
async function ghPut(c, data, prevSha, message) {
  const body = { message, content: b64encode(JSON.stringify(data, null, 2) + '\n'), branch: c.branch };
  if (prevSha) body.sha = prevSha;
  const res = await fetch(apiUrl(c), { method: 'PUT', headers: { ...headers(c), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new HttpError(res.status, await errText(res));
  return res.json();
}
async function errText(res) {
  let msg = `HTTP ${res.status}`;
  try { const j = await res.json(); if (j.message) msg += `: ${j.message}`; } catch { /* ignore */ }
  if (res.status === 401) msg = 'Token 无效或已过期 (401)';
  if (res.status === 403) msg += '（Token 没有写入权限，或请求次数超限）';
  if (res.status === 404) msg = '找不到仓库或文件 (404)，请检查用户名/仓库名，或 Token 是否有该仓库权限';
  return msg;
}

/** 测试连接，返回 { ok, canPush, message } */
export async function testConnection(c = getConfig()) {
  try {
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`, { headers: headers(c), cache: 'no-store' });
    if (!res.ok) return { ok: false, message: await errText(res) };
    const j = await res.json();
    const canPush = !!j.permissions?.push;
    return { ok: true, canPush, private: j.private, message: canPush ? '连接成功，可以写入' : c.token ? '能读取，但这个 Token 没有写入权限' : '能读取（未填写 Token，只读）' };
  } catch (e) {
    return { ok: false, message: '网络错误：' + e.message };
  }
}

// ---------- 读取 / 保存 ----------
export async function init() {
  state.mode = computeMode();
  const cached = readLS(state.mode === 'local' ? LS.local : LS.cache, null);
  if (cached) {
    base = normalize(cached);
    recompute();
    state.loaded = true;
  }
  emit();
  await refresh();
}

export async function refresh() {
  state.mode = computeMode();
  const c = getConfig();
  if (state.mode === 'local') {
    let d = readLS(LS.local, null);
    if (!d) {
      try {
        const res = await fetch('./data/ledger.json', { cache: 'no-store' });
        if (res.ok) d = await res.json();
      } catch { /* 没有种子数据 */ }
    }
    base = normalize(d || emptyData());
    // 本地模式下不需要排队，直接合并
    for (const p of pending) base = applyOp(base, p.op);
    pending = [];
    savePending();
    writeLS(LS.local, base);
    recompute();
    state.loaded = true;
    state.status = 'ok';
    emit();
    return;
  }
  state.status = 'loading';
  emit();
  try {
    const r = await ghGet(c);
    base = normalize(r.data || emptyData());
    sha = r.sha;
    writeLS(LS.cache, base);
    state.status = 'ok';
    state.error = '';
    state.lastSync = Date.now();
  } catch (e) {
    state.status = 'error';
    state.error = e.message;
  }
  recompute();
  state.loaded = true;
  emit();
  if (pending.length && state.mode === 'github') flush();
}

/** 提交一个修改。返回 true 表示已同步（或本地模式已保存），false 表示暂存在本机待同步 */
export async function commit(op, msg) {
  if (state.mode === 'readonly') throw new Error('只读模式：请先在「设置」里填写 GitHub Token');
  if (state.mode === 'local') {
    base = applyOp(clone(base || emptyData()), op);
    writeLS(LS.local, base);
    recompute();
    emit();
    return true;
  }
  pending.push({ op, msg, at: nowISO() });
  savePending();
  recompute();
  emit();
  return flush();
}

let flushing = null;
export function flush() {
  if (state.mode !== 'github') return Promise.resolve(false);
  if (!flushing) flushing = doFlush().finally(() => (flushing = null));
  return flushing;
}
async function doFlush() {
  const c = getConfig();
  for (let attempt = 0; attempt < 4 && pending.length; attempt++) {
    state.status = 'saving';
    emit();
    let remote;
    try {
      remote = await ghGet(c);
    } catch (e) {
      state.status = 'error';
      state.error = e.message;
      emit();
      return false;
    }
    const batch = pending.slice();
    let d = normalize(clone(remote.data || emptyData()));
    for (const p of batch) d = applyOp(d, p.op);
    d.updatedAt = nowISO();
    const me = c.me ? (d.members.find((m) => m.id === c.me)?.short || c.me) : '';
    let msg = batch.map((p) => p.msg).join('；');
    if (msg.length > 180) msg = msg.slice(0, 180) + '…';
    if (me) msg += ` (by ${me})`;
    try {
      const r = await ghPut(c, d, remote.sha, msg);
      base = d;
      sha = r.content?.sha || null;
      pending = pending.slice(batch.length);
      savePending();
      writeLS(LS.cache, base);
      state.status = 'ok';
      state.error = '';
      state.lastSync = Date.now();
      recompute();
      emit();
    } catch (e) {
      if (e.status === 409 || e.status === 422) { state.error = e.message; continue; } // 别人刚好也改了：重新拉取再试
      state.status = 'error';
      state.error = e.message;
      emit();
      return false;
    }
  }
  if (pending.length) {
    state.status = 'error';
    state.error = state.error || '保存冲突，请稍后重试';
    emit();
    return false;
  }
  return true;
}

/** 放弃本机还没同步的修改 */
export function discardPending() {
  pending = [];
  savePending();
  recompute();
  emit();
}
