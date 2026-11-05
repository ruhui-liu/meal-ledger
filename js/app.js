import * as S from './store.js';
import * as C from './calc.js';
import { getRate } from './rates.js';
import {
  CUR, CURS, esc, uid, today, nowISO, fmtDate, fmtDateShort, weekday, monthKey, fmtMonth,
  roundCur, isZero, num, money, moneyText, parseNum, readLS, writeLS, clone,
} from './util.js';

const $view = document.getElementById('view');
const MEALS = ['早餐', '午餐', '晚餐', '夜宵', '其他'];
const PALETTE = ['#d9480f', '#1c7ed6', '#2b8a3e', '#9c36b5', '#e67700', '#0b7285', '#c2255c', '#5c940d', '#6741d9', '#a61e4d'];
const FORM_VIEWS = new Set(['add', 'edit', 'pay']);

const prefs = Object.assign(
  { balMode: 'split', balAlgo: 'pair', balScope: 'all', statsRange: 'all', statsMode: 'split', statsFrom: '', statsTo: '', billType: 'all', billPerson: '' },
  readLS('fz.prefs', {}),
);
const setPref = (k, v) => { prefs[k] = v; writeLS('fz.prefs', prefs); };
let billQuery = '';

// ---------------- 成员 ----------------
const D = () => S.state.data;
const myId = () => { const me = S.getConfig().me; return D().members.some((m) => m.id === me) ? me : ''; };
const mem = (id) => D().members.find((m) => m.id === id) || { id, name: id || '?', short: '?', missing: true };
function color(id) {
  const m = mem(id);
  if (m.color) return m.color;
  const i = D().members.findIndex((x) => x.id === id);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}
const av = (id, cls = '') => `<span class="av ${cls}" style="--c:${color(id)}" title="${esc(mem(id).name)}">${esc(mem(id).short || mem(id).name.slice(0, 2))}</span>`;
const nm = (id) => esc(mem(id).name);
const nmShort = (id) => esc(mem(id).short || mem(id).name);

// ---------------- 小组件 ----------------
function seg(name, options, value, { cls = '', pref = false } = {}) {
  return `<div class="seg ${cls}" role="radiogroup">${options
    .map(([v, l]) => `<label><input type="radio" name="${name}" value="${esc(v)}" ${v === value ? 'checked' : ''} ${pref ? 'data-pref' : ''}><span>${l}</span></label>`)
    .join('')}</div>`;
}
function chips(name, options, selected, { type = 'radio', toggle = false } = {}) {
  const sel = new Set([].concat(selected ?? []).filter((x) => x !== ''));
  return `<div class="chips">${options
    .map(([v, l]) => {
      const on = sel.has(v);
      return `<label class="chip"><input type="${type}" name="${name}" value="${esc(v)}" ${on ? 'checked' : ''} ${toggle ? `data-toggle ${on ? 'data-was="1"' : ''}` : ''}><span>${l}</span></label>`;
    })
    .join('')}</div>`;
}
const memberOpts = (ids) => ids.map((id) => [id, `${av(id, 'xs')}${nm(id)}`]);

function amts(obj, { cls = '', zero = true } = {}) {
  const parts = CURS.filter((c) => obj[c] !== undefined && !isZero(obj[c], c)).map((c) => money(obj[c], c, cls));
  if (!parts.length && zero) return money(0, CURS[0], 'muted');
  return parts.join(' ');
}
function modeAmts(o, mode, opts) {
  if (mode === 'split') return amts({ JPY: o.JPY, CNY: o.CNY }, opts);
  return money(mode === 'CNY' ? o.toCNY : o.toJPY, mode, opts?.cls || '');
}

function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.className = `toast ${kind}`), 2800);
}

function openModal(html, mount) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-back"><div class="sheet" role="dialog" aria-modal="true"><button class="sheet-close" data-close aria-label="关闭">×</button>${html}</div></div>`;
  document.body.classList.add('noscroll');
  const back = root.firstElementChild;
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) closeModal(); });
  requestAnimationFrame(() => back.classList.add('in'));
  if (mount) mount(back.querySelector('.sheet'));
}
function closeModal() {
  const root = document.getElementById('modal-root');
  if (root.innerHTML) { root.innerHTML = ''; document.body.classList.remove('noscroll'); }
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function readonlyNote() {
  if (S.canWrite()) return '';
  return `<div class="notice">现在是<b>只读模式</b>，可以查看但不能记账。要记账请到 <a href="#/settings">设置</a> 填写 GitHub Token。</div>`;
}
function syncErrorNote() {
  const st = S.state;
  if (st.status !== 'error' && !st.pending) return '';
  return `<div class="notice warn">${st.pending ? `有 <b>${st.pending}</b> 条修改还没同步到 GitHub。` : ''}${st.status === 'error' ? `同步出错：${esc(st.error)}` : ''}
    <button class="btn-mini" data-act="refresh">重试</button></div>`;
}

// ---------------- 路由 ----------------
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [p, q = ''] = h.split('?');
  return { parts: p.split('/').filter(Boolean), params: Object.fromEntries(new URLSearchParams(q)) };
}
let current = '';
function route() {
  closeModal();
  const { parts, params } = parseHash();
  current = parts[0] || 'balances';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (current === 'edit' || current === 'pay' ? 'add' : current)));
  window.scrollTo(0, 0);
  render(parts, params);
}
function render(parts = parseHash().parts, params = parseHash().params) {
  switch (current) {
    case 'bills': return renderBills();
    case 'add': return renderBillForm(null, params);
    case 'edit': return renderBillForm(parts[1], params);
    case 'pay': return renderPayForm(parts[1], params);
    case 'stats': return renderStats();
    case 'settings': return renderSettings();
    default: return renderBalances();
  }
}
let wasLoaded = S.state.loaded;
S.subscribe(() => {
  renderSync();
  const justLoaded = !wasLoaded && S.state.loaded;
  wasLoaded = S.state.loaded;
  if (FORM_VIEWS.has(current)) { if (justLoaded) render(); return; }
  const ae = document.activeElement;
  if (ae && $view.contains(ae) && /INPUT|TEXTAREA|SELECT/.test(ae.tagName) && ae.type !== 'radio' && ae.type !== 'checkbox') return;
  render();
});
window.addEventListener('hashchange', route);

function renderSync() {
  const st = S.state;
  const el = document.getElementById('sync');
  let txt = '已同步', cls = 'ok';
  if (st.mode === 'local') { txt = '本地模式'; cls = 'local'; }
  else if (st.status === 'loading') { txt = '加载中…'; cls = 'busy'; }
  else if (st.status === 'saving') { txt = '保存中…'; cls = 'busy'; }
  else if (st.pending) { txt = `待同步 ${st.pending}`; cls = 'warn'; }
  else if (st.status === 'error') { txt = '同步失败'; cls = 'err'; }
  else if (st.mode === 'readonly') { txt = '只读'; cls = 'ro'; }
  el.className = `sync ${cls}`;
  el.innerHTML = `<i></i>${txt}`;
  el.title = st.error || (st.lastSync ? `上次同步 ${new Date(st.lastSync).toLocaleTimeString()}` : '');
}
document.getElementById('sync').addEventListener('click', () => {
  if (S.state.pending && S.state.mode === 'github') S.flush(); else S.refresh();
});

