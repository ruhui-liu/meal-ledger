import * as S from './store.js';
import * as C from './calc.js';
import { t, getLang, setLang } from './i18n.js';
import {
  CUR, CURS, esc, uid, today, nowISO, fmtDate, fmtDateShort, weekday, monthKey, fmtMonth,
  roundCur, isZero, num, money, moneyText, unit, parseNum, readLS, writeLS, clone,
} from './util.js';

const $view = document.getElementById('view');
const MEALS = ['早餐', '午餐', '晚餐', '夜宵', '其他']; // 存的是中文，显示时翻译
const PALETTE = ['#d9480f', '#1c7ed6', '#2b8a3e', '#9c36b5', '#e67700', '#0b7285', '#c2255c', '#5c940d', '#6741d9', '#a61e4d'];
const FORM_VIEWS = new Set(['add', 'edit', 'pay']);
const THEMES = [['material', 'Google 简约（默认）'], ['ios', 'iOS 原生'], ['mint', '清爽薄荷绿'], ['night', '深色金融'], ['play', '活泼圆润'], ['oneui', '三星 One UI'], ['warm', '暖橙（原版）']];

const prefs = Object.assign(
  { balMode: 'split', balAlgo: 'pair', balScope: 'all', statsRange: 'all', statsMode: 'split', statsFrom: '', statsTo: '', billType: 'all', billPerson: '', billRange: 'all', billFrom: '', billTo: '' },
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
const avatarOk = (src) => typeof src === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(src);
const av = (id, cls = '') => {
  const m = mem(id);
  const inner = avatarOk(m.avatar) ? `<img src="${m.avatar}" alt="" loading="lazy" decoding="async">` : esc(m.short || m.name.slice(0, 2));
  return `<span class="av ${cls}${avatarOk(m.avatar) ? ' has-img' : ''}" style="--c:${color(id)}" title="${esc(m.name)}">${inner}</span>`;
};
/** 读取图片 → 居中裁成正方形 → 缩到 128px → JPEG data URL */
function resizeAvatar(file, size = 128) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t('照片读取失败'))); };
    img.src = url;
  });
}
const nm = (id) => esc(mem(id).name);
const nmShort = (id) => esc(mem(id).short || mem(id).name);
const curName = (c) => t(CUR[c].name);
const tm = (s) => esc(t(s)); // 翻译存储里的固定值（餐别、默认支付方式）
/** 结转记录的标题：英文模式下用通用标题替换数据里的中文 */
function titleOf(b) {
  if (b.kind === 'carry' && getLang() === 'en') return esc(t('期初结转：欠 {name} 的{cur}', { name: mem(b.payer).name, cur: b.currency }));
  return esc(b.title || t('未命名'));
}

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
const rateText = (r) => `100${unit('JPY')} = <b>${(r * 100).toFixed(4)}</b>${unit('CNY')}`;

function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.className = `toast ${kind}`), 2800);
}

function openModal(html, mount) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-back"><div class="sheet" role="dialog" aria-modal="true"><button class="sheet-close" data-close aria-label="${t('关闭')}">×</button>${html}</div></div>`;
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
  return `<div class="notice">${t('现在是<b>只读模式</b>，可以查看但不能记账。要记账请到 <a href="#/settings">设置</a> 填写 GitHub Token。')}</div>`;
}
function syncErrorNote() {
  const st = S.state;
  if (st.status !== 'error' && !st.pending) return '';
  return `<div class="notice warn">${st.pending ? t('有 <b>{n}</b> 条修改还没同步到 GitHub。', { n: st.pending }) : ''}${st.status === 'error' ? t('同步出错：{err}', { err: esc(st.error) }) : ''}
    <button class="btn-mini" data-act="refresh">${t('重试')}</button></div>`;
}

// ---------------- 语言 ----------------
function applyStaticText() {
  document.title = t('饭账本');
  document.documentElement.lang = getLang() === 'en' ? 'en' : 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  const btn = document.getElementById('langBtn');
  btn.textContent = getLang() === 'en' ? '中' : 'EN';
  btn.title = getLang() === 'en' ? '切换到中文' : 'Switch to English';
}
function switchLang(l) {
  setLang(l);
  applyStaticText();
  renderSync();
  closeModal();
  render();
}
document.getElementById('langBtn').addEventListener('click', () => switchLang(getLang() === 'en' ? 'zh' : 'en'));

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
  C.setRateTable(S.state.rates);
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
  let txt = t('已同步'), cls = 'ok';
  if (st.mode === 'local') { txt = t('本地模式'); cls = 'local'; }
  else if (st.status === 'loading') { txt = t('加载中…'); cls = 'busy'; }
  else if (st.status === 'saving') { txt = t('保存中…'); cls = 'busy'; }
  else if (st.pending) { txt = t('待同步 {n}', { n: st.pending }); cls = 'warn'; }
  else if (st.status === 'error') { txt = t('同步失败'); cls = 'err'; }
  else if (st.mode === 'readonly') { txt = t('只读'); cls = 'ro'; }
  el.className = `sync ${cls}`;
  el.innerHTML = `<i></i>${txt}`;
  el.title = st.error || (st.lastSync ? t('上次同步 {time}', { time: new Date(st.lastSync).toLocaleTimeString() }) : '');
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
    if (!b || !confirm(t('确定删除「{title}」吗？', { title: b.title || t('这笔账') }))) return;
    closeModal();
    await save({ t: 'delBill', id }, `删除 ${b.date} ${b.title} ${b.amount}${b.currency}`);
  },
  editPay: (id) => { location.hash = `#/pay/${id}`; },
  delPay: async (id) => {
    const p = D().payments.find((x) => x.id === id);
    if (!p || !confirm(t('确定删除这条还款记录吗？'))) return;
    closeModal();
    await save({ t: 'delPayment', id }, `删除还款 ${p.date} ${mem(p.from).short}→${mem(p.to).short}`);
  },
  setMe: (id) => { S.saveConfig({ me: id }); toast(t('已设定：我是 {name}', { name: mem(id).name })); render(); },
  setLang: (l) => switchLang(l),
  setTheme: (th) => {
    try { localStorage.setItem('fz.theme', th); } catch { /* ignore */ }
    document.documentElement.dataset.theme = th;
    render();
  },
  refresh: () => { if (S.state.pending && S.state.mode === 'github') S.flush(); else S.refresh(); },
  editMember: (id) => editMember(id),
  addMember: () => editMember(null),
  delMethod: async (name) => {
    if (!confirm(t('删除支付方式「{name}」？（已记录的账目不受影响）', { name: t(name) }))) return;
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
  exportJSON: () => download(`meal-ledger-${today()}.json`, JSON.stringify(D(), null, 2), 'application/json'),
  exportCSV: () => download(`meal-ledger-${today()}.csv`, toCSV(), 'text/csv'),
  importJSON: () => document.getElementById('importFile')?.click(),
  discard: () => { if (confirm(t('放弃本机还没同步的修改？'))) S.discardPending(); },
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  e.preventDefault();
  ACTIONS[el.dataset.act]?.(el.dataset.arg, el, e);
});
$view.addEventListener('change', (e) => {
  const el = e.target;
  if (el.hasAttribute?.('data-pref')) { setPref(el.name, el.value); render(); }
});

