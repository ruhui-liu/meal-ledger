// 小票识别：在手机上用 Tesseract.js 做文字识别（不上传图片），再从文字里找日期、店名、合计金额
const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let loading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESS_URL;
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => { loading = null; reject(new Error('OCR load failed')); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

/** 识别图片里的文字。onProgress(0~1, 阶段) */
export async function ocr(image, onProgress = () => {}) {
  const T = await loadTesseract();
  const worker = await T.createWorker(['jpn', 'eng'], 1, {
    logger: (m) => { if (typeof m.progress === 'number') onProgress(m.progress, m.status); },
  });
  try {
    const { data } = await worker.recognize(image);
    return data.text || '';
  } finally {
    worker.terminate();
  }
}

// ---------- 解析 ----------
const Z2H = (s) => s
  .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  .replace(/[，､]/g, ',').replace(/[．。]/g, '.').replace(/[／]/g, '/').replace(/[：]/g, ':')
  .replace(/[￥]/g, '¥').replace(/　/g, ' ')
  // OCR 常见错误：汉字之间多出空格、¥ 被认成反斜杠、千分位逗号后多空格、「一」被认成长音「ー」
  .replace(/([぀-ヿ一-鿿])[ \t]+(?=[぀-ヿ一-鿿])/g, '$1')
  .replace(/\\(?=\s*\d)/g, '¥')
  .replace(/(\d)[,.][ \t]+(\d{3})(?!\d)/g, '$1,$2')
  .replace(/(^|[^゠-ヿ])ー(?=[一-鿿])/gm, '$1一');
const pad = (n) => String(n).padStart(2, '0');
const validDate = (y, m, d, today) => {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2015 && y <= 2099)) return null;
  const s = `${y}-${pad(m)}-${pad(d)}`;
  return s <= today ? s : null; // 不会是将来的日期
};

function findDate(lines, today) {
  for (const raw of lines) {
    const l = raw.replace(/\s+/g, '');
    let m = l.match(/(20\d{2})[年/.\-](\d{1,2})[月/.\-](\d{1,2})/);
    if (m) { const r = validDate(+m[1], +m[2], +m[3], today); if (r) return r; }
    m = l.match(/(?:令和|R)(\d{1,2})[年/.\-](\d{1,2})[月/.\-](\d{1,2})/);
    if (m) { const r = validDate(2018 + +m[1], +m[2], +m[3], today); if (r) return r; }
  }
  for (const raw of lines) { // 两位数年份：26/11/06
    const m = raw.match(/(?:^|[^\d])(\d{2})[/.](\d{1,2})[/.](\d{1,2})(?:[^\d]|$)/);
    if (m) { const r = validDate(2000 + +m[1], +m[2], +m[3], today); if (r) return r; }
  }
  return null;
}

const NUM = /[¥\\]?\s*(\d{1,3}(?:[,.\s]\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:円|元)?/g;
function numbersIn(line) {
  const out = [];
  for (const m of line.matchAll(NUM)) {
    const v = parseFloat(m[1].replace(/[,.\s]/g, '') + (m[2] ? '.' + m[2] : ''));
    if (Number.isFinite(v) && v > 0) out.push(v);
  }
  return out;
}

function findTotal(lines) {
  const keys = [
    /合\s*計|総\s*計|合計金額|お会計|ご請求|お支払(?:い)?(?:金額)?|お買上(?:げ)?|ご利用(?:金)?額|TOTAL|Total|総額|总计|合计|实付|应付/,
  ];
  const skip = /小\s*計|税|対象|内消費|お釣|おつり|釣銭|預り|お預|ポイント|点数|個|割引|値引|CHANGE|Change|找零/;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!keys.some((k) => k.test(l)) || skip.test(l)) continue;
    let nums = numbersIn(l.replace(/.*?(合\s*計|総\s*計|お会計|ご請求|お支払|お買上|ご利用|TOTAL|Total|総額|总计|合计|实付|应付)/, ''));
    if (!nums.length && lines[i + 1]) nums = numbersIn(lines[i + 1]);
    if (nums.length) return Math.max(...nums);
  }
  // 没有关键词：取带 ¥ / 円 的最大金额
  const marked = lines.filter((l) => /[¥\\]|円|元/.test(l) && !skip.test(l)).flatMap(numbersIn).filter((v) => v < 10000000);
  return marked.length ? Math.max(...marked) : null;
}

const GENERIC = /^(RESTAURANT|RECEIPT|CAFE|BAR|DINING|KITCHEN|SHOP|STORE|WELCOME|THANK YOU|INVOICE)$/i;
function findStore(lines) {
  const bad = /レシート|領収|領収書|明細|TEL|Tel|電話|〒|http|www|\d{2,4}-\d{2,4}-\d{3,4}|登録番号|インボイス|毎度|ありがとう|いらっしゃい|日付|担当|レジ|No\.|伝票|発行|様|合計|小計|¥|円/;
  const head = lines.slice(0, 8);
  const scored = head
    .map((l, i) => [l.replace(/\s{2,}/g, ' ').trim(), i])
    .filter(([l]) => l.length >= 2 && l.length <= 24 && !bad.test(l) && !GENERIC.test(l))
    .map(([l, i]) => {
      const cjk = (l.match(/[぀-ヿ一-鿿]/g) || []).length;
      const latin = (l.match(/[A-Za-z]/g) || []).length;
      const digits = (l.match(/\d/g) || []).length;
      let score = cjk * 2 + latin - digits * 2 - i * 1.5;
      if (/店|屋|亭|堂|館|食堂|ラーメン|寿司|すし|焼|カフェ|Cafe|CAFE|Restaurant|酒場|居酒屋|本店|支店/.test(l)) score += 8;
      return [l, score];
    })
    .filter(([, sc]) => sc > 2)
    .sort((a, b) => b[1] - a[1]);
  return scored.length ? scored[0][0] : null;
}

/** 从识别出的文字里提取 { date, title, amount, currency } */
export function parseReceipt(text, today) {
  const lines = Z2H(text).split(/\n/).map((l) => l.trim()).filter(Boolean);
  const all = lines.join('\n');
  const jpHint = /[぀-ヿ]|円|税込|令和/.test(all);
  const cnHint = /元|人民币|RMB|CNY|实付|合计|总计/.test(all);
  const currency = cnHint && !jpHint ? 'CNY' : 'JPY';
  let amount = findTotal(lines);
  if (amount && currency === 'JPY') amount = Math.round(amount);
  return { date: findDate(lines, today), title: findStore(lines), amount, currency };
}