// ---------------- 动作（事件委托） ----------------
const ACTIONS = {
  openBill: (id) => openBill(id),
  openPay: (id) => openPayment(id),
  openPair: (arg) => { const [a, b] = arg.split('|'); openPair(a, b); },
  pay: (arg, el) => {
    const [from, to] = arg.split('|');
    const q = new URLSearchParams({ from, to });
    for (const c of CURS) if (el.dataset[c.toLowerCase()]) q.set(c, el.dataset[c.toLowerCase()]);
    location.hash = `#/pay?${q}`;
  },
  editBill: (id) => { location.hash = `#/edit/${id}`; },
  copyBill: (id) => { location.hash = `#/add?copy=${id}`; },
  delBill: async (id) => {
    const b = D().bills.find((x) => x.id === id);
    if (!b || !confirm(`确定删除「${b.title || '这笔账'}」吗？`)) return;
    closeModal();
    await save({ t: 'delBill', id }, `删除 ${b.date} ${b.title} ${b.amount}${b.currency}`);
  },
  editPay: (id) => { location.hash = `#/pay/${id}`; },
  delPay: async (id) => {
    const p = D().payments.find((x) => x.id === id);
    if (!p || !confirm('确定删除这条还款记录吗？')) return;
    closeModal();
    await save({ t: 'delPayment', id }, `删除还款 ${p.date} ${mem(p.from).short}→${mem(p.to).short}`);
  },
  setMe: (id) => { S.saveConfig({ me: id }); toast(`已设定：我是 ${mem(id).name}`); render(); },
  refresh: () => { if (S.state.pending && S.state.mode === 'github') S.flush(); else S.refresh(); },
  editMember: (id) => editMember(id),
  addMember: () => editMember(null),
  delMethod: async (name) => {
    if (!confirm(`删除支付方式「${name}」？（已记录的账目不受影响）`)) return;
    await save({ t: 'setMethods', v: D().methods.filter((m) => m !== name) }, `删除支付方式 ${name}`);
  },
  moveMethod: async (arg) => {
    const [name, dir] = arg.split('|');
    const list = [...D().methods];
    const i = list.indexOf(name), j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await save({ t: 'setMethods', v: list }, '调整支付方式顺序');
  },
  exportJSON: () => download(`饭账本-${today()}.json`, JSON.stringify(D(), null, 2), 'application/json'),
  exportCSV: () => download(`饭账本-${today()}.csv`, toCSV(), 'text/csv'),
  importJSON: () => document.getElementById('importFile')?.click(),
  discard: () => { if (confirm('放弃本机还没同步的修改？')) S.discardPending(); },
};
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  e.preventDefault();
  ACTIONS[t.dataset.act]?.(t.dataset.arg, t, e);
});
$view.addEventListener('change', (e) => {
  const t = e.target;
  if (t.hasAttribute?.('data-pref')) { setPref(t.name, t.value); render(); }
});

async function save(op, msg) {
  try {
    const ok = await S.commit(op, msg);
    if (ok) toast(S.state.mode === 'local' ? '已保存' : '已保存并同步到 GitHub', 'ok');
    else toast('已保存在本机，网络恢复后会自动同步', 'warn');
    return true;
  } catch (e) {
    toast(e.message, 'err');
    return false;
  }
}

// ================= 结算 =================
function groupDebts(list) {
  const m = new Map();
  for (const x of list) {
    const k = x.from + '>' + x.to;
    if (!m.has(k)) m.set(k, { from: x.from, to: x.to, amts: {} });
    m.get(k).amts[x.cur] = (m.get(k).amts[x.cur] || 0) + x.amt;
  }
  return [...m.values()];
}
function refRate() {
  const r = [...D().bills].filter((b) => b.rate > 0).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  return r ? r.rate : 0.047;
}
const magnitude = (a, rr) => (a.JPY || 0) * rr + (a.CNY || 0);
const sumAmts = (rows) => rows.reduce((s, r) => { for (const [c, v] of Object.entries(r.amts)) s[c] = (s[c] || 0) + v; return s; }, {});

function debtRow(r, show) {
  const who = show === 'to' ? r.to : r.from;
  const sub = show === 'to' ? '你欠 TA' : show === 'from' && myId() === r.to ? '欠你' : `→ 付给 ${nm(r.to)}`;
  const data = CURS.filter((c) => r.amts[c]).map((c) => `data-${c.toLowerCase()}="${roundCur(r.amts[c], c)}"`).join(' ');
  return `<div class="debt" data-act="openPair" data-arg="${r.from}|${r.to}" role="button" tabindex="0">
    ${av(who)}
    <div class="debt-who"><b>${nm(who)}</b><small>${sub}</small></div>
    <div class="debt-amt">${amts(r.amts)}</div>
    ${S.canWrite() ? `<button class="btn-mini" data-act="pay" data-arg="${r.from}|${r.to}" ${data}>还款</button>` : ''}
  </div>`;
}

function renderBalances() {
  const d = D(), me = myId();
  if (!d.members.length) {
    $view.innerHTML = `<div class="empty"><p>还没有成员。</p><a class="btn primary" href="#/settings">去添加成员</a></div>`;
    return;
  }
  const mode = prefs.balMode, algo = prefs.balAlgo, scope = me ? prefs.balScope : 'all';
  const raw = algo === 'simple' ? C.debtsSimplified(d, mode) : C.debtsPairwise(d, mode);
  const rr = refRate();
  const rows = groupDebts(raw).sort((a, b) => magnitude(b.amts, rr) - magnitude(a.amts, rr));

  let main = '';
  if (!rows.length) {
    main = `<section class="card"><div class="empty small"><b>全部结清</b><p class="muted">目前没有任何欠款。</p></div></section>`;
  } else if (scope === 'me') {
    const owe = rows.filter((r) => r.from === me), recv = rows.filter((r) => r.to === me);
    main = `<section class="card summary2">
        <div><small>我要付给别人</small><div class="big neg">${amts(sumAmts(owe))}</div></div>
        <div><small>别人要付给我</small><div class="big pos">${amts(sumAmts(recv))}</div></div>
      </section>
      <section class="card"><h3>我要付给</h3>${owe.length ? owe.map((r) => debtRow(r, 'to')).join('') : '<p class="muted pad">没有</p>'}</section>
      <section class="card"><h3>要付给我</h3>${recv.length ? recv.map((r) => debtRow(r, 'from')).join('') : '<p class="muted pad">没有</p>'}</section>`;
  } else {
    const byCred = new Map();
    for (const r of rows) { if (!byCred.has(r.to)) byCred.set(r.to, []); byCred.get(r.to).push(r); }
    main = [...byCred.entries()]
      .sort((a, b) => magnitude(sumAmts(b[1]), rr) - magnitude(sumAmts(a[1]), rr))
      .map(([to, list]) => `<section class="card">
        <div class="card-h">${av(to)}<div><b>付给 ${nm(to)}</b><small>${list.length} 人</small></div><div class="card-h-r">${amts(sumAmts(list))}</div></div>
        ${list.map((r) => debtRow(r, 'from')).join('')}
      </section>`).join('');
  }

  const net = C.netByMember(d, mode);
  const netRows = d.members
    .filter((m) => !m.inactive || net[m.id])
    .map((m) => {
      const v = net[m.id] || {};
      const parts = (mode === 'split' ? CURS : [mode]).filter((c) => v[c] && !isZero(v[c], c));
      const cells = parts.length
        ? parts.map((c) => `<span class="${v[c] > 0 ? 'pos' : 'neg'}">${v[c] > 0 ? '应收 ' : '应付 '}${money(Math.abs(v[c]), c)}</span>`).join('')
        : '<span class="muted">已结清</span>';
      return `<div class="net-row">${av(m.id)}<span class="nm">${nm(m.id)}</span><span class="net-v">${cells}</span></div>`;
    }).join('');

  const whoAmI = !me ? `<section class="card pick-me"><b>你是谁？</b><small class="muted">选一下，就能用「只看我」查看自己的账（只保存在这台设备上）</small>
      <div class="chips">${d.members.filter((m) => !m.inactive).map((m) => `<button class="chip-btn" data-act="setMe" data-arg="${m.id}">${av(m.id, 'xs')}${nm(m.id)}</button>`).join('')}</div></section>` : '';

  $view.innerHTML = `
    <div class="page-h"><h1>谁该给谁多少</h1></div>
    ${syncErrorNote()}
    ${whoAmI}
    <div class="controls">
      ${seg('balMode', [['split', '分币种'], ['CNY', '全换成人民币'], ['JPY', '全换成日元']], mode, { pref: true })}
      <div class="controls-row">
        ${seg('balAlgo', [['pair', '两两抵消'], ['simple', '最少转账']], algo, { cls: 'sm', pref: true })}
        ${me ? seg('balScope', [['all', '所有人'], ['me', '只看我']], scope, { cls: 'sm', pref: true }) : ''}
      </div>
    </div>
    ${main}
    <section class="card"><h3>每个人的净额</h3>${netRows}</section>
    <p class="foot">${mode === 'split'
      ? '日元和人民币分开计算，互不抵消。'
      : `所有金额按<b>每笔账消费当天的汇率</b>（欧洲央行参考汇率）换算成${CUR[mode].name}后再汇总。`}
      ${algo === 'simple' ? '「最少转账」只看每个人的净额重新配对，转账次数最少，但收款人可能不是当初付钱的人。' : '「两两抵消」：两个人之间互相欠的钱先抵消，只剩一个方向。'}
      点一行可以看这两个人之间的明细。</p>`;
}