async function save(op, msg) {
  try {
    const ok = await S.commit(op, msg);
    if (ok) toast(t(S.state.mode === 'local' ? '已保存' : '已保存并同步到 GitHub'), 'ok');
    else toast(t('已保存在本机，网络恢复后会自动同步'), 'warn');
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
  return C.rateOf({ date: today() }, D());
}
/** 账目详情里显示的汇率说明 */
function rateDesc(rec) {
  const r = C.rateOf(rec, D());
  let src;
  if (rec.rateSource === 'manual' && rec.rate > 0) src = t('手动填写');
  else {
    const info = C.rateInfo(rec.date);
    src = info ? (info.exact ? t('银联 {date}', { date: info.date }) : t('暂用银联 {date} 的汇率（当天的还没发布，发布后自动更新）', { date: info.date })) : t('（汇率表缺失，估算）');
  }
  return `${rateText(r)} <small class="muted">${esc(src)}</small>`;
}
const magnitude = (a, rr) => (a.JPY || 0) * rr + (a.CNY || 0);
const sumAmts = (rows) => rows.reduce((s, r) => { for (const [c, v] of Object.entries(r.amts)) s[c] = (s[c] || 0) + v; return s; }, {});

function debtRow(r, show) {
  const who = show === 'to' ? r.to : r.from;
  const sub = show === 'to' ? t('你欠 TA') : show === 'from' && myId() === r.to ? t('欠你') : t('→ 付给 {name}', { name: nm(r.to) });
  const data = CURS.filter((c) => r.amts[c]).map((c) => `data-${c.toLowerCase()}="${roundCur(r.amts[c], c)}"`).join(' ');
  return `<div class="debt" data-act="openPair" data-arg="${r.from}|${r.to}" role="button" tabindex="0">
    ${av(who)}
    <div class="debt-who"><b>${nm(who)}</b><small>${sub}</small></div>
    <div class="debt-amt">${amts(r.amts)}</div>
    ${S.canWrite() ? `<button class="btn-mini" data-act="pay" data-arg="${r.from}|${r.to}" ${data}>${t('还款')}</button>` : ''}
  </div>`;
}

function renderBalances() {
  const d = D(), me = myId();
  if (!d.members.length) {
    $view.innerHTML = `<div class="empty"><p>${t('还没有成员。')}</p><a class="btn primary" href="#/settings">${t('去添加成员')}</a></div>`;
    return;
  }
  const mode = prefs.balMode, algo = prefs.balAlgo, scope = me ? prefs.balScope : 'all';
  const raw = algo === 'simple' ? C.debtsSimplified(d, mode) : C.debtsPairwise(d, mode);
  const rr = refRate();
  const rows = groupDebts(raw).sort((a, b) => magnitude(b.amts, rr) - magnitude(a.amts, rr));

  let main = '';
  if (!rows.length) {
    main = `<section class="card"><div class="empty small"><b>${t('全部结清')}</b><p class="muted">${t('目前没有任何欠款。')}</p></div></section>`;
  } else if (scope === 'me') {
    const owe = rows.filter((r) => r.from === me), recv = rows.filter((r) => r.to === me);
    const none = `<p class="muted pad">${t('没有')}</p>`;
    main = `<section class="card summary2">
        <div><small>${t('我要付给别人')}</small><div class="big neg">${amts(sumAmts(owe))}</div></div>
        <div><small>${t('别人要付给我')}</small><div class="big pos">${amts(sumAmts(recv))}</div></div>
      </section>
      <section class="card"><h3>${t('我要付给')}</h3>${owe.length ? owe.map((r) => debtRow(r, 'to')).join('') : none}</section>
      <section class="card"><h3>${t('要付给我')}</h3>${recv.length ? recv.map((r) => debtRow(r, 'from')).join('') : none}</section>`;
  } else {
    const byCred = new Map();
    for (const r of rows) { if (!byCred.has(r.to)) byCred.set(r.to, []); byCred.get(r.to).push(r); }
    main = [...byCred.entries()]
      .sort((a, b) => magnitude(sumAmts(b[1]), rr) - magnitude(sumAmts(a[1]), rr))
      .map(([to, list]) => `<section class="card">
        <div class="card-h">${av(to)}<div><b>${t('付给 {name}', { name: nm(to) })}</b><small>${t('{n} 人', { n: list.length })}</small></div><div class="card-h-r">${amts(sumAmts(list))}</div></div>
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
        ? parts.map((c) => `<span class="${v[c] > 0 ? 'pos' : 'neg'}">${t(v[c] > 0 ? '应收 ' : '应付 ')}${money(Math.abs(v[c]), c)}</span>`).join('')
        : `<span class="muted">${t('已结清')}</span>`;
      return `<div class="net-row">${av(m.id)}<span class="nm">${nm(m.id)}</span><span class="net-v">${cells}</span></div>`;
    }).join('');

  const whoAmI = !me ? `<section class="card pick-me"><b>${t('你是谁？')}</b><small class="muted">${t('选一下，就能用「只看我」查看自己的账（只保存在这台设备上）')}</small>
      <div class="chips">${d.members.filter((m) => !m.inactive).map((m) => `<button class="chip-btn" data-act="setMe" data-arg="${m.id}">${av(m.id, 'xs')}${nm(m.id)}</button>`).join('')}</div></section>` : '';

  $view.innerHTML = `
    <div class="page-h"><h1>${t('谁该给谁多少')}</h1></div>
    ${syncErrorNote()}
    ${whoAmI}
    <div class="controls">
      ${seg('balMode', [['split', t('分币种')], ['CNY', t('全换成人民币')], ['JPY', t('全换成日元')]], mode, { pref: true })}
      <div class="controls-row">
        ${seg('balAlgo', [['pair', t('两两抵消')], ['simple', t('最少转账')]], algo, { cls: 'sm', pref: true })}
        ${me ? seg('balScope', [['all', t('所有人')], ['me', t('只看我')]], scope, { cls: 'sm', pref: true }) : ''}
      </div>
    </div>
    ${main}
    <section class="card"><h3>${t('每个人的净额')}</h3>${netRows}</section>
    <p class="foot">${mode === 'split'
      ? t('日元和人民币分开计算，互不抵消。')
      : t('所有金额按<b>每笔账消费当天的汇率</b>（银联当日汇率）换算成{cur}后再汇总。', { cur: curName(mode) })}
      ${t(algo === 'simple' ? '「最少转账」只看每个人的净额重新配对，转账次数最少，但收款人可能不是当初付钱的人。' : '「两两抵消」：两个人之间互相欠的钱先抵消，只剩一个方向。')}
      ${t('点一行可以看这两个人之间的明细。')}</p>`;
}

function openPair(a, b) {
  const mode = prefs.balMode;
  const hist = C.pairHistory(D(), a, b, mode);
  const tot = {};
  hist.forEach((h) => (tot[h.vcur] = (tot[h.vcur] || 0) + h.sign * h.vamt));
  const totHtml = Object.entries(tot).filter(([c, v]) => !isZero(v, c))
    .map(([c, v]) => `<div class="${v > 0 ? 'neg' : 'pos'}">${v > 0 ? t('{a} 欠 {b}', { a: nm(a), b: nm(b) }) : t('{a} 欠 {b}', { a: nm(b), b: nm(a) })} ${money(Math.abs(v), c)}</div>`).join('')
    || `<div class="muted">${t('两人之间已结清')}</div>`;
  const items = hist.map((h) => {
    const r = h.ref;
    const title = h.type === 'bill'
      ? `${r.kind === 'carry' ? `<span class="tag carry">${t('结转')}</span>` : r.meal ? `<span class="tag">${tm(r.meal)}</span>` : ''}${titleOf(r)}`
      : `<span class="tag pay">${t('还款')}</span>${nm(r.from)} → ${nm(r.to)}`;
    const sub = h.type === 'bill' ? t('{payer} 付 · {who} 的份额', { payer: nmShort(r.payer), who: nmShort(h.from) }) : `${moneyText(r.amount, r.currency)}${r.method ? ' · ' + tm(r.method) : ''}`;
    return `<div class="item" data-act="${h.type === 'bill' ? 'openBill' : 'openPay'}" data-arg="${r.id}" role="button" tabindex="0">
      <div class="item-m"><div class="item-t">${title}</div><div class="item-s">${fmtDate(h.date)} · ${sub}</div></div>
      <div class="item-r ${h.sign > 0 ? 'neg' : 'pos'}"><span class="nowrap">${h.sign > 0 ? '+' : '−'}${money(h.vamt, h.vcur)}</span></div></div>`;
  }).join('');
  openModal(`<h2 class="sheet-t">${av(a)} ${nm(a)} <span class="muted">${t('和')}</span> ${av(b)} ${nm(b)}</h2>
    <div class="pair-tot">${totHtml}</div>
    <p class="muted small">${t('+ 表示 {a} 欠 {b} 的钱增加，− 表示减少', { a: nm(a), b: nm(b) })}${mode !== 'split' ? t('（已按各自日期汇率换算成{cur}）', { cur: curName(mode) }) : ''}${getLang() === 'en' ? '.' : '。'}</p>
    <div class="list">${items || `<p class="muted pad">${t('没有往来记录')}</p>`}</div>`);
}

// ================= 账目列表 =================
function renderBills() {
  const d = D();
  $view.innerHTML = `
    <div class="page-h"><h1>${t('账目')}</h1><a class="btn primary sm" href="#/add">${t('＋ 记一笔')}</a></div>
    ${syncErrorNote()}
    <div class="controls">
      <input class="search" type="search" id="billSearch" placeholder="${t('搜索地点、备注、支付方式…')}" value="${esc(billQuery)}">
      ${seg('billType', [['all', t('全部')], ['meal', t('消费')], ['pay', t('还款')]], prefs.billType, { pref: true, cls: 'sm' })}
      ${seg('billRange', RANGE_OPTS(), prefs.billRange, { pref: true, cls: 'sm' })}
      ${prefs.billRange === 'custom' ? `<div class="controls-row"><input type="date" name="billFrom" data-pref value="${esc(prefs.billFrom)}"> ${t('至')} <input type="date" name="billTo" data-pref value="${esc(prefs.billTo)}"></div>` : ''}
      <div class="chips scroll">${[['', t('所有人')], ...d.members.map((m) => [m.id, `${av(m.id, 'xs')}${nm(m.id)}`])]
        .map(([v, l]) => `<label class="chip"><input type="radio" name="billPerson" value="${v}" data-pref ${prefs.billPerson === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
    </div>
    <div id="billSummary"></div>
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
  const rg = rangeOf(prefs.billRange, prefs.billFrom, prefs.billTo);
  if (rg.from) items = items.filter(({ v }) => v.date >= rg.from);
  if (rg.to) items = items.filter(({ v }) => v.date <= rg.to);
  if (q) {
    items = items.filter(({ k, v }) => {
      const names = (k === 'bill' ? [v.payer, ...v.split.members] : [v.from, v.to]).map((id) => `${mem(id).name} ${mem(id).short}`).join(' ');
      return `${v.title || ''} ${v.note || ''} ${v.method || ''} ${t(v.method || '')} ${v.meal || ''} ${t(v.meal || '')} ${names} ${v.date}`.toLowerCase().includes(q);
    });
  }
  items.sort((a, b) => (a.v.date !== b.v.date ? (a.v.date < b.v.date ? 1 : -1) : (a.v.createdAt || '') < (b.v.createdAt || '') ? 1 : -1));
  const sumEl = document.getElementById('billSummary');
  const filtered = prefs.billRange !== 'all' || q || p || prefs.billType !== 'all';
  if (filtered && items.length) {
    const tot = {};
    items.filter((x) => x.k === 'bill' && x.v.kind !== 'carry').forEach((x) => (tot[x.v.currency] = (tot[x.v.currency] || 0) + x.v.amount));
    const range = rg.from || rg.to ? `${rg.from ? fmtDate(rg.from) : '…'} – ${rg.to ? fmtDate(rg.to > today() && prefs.billRange !== 'custom' ? today() : rg.to) : '…'} · ` : '';
    sumEl.innerHTML = `<div class="filter-sum">${range}${t('共 {n} 条记录', { n: items.length })}${Object.keys(tot).length ? ' · ' + t('消费合计 {amt}', { amt: amts(tot) }) : ''}</div>`;
  } else sumEl.innerHTML = '';
  const el = document.getElementById('billList');
  if (!items.length) { el.innerHTML = `<div class="empty small"><p class="muted">${t(d.bills.length ? '没有符合条件的记录' : '还没有记录')}</p></div>`; return; }
  const groups = new Map();
  for (const it of items) { const k = monthKey(it.v.date); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
  el.innerHTML = [...groups.entries()].map(([k, list]) => {
    const tot = {};
    list.filter((x) => x.k === 'bill' && x.v.kind !== 'carry').forEach((x) => (tot[x.v.currency] = (tot[x.v.currency] || 0) + x.v.amount));
    const n = list.filter((x) => x.k === 'bill' && x.v.kind !== 'carry').length;
    return `<section class="month"><div class="month-h"><b>${fmtMonth(k)}</b><span class="muted">${n ? `${t('{n} 笔消费', { n })} · ${amts(tot)}` : ''}</span></div>
      <div class="card list">${list.map((x) => (x.k === 'bill' ? billRow(x.v) : payRow(x.v))).join('')}</div></section>`;
  }).join('');
}

const dow = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };
function billRow(b) {
  const carry = b.kind === 'carry';
  const tag = carry ? `<span class="tag carry">${t('结转')}</span>` : b.meal ? `<span class="tag">${tm(b.meal)}</span>` : '';
  const n = b.split.members.length;
  const sub = carry ? t('{n} 人欠 {name}', { n, name: nmShort(b.payer) }) : `${t('{payer} 付', { payer: nmShort(b.payer) })}${b.method ? ' · ' + tm(b.method) : ''} · ${t('{n} 人', { n })}`;
  return `<div class="item" data-act="openBill" data-arg="${b.id}" role="button" tabindex="0">
    <div class="item-d wd-${dow(b.date)}"><b>${fmtDateShort(b.date)}</b><small>${weekday(b.date)}</small></div>
    <div class="item-m"><div class="item-t">${tag}${titleOf(b)}</div>
      <div class="item-s">${sub}</div>
      <div class="avs">${b.split.members.map((id) => av(id, 'xs')).join('')}</div></div>
    <div class="item-r">${money(b.amount, b.currency)}</div></div>`;
}
function payRow(p) {
  const cr = C.creditOf(p, C.rateOf(p, D()));
  return `<div class="item" data-act="openPay" data-arg="${p.id}" role="button" tabindex="0">
    <div class="item-d wd-${dow(p.date)}"><b>${fmtDateShort(p.date)}</b><small>${weekday(p.date)}</small></div>
    <div class="item-m"><div class="item-t"><span class="tag pay">${t('还款')}</span>${nm(p.from)} → ${nm(p.to)}</div>
      <div class="item-s">${p.method ? tm(p.method) : t('未记录方式')}${cr.cur !== p.currency ? ` · ${t('抵扣 {amt}', { amt: moneyText(cr.amt, cr.cur) })}` : ''}${p.note ? ' · ' + esc(p.note) : ''}</div></div>
    <div class="item-r pos">${money(p.amount, p.currency)}</div></div>`;
}

function openBill(id) {
  const b = D().bills.find((x) => x.id === id);
  if (!b) return toast(t('找不到这笔账'), 'err');
  const sh = C.sharesOf(b);
  const rate = C.rateOf(b, D());
  const other = b.currency === 'JPY' ? 'CNY' : 'JPY';
  const modeTxt = t({ equal: '平均分', amount: '指定金额', ratio: '按比例' }[b.split.mode] || '平均分');
  const rows = b.split.members.map((mid) => {
    const v = sh[mid];
    const raw = b.split.mode !== 'equal' ? `<small class="muted">${t(b.split.mode === 'ratio' ? '比例 ' : '指定 ')}${esc(String(b.split.values?.[mid] ?? 0))}</small>` : '';
    return `<div class="share-row">${av(mid)}<span class="nm"><span>${nm(mid)}${mid === b.payer ? `<small class="tag">${t('付款人')}</small>` : ''}</span>${raw}</span>
      <span class="share-v">${money(v, b.currency)}<small class="muted">≈ ${moneyText(C.convert(v, b.currency, other, rate), other)}</small></span></div>`;
  }).join('');
  const payerIn = b.split.members.includes(b.payer);
  const creator = b.createdBy ? mem(b.createdBy).name : '';
  openModal(`
    <div class="bill-head">
      <div class="muted">${fmtDate(b.date, true)}${b.meal ? ' · ' + tm(b.meal) : ''}</div>
      <h2>${b.kind === 'carry' ? `<span class="tag carry">${t('结转')}</span>` : ''}${titleOf(b)}</h2>
      <div class="bill-amt">${money(b.amount, b.currency)}<small class="muted">≈ ${moneyText(C.convert(b.amount, b.currency, other, rate), other)}</small></div>
    </div>
    <dl class="kv">
      <dt>${t('付款人')}</dt><dd>${av(b.payer, 'xs')} ${nm(b.payer)}</dd>
      <dt>${t('支付方式')}</dt><dd>${b.method ? tm(b.method) : t('未记录')}</dd>
      <dt>${t('分账方式')}</dt><dd>${modeTxt}${b.split.mode === 'amount' ? t('（没指定完的部分平均分）') : ''}</dd>
      <dt>${t('汇率')}</dt><dd>${rateDesc(b)}</dd>
    </dl>
    <h3>${t('{n} 人分摊', { n: b.split.members.length })}${payerIn ? '' : t('（付款人没有参与）')}</h3>
    <div class="shares">${rows}</div>
    ${b.note ? `<p class="note">${esc(b.note)}</p>` : ''}
    <p class="muted small">${creator ? t('由 {name} 记录 · ', { name: esc(creator) }) : ''}${b.createdAt ? new Date(b.createdAt).toLocaleString() : ''}</p>
    ${S.canWrite() ? `<div class="sheet-actions">
      <button class="btn" data-act="editBill" data-arg="${b.id}">${t('编辑')}</button>
      ${b.kind !== 'carry' ? `<button class="btn" data-act="copyBill" data-arg="${b.id}">${t('复制为新账')}</button>` : ''}
      <button class="btn danger" data-act="delBill" data-arg="${b.id}">${t('删除')}</button></div>` : ''}`);
}

function openPayment(id) {
  const p = D().payments.find((x) => x.id === id);
  if (!p) return toast(t('找不到这条记录'), 'err');
  const rate = C.rateOf(p, D());
  const cr = C.creditOf(p, rate);
  openModal(`
    <div class="bill-head"><div class="muted">${fmtDate(p.date, true)}</div>
      <h2><span class="tag pay">${t('还款')}</span>${nm(p.from)} → ${nm(p.to)}</h2>
      <div class="bill-amt pos">${money(p.amount, p.currency)}</div></div>
    <dl class="kv">
      <dt>${t('支付方式')}</dt><dd>${p.method ? tm(p.method) : t('未记录')}</dd>
      <dt>${t('抵扣')}</dt><dd>${cr.cur === p.currency ? t('抵扣{cur}欠款', { cur: curName(p.currency) }) : t('换算后抵扣 {amt} {cur}欠款', { amt: money(cr.amt, cr.cur), cur: curName(cr.cur) })}</dd>
      <dt>${t('汇率')}</dt><dd>${rateDesc(p)}</dd>
    </dl>
    ${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}
    <p class="muted small">${p.createdBy ? t('由 {name} 记录 · ', { name: esc(mem(p.createdBy).name) }) : ''}${p.createdAt ? new Date(p.createdAt).toLocaleString() : ''}</p>
    ${S.canWrite() ? `<div class="sheet-actions"><button class="btn" data-act="editPay" data-arg="${p.id}">${t('编辑')}</button>
      <button class="btn danger" data-act="delPay" data-arg="${p.id}">${t('删除')}</button></div>` : ''}`);
}

// ================= 记一笔 =================
function guessMeal() {
  const h = new Date().getHours();
  return h < 10 ? '早餐' : h < 16 ? '午餐' : h < 22 ? '晚餐' : '夜宵';
}
function formTabs(active) {
  return `<div class="seg form-tabs"><a href="#/add" class="${active === 'bill' ? 'on' : ''}">${t('消费')}</a><a href="#/pay" class="${active === 'pay' ? 'on' : ''}">${t('还款 / 转账')}</a></div>`;
}

// 表单里的汇率：手动填写优先，否则按日期查银联汇率表
const isManual = (f) => f.rateSource === 'manual' && f.rate > 0;
const formRate = (f) => (isManual(f) ? f.rate : C.rateOf({ date: f.date }, D()));
function rateMainHtml(f) {
  const r = formRate(f);
  let src;
  if (isManual(f)) src = t('手动填写');
  else {
    const info = C.rateInfo(f.date);
    src = !info ? `<span class="err">${t('没有汇率数据，可以手动填写')}</span>`
      : info.exact ? t('银联 · {date}', { date: info.date === today() ? t('今天') : info.date })
      : t('暂用银联 {used} 的汇率（{date} 的还没发布，发布后会自动换成当天的）', { used: info.date, date: esc(f.date) });
  }
  return `<span>${rateText(r)}</span><span class="muted">1${unit('CNY')} ≈ ${(1 / r).toFixed(2)}${unit('JPY')}</span><small class="muted">${src}</small>`;
}
const rateBtnsHtml = (f) => `<button type="button" class="link" data-f="editRate">${t('手动修改')}</button>${isManual(f) ? `<button type="button" class="link" data-f="autoRate">${t('恢复银联汇率')}</button>` : ''}`;
function rateBoxHtml(f, editing) {
  return `<div class="rate-main">${rateMainHtml(f)}</div><div class="rate-btns">${rateBtnsHtml(f)}</div>
    <div class="rate-edit" ${editing ? '' : 'hidden'}>100${unit('JPY')} = <input name="rateManual" inputmode="decimal" value="${(formRate(f) * 100).toFixed(4)}"> ${unit('CNY')}</div>`;
}
function updateRateText(form, f) {
  form.querySelector('.rate-main').innerHTML = rateMainHtml(f);
  form.querySelector('.rate-btns').innerHTML = rateBtnsHtml(f);
}
const rateFields = (f) => (isManual(f) ? { rate: f.rate, rateSource: 'manual' } : {});
const addMemberBtn = (where) => (S.canWrite() ? `<button type="button" class="chip-add" data-f="addMember" data-where="${where}">${t('＋ 新成员')}</button>` : '');
const withAdd = (chipsHtml, where) => chipsHtml.replace(/<\/div>$/, addMemberBtn(where) + '</div>');
const curSeg = (value) => seg('currency', [['JPY', t('日元')], ['CNY', t('人民币')]], value);
const methodChips = (methods, value) => chips('method', methods.map((m) => [m, tm(m)]), value, { toggle: true });
const notFound = (msg) => `<div class="empty"><p>${t(msg)}</p><a class="btn" href="#/bills">${t('返回')}</a></div>`;

function renderBillForm(editId, params = {}) {
  const d = D(), me = myId();
  const src = editId ? d.bills.find((b) => b.id === editId) : params.copy ? d.bills.find((b) => b.id === params.copy) : null;
  if (editId && !src) { $view.innerHTML = notFound('找不到这笔账'); return; }
  const active = d.members.filter((m) => !m.inactive).map((m) => m.id);
  const lastMembers = (prefs.lastMembers || active).filter((id) => active.includes(id));
  const f = src
    ? { ...clone(src), split: { mode: src.split.mode || 'equal', members: [...src.split.members], values: Object.fromEntries(Object.entries(src.split.values || {}).map(([k, v]) => [k, String(v)])) }, amount: String(src.amount) }
    : { kind: 'meal', date: today(), meal: guessMeal(), title: '', currency: prefs.lastCur || 'JPY', amount: '', payer: me || '', method: '', split: { mode: 'equal', members: lastMembers.length ? lastMembers : active, values: {} }, note: '' };
  if (!editId && src) { // 复制为新账
    Object.assign(f, { id: undefined, date: today(), kind: 'meal', createdAt: undefined, createdBy: undefined });
  }
  if (!isManual(f)) Object.assign(f, { rate: null, rateSource: null });
  delete f.rateDate;
  const shownIds = [...new Set([...active, ...f.split.members, f.payer].filter(Boolean))];
  const titles = [...new Set(d.bills.filter((b) => b.kind !== 'carry').sort((a, b) => (a.date < b.date ? 1 : -1)).map((b) => b.title).filter(Boolean))].slice(0, 40);
  const methods = [...new Set([...d.methods, f.method].filter(Boolean))];
  let rateEditing = false;

  $view.innerHTML = `
    <div class="page-h"><h1>${t(editId ? '编辑账目' : '记一笔')}</h1>${editId ? '' : formTabs('bill')}</div>
    ${readonlyNote()}
    <form id="bf" class="form" autocomplete="off" novalidate>
      ${f.kind === 'carry' ? `<div class="notice">${t('这是一条<b>期初结转</b>记录（从 Excel 总账导入的欠款余额），付款人 = 收款人，分摊人 = 欠款人。')}</div>` : ''}
      <div class="grid2">
        <label class="field"><span class="lbl">${t('日期')}</span><input type="date" name="date" value="${f.date}" required></label>
        <div class="field"><span class="lbl">${t('类型')}</span>${chips('meal', MEALS.map((m) => [m, tm(m)]), f.meal, { toggle: true })}</div>
      </div>
      <label class="field"><span class="lbl">${t('地点 / 内容')}</span><input name="title" value="${esc(f.title)}" placeholder="${t('比如：一风堂 本乡三丁目')}" list="titles" enterkeyhint="next"></label>
      <datalist id="titles">${titles.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      <div class="field"><span class="lbl">${t('金额')}</span>
        <div class="amount-row">${curSeg(f.currency)}
          <div class="amount-wrap"><input name="amount" class="amount-input" inputmode="decimal" value="${esc(f.amount)}" placeholder="0"><span class="unit" id="unit">${unit(f.currency)}</span></div></div>
        <div class="hint" id="amountHint"></div>
      </div>
      <div class="field"><span class="lbl">${t('谁付的钱')}</span><div id="payerBox">${withAdd(chips('payer', memberOpts(shownIds), f.payer), 'payer')}</div></div>
      <div class="field"><span class="lbl">${t('支付方式')}</span>${methodChips(methods, f.method)}</div>
      <div class="field"><div class="lbl-row"><span class="lbl">${t(f.kind === 'carry' ? '欠款人' : '谁一起吃')} <b id="pc"></b></span>
        <span><button type="button" class="link" data-f="all">${t('全选')}</button><button type="button" class="link" data-f="none">${t('清空')}</button></span></div>
        <div id="membersBox">${withAdd(chips('members', memberOpts(shownIds), f.split.members, { type: 'checkbox' }), 'members')}</div></div>
      <div class="field"><span class="lbl">${t('怎么分')}</span>
        ${seg('splitMode', [['equal', t('平均分')], ['amount', t('指定金额')], ['ratio', t('按比例')]], f.split.mode)}
        <div class="hint" id="splitHint"></div>
        <div id="splitRows" class="split-rows"></div>
      </div>
      <div class="field"><span class="lbl">${t('汇率（按消费日的银联汇率，用于换算）')}</span><div class="rate-box" id="rateBox"></div></div>
      <label class="field"><span class="lbl">${t('备注')}</span><textarea name="note" rows="2" placeholder="${t('可选')}">${esc(f.note || '')}</textarea></label>
      <div class="form-actions"><button type="submit" class="btn primary block" ${S.canWrite() ? '' : 'disabled'}>${t(editId ? '保存修改' : '保存')}</button>
        ${editId ? `<a class="btn block" href="#/bills">${t('取消')}</a>` : ''}</div>
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
      ...rateFields(f), note: f.note,
      createdAt: f.createdAt, createdBy: f.createdBy,
    };
  }
  function renderSplitRows() {
    const mode = f.split.mode;
    $('#pc').textContent = f.split.members.length ? t('（{n} 人）', { n: f.split.members.length }) : '';
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
      el.innerHTML = Number.isFinite(v) ? `${el.dataset.share === bill.payer ? `<small class="muted">${t('自己 ')}</small>` : ''}${money(v, cur)}` : '<span class="muted">—</span>';
    });
    $('#unit').textContent = unit(cur);
    const other = cur === 'JPY' ? 'CNY' : 'JPY';
    const ah = $('#amountHint');
    if (String(f.amount).trim() && !okAmt) ah.innerHTML = `<span class="err">${t('金额格式不对')}</span>`;
    else if (okAmt) ah.innerHTML = `${/[+\-*/]/.test(f.amount) ? `= ${money(bill.amount, cur)} · ` : ''}≈ ${moneyText(C.convert(bill.amount, cur, other, formRate(f)), other)}`;
    else ah.innerHTML = t('可以直接输入算式，例如 <code>3200+2880</code>');
    const n = f.split.members.length;
    const hint = $('#splitHint');
    if (!n) hint.innerHTML = `<span class="err">${t('请选择参与人')}</span>`;
    else if (f.split.mode === 'equal') hint.innerHTML = okAmt ? t('{n} 人平均，每人 {amt}', { n, amt: money(bill.amount / n, cur) }) : t('{n} 人平均分', { n });
    else if (f.split.mode === 'amount') {
      const sum = f.split.members.reduce((s, id) => s + (Number.isFinite(bill.split.values[id]) ? bill.split.values[id] : 0), 0);
      const rem = (bill.amount || 0) - sum;
      hint.innerHTML = !okAmt ? t('填写每个人的金额（可以写算式）') : rem < -CUR[cur].eps
        ? `<span class="err">${t('已指定 {sum}，超出总额 {over}', { sum: moneyText(sum, cur), over: moneyText(-rem, cur) })}</span>`
        : isZero(rem, cur) ? t('已指定 {sum}，正好等于总额', { sum: moneyText(sum, cur) })
        : t('已指定 {sum}，剩下 {rem} 由 {n} 人平均分（每人 +{each}）', { sum: moneyText(sum, cur), rem: moneyText(rem, cur), n, each: moneyText(rem / n, cur) });
    } else hint.innerHTML = t('填每个人的比例或各自点单的价格，总额按比例分摊（适合用人民币刷卡、按日元菜价分的情况）');
  }
  function renderRate() { $('#rateBox').innerHTML = rateBoxHtml(f, rateEditing); }
  function addMemberHere(where) {
    editMember(null, (m) => {
      shownIds.push(m.id);
      if (where === 'payer') f.payer = m.id;
      if (!f.split.members.includes(m.id)) f.split.members.push(m.id);
      $('#payerBox').innerHTML = withAdd(chips('payer', memberOpts(shownIds), f.payer), 'payer');
      $('#membersBox').innerHTML = withAdd(chips('members', memberOpts(shownIds), f.split.members, { type: 'checkbox' }), 'members');
      onInput({ target: form });
    });
  }

  let snap = '';
  const snapshot = () => [f.split.members.join(), f.split.mode, f.date, f.currency].join('#');
  function onInput(e) {
    if (e.target.name === 'rateManual') {
      const v = parseNum(e.target.value) / 100;
      if (v > 0) { f.rate = v; f.rateSource = 'manual'; updateRateText(form, f); updateShares(); }
      return;
    }
    const before = snap;
    const prevDate = f.date;
    readForm();
    snap = snapshot();
    if (before !== snap) renderSplitRows(); else updateShares();
    if (prevDate !== f.date && !rateEditing) renderRate();
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
    if (act === 'autoRate') { f.rate = null; f.rateSource = null; rateEditing = false; renderRate(); updateShares(); }
    if (act === 'addMember') addMemberHere(b.dataset.where);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    readForm();
    const bill = buildBill();
    const err = C.billError(bill, (id) => mem(id).name);
    if (err) return toast(err, 'err');
    if (!S.canWrite()) return toast(t('只读模式，请先在设置里填写 GitHub Token'), 'err');
    const now = nowISO();
    bill.id = editId || uid('b');
    bill.updatedAt = now;
    if (!editId) { bill.createdAt = now; bill.createdBy = me || ''; }
    if (bill.kind !== 'carry') { setPref('lastCur', bill.currency); setPref('lastMembers', bill.split.members); }
    const btn = form.querySelector('[type=submit]');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('保存中…');
    const ok = await save({ t: 'putBill', v: bill }, `${editId ? '修改' : '记账'} ${bill.date} ${bill.title || ''} ${bill.amount}${bill.currency}`);
    btn.disabled = false;
    btn.textContent = label;
    if (ok) location.hash = '#/bills';
  });

  readForm();
  snap = snapshot();
  renderSplitRows();
  renderRate();
}

// ================= 还款 =================
function renderPayForm(editId, params = {}) {
  const d = D(), me = myId();
  const src = editId ? d.payments.find((p) => p.id === editId) : null;
  if (editId && !src) { $view.innerHTML = notFound('找不到这条记录'); return; }
  const owed = { JPY: params.JPY, CNY: params.CNY };
  const cur0 = params.JPY ? 'JPY' : params.CNY ? 'CNY' : prefs.lastCur || 'JPY';
  const f = src
    ? { ...clone(src), amount: String(src.amount), credit: src.creditCurrency && src.creditCurrency !== src.currency ? 'other' : 'same' }
    : { date: today(), from: params.from || me || '', to: params.to || '', currency: cur0, amount: owed[cur0] ? String(owed[cur0]) : '', method: '', credit: 'same', note: '' };
  if (!isManual(f)) Object.assign(f, { rate: null, rateSource: null });
  delete f.rateDate;
  delete f.creditAmount;
  let touched = !!src;
  // 显示：常用成员 + 还有欠款往来的成员（即使已隐藏）
  const involved = new Set();
  C.debtsPairwise(d, 'split').forEach((x) => { involved.add(x.from); involved.add(x.to); });
  const shownIds = [...new Set([...d.members.filter((m) => !m.inactive || involved.has(m.id)).map((m) => m.id), f.from, f.to].filter(Boolean))];
  const methods = [...new Set([...d.methods, f.method].filter(Boolean))];
  let rateEditing = false;

  $view.innerHTML = `
    <div class="page-h"><h1>${t(editId ? '编辑还款' : '记录还款')}</h1>${editId ? '' : formTabs('pay')}</div>
    ${readonlyNote()}
    <form id="pf" class="form" autocomplete="off" novalidate>
      <p class="muted small">${t('谁把钱还给了谁。保存后，对应的欠款会自动减少。')}</p>
      <label class="field"><span class="lbl">${t('日期')}</span><input type="date" name="date" value="${f.date}"></label>
      <div class="field"><span class="lbl">${t('谁还钱（付款）')}</span><div id="fromBox">${withAdd(chips('from', memberOpts(shownIds), f.from), 'from')}</div></div>
      <div class="field"><span class="lbl">${t('还给谁（收款）')}</span><div id="toBox">${withAdd(chips('to', memberOpts(shownIds), f.to), 'to')}</div></div>
      <div class="field"><span class="lbl">${t('金额')}</span>
        <div class="amount-row">${curSeg(f.currency)}
          <div class="amount-wrap"><input name="amount" class="amount-input" inputmode="decimal" value="${esc(f.amount)}" placeholder="0"><span class="unit" id="unit">${unit(f.currency)}</span></div></div>
        <div class="hint" id="owedHint"></div>
      </div>
      <div class="field"><span class="lbl">${t('支付方式')}</span>${methodChips(methods, f.method)}</div>
      <div class="field"><span class="lbl">${t('抵扣哪种欠款')}</span><div id="creditBox"></div><div class="hint" id="creditHint"></div></div>
      <div class="field"><span class="lbl">${t('汇率（按还款日的银联汇率）')}</span><div class="rate-box" id="rateBox"></div></div>
      <label class="field"><span class="lbl">${t('备注')}</span><textarea name="note" rows="2" placeholder="${t('可选')}">${esc(f.note || '')}</textarea></label>
      <div class="form-actions"><button type="submit" class="btn primary block" ${S.canWrite() ? '' : 'disabled'}>${t('保存')}</button>
        ${editId ? `<a class="btn block" href="#/bills">${t('取消')}</a>` : ''}</div>
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
    $('#creditBox').innerHTML = seg('credit', [['same', t('{cur}欠款', { cur: curName(f.currency) })], ['other', t('换算后抵{cur}欠款', { cur: curName(otherCur()) })]], f.credit);
  }
  function update() {
    $('#unit').textContent = unit(f.currency);
    const amt = parseNum(f.amount);
    const ch = $('#creditHint');
    if (f.credit === 'other' && amt > 0) {
      const v = C.convert(amt, f.currency, otherCur(), formRate(f));
      ch.innerHTML = t('按还款日汇率，相当于抵扣 {amt} 的{cur}欠款', { amt: money(v, otherCur()), cur: curName(otherCur()) });
    } else ch.innerHTML = f.credit === 'other' ? t('比如：欠的是日元，用微信/支付宝还人民币') : '';
    // 当前欠款提示
    const oh = $('#owedHint');
    if (f.from && f.to && f.from !== f.to) {
      const debts = C.debtsPairwise(D(), 'split').filter((x) => (x.from === f.from && x.to === f.to));
      const o = {}; debts.forEach((x) => (o[x.cur] = x.amt));
      oh.innerHTML = debts.length ? t('目前 {a} 欠 {b}：{amt}', { a: nm(f.from), b: nm(f.to), amt: amts(o) }) : t('目前 {a} 不欠 {b} 钱', { a: nm(f.from), b: nm(f.to) });
    } else oh.innerHTML = f.from && f.from === f.to ? `<span class="err">${t('付款人和收款人不能是同一个人')}</span>` : '';
  }
  function renderRate() { $('#rateBox').innerHTML = rateBoxHtml(f, rateEditing); }
  function addMemberHere(where) {
    editMember(null, (m) => {
      shownIds.push(m.id);
      f[where] = m.id;
      $('#fromBox').innerHTML = withAdd(chips('from', memberOpts(shownIds), f.from), 'from');
      $('#toBox').innerHTML = withAdd(chips('to', memberOpts(shownIds), f.to), 'to');
      onInput({ target: form });
    });
  }

  function onInput(e) {
    if (e.target.name === 'rateManual') {
      const v = parseNum(e.target.value) / 100;
      if (v > 0) { f.rate = v; f.rateSource = 'manual'; updateRateText(form, f); update(); }
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
    if (prev.date !== f.date && !rateEditing) renderRate();
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
    if (b.dataset.f === 'autoRate') { f.rate = null; f.rateSource = null; rateEditing = false; renderRate(); update(); }
    if (b.dataset.f === 'addMember') addMemberHere(b.dataset.where);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    readForm();
    const amount = parseNum(f.amount);
    if (!f.date) return toast(t('请选择日期'), 'err');
    if (!f.from || !f.to) return toast(t('请选择付款人和收款人'), 'err');
    if (f.from === f.to) return toast(t('付款人和收款人不能是同一个人'), 'err');
    if (!(amount > 0)) return toast(t('请输入正确的金额'), 'err');
    if (!S.canWrite()) return toast(t('只读模式，请先在设置里填写 GitHub Token'), 'err');
    const now = nowISO();
    const p = {
      id: editId || uid('p'), date: f.date, from: f.from, to: f.to, currency: f.currency, amount, method: f.method,
      ...rateFields(f), note: f.note,
      createdAt: src?.createdAt || now, createdBy: src ? src.createdBy : me || '', updatedAt: now,
    };
    // 换算抵扣：抵扣金额按还款日的汇率实时计算，不写死
    if (f.credit === 'other') p.creditCurrency = otherCur();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    const ok = await save({ t: 'putPayment', v: p }, `${editId ? '修改还款' : '还款'} ${p.date} ${mem(p.from).short}→${mem(p.to).short} ${amount}${p.currency}`);
    btn.disabled = false;
    if (ok) location.hash = editId ? '#/bills' : '#/';
  });

  renderCredit();
  update();
  renderRate();
}

// ================= 统计 =================
const monthEnd = (ym) => { const [yy, mm] = ym.split('-').map(Number); return `${ym}-${String(new Date(yy, mm, 0).getDate()).padStart(2, '0')}`; };
function rangeOf(kind, from, to) {
  const td = today(), y = td.slice(0, 4), m = td.slice(0, 7);
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  const lm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  switch (kind) {
    case 'year': return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'month': return { from: `${m}-01`, to: monthEnd(m) };
    case 'lastMonth': return { from: `${lm}-01`, to: monthEnd(lm) };
    case 'custom': return { from: from || '', to: to || '' };
    default: return {};
  }
}
const statsRange = () => rangeOf(prefs.statsRange, prefs.statsFrom, prefs.statsTo);
const RANGE_OPTS = () => [['all', t('全部')], ['month', t('本月')], ['lastMonth', t('上月')], ['year', t('今年')], ['custom', t('自定义')]];
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
      <div class="stat-p-h">${av(m.id)}<b>${nm(m.id)}</b><small class="muted">${t('付款 {a} 次 · 参与 {b} 次', { a: p.paidCount, b: p.joinCount })}</small></div>
      <dl class="kv sm">
        <dt>${t('付了')}</dt><dd>${modeAmts(p.paid, mode)}</dd>
        <dt>${t('自己吃了')}</dt><dd>${modeAmts(p.used, mode)}</dd>
        <dt>${t('垫付差额')}</dt><dd>${modeAmts(diff, mode)}</dd>
      </dl></div>`;
  }).join('');
  const methodRows = Object.entries(st.methods).sort((a, b) => b[1].count - a[1].count)
    .map(([k, v]) => `<tr><td>${tm(k)}</td><td class="r">${v.count}</td><td class="r">${modeAmts(v.amt, mode)}</td></tr>`).join('');
  const placeRows = Object.entries(st.places).sort((a, b) => b[1].count - a[1].count || b[1].amt.toCNY - a[1].amt.toCNY).slice(0, 10)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${v.count}</td><td class="r">${modeAmts(v.amt, mode)}</td></tr>`).join('');
  const noRec = `<p class="muted pad">${t('没有记录')}</p>`;
  $view.innerHTML = `
    <div class="page-h"><h1>${t('统计')}</h1></div>
    <div class="controls">
      ${seg('statsRange', [['all', t('全部')], ['year', t('今年')], ['month', t('本月')], ['lastMonth', t('上月')], ['custom', t('自定义')]], prefs.statsRange, { pref: true, cls: 'sm' })}
      ${prefs.statsRange === 'custom' ? `<div class="controls-row"><input type="date" name="statsFrom" data-pref value="${esc(prefs.statsFrom)}"> ${t('至')} <input type="date" name="statsTo" data-pref value="${esc(prefs.statsTo)}"></div>` : ''}
      ${seg('statsMode', [['split', t('分币种')], ['CNY', t('换算人民币')], ['JPY', t('换算日元')]], mode, { pref: true, cls: 'sm' })}
    </div>
    <section class="card summary2">
      <div><small>${t('聚餐 / 消费')}</small><div class="big"><span>${st.total.count}<small>${t(' 次')}</small></span></div></div>
      <div><small>${t('总花费')}</small><div class="big">${modeAmts(st.total.amt, mode)}</div></div>
    </section>
    <section class="card"><h3>${t('每个人')}</h3>${personCards || `<p class="muted pad">${t('这段时间没有记录')}</p>`}</section>
    <section class="card"><h3>${t('支付方式')}</h3>${methodRows ? `<table class="tbl"><thead><tr><th>${t('方式')}</th><th class="r">${t('次数')}</th><th class="r">${t('金额')}</th></tr></thead><tbody>${methodRows}</tbody></table>` : noRec}</section>
    <section class="card"><h3>${t('常去的店')}</h3>${placeRows ? `<table class="tbl"><thead><tr><th>${t('地点')}</th><th class="r">${t('次数')}</th><th class="r">${t('金额')}</th></tr></thead><tbody>${placeRows}</tbody></table>` : noRec}</section>
    <p class="foot">${t('统计不包含「期初结转」。「垫付差额」= 付了 − 自己吃了，正数表示替别人垫的钱多。')}</p>`;
}

// ================= 设置 =================
function renderSettings() {
  const d = D(), cfg = S.getConfig(), me = myId(), w = S.canWrite();
  const st = S.state;
  $view.innerHTML = `
    <div class="page-h"><h1>${t('设置')}</h1></div>
    ${syncErrorNote()}
    <section class="card"><h3>${t('语言 / Language')}</h3>
      <div class="chips pad"><button class="chip-btn ${getLang() === 'zh' ? 'on' : ''}" data-act="setLang" data-arg="zh">中文</button><button class="chip-btn ${getLang() === 'en' ? 'on' : ''}" data-act="setLang" data-arg="en">English</button></div>
    </section>

    <section class="card"><h3>${t('风格')} <small class="muted">${t('（只保存在这台设备）')}</small></h3>
      <div class="chips pad">${THEMES.map(([id, label]) => `<button class="chip-btn ${document.documentElement.dataset.theme === id ? 'on' : ''}" data-act="setTheme" data-arg="${id}">${t(label)}</button>`).join('')}</div>
    </section>

    <section class="card"><h3>${t('我是谁')} <small class="muted">${t('（只保存在这台设备）')}</small></h3>
      <div class="chips pad">${d.members.filter((m) => !m.inactive).map((m) => `<button class="chip-btn ${m.id === me ? 'on' : ''}" data-act="setMe" data-arg="${m.id}">${av(m.id, 'xs')}${nm(m.id)}</button>`).join('') || `<span class="muted">${t('先添加成员')}</span>`}</div>
      ${me && w ? `<div class="pad"><button class="btn sm" data-act="editMember" data-arg="${me}">${av(me, 'xs')} ${t('换我的头像 / 改名字')}</button></div>` : ''}
    </section>

    <section class="card"><div class="card-h"><b>${t('成员')}</b>${w ? `<button class="btn-mini card-h-r" data-act="addMember">${t('＋ 添加')}</button>` : ''}</div>
      ${w ? `<p class="muted small pad" style="padding-bottom:4px">${t('点一位成员，可以改名字、换头像、隐藏。')}</p>` : `<p class="muted small pad" style="padding-bottom:4px">${t('只读模式下不能修改成员和头像，需要先在下面「GitHub 同步」填写 Token。')}</p>`}
      ${d.members.map((m) => `<div class="mem-row" ${w ? `data-act="editMember" data-arg="${m.id}" role="button" tabindex="0"` : ''}>${av(m.id)}<span class="nm">${nm(m.id)}${m.inactive ? ` <small class="tag">${t('已隐藏')}</small>` : ''}</span><small class="muted">${esc(m.short)}</small>${w ? '<span class="chev">›</span>' : ''}</div>`).join('') || `<p class="muted pad">${t('还没有成员')}</p>`}
    </section>

    <section class="card"><h3>${t('支付方式')}</h3>
      <div class="method-list">${d.methods.map((m, i) => `<div class="method">${tm(m)}${w ? `<span class="method-btns">${i > 0 ? `<button class="icon-btn" data-act="moveMethod" data-arg="${esc(m)}|up" aria-label="${t('上移')}">↑</button>` : ''}<button class="icon-btn" data-act="delMethod" data-arg="${esc(m)}" aria-label="${t('删除')}">×</button></span>` : ''}</div>`).join('')}</div>
      ${w ? `<form id="methodForm" class="inline-form"><input name="m" placeholder="${t('新的支付方式，例如 Suica')}"><button class="btn sm">${t('添加')}</button></form>` : ''}
    </section>

    <section class="card"><h3>${t('GitHub 同步')}</h3>
      <p class="muted small pad">${t('数据保存在仓库里的 <code>{path}</code>，每次保存都是一次 commit（可在 GitHub 上查看历史）。', { path: esc(cfg.path) })}<br>
        ${t('状态：')}<b>${t({ github: '已连接，可记账', readonly: '只读（未填写 Token）', local: '本地模式（数据只存在这个浏览器里）' }[st.mode])}</b></p>
      <form id="gitForm" class="form compact">
        <div class="grid2">
          <label class="field"><span class="lbl">${t('GitHub 用户名')}</span><input name="owner" value="${esc(cfg.owner)}" placeholder="ruhui-liu" autocapitalize="off"></label>
          <label class="field"><span class="lbl">${t('仓库名')}</span><input name="repo" value="${esc(cfg.repo)}" placeholder="meal-ledger" autocapitalize="off"></label>
          <label class="field"><span class="lbl">${t('分支')}</span><input name="branch" value="${esc(cfg.branch)}" autocapitalize="off"></label>
          <label class="field"><span class="lbl">${t('数据文件路径')}</span><input name="path" value="${esc(cfg.path)}" autocapitalize="off"></label>
        </div>
        <label class="field"><span class="lbl">${t('Token（只保存在这台设备）')}</span><input name="token" type="password" value="" placeholder="${cfg.token ? t('已保存（留空表示不修改）') : 'github_pat_…'}" autocapitalize="off" autocomplete="off"></label>
        <p class="muted small">${t('在 <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Settings → Fine-grained tokens</a> 新建：Repository access 只选这个仓库，Permissions → Contents 选 <b>Read and write</b>。')}</p>
        <div class="btn-row"><button class="btn primary" type="submit">${t('保存并连接')}</button><button class="btn" type="button" id="testGit">${t('测试连接')}</button>${cfg.token ? `<button class="btn danger" type="button" id="clearToken">${t('删除 Token')}</button>` : ''}</div>
        <div id="gitMsg" class="hint"></div>
      </form>
    </section>

    <section class="card"><h3>${t('数据')}</h3>
      <div class="btn-row pad"><button class="btn" data-act="exportJSON">${t('导出 JSON 备份')}</button><button class="btn" data-act="exportCSV">${t('导出 CSV（Excel 可打开）')}</button>
        ${w ? `<button class="btn" data-act="importJSON">${t('从 JSON 恢复')}</button>` : ''}<button class="btn" data-act="refresh">${t('重新加载')}</button>
        ${st.pending ? `<button class="btn danger" data-act="discard">${t('放弃未同步的修改')}</button>` : ''}</div>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
      <p class="muted small pad">${t('汇率：银联当日 JPY→CNY 汇率，已更新到 <b>{date}</b>（GitHub Actions 每 3 小时自动拉取）。', { date: C.latestRateDate() || t('（未加载）') })}<br>${t('共 {a} 笔账、{b} 条还款、{c} 位成员。', { a: d.bills.length, b: d.payments.length, c: d.members.length })}${d.updatedAt ? ' ' + t('最后更新 {time}', { time: new Date(d.updatedAt).toLocaleString() }) : ''}</p>
    </section>`;

  const mf = document.getElementById('methodForm');
  mf?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = mf.m.value.trim();
    if (!v) return;
    if (d.methods.includes(v)) return toast(t('已经有这个支付方式了'), 'err');
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
    msg.textContent = t('连接中…');
    const r = await S.testConnection();
    toast(r.message, r.ok && r.canPush ? 'ok' : r.ok ? 'warn' : 'err');
    await S.refresh();
  });
  document.getElementById('testGit').addEventListener('click', async () => {
    msg.textContent = t('测试中…');
    const c = { ...S.getConfig(), owner: gf.owner.value.trim(), repo: gf.repo.value.trim() };
    if (gf.token.value.trim()) c.token = gf.token.value.trim();
    const r = await S.testConnection(c);
    msg.innerHTML = r.ok ? `<span class="pos">${esc(r.message)}${r.private === false ? t('（这是公开仓库）') : ''}</span>` : `<span class="err">${esc(r.message)}</span>`;
  });
  document.getElementById('clearToken')?.addEventListener('click', () => {
    if (!confirm(t('从这台设备删除 Token？删除后变为只读。'))) return;
    S.saveConfig({ token: '' });
    S.refresh();
  });
  document.getElementById('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.bills) || !Array.isArray(data.members)) throw new Error(t('文件格式不对'));
      if (!confirm(t('用这个文件（{a} 笔账、{b} 条还款）覆盖现在的全部数据？', { a: data.bills.length, b: (data.payments || []).length }))) return;
      await save({ t: 'replaceAll', v: data }, '从 JSON 恢复数据');
    } catch (err) {
      toast(t('导入失败：') + err.message, 'err');
    }
    e.target.value = '';
  });
}

function editMember(id, onSaved) {
  const d = D();
  const m = id ? d.members.find((x) => x.id === id) : { id: '', name: '', short: '', inactive: false };
  if (!m) return;
  const used = id && (d.bills.some((b) => b.payer === id || b.split.members.includes(id)) || d.payments.some((p) => p.from === id || p.to === id));
  let avatar = avatarOk(m.avatar) ? m.avatar : '';
  const avPreview = () => `<span class="av av-lg${avatar ? ' has-img' : ''}" style="--c:${m.color || (id ? color(id) : PALETTE[d.members.length % PALETTE.length])}">${avatar ? `<img src="${avatar}" alt="">` : esc(m.short || m.name.slice(0, 2) || '?')}</span>`;
  openModal(`<h2 class="sheet-t">${t(id ? '编辑成员' : '添加成员')}</h2>
    <form id="memForm" class="form compact">
      <div class="field"><span class="lbl">${t('头像')}</span>
        <div class="av-edit"><span id="avPrev">${avPreview()}</span>
          <label class="btn sm">${t(avatar ? '更换照片' : '上传照片')}<input type="file" id="avFile" accept="image/*" hidden></label>
          <button type="button" class="btn sm danger" id="avDel" ${avatar ? '' : 'hidden'}>${t('移除照片')}</button></div></div>
      <label class="field"><span class="lbl">${t('名字')}</span><input name="name" value="${esc(m.name)}" placeholder="${t('例如：张三')}" required></label>
      <label class="field"><span class="lbl">${t('简称（头像上显示，1–3 个字）')}</span><input name="short" value="${esc(m.short)}" maxlength="3" placeholder="${t('例如：ZS（不填就用名字前两个字）')}"></label>
      <label class="field"><span class="lbl">${t('颜色')}</span><input name="color" type="color" value="${m.color || (id ? color(id) : PALETTE[d.members.length % PALETTE.length])}"></label>
      ${id ? `<label class="check"><input type="checkbox" name="inactive" ${m.inactive ? 'checked' : ''}> ${t('隐藏（毕业/不常来了：记账时不再默认显示，历史账目保留）')}</label>` : ''}
      <div class="btn-row"><button class="btn primary" type="submit">${t('保存')}</button>
        ${id && !used ? `<button class="btn danger" type="button" id="delMem">${t('删除')}</button>` : ''}</div>
      ${used ? `<p class="muted small">${t('这个成员已经有账目记录，不能删除，可以选择隐藏。')}</p>` : ''}
    </form>`, (sheet) => {
    const fm = sheet.querySelector('#memForm');
    if (!id) setTimeout(() => fm.name.focus(), 50);
    const refreshAv = () => {
      sheet.querySelector('#avPrev').innerHTML = avPreview();
      sheet.querySelector('#avDel').hidden = !avatar;
    };
    sheet.querySelector('#avFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try { avatar = await resizeAvatar(file); refreshAv(); } catch (err) { toast(err.message, 'err'); }
      e.target.value = '';
    });
    sheet.querySelector('#avDel').addEventListener('click', () => { avatar = ''; refreshAv(); });
    fm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = fm.name.value.trim();
      if (!name) return toast(t('请输入名字'), 'err');
      const short = fm.short.value.trim() || name.slice(0, 2);
      const v = { ...m, id: id || uid('m'), name, short, color: fm.color.value, inactive: !!fm.inactive?.checked, avatar };
      if (!v.inactive) delete v.inactive;
      if (!v.avatar) delete v.avatar;
      if (!id && D().members.some((x) => x.name === name)) return toast(t('已经有叫 {name} 的成员了', { name }), 'err');
      closeModal();
      const saving = save({ t: 'putMember', v }, `${id ? '修改' : '添加'}成员 ${name}`);
      if (S.canWrite() && onSaved) onSaved(v); // 数据已在本机更新，表单里立即可选
      await saving;
    });
    sheet.querySelector('#delMem')?.addEventListener('click', async () => {
      if (!confirm(t('删除成员 {name}？', { name: m.name }))) return;
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
  const head = [t('类型'), t('日期'), t('餐别'), t('地点/内容'), t('币种'), t('金额'), t('付款人'), t('支付方式'), t('分账方式'), ...ms.map((m) => `${m.name}(${m.short})`), t('汇率(1円=元)'), t('备注')];
  const lines = [head.map(q).join(',')];
  const sorted = [...d.bills].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const b of sorted) {
    const sh = C.sharesOf(b);
    lines.push([t(b.kind === 'carry' ? '期初结转' : '消费'), b.date, t(b.meal || ''), b.title || '', b.currency, b.amount, mem(b.payer).name, t(b.method || ''),
      t({ equal: '平均', amount: '指定金额', ratio: '按比例' }[b.split.mode] || '平均'),
      ...ms.map((m) => (sh[m.id] !== undefined ? roundCur(sh[m.id], b.currency) : '')), C.rateOf(b, d), b.note || ''].map(q).join(','));
  }
  for (const p of [...d.payments].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const cr = C.creditOf(p, C.rateOf(p, d));
    lines.push([t('还款'), p.date, '', `${mem(p.from).name} → ${mem(p.to).name}`, p.currency, p.amount, mem(p.from).name, t(p.method || ''),
      cr.cur !== p.currency ? `${t('抵扣 {amt}', { amt: roundCur(cr.amt, cr.cur) })} ${cr.cur}` : '', ...ms.map(() => ''), C.rateOf(p, d), p.note || ''].map(q).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

// ================= 启动 =================
C.setRateTable(S.state.rates);
applyStaticText();
renderSync();
route();
S.init();