function openPair(a, b) {
  const mode = prefs.balMode;
  const hist = C.pairHistory(D(), a, b, mode);
  const tot = {};
  hist.forEach((h) => (tot[h.vcur] = (tot[h.vcur] || 0) + h.sign * h.vamt));
  const totHtml = Object.entries(tot).filter(([c, v]) => !isZero(v, c))
    .map(([c, v]) => `<div class="${v > 0 ? 'neg' : 'pos'}">${v > 0 ? `${nm(a)} 欠 ${nm(b)}` : `${nm(b)} 欠 ${nm(a)}`} ${money(Math.abs(v), c)}</div>`).join('') || '<div class="muted">两人之间已结清</div>';
  const items = hist.map((h) => {
    const r = h.ref;
    const title = h.type === 'bill'
      ? `${r.kind === 'carry' ? '<span class="tag carry">结转</span>' : r.meal ? `<span class="tag">${esc(r.meal)}</span>` : ''}${esc(r.title || '未命名')}`
      : `<span class="tag pay">还款</span>${nm(r.from)} → ${nm(r.to)}`;
    const sub = h.type === 'bill' ? `${nmShort(r.payer)} 付 · ${nmShort(h.from)} 的份额` : `${moneyText(r.amount, r.currency)}${r.method ? ' · ' + esc(r.method) : ''}`;
    return `<div class="item" data-act="${h.type === 'bill' ? 'openBill' : 'openPay'}" data-arg="${r.id}" role="button" tabindex="0">
      <div class="item-m"><div class="item-t">${title}</div><div class="item-s">${fmtDate(h.date)} · ${sub}</div></div>
      <div class="item-r ${h.sign > 0 ? 'neg' : 'pos'}"><span class="nowrap">${h.sign > 0 ? '+' : '−'}${money(h.vamt, h.vcur)}</span></div></div>`;
  }).join('');
  openModal(`<h2 class="sheet-t">${av(a)} ${nm(a)} <span class="muted">和</span> ${av(b)} ${nm(b)}</h2>
    <div class="pair-tot">${totHtml}</div>
    <p class="muted small">+ 表示 ${nm(a)} 欠 ${nm(b)} 的钱增加，− 表示减少${mode !== 'split' ? `（已按各自日期汇率换算成${CUR[mode].name}）` : ''}。</p>
    <div class="list">${items || '<p class="muted pad">没有往来记录</p>'}</div>`);
}

// ================= 账目列表 =================
function renderBills() {
  const d = D();
  $view.innerHTML = `
    <div class="page-h"><h1>账目</h1><a class="btn primary sm" href="#/add">＋ 记一笔</a></div>
    ${syncErrorNote()}
    <div class="controls">
      <input class="search" type="search" id="billSearch" placeholder="搜索地点、备注、支付方式…" value="${esc(billQuery)}">
      ${seg('billType', [['all', '全部'], ['meal', '消费'], ['pay', '还款']], prefs.billType, { pref: true, cls: 'sm' })}
      <div class="chips scroll">${[['', '所有人'], ...d.members.map((m) => [m.id, `${av(m.id, 'xs')}${nm(m.id)}`])]
        .map(([v, l]) => `<label class="chip"><input type="radio" name="billPerson" value="${v}" data-pref ${prefs.billPerson === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
    </div>
    <div id="billList"></div>`;
  const input = document.getElementById('billSearch');
  input.addEventListener('input', () => { billQuery = input.value; renderBillList(); });
  renderBillList();
}

function renderBillList() {
  const d = D();
  const q = billQuery.trim().toLowerCase();
  const p = prefs.billPerson && d.members.some((m) => m.id === prefs.billPerson) ? prefs.billPerson : '';
  let items = [];
  if (prefs.billType !== 'pay') items.push(...d.bills.map((b) => ({ k: 'bill', v: b })));
  if (prefs.billType !== 'meal') items.push(...d.payments.map((x) => ({ k: 'pay', v: x })));
  if (p) items = items.filter(({ k, v }) => (k === 'bill' ? v.payer === p || v.split.members.includes(p) : v.from === p || v.to === p));
  if (q) {
    items = items.filter(({ k, v }) => {
      const names = (k === 'bill' ? [v.payer, ...v.split.members] : [v.from, v.to]).map((id) => `${mem(id).name} ${mem(id).short}`).join(' ');
      return `${v.title || ''} ${v.note || ''} ${v.method || ''} ${v.meal || ''} ${names} ${v.date}`.toLowerCase().includes(q);
    });
  }
  items.sort((a, b) => (a.v.date !== b.v.date ? (a.v.date < b.v.date ? 1 : -1) : (a.v.createdAt || '') < (b.v.createdAt || '') ? 1 : -1));
  const el = document.getElementById('billList');
  if (!items.length) { el.innerHTML = `<div class="empty small"><p class="muted">${d.bills.length ? '没有符合条件的记录' : '还没有记录'}</p></div>`; return; }
  const groups = new Map();
  for (const it of items) { const k = monthKey(it.v.date); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
  el.innerHTML = [...groups.entries()].map(([k, list]) => {
    const tot = {};
    list.filter((x) => x.k === 'bill' && x.v.kind !== 'carry').forEach((x) => (tot[x.v.currency] = (tot[x.v.currency] || 0) + x.v.amount));
    const n = list.filter((x) => x.k === 'bill' && x.v.kind !== 'carry').length;
    return `<section class="month"><div class="month-h"><b>${fmtMonth(k)}</b><span class="muted">${n ? `${n} 笔消费 · ${amts(tot)}` : ''}</span></div>
      <div class="card list">${list.map((x) => (x.k === 'bill' ? billRow(x.v) : payRow(x.v))).join('')}</div></section>`;
  }).join('');
}

function billRow(b) {
  const carry = b.kind === 'carry';
  const tag = carry ? '<span class="tag carry">结转</span>' : b.meal ? `<span class="tag">${esc(b.meal)}</span>` : '';
  const sub = carry ? `${b.split.members.length} 人欠 ${nmShort(b.payer)}` : `${nmShort(b.payer)} 付${b.method ? ' · ' + esc(b.method) : ''} · ${b.split.members.length} 人`;
  return `<div class="item" data-act="openBill" data-arg="${b.id}" role="button" tabindex="0">
    <div class="item-d"><b>${fmtDateShort(b.date)}</b><small>${weekday(b.date)}</small></div>
    <div class="item-m"><div class="item-t">${tag}${esc(b.title || '未命名')}</div>
      <div class="item-s">${sub}</div>
      <div class="avs">${b.split.members.map((id) => av(id, 'xs')).join('')}</div></div>
    <div class="item-r">${money(b.amount, b.currency)}</div></div>`;
}
function payRow(p) {
  const cr = C.creditOf(p, C.rateOf(p, D()));
  return `<div class="item" data-act="openPay" data-arg="${p.id}" role="button" tabindex="0">
    <div class="item-d"><b>${fmtDateShort(p.date)}</b><small>${weekday(p.date)}</small></div>
    <div class="item-m"><div class="item-t"><span class="tag pay">还款</span>${nm(p.from)} → ${nm(p.to)}</div>
      <div class="item-s">${p.method ? esc(p.method) : '未记录方式'}${cr.cur !== p.currency ? ` · 抵扣 ${moneyText(cr.amt, cr.cur)}` : ''}${p.note ? ' · ' + esc(p.note) : ''}</div></div>
    <div class="item-r pos">${money(p.amount, p.currency)}</div></div>`;
}

function openBill(id) {
  const b = D().bills.find((x) => x.id === id);
  if (!b) return toast('找不到这笔账', 'err');
  const sh = C.sharesOf(b);
  const rate = C.rateOf(b, D());
  const other = b.currency === 'JPY' ? 'CNY' : 'JPY';
  const modeTxt = { equal: '平均分', amount: '指定金额', ratio: '按比例' }[b.split.mode] || '平均分';
  const rows = b.split.members.map((mid) => {
    const v = sh[mid];
    const raw = b.split.mode !== 'equal' ? `<small class="muted">${b.split.mode === 'ratio' ? '比例 ' : '指定 '}${esc(String(b.split.values?.[mid] ?? 0))}</small>` : '';
    return `<div class="share-row">${av(mid)}<span class="nm"><span>${nm(mid)}${mid === b.payer ? '<small class="tag">付款人</small>' : ''}</span>${raw}</span>
      <span class="share-v">${money(v, b.currency)}<small class="muted">≈ ${moneyText(C.convert(v, b.currency, other, rate), other)}</small></span></div>`;
  }).join('');
  const payerIn = b.split.members.includes(b.payer);
  const creator = b.createdBy ? mem(b.createdBy).name : '';
  openModal(`
    <div class="bill-head">
      <div class="muted">${fmtDate(b.date, true)}${b.meal ? ' · ' + esc(b.meal) : ''}</div>
      <h2>${b.kind === 'carry' ? '<span class="tag carry">结转</span>' : ''}${esc(b.title || '未命名')}</h2>
      <div class="bill-amt">${money(b.amount, b.currency)}<small class="muted">≈ ${moneyText(C.convert(b.amount, b.currency, other, rate), other)}</small></div>
    </div>
    <dl class="kv">
      <dt>付款人</dt><dd>${av(b.payer, 'xs')} ${nm(b.payer)}</dd>
      <dt>支付方式</dt><dd>${esc(b.method || '未记录')}</dd>
      <dt>分账方式</dt><dd>${modeTxt}${b.split.mode === 'amount' ? '（没指定完的部分平均分）' : ''}</dd>
      <dt>汇率</dt><dd>100円 = ${(rate * 100).toFixed(4)}元 <small class="muted">${b.rate > 0 ? (b.rateSource === 'manual' ? '手动填写' : `${esc(b.rateSource || '')} ${esc(b.rateDate || '')}`) : '（缺失，按最近日期估算）'}</small></dd>
    </dl>
    <h3>${b.split.members.length} 人分摊${payerIn ? '' : '（付款人没有参与）'}</h3>
    <div class="shares">${rows}</div>
    ${b.note ? `<p class="note">${esc(b.note)}</p>` : ''}
    <p class="muted small">${creator ? `由 ${esc(creator)} 记录 · ` : ''}${b.createdAt ? new Date(b.createdAt).toLocaleString() : ''}</p>
    ${S.canWrite() ? `<div class="sheet-actions">
      <button class="btn" data-act="editBill" data-arg="${b.id}">编辑</button>
      ${b.kind !== 'carry' ? `<button class="btn" data-act="copyBill" data-arg="${b.id}">复制为新账</button>` : ''}
      <button class="btn danger" data-act="delBill" data-arg="${b.id}">删除</button></div>` : ''}`);
}

function openPayment(id) {
  const p = D().payments.find((x) => x.id === id);
  if (!p) return toast('找不到这条记录', 'err');
  const rate = C.rateOf(p, D());
  const cr = C.creditOf(p, rate);
  openModal(`
    <div class="bill-head"><div class="muted">${fmtDate(p.date, true)}</div>
      <h2><span class="tag pay">还款</span>${nm(p.from)} → ${nm(p.to)}</h2>
      <div class="bill-amt pos">${money(p.amount, p.currency)}</div></div>
    <dl class="kv">
      <dt>支付方式</dt><dd>${esc(p.method || '未记录')}</dd>
      <dt>抵扣</dt><dd>${cr.cur === p.currency ? `抵扣${CUR[p.currency].name}欠款` : `换算后抵扣 ${money(cr.amt, cr.cur)} ${CUR[cr.cur].name}欠款`}</dd>
      <dt>汇率</dt><dd>100円 = ${(rate * 100).toFixed(4)}元 <small class="muted">${p.rate > 0 ? (p.rateSource === 'manual' ? '手动填写' : `${esc(p.rateSource || '')} ${esc(p.rateDate || '')}`) : '（缺失，按最近日期估算）'}</small></dd>
    </dl>
    ${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}
    <p class="muted small">${p.createdBy ? `由 ${esc(mem(p.createdBy).name)} 记录 · ` : ''}${p.createdAt ? new Date(p.createdAt).toLocaleString() : ''}</p>
    ${S.canWrite() ? `<div class="sheet-actions"><button class="btn" data-act="editPay" data-arg="${p.id}">编辑</button>
      <button class="btn danger" data-act="delPay" data-arg="${p.id}">删除</button></div>` : ''}`);
}

// ================= 记一笔 =================
function guessMeal() {
  const h = new Date().getHours();
  return h < 10 ? '早餐' : h < 16 ? '午餐' : h < 22 ? '晚餐' : '夜宵';
}
function formTabs(active) {
  return `<div class="seg form-tabs"><a href="#/add" class="${active === 'bill' ? 'on' : ''}">消费</a><a href="#/pay" class="${active === 'pay' ? 'on' : ''}">还款 / 转账</a></div>`;
}

function rateMainHtml(f, st) {
  let main;
  if (st === 'loading') main = '<span class="muted">正在获取汇率…</span>';
  else if (f.rate > 0) {
    main = `<span>100円 = <b>${(f.rate * 100).toFixed(4)}</b>元</span><span class="muted">1元 ≈ ${(1 / f.rate).toFixed(2)}円</span>
      <small class="muted">${f.rateSource === 'manual' ? '手动填写' : `${esc(f.rateSource || '')} · ${f.rateDate === f.date ? '当天' : esc(f.rateDate || '')}${f.rateDate && f.rateDate !== f.date ? '（最近交易日）' : ''}`}</small>`;
  } else main = '<span class="err">没取到汇率，可以手动填写（不填也能保存，换算时用最近日期的汇率）</span>';
  return main;
}
const rateBtnsHtml = (f) => `<button type="button" class="link" data-f="editRate">手动修改</button>${f.rateSource === 'manual' ? '<button type="button" class="link" data-f="autoRate">恢复自动</button>' : ''}`;
function rateBoxHtml(f, st, editing) {
  return `<div class="rate-main">${rateMainHtml(f, st)}</div><div class="rate-btns">${rateBtnsHtml(f)}</div>
    <div class="rate-edit" ${editing ? '' : 'hidden'}>100円 = <input name="rateManual" inputmode="decimal" value="${f.rate > 0 ? (f.rate * 100).toFixed(4) : ''}"> 元</div>`;
}
function updateRateText(form, f) {
  form.querySelector('.rate-main').innerHTML = rateMainHtml(f, 'ok');
  form.querySelector('.rate-btns').innerHTML = rateBtnsHtml(f);
}

function renderBillForm(editId, params = {}) {
  const d = D(), me = myId();
  const src = editId ? d.bills.find((b) => b.id === editId) : params.copy ? d.bills.find((b) => b.id === params.copy) : null;
  if (editId && !src) { $view.innerHTML = `<div class="empty"><p>找不到这笔账</p><a class="btn" href="#/bills">返回</a></div>`; return; }
  const active = d.members.filter((m) => !m.inactive).map((m) => m.id);
  const lastMembers = (prefs.lastMembers || active).filter((id) => active.includes(id));
  const f = src
    ? { ...clone(src), split: { mode: src.split.mode || 'equal', members: [...src.split.members], values: Object.fromEntries(Object.entries(src.split.values || {}).map(([k, v]) => [k, String(v)])) }, amount: String(src.amount) }
    : { kind: 'meal', date: today(), meal: guessMeal(), title: '', currency: prefs.lastCur || 'JPY', amount: '', payer: me || '', method: '', split: { mode: 'equal', members: lastMembers.length ? lastMembers : active, values: {} }, rate: null, rateDate: null, rateSource: null, note: '' };
  if (!editId && src) { // 复制为新账
    Object.assign(f, { id: undefined, date: today(), kind: 'meal', createdAt: undefined, createdBy: undefined, rate: null, rateDate: null, rateSource: null });
  }
  const shownIds = [...new Set([...active, ...f.split.members, f.payer].filter(Boolean))];
  const titles = [...new Set(d.bills.filter((b) => b.kind !== 'carry').sort((a, b) => (a.date < b.date ? 1 : -1)).map((b) => b.title).filter(Boolean))].slice(0, 40);
  const methods = [...new Set([...d.methods, f.method].filter(Boolean))];
  let rateState = f.rate > 0 ? 'ok' : 'loading';
  let rateEditing = false;

  $view.innerHTML = `
    <div class="page-h"><h1>${editId ? '编辑账目' : '记一笔'}</h1>${editId ? '' : formTabs('bill')}</div>
    ${readonlyNote()}
    <form id="bf" class="form" autocomplete="off" novalidate>
      ${f.kind === 'carry' ? '<div class="notice">这是一条<b>期初结转</b>记录（从 Excel 总账导入的欠款余额），付款人 = 收款人，分摊人 = 欠款人。</div>' : ''}
      <div class="grid2">
        <label class="field"><span class="lbl">日期</span><input type="date" name="date" value="${f.date}" required></label>
        <div class="field"><span class="lbl">类型</span>${chips('meal', MEALS.map((m) => [m, m]), f.meal, { toggle: true })}</div>
      </div>
      <label class="field"><span class="lbl">地点 / 内容</span><input name="title" value="${esc(f.title)}" placeholder="比如：一风堂 本乡三丁目" list="titles" enterkeyhint="next"></label>
      <datalist id="titles">${titles.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      <div class="field"><span class="lbl">金额</span>
        <div class="amount-row">${seg('currency', [['JPY', '日元'], ['CNY', '人民币']], f.currency)}
          <div class="amount-wrap"><input name="amount" class="amount-input" inputmode="decimal" value="${esc(f.amount)}" placeholder="0"><span class="unit" id="unit">${CUR[f.currency].unit}</span></div></div>
        <div class="hint" id="amountHint"></div>
      </div>
      <div class="field"><span class="lbl">谁付的钱</span>${chips('payer', memberOpts(shownIds), f.payer)}</div>
      <div class="field"><span class="lbl">支付方式</span>${chips('method', methods.map((m) => [m, esc(m)]), f.method, { toggle: true })}</div>
      <div class="field"><div class="lbl-row"><span class="lbl">${f.kind === 'carry' ? '欠款人' : '谁一起吃'} <b id="pc"></b></span>
        <span><button type="button" class="link" data-f="all">全选</button><button type="button" class="link" data-f="none">清空</button></span></div>
        ${chips('members', memberOpts(shownIds), f.split.members, { type: 'checkbox' })}</div>
      <div class="field"><span class="lbl">怎么分</span>
        ${seg('splitMode', [['equal', '平均分'], ['amount', '指定金额'], ['ratio', '按比例']], f.split.mode)}
        <div class="hint" id="splitHint"></div>
        <div id="splitRows" class="split-rows"></div>
      </div>
      <div class="field"><span class="lbl">汇率（按消费日，用于换算）</span><div class="rate-box" id="rateBox"></div></div>
      <label class="field"><span class="lbl">备注</span><textarea name="note" rows="2" placeholder="可选">${esc(f.note || '')}</textarea></label>
      <div class="form-actions"><button type="submit" class="btn primary block" ${S.canWrite() ? '' : 'disabled'}>${editId ? '保存修改' : '保存'}</button>
        ${editId ? `<a class="btn block" href="#/bills">取消</a>` : ''}</div>
    </form>`;

  const form = document.getElementById('bf');
  const $ = (s) => form.querySelector(s);

  function readForm() {
    const fd = new FormData(form);
    f.date = fd.get('date') || '';
    f.meal = fd.get('meal') || '';
    f.title = (fd.get('title') || '').trim();
    f.currency = fd.get('currency') || 'JPY';
    f.amount = fd.get('amount') || '';
    f.payer = fd.get('payer') || '';
    f.method = fd.get('method') || '';
    f.split.members = fd.getAll('members');
    f.split.mode = fd.get('splitMode') || 'equal';
    form.querySelectorAll('[data-sv]').forEach((i) => (f.split.values[i.dataset.sv] = i.value));
    f.note = fd.get('note') || '';
  }
  function buildBill() {
    const values = {};
    if (f.split.mode !== 'equal') for (const id of f.split.members) { const s = f.split.values[id]; values[id] = s === undefined || String(s).trim() === '' ? 0 : parseNum(s); }
    return {
      id: f.id, kind: f.kind || 'meal', date: f.date, meal: f.meal, title: f.title, currency: f.currency, amount: parseNum(f.amount),
      payer: f.payer, method: f.method,
      split: { mode: f.split.mode, members: [...f.split.members], ...(f.split.mode !== 'equal' ? { values } : {}) },
      rate: f.rate > 0 ? f.rate : null, rateDate: f.rateDate || null, rateSource: f.rateSource || null, note: f.note,
      createdAt: f.createdAt, createdBy: f.createdBy,
    };
  }
  function renderSplitRows() {
    const mode = f.split.mode;
    $('#pc').textContent = f.split.members.length ? `（${f.split.members.length} 人）` : '';
    $('#splitRows').innerHTML = f.split.members.map((id) => `<div class="split-row">${av(id)}<span class="nm">${nm(id)}</span>
      ${mode === 'equal' ? '' : `<input data-sv="${id}" inputmode="decimal" value="${esc(f.split.values[id] ?? '')}" placeholder="0" aria-label="${nm(id)}">`}
      <span class="share" data-share="${id}"></span></div>`).join('');
    updateShares();
  }
  function updateShares() {
    const bill = buildBill();
    const cur = bill.currency;
    const okAmt = bill.amount > 0;
    const sh = okAmt ? C.sharesOf(bill) : {};
    form.querySelectorAll('[data-share]').forEach((el) => {
      const v = sh[el.dataset.share];
      el.innerHTML = Number.isFinite(v) ? `${el.dataset.share === bill.payer ? '<small class="muted">自己 </small>' : ''}${money(v, cur)}` : '<span class="muted">—</span>';
    });
    $('#unit').textContent = CUR[cur].unit;
    const other = cur === 'JPY' ? 'CNY' : 'JPY';
    const ah = $('#amountHint');
    if (String(f.amount).trim() && !okAmt) ah.innerHTML = '<span class="err">金额格式不对</span>';
    else if (okAmt) ah.innerHTML = `${/[+\-*/]/.test(f.amount) ? `= ${money(bill.amount, cur)} · ` : ''}≈ ${moneyText(C.convert(bill.amount, cur, other, f.rate || refRate()), other)}`;
    else ah.innerHTML = '可以直接输入算式，例如 <code>3200+2880</code>';
    const n = f.split.members.length;
    const hint = $('#splitHint');
    if (!n) hint.innerHTML = '<span class="err">请选择参与人</span>';
    else if (f.split.mode === 'equal') hint.innerHTML = okAmt ? `${n} 人平均，每人 ${money(bill.amount / n, cur)}` : `${n} 人平均分`;
    else if (f.split.mode === 'amount') {
      const sum = f.split.members.reduce((s, id) => s + (Number.isFinite(bill.split.values[id]) ? bill.split.values[id] : 0), 0);
      const rem = (bill.amount || 0) - sum;
      hint.innerHTML = !okAmt ? '填写每个人的金额（可以写算式）' : rem < -CUR[cur].eps
        ? `<span class="err">已指定 ${moneyText(sum, cur)}，超出总额 ${moneyText(-rem, cur)}</span>`
        : isZero(rem, cur) ? `已指定 ${moneyText(sum, cur)}，正好等于总额` : `已指定 ${moneyText(sum, cur)}，剩下 ${moneyText(rem, cur)} 由 ${n} 人平均分（每人 +${moneyText(rem / n, cur)}）`;
    } else hint.innerHTML = '填每个人的比例或各自点单的价格，总额按比例分摊（适合用人民币刷卡、按日元菜价分的情况）';
  }
  let rateSeq = 0;
  async function loadRate(force) {
    if (f.rateSource === 'manual' && !force) return;
    if (!f.date) return;
    const seq = ++rateSeq;
    rateState = 'loading';
    renderRate();
    try {
      const r = await getRate(f.date);
      if (seq !== rateSeq) return;
      Object.assign(f, { rate: r.rate, rateDate: r.date, rateSource: r.source });
      rateState = 'ok';
    } catch {
      if (seq !== rateSeq) return;
      Object.assign(f, { rate: null, rateDate: null, rateSource: null });
      rateState = 'error';
    }
    renderRate();
    updateShares();
  }
  function renderRate() { $('#rateBox').innerHTML = rateBoxHtml(f, rateState, rateEditing); }

  let snap = '';
  const snapshot = () => [f.split.members.join(), f.split.mode, f.date, f.currency].join('#');
  function onInput(e) {
    if (e.target.name === 'rateManual') {
      const v = parseNum(e.target.value) / 100;
      if (v > 0) { f.rate = v; f.rateSource = 'manual'; f.rateDate = f.date; rateState = 'ok'; updateRateText(form, f); updateShares(); }
      return;
    }
    const before = snap;
    const prevDate = f.date;
    readForm();
    snap = snapshot();
    if (before !== snap) renderSplitRows(); else updateShares();
    if (prevDate !== f.date) loadRate();
  }
  form.addEventListener('input', onInput);
  form.addEventListener('change', onInput);
  form.addEventListener('click', (e) => {
    const i = e.target;
    if (i.matches?.('input[type=radio][data-toggle]')) {
      if (i.dataset.was === '1') { i.checked = false; i.dataset.was = ''; onInput({ target: i }); }
      else { form.querySelectorAll(`input[name="${i.name}"]`).forEach((x) => (x.dataset.was = '')); i.dataset.was = '1'; }
      return;
    }
    const b = e.target.closest('[data-f]');
    if (!b) return;
    e.preventDefault();
    const act = b.dataset.f;
    if (act === 'all' || act === 'none') { form.querySelectorAll('input[name=members]').forEach((x) => (x.checked = act === 'all')); onInput({ target: b }); }
    if (act === 'editRate') { rateEditing = true; renderRate(); $('[name=rateManual]').focus(); }
    if (act === 'autoRate') { f.rateSource = null; rateEditing = false; loadRate(true); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    readForm();
    const bill = buildBill();
    const err = C.billError(bill, (id) => mem(id).name);
    if (err) return toast(err, 'err');
    if (!S.canWrite()) return toast('只读模式，请先在设置里填写 GitHub Token', 'err');
    const now = nowISO();
    bill.id = editId || uid('b');
    bill.updatedAt = now;
    if (!editId) { bill.createdAt = now; bill.createdBy = me || ''; }
    if (bill.kind !== 'carry') { setPref('lastCur', bill.currency); setPref('lastMembers', bill.split.members); }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = '保存中…';
    const ok = await save({ t: 'putBill', v: bill }, `${editId ? '修改' : '记账'} ${bill.date} ${bill.title || ''} ${bill.amount}${bill.currency}`);
    btn.disabled = false;
    btn.textContent = '保存';
    if (ok) location.hash = '#/bills';
  });

  readForm();
  snap = snapshot();
  renderSplitRows();
  renderRate();
  if (!(f.rate > 0)) loadRate(true);
}

// ================= 还款 =================
function renderPayForm(editId, params = {}) {
  const d = D(), me = myId();
  const src = editId ? d.payments.find((p) => p.id === editId) : null;
  if (editId && !src) { $view.innerHTML = `<div class="empty"><p>找不到这条记录</p><a class="btn" href="#/bills">返回</a></div>`; return; }
  const owed = { JPY: params.JPY, CNY: params.CNY };
  const cur0 = params.JPY ? 'JPY' : params.CNY ? 'CNY' : prefs.lastCur || 'JPY';
  const f = src
    ? { ...clone(src), amount: String(src.amount), credit: src.creditCurrency && src.creditCurrency !== src.currency ? 'other' : 'same' }
    : { date: today(), from: params.from || me || '', to: params.to || '', currency: cur0, amount: owed[cur0] ? String(owed[cur0]) : '', method: '', credit: 'same', rate: null, rateDate: null, rateSource: null, note: '' };
  let touched = !!src;
  const active = d.members.filter((m) => !m.inactive).map((m) => m.id);
  const shownIds = [...new Set([...active, f.from, f.to].filter(Boolean))];
  const methods = [...new Set([...d.methods, f.method].filter(Boolean))];
  let rateState = f.rate > 0 ? 'ok' : 'loading';
  let rateEditing = false;

  $view.innerHTML = `
    <div class="page-h"><h1>${editId ? '编辑还款' : '记录还款'}</h1>${editId ? '' : formTabs('pay')}</div>
    ${readonlyNote()}
    <form id="pf" class="form" autocomplete="off" novalidate>
      <p class="muted small">谁把钱还给了谁。保存后，对应的欠款会自动减少。</p>
      <label class="field"><span class="lbl">日期</span><input type="date" name="date" value="${f.date}"></label>
      <div class="field"><span class="lbl">谁还钱（付款）</span>${chips('from', memberOpts(shownIds), f.from)}</div>
      <div class="field"><span class="lbl">还给谁（收款）</span>${chips('to', memberOpts(shownIds), f.to)}</div>
      <div class="field"><span class="lbl">金额</span>
        <div class="amount-row">${seg('currency', [['JPY', '日元'], ['CNY', '人民币']], f.currency)}
          <div class="amount-wrap"><input name="amount" class="amount-input" inputmode="decimal" value="${esc(f.amount)}" placeholder="0"><span class="unit" id="unit">${CUR[f.currency].unit}</span></div></div>
        <div class="hint" id="owedHint"></div>
      </div>
      <div class="field"><span class="lbl">支付方式</span>${chips('method', methods.map((m) => [m, esc(m)]), f.method, { toggle: true })}</div>
      <div class="field"><span class="lbl">抵扣哪种欠款</span><div id="creditBox"></div><div class="hint" id="creditHint"></div></div>
      <div class="field"><span class="lbl">汇率（按还款日）</span><div class="rate-box" id="rateBox"></div></div>
      <label class="field"><span class="lbl">备注</span><textarea name="note" rows="2" placeholder="可选">${esc(f.note || '')}</textarea></label>
      <div class="form-actions"><button type="submit" class="btn primary block" ${S.canWrite() ? '' : 'disabled'}>保存</button>
        ${editId ? `<a class="btn block" href="#/bills">取消</a>` : ''}</div>
    </form>`;
  const form = document.getElementById('pf');
  const $ = (s) => form.querySelector(s);
  const otherCur = () => (f.currency === 'JPY' ? 'CNY' : 'JPY');

  function readForm() {
    const fd = new FormData(form);
    f.date = fd.get('date') || '';
    f.from = fd.get('from') || '';
    f.to = fd.get('to') || '';
    f.currency = fd.get('currency') || 'JPY';
    f.amount = fd.get('amount') || '';
    f.method = fd.get('method') || '';
    f.credit = fd.get('credit') || 'same';
    f.note = fd.get('note') || '';
  }
  function renderCredit() {
    $('#creditBox').innerHTML = seg('credit', [['same', `${CUR[f.currency].name}欠款`], ['other', `换算后抵${CUR[otherCur()].name}欠款`]], f.credit);
  }
  function update() {
    $('#unit').textContent = CUR[f.currency].unit;
    const amt = parseNum(f.amount);
    const ch = $('#creditHint');
    if (f.credit === 'other' && amt > 0) {
      const v = C.convert(amt, f.currency, otherCur(), f.rate || refRate());
      ch.innerHTML = `按还款日汇率，相当于抵扣 ${money(v, otherCur())} 的${CUR[otherCur()].name}欠款`;
    } else ch.innerHTML = f.credit === 'other' ? '比如：欠的是日元，用微信/支付宝还人民币' : '';
    // 当前欠款提示
    const oh = $('#owedHint');
    if (f.from && f.to && f.from !== f.to) {
      const debts = C.debtsPairwise(D(), 'split').filter((x) => (x.from === f.from && x.to === f.to));
      const o = {}; debts.forEach((x) => (o[x.cur] = x.amt));
      oh.innerHTML = debts.length ? `目前 ${nm(f.from)} 欠 ${nm(f.to)}：${amts(o)}` : `目前 ${nm(f.from)} 不欠 ${nm(f.to)} 钱`;
    } else oh.innerHTML = f.from && f.from === f.to ? '<span class="err">付款人和收款人不能是同一个人</span>' : '';
  }
  let rateSeq = 0;
  async function loadRate(force) {
    if (f.rateSource === 'manual' && !force) return;
    if (!f.date) return;
    const seq = ++rateSeq;
    rateState = 'loading';
    renderRate();
    try {
      const r = await getRate(f.date);
      if (seq !== rateSeq) return;
      Object.assign(f, { rate: r.rate, rateDate: r.date, rateSource: r.source });
      rateState = 'ok';
    } catch {
      if (seq !== rateSeq) return;
      Object.assign(f, { rate: null, rateDate: null, rateSource: null });
      rateState = 'error';
    }
    renderRate();
    update();
  }
  function renderRate() { $('#rateBox').innerHTML = rateBoxHtml(f, rateState, rateEditing); }

  function onInput(e) {
    if (e.target.name === 'rateManual') {
      const v = parseNum(e.target.value) / 100;
      if (v > 0) { f.rate = v; f.rateSource = 'manual'; f.rateDate = f.date; rateState = 'ok'; updateRateText(form, f); update(); }
      return;
    }
    if (e.target.name === 'amount') touched = true;
    const prev = { date: f.date, cur: f.currency, from: f.from, to: f.to };
    readForm();
    if (prev.cur !== f.currency) {
      if (!touched && owed[f.currency]) { f.amount = String(owed[f.currency]); $('[name=amount]').value = f.amount; }
      renderCredit();
    }
    if (!touched && !src && (prev.from !== f.from || prev.to !== f.to) && f.from && f.to) {
      const x = C.debtsPairwise(D(), 'split').find((y) => y.from === f.from && y.to === f.to && y.cur === f.currency);
      f.amount = x ? String(roundCur(x.amt, f.currency)) : '';
      $('[name=amount]').value = f.amount;
    }
    update();
    if (prev.date !== f.date) loadRate();
  }
  form.addEventListener('input', onInput);
  form.addEventListener('change', onInput);
  form.addEventListener('click', (e) => {
    const i = e.target;
    if (i.matches?.('input[type=radio][data-toggle]')) {
      if (i.dataset.was === '1') { i.checked = false; i.dataset.was = ''; onInput({ target: i }); }
      else { form.querySelectorAll(`input[name="${i.name}"]`).forEach((x) => (x.dataset.was = '')); i.dataset.was = '1'; }
      return;
    }
    const b = e.target.closest('[data-f]');
    if (!b) return;
    e.preventDefault();
    if (b.dataset.f === 'editRate') { rateEditing = true; renderRate(); $('[name=rateManual]').focus(); }
    if (b.dataset.f === 'autoRate') { f.rateSource = null; rateEditing = false; loadRate(true); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    readForm();
    const amount = parseNum(f.amount);
    if (!f.date) return toast('请选择日期', 'err');
    if (!f.from || !f.to) return toast('请选择付款人和收款人', 'err');
    if (f.from === f.to) return toast('付款人和收款人不能是同一个人', 'err');
    if (!(amount > 0)) return toast('请输入正确的金额', 'err');
    if (!S.canWrite()) return toast('只读模式，请先在设置里填写 GitHub Token', 'err');
    const now = nowISO();
    const p = {
      id: editId || uid('p'), date: f.date, from: f.from, to: f.to, currency: f.currency, amount, method: f.method,
      rate: f.rate > 0 ? f.rate : null, rateDate: f.rateDate || null, rateSource: f.rateSource || null, note: f.note,
      createdAt: src?.createdAt || now, createdBy: src ? src.createdBy : me || '', updatedAt: now,
    };
    if (f.credit === 'other') {
      p.creditCurrency = otherCur();
      p.creditAmount = C.convert(amount, f.currency, p.creditCurrency, f.rate > 0 ? f.rate : refRate());
    }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    const ok = await save({ t: 'putPayment', v: p }, `${editId ? '修改还款' : '还款'} ${p.date} ${mem(p.from).short}→${mem(p.to).short} ${amount}${p.currency}`);
    btn.disabled = false;
    if (ok) location.hash = editId ? '#/bills' : '#/';
  });

  renderCredit();
  update();
  renderRate();
  if (!(f.rate > 0)) loadRate(true);
}

// ================= 统计 =================
function statsRange() {
  const t = today(), y = t.slice(0, 4), m = t.slice(0, 7);
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  const lm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  switch (prefs.statsRange) {
    case 'year': return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'month': return { from: `${m}-01`, to: `${m}-31` };
    case 'lastMonth': return { from: `${lm}-01`, to: `${lm}-31` };
    case 'custom': return { from: prefs.statsFrom || '', to: prefs.statsTo || '' };
    default: return {};
  }
}
function renderStats() {
  const d = D();
  const range = statsRange();
  const mode = prefs.statsMode;
  const st = C.stats(d, range);
  const people = d.members.filter((m) => st.per[m.id]).sort((a, b) => st.per[b.id].paid.toCNY - st.per[a.id].paid.toCNY);
  const personCards = people.map((m) => {
    const p = st.per[m.id];
    const diff = { JPY: p.paid.JPY - p.used.JPY, CNY: p.paid.CNY - p.used.CNY, toCNY: p.paid.toCNY - p.used.toCNY, toJPY: p.paid.toJPY - p.used.toJPY };
    return `<div class="stat-p">
      <div class="stat-p-h">${av(m.id)}<b>${nm(m.id)}</b><small class="muted">付款 ${p.paidCount} 次 · 参与 ${p.joinCount} 次</small></div>
      <dl class="kv sm">
        <dt>付了</dt><dd>${modeAmts(p.paid, mode)}</dd>
        <dt>自己吃了</dt><dd>${modeAmts(p.used, mode)}</dd>
        <dt>垫付差额</dt><dd>${modeAmts(diff, mode)}</dd>
      </dl></div>`;
  }).join('');
  const methodRows = Object.entries(st.methods).sort((a, b) => b[1].count - a[1].count)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${v.count}</td><td class="r">${modeAmts(v.amt, mode)}</td></tr>`).join('');
  const placeRows = Object.entries(st.places).sort((a, b) => b[1].count - a[1].count || b[1].amt.toCNY - a[1].amt.toCNY).slice(0, 10)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${v.count}</td><td class="r">${modeAmts(v.amt, mode)}</td></tr>`).join('');
  $view.innerHTML = `
    <div class="page-h"><h1>统计</h1></div>
    <div class="controls">
      ${seg('statsRange', [['all', '全部'], ['year', '今年'], ['month', '本月'], ['lastMonth', '上月'], ['custom', '自定义']], prefs.statsRange, { pref: true, cls: 'sm' })}
      ${prefs.statsRange === 'custom' ? `<div class="controls-row"><input type="date" name="statsFrom" data-pref value="${esc(prefs.statsFrom)}"> 至 <input type="date" name="statsTo" data-pref value="${esc(prefs.statsTo)}"></div>` : ''}
      ${seg('statsMode', [['split', '分币种'], ['CNY', '换算人民币'], ['JPY', '换算日元']], mode, { pref: true, cls: 'sm' })}
    </div>
    <section class="card summary2">
      <div><small>聚餐 / 消费</small><div class="big"><span>${st.total.count}<small> 次</small></span></div></div>
      <div><small>总花费</small><div class="big">${modeAmts(st.total.amt, mode)}</div></div>
    </section>
    <section class="card"><h3>每个人</h3>${personCards || '<p class="muted pad">这段时间没有记录</p>'}</section>
    <section class="card"><h3>支付方式</h3>${methodRows ? `<table class="tbl"><thead><tr><th>方式</th><th class="r">次数</th><th class="r">金额</th></tr></thead><tbody>${methodRows}</tbody></table>` : '<p class="muted pad">没有记录</p>'}</section>
    <section class="card"><h3>常去的店</h3>${placeRows ? `<table class="tbl"><thead><tr><th>地点</th><th class="r">次数</th><th class="r">金额</th></tr></thead><tbody>${placeRows}</tbody></table>` : '<p class="muted pad">没有记录</p>'}</section>
    <p class="foot">统计不包含「期初结转」。「垫付差额」= 付了 − 自己吃了，正数表示替别人垫的钱多。</p>`;
}

// ================= 设置 =================
function renderSettings() {
  const d = D(), cfg = S.getConfig(), me = myId(), w = S.canWrite();
  const st = S.state;
  $view.innerHTML = `
    <div class="page-h"><h1>设置</h1></div>
    ${syncErrorNote()}
    <section class="card"><h3>我是谁 <small class="muted">（只保存在这台设备）</small></h3>
      <div class="chips pad">${d.members.filter((m) => !m.inactive).map((m) => `<button class="chip-btn ${m.id === me ? 'on' : ''}" data-act="setMe" data-arg="${m.id}">${av(m.id, 'xs')}${nm(m.id)}</button>`).join('') || '<span class="muted">先添加成员</span>'}</div>
    </section>

    <section class="card"><div class="card-h"><b>成员</b>${w ? '<button class="btn-mini card-h-r" data-act="addMember">＋ 添加</button>' : ''}</div>
      ${d.members.map((m) => `<div class="mem-row" ${w ? `data-act="editMember" data-arg="${m.id}" role="button" tabindex="0"` : ''}>${av(m.id)}<span class="nm">${nm(m.id)}${m.inactive ? ' <small class="tag">已隐藏</small>' : ''}</span><small class="muted">${esc(m.short)}</small>${w ? '<span class="chev">›</span>' : ''}</div>`).join('') || '<p class="muted pad">还没有成员</p>'}
    </section>

    <section class="card"><h3>支付方式</h3>
      <div class="method-list">${d.methods.map((m, i) => `<div class="method">${esc(m)}${w ? `<span class="method-btns">${i > 0 ? `<button class="icon-btn" data-act="moveMethod" data-arg="${esc(m)}|up" aria-label="上移">↑</button>` : ''}<button class="icon-btn" data-act="delMethod" data-arg="${esc(m)}" aria-label="删除">×</button></span>` : ''}</div>`).join('')}</div>
      ${w ? `<form id="methodForm" class="inline-form"><input name="m" placeholder="新的支付方式，例如 Suica"><button class="btn sm">添加</button></form>` : ''}
    </section>

    <section class="card"><h3>GitHub 同步</h3>
      <p class="muted small pad">数据保存在仓库里的 <code>${esc(cfg.path)}</code>，每次保存都是一次 commit（可在 GitHub 上查看历史）。<br>
        状态：<b>${{ github: '已连接，可记账', readonly: '只读（未填写 Token）', local: '本地模式（数据只存在这个浏览器里）' }[st.mode]}</b></p>
      <form id="gitForm" class="form compact">
        <div class="grid2">
          <label class="field"><span class="lbl">GitHub 用户名</span><input name="owner" value="${esc(cfg.owner)}" placeholder="ruhui-liu" autocapitalize="off"></label>
          <label class="field"><span class="lbl">仓库名</span><input name="repo" value="${esc(cfg.repo)}" placeholder="meal-ledger" autocapitalize="off"></label>
          <label class="field"><span class="lbl">分支</span><input name="branch" value="${esc(cfg.branch)}" autocapitalize="off"></label>
          <label class="field"><span class="lbl">数据文件路径</span><input name="path" value="${esc(cfg.path)}" autocapitalize="off"></label>
        </div>
        <label class="field"><span class="lbl">Token（只保存在这台设备）</span><input name="token" type="password" value="" placeholder="${cfg.token ? '已保存（留空表示不修改）' : 'github_pat_…'}" autocapitalize="off" autocomplete="off"></label>
        <p class="muted small">在 <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Settings → Fine-grained tokens</a> 新建：Repository access 只选这个仓库，Permissions → Contents 选 <b>Read and write</b>。</p>
        <div class="btn-row"><button class="btn primary" type="submit">保存并连接</button><button class="btn" type="button" id="testGit">测试连接</button>${cfg.token ? '<button class="btn danger" type="button" id="clearToken">删除 Token</button>' : ''}</div>
        <div id="gitMsg" class="hint"></div>
      </form>
    </section>

    <section class="card"><h3>数据</h3>
      <div class="btn-row pad"><button class="btn" data-act="exportJSON">导出 JSON 备份</button><button class="btn" data-act="exportCSV">导出 CSV（Excel 可打开）</button>
        ${w ? '<button class="btn" data-act="importJSON">从 JSON 恢复</button>' : ''}<button class="btn" data-act="refresh">重新加载</button>
        ${st.pending ? '<button class="btn danger" data-act="discard">放弃未同步的修改</button>' : ''}</div>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
      <p class="muted small pad">共 ${d.bills.length} 笔账、${d.payments.length} 条还款、${d.members.length} 位成员。${d.updatedAt ? `最后更新 ${new Date(d.updatedAt).toLocaleString()}` : ''}</p>
    </section>`;

  const mf = document.getElementById('methodForm');
  mf?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = mf.m.value.trim();
    if (!v) return;
    if (d.methods.includes(v)) return toast('已经有这个支付方式了', 'err');
    mf.m.value = '';
    await save({ t: 'setMethods', v: [...d.methods, v] }, `添加支付方式 ${v}`);
  });
  const gf = document.getElementById('gitForm');
  const msg = document.getElementById('gitMsg');
  gf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = { owner: gf.owner.value.trim(), repo: gf.repo.value.trim(), branch: gf.branch.value.trim() || 'main', path: gf.path.value.trim() || 'data/ledger.json' };
    if (gf.token.value.trim()) patch.token = gf.token.value.trim();
    S.saveConfig(patch);
    msg.textContent = '连接中…';
    const r = await S.testConnection();
    toast(r.message, r.ok && r.canPush ? 'ok' : r.ok ? 'warn' : 'err');
    await S.refresh();
  });
  document.getElementById('testGit').addEventListener('click', async () => {
    msg.textContent = '测试中…';
    const c = { ...S.getConfig(), owner: gf.owner.value.trim(), repo: gf.repo.value.trim() };
    if (gf.token.value.trim()) c.token = gf.token.value.trim();
    const r = await S.testConnection(c);
    msg.innerHTML = r.ok ? `<span class="pos">${esc(r.message)}${r.private === false ? '（这是公开仓库）' : ''}</span>` : `<span class="err">${esc(r.message)}</span>`;
  });
  document.getElementById('clearToken')?.addEventListener('click', () => {
    if (!confirm('从这台设备删除 Token？删除后变为只读。')) return;
    S.saveConfig({ token: '' });
    S.refresh();
  });
  document.getElementById('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.bills) || !Array.isArray(data.members)) throw new Error('文件格式不对');
      if (!confirm(`用这个文件（${data.bills.length} 笔账、${(data.payments || []).length} 条还款）覆盖现在的全部数据？`)) return;
      await save({ t: 'replaceAll', v: data }, '从 JSON 恢复数据');
    } catch (err) {
      toast('导入失败：' + err.message, 'err');
    }
    e.target.value = '';
  });
}

function editMember(id) {
  const d = D();
  const m = id ? d.members.find((x) => x.id === id) : { id: '', name: '', short: '', inactive: false };
  if (!m) return;
  const used = id && (d.bills.some((b) => b.payer === id || b.split.members.includes(id)) || d.payments.some((p) => p.from === id || p.to === id));
  openModal(`<h2 class="sheet-t">${id ? '编辑成员' : '添加成员'}</h2>
    <form id="memForm" class="form compact">
      <label class="field"><span class="lbl">名字</span><input name="name" value="${esc(m.name)}" placeholder="例如：Ruhui / 刘如慧" required></label>
      <label class="field"><span class="lbl">简称（头像上显示，1–3 个字）</span><input name="short" value="${esc(m.short)}" maxlength="3" placeholder="RH"></label>
      <label class="field"><span class="lbl">颜色</span><input name="color" type="color" value="${m.color || (id ? color(id) : PALETTE[d.members.length % PALETTE.length])}"></label>
      ${id ? `<label class="check"><input type="checkbox" name="inactive" ${m.inactive ? 'checked' : ''}> 隐藏（毕业/不常来了：记账时不再默认显示，历史账目保留）</label>` : ''}
      <div class="btn-row"><button class="btn primary" type="submit">保存</button>
        ${id && !used ? '<button class="btn danger" type="button" id="delMem">删除</button>' : ''}</div>
      ${used ? '<p class="muted small">这个成员已经有账目记录，不能删除，可以选择隐藏。</p>' : ''}
    </form>`, (sheet) => {
    const fm = sheet.querySelector('#memForm');
    fm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = fm.name.value.trim();
      if (!name) return toast('请输入名字', 'err');
      const short = fm.short.value.trim() || name.slice(0, 2);
      const v = { ...m, id: id || uid('m'), name, short, color: fm.color.value, inactive: !!fm.inactive?.checked };
      if (!v.inactive) delete v.inactive;
      closeModal();
      await save({ t: 'putMember', v }, `${id ? '修改' : '添加'}成员 ${name}`);
    });
    sheet.querySelector('#delMem')?.addEventListener('click', async () => {
      if (!confirm(`删除成员 ${m.name}？`)) return;
      closeModal();
      await save({ t: 'delMember', id }, `删除成员 ${m.name}`);
    });
  });
}

// ================= CSV =================
function toCSV() {
  const d = D();
  const ms = d.members;
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const head = ['类型', '日期', '餐别', '地点/内容', '币种', '金额', '付款人', '支付方式', '分账方式', ...ms.map((m) => `${m.name}(${m.short})`), '汇率(1円=元)', '备注'];
  const lines = [head.map(q).join(',')];
  const sorted = [...d.bills].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const b of sorted) {
    const sh = C.sharesOf(b);
    lines.push([b.kind === 'carry' ? '期初结转' : '消费', b.date, b.meal || '', b.title || '', b.currency, b.amount, mem(b.payer).name, b.method || '',
      { equal: '平均', amount: '指定金额', ratio: '按比例' }[b.split.mode] || '平均',
      ...ms.map((m) => (sh[m.id] !== undefined ? roundCur(sh[m.id], b.currency) : '')), C.rateOf(b, d), b.note || ''].map(q).join(','));
  }
  for (const p of [...d.payments].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const cr = C.creditOf(p, C.rateOf(p, d));
    lines.push(['还款', p.date, '', `${mem(p.from).name} → ${mem(p.to).name}`, p.currency, p.amount, mem(p.from).name, p.method || '',
      cr.cur !== p.currency ? `抵扣 ${roundCur(cr.amt, cr.cur)} ${cr.cur}` : '', ...ms.map(() => ''), C.rateOf(p, d), p.note || ''].map(q).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

// ================= 启动 =================
renderSync();
route();
S.init();
