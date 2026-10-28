// gang-quick 后端 —— 极简 gang.fun 内盘买卖 + 持仓(1秒刷新)
// 启动: node server.mjs   (默认端口 8790，可用 PORT 覆盖)
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8790);

// ---------- 常量 ----------
const PADS = {
  '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E': 'V2-1B8F',
  '0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb': 'V2-F81C',
  '0x60aee38576035E757deD30fF8db8A8DA476430C1': 'V2-60AE',
  '0x245a42ce8337dece0f1c04f8430c90c8d98b88e4': 'V2-245A',
};
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const BNB = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const RPCs = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io'];
// baw 路径：优先环境变量 → 本机默认 → 依赖 PATH 里的 `baw`
const BAW_BIN = (() => {
  if (process.env.BAW_BIN) return process.env.BAW_BIN;
  const winDefault = 'C:\\Users\\chunh\\.dsh\\tools\\pnpm-global\\bin\\baw.CMD';
  try { if (existsSync(winDefault)) return winDefault; } catch {}
  return 'baw';
})();
// 构造子进程 PATH：只拼入本机真实存在的目录
function buildPath() {
  const extra = [
    'C:\\Users\\chunh\\.dsh\\tools\\pnpm-global\\bin',
    'C:\\Users\\chunh\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin',
  ].filter((d) => { try { return existsSync(d); } catch { return false; } });
  return extra.length ? extra.join(';') + ';' + (process.env.PATH || '') : (process.env.PATH || '');
}
// 读系统剪贴板（跨平台）
async function readClipboard() {
  const cmd = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']]
    : process.platform === 'darwin'
      ? ['pbpaste', []]
      : ['xclip', ['-selection', 'clipboard', '-o']];
  return new Promise((resolve, reject) => {
    execFile(cmd[0], cmd[1], { timeout: 5000, maxBuffer: 1024 * 1024 }, (e2, stdout) => {
      if (e2) return reject(e2);
      resolve(String(stdout || '').trim());
    });
  });
}
const FROM = process.env.FROM || '0x176283F80e337CE6725578b039B6b305A27b4535';
const SLIPPAGE = Number(process.env.SLIPPAGE || 3);
// 「转出」固定接收地址（可用 TRANSFER_TO 环境变量覆盖）
const RECIPIENT = process.env.TRANSFER_TO || '0xF55FC5FC56a09716F4Bf77Adb890630cFB6b0de7';

// ---------- keccak ----------
const RC = [0x0000000000000001n,0x0000000000008082n,0x800000000000808an,0x8000000080008000n,0x000000000000808bn,0x0000000080000001n,0x8000000080008081n,0x8000000000008009n,0x000000000000008an,0x0000000000000088n,0x0000000080008009n,0x000000008000000an,0x000000008000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x000000000000800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x0000000080000001n,0x8000000080008008n];
const ROTC = [[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]];
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => { n %= 64; return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64; };
function keccakF(s) {
  for (let r = 0; r < 24; r++) {
    const C = [];
    for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x+5] ^ s[x+10] ^ s[x+15] ^ s[x+20];
    for (let x = 0; x < 5; x++) { const D = C[(x+4)%5] ^ rotl(C[(x+1)%5],1); for (let y=0;y<25;y+=5) s[y+x] ^= D; }
    const B = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5*((2*x+3*y)%5)] = rotl(s[x+5*y], ROTC[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) { const i = x+5*y; s[i] = B[i] ^ ((~B[(x+1)%5+5*y]&M64) & B[(x+2)%5+5*y]); }
    s[0] ^= RC[r];
  }
}
function keccak256(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  const rate = 136, padLen = rate - (data.length % rate);
  const padded = Buffer.alloc(data.length + padLen);
  data.copy(padded); padded[data.length] ^= 0x01; padded[padded.length-1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) { for (let i = 0; i < rate/8; i++) s[i] ^= padded.readBigUInt64LE(off + i*8); keccakF(s); }
  const out = Buffer.alloc(32); for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i*8);
  return out.toString('hex');
}
const sel = (sig) => '0x' + keccak256(sig).slice(0, 8);
const padAddr = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const padHex = (n) => BigInt(n).toString(16).padStart(64, '0');

// ---------- RPC ----------
async function rpc(method, params) {
  let last;
  for (const url of RPCs) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) { last = new Error(JSON.stringify(j.error)); continue; }
      return j.result;
    } catch (e) { last = e; }
  }
  throw last || new Error('rpc fail');
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const words = (hex) => (hex.slice(2).match(/.{64}/g) || []).map((w) => BigInt('0x' + w));

// ---------- ABI ----------
const ABI = {
  balanceOf: (w) => sel('balanceOf(address)') + padAddr(w),
  decimals: () => sel('decimals()'),
  symbol: () => sel('symbol()'),
  curves: (t) => sel('curves(address)') + padAddr(t),
  virtualToken: () => sel('VIRTUAL_TOKEN()'),
  walletRoom: (t, w) => sel('walletRoom(address,address)') + padAddr(t) + padAddr(w),
  allowance: (o, s) => sel('allowance(address,address)') + padAddr(o) + padAddr(s),
  approve: (s, a) => sel('approve(address,uint256)') + padAddr(s) + padHex(a),
  buyV2: (t, qIn, minOut) => sel('buy(address,uint256,uint256)') + padAddr(t) + padHex(qIn) + padHex(minOut),
  sellV2: (t, amt, minOut) => sel('sell(address,uint256,uint256)') + padAddr(t) + padHex(amt) + padHex(minOut),
  deposit: () => sel('deposit()'),
  withdraw: (a) => sel('withdraw(uint256)') + padHex(a),
  transfer: (to, a) => sel('transfer(address,uint256)') + padAddr(to) + padHex(a),
};
const h2s = (h) => { if(!h || h==='0x') return ''; const b=h.slice(2); if(b.length<=64) return Buffer.from(b,'hex').toString('utf8').replace(/\u0000/g,'').trim(); const len=parseInt(b.slice(64,128),16); return Buffer.from(b.slice(128,128+len*2),'hex').toString('utf8'); };
const FEE = 100n, BPS = 10000n;
const ceilDiv = (a, b) => (a + b - 1n) / b;
const minOut = (v, s) => (v * BigInt(10000 - Math.min(9900, Math.round(s * 100)))) / 10000n;

// ---------- baw ----------
function bawOnce(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    env.PATH = buildPath();
    const child = execFile(BAW_BIN, ['--json', ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env, shell: true }, (err, stdout, stderr) => {
      const text = String(stdout || '').trim();
      let j = null; try { j = JSON.parse(text); } catch {}
      if (err) return reject(new Error((j?.error?.message) || String(stderr || err.message).slice(0, 400)));
      if (!j) return reject(new Error('baw_bad_json'));
      if (j.success === false) return reject(new Error(j.error?.message || 'baw_failed'));
      resolve(j);
    });
    child.on('error', reject);
  });
}
// 网络抖动自动重试（币安接口超时/断连）
async function baw(args, opts = {}) {
  const attempts = opts.attempts ?? 3;
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await bawOnce(args, opts); }
    catch (e) {
      last = e;
      const msg = String(e.message || '');
      if (/REQUEST_TIMEOUT|fetch failed|ETIMEDOUT|ECONNRESET|Connect Timeout|timeout/i.test(msg) && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw last;
}
async function walletStatus() { try { return (await baw(['wallet', 'status'], { timeoutMs: 20000 })).data?.status || 'UNKNOWN'; } catch { return 'UNKNOWN'; } }
async function walletAddresses() { try { return (await baw(['wallet', 'address'], { timeoutMs: 20000 })).data?.addresses || []; } catch { return []; } }
async function marketSwap(fromTokenQty, fromToken, toToken) {
  return (await baw(['market-order', 'swap', '--fromTokenQty', String(fromTokenQty), '--fromToken', fromToken, '--toToken', toToken, '--binanceChainId', '56', '--slippage', '3'])).data || {};
}
async function sendContract({ to, valueWei = '0', inputData, label }) {
  const pre = (await baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', FROM, '--to', to, '--value', String(valueWei), '--inputData', inputData])).data || {};
  if (!pre.requestId) throw new Error(`${label}: 预演未返回 requestId`);
  const ex = (await baw(['contract-call', 'execute', '--requestId', pre.requestId])).data || {};
  return { status: ex.status, txHash: ex.txHash || null, sim: pre.simulationResult };
}

// ---------- 曲线 ----------
async function findPad(token) {
  for (const [pad, name] of Object.entries(PADS)) {
    try {
      const w = words(await call(pad, ABI.curves(token)));
      if (w[1] !== 0n) return { name, pad, curve: { creator: '0x' + w[0].toString(16).padStart(40, '0'), quote: '0x' + w[1].toString(16).padStart(40, '0'), real: w[2], sold: w[3], gradAmt: w[4], vQ: w[5] } };
    } catch {}
  }
  return null;
}
async function virtualToken(pad) { return words(await call(pad, ABI.virtualToken()))[0]; }
function quoteBuy(curve, vt, quoteIn) {
  const K = curve.vQ * vt;
  const net = quoteIn - (quoteIn * FEE) / BPS;
  const out = (curve.vt - curve.sold) - ceilDiv(K, curve.vQ + curve.real + net);
  return out > 0n ? out : 0n;
}
function quoteSell(curve, vt, tokensIn) {
  const K = curve.vQ * vt;
  const gross = (curve.vQ + curve.real) - ceilDiv(K, curve.vt - curve.sold + tokensIn);
  const fee = (gross * FEE) / BPS;
  return { gross, fee, out: gross - fee };
}
async function tokenMeta(token) {
  try {
    const sym = h2s(await call(token, ABI.symbol()));
    const dec = parseInt(await call(token, ABI.decimals()), 16) || 18;
    return { symbol: sym || 'TOKEN', decimals: dec };
  } catch { return { symbol: 'TOKEN', decimals: 18 }; }
}

// ---------- 持仓持久化 ----------
const posFile = path.join(__dir, 'positions.json');
function loadPos() { try { return JSON.parse(readFileSync(posFile, 'utf8')); } catch { return {}; } }
function savePos(p) { writeFileSync(posFile, JSON.stringify(p, null, 2)); }
// 初始：SMK5C 剩 50%，成本 0.05 BNB
if (!existsSync(posFile)) {
  savePos({ '0x608f17dd1689847cb0ec8d9d009b0f7c91c7451b': { symbol: 'SMK5C', costBnb: 0.05 } });
}

// ---------- 工具 ----------
const err = (res, code, msg) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: msg })); };
const ok = (res, data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, ...data })); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });

// ---------- 缓存（降低 1 秒刷新对 RPC / baw 的压力） ----------
const CACHE = new Map();
function cacheGet(key, ttlMs, fn) {
  const c = CACHE.get(key), now = Date.now();
  if (c && now - c.at < ttlMs) return Promise.resolve(c.v);
  return fn().then((v) => { CACHE.set(key, { v, at: Date.now() }); return v; });
}
// 轮询等待链上状态（比固定 sleep 快，确认后立刻返回）
async function waitFor(fn, timeoutMs = 8000, intervalMs = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}
// 钱包状态/地址：baw 是子进程，很重，绝不放在 1 秒刷新路径里
async function walletInfo() {
  return cacheGet('wallet', 300_000, async () => {
    let status = 'UNKNOWN';
    try { status = await walletStatus(); } catch {}
    return { status, addr: FROM };
  });
}
// 同步取缓存；没有就在后台预热，本次先返回占位
function cachedWallet() {
  const c = CACHE.get('wallet');
  if (c) return c.v;
  walletInfo().catch(() => {});
  return { status: '…', addr: FROM };
}
// pad / virtualToken：几乎不变，缓存 10 分钟
async function padInfo(token) {
  return cacheGet('pad:' + token.toLowerCase(), 600_000, async () => {
    const f = await findPad(token);
    if (!f) return null;
    const vt = await virtualToken(f.pad);
    return { f, vt };
  });
}
// BNB 的 USDT 价（60 秒缓存，多级兜底）
async function getBnbUsd() {
  return cacheGet('bnbUsd', 60_000, async () => {
    try {
      const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT', { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      if (Number(j?.price) > 0) return Number(j.price);
    } catch {}
    try {
      const r2 = await fetch('https://gang.fun/api/tokens/0x0c6302401aa5325c2e36f170f52c00b1d220b405', { headers: { accept: 'application/json' } });
      const j2 = await r2.json();
      if (Number(j2?.quoteUsd) > 0) return Number(j2.quoteUsd);
    } catch {}
    return 735; // 兜底
  });
}

// ---------- 核心：状态（余额 + 持仓） ----------
async function getState() {
  const { status, addr } = cachedWallet();
  const [bnb, wbnb, usdt, bnbUsd] = await Promise.all([
    rpc('eth_getBalance', [addr, 'latest']).then((x) => Number(BigInt(x)) / 1e18).catch(() => 0),
    call(WBNB, ABI.balanceOf(addr)).then((x) => Number(words(x)[0]) / 1e18).catch(() => 0),
    call(USDT, ABI.balanceOf(addr)).then((x) => Number(words(x)[0]) / 1e18).catch(() => 0),
    getBnbUsd(),
  ]);
  const pos = loadPos();
  const positions = [];
  for (const [token, p] of Object.entries(pos)) {
    let bal = 0n, valueBnb = 0, symbol = p.symbol || 'TOKEN';
    const pi = await padInfo(token);
    // balanceOf 与 curves 并行，省一半往返
    const [balHex, cwHex] = await Promise.all([
      call(token, ABI.balanceOf(addr)).catch(() => null),
      pi ? call(pi.f.pad, ABI.curves(token)).catch(() => null) : Promise.resolve(null),
    ]);
    if (balHex) { try { bal = words(balHex)[0]; } catch {} }
    if (pi && cwHex) {
      try {
        const cw = words(cwHex);
        const curve = { creator: '0x' + cw[0].toString(16).padStart(40, '0'), quote: '0x' + cw[1].toString(16).padStart(40, '0'), real: cw[2], sold: cw[3], gradAmt: cw[4], vQ: cw[5] };
        const q = quoteSell({ ...curve, vt: pi.vt }, pi.vt, bal);
        valueBnb = Number(q.out) / 1e18;
      } catch {}
    }
    const cost = Number(p.costBnb || 0);
    const pnl = valueBnb - cost;
    const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
    positions.push({ token, symbol, balance: Number(bal) / 1e18, costBnb: cost, valueBnb, pnlBnb: pnl, pnlPct,
      costUsd: cost * bnbUsd, valueUsd: valueBnb * bnbUsd, pnlUsd: pnl * bnbUsd, auto: p.auto || null });
  }
  return { addr, status, bnb, wbnb, usdt, bnbUsd, positions };
}

// ---------- 卖出（手动 + 自动策略共用） ----------
async function doSell(token, pct, slippage = SLIPPAGE) {
  if (!token || !(pct > 0 && pct <= 100)) throw new Error('参数错');
  const f = await findPad(token);
  if (!f) {
    // 已毕业：走外盘聚合兑换（代币 → BNB）
    const bal0 = words(await call(token, ABI.balanceOf(FROM)))[0];
    if (bal0 <= 0n) throw new Error('没有可卖余额');
    const amt = pct >= 100 ? bal0 : (bal0 * BigInt(Math.round(pct * 100))) / 10000n;
    if (amt <= 0n) throw new Error('数量为 0');
    const dec = (await tokenMeta(token)).decimals;
    const sw = await marketSwap(Number(amt) / 10 ** dec, token, BNB);
    return { status: sw.status || 'submitted', orderId: sw.orderId, soldTokens: Number(amt) / 10 ** dec, note: '已毕业，走外盘聚合兑换' };
  }
  const vt = await virtualToken(f.pad);
  const c = { ...f.curve, vt };
  const bal = words(await call(token, ABI.balanceOf(FROM)))[0];
  if (bal <= 0n) throw new Error('没有可卖余额');
  const amt = pct >= 100 ? bal : (bal * BigInt(Math.round(pct * 100))) / 10000n;
  const q = quoteSell(c, vt, amt);
  const hashes = [];
  let allow = words(await call(token, ABI.allowance(FROM, f.pad)))[0];
  if (allow < amt) {
    hashes.push((await sendContract({ to: token, inputData: ABI.approve(f.pad, amt * 10n), label: 'approve-token' })).txHash);
    const ok2 = await waitFor(async () => { const x = words(await call(token, ABI.allowance(FROM, f.pad)))[0]; return x >= amt ? x : null; }, 15000);
    allow = ok2 || words(await call(token, ABI.allowance(FROM, f.pad)))[0];
    if (allow < amt) throw new Error('授权还没上链（可能需要在币安 App 里确认授权）');
  }
  const r = await sendContract({ to: f.pad, inputData: ABI.sellV2(token, amt, minOut(q.out, slippage)), label: 'sell' });
  const pos = loadPos();
  const cur = pos[token.toLowerCase()] || pos[token];
  if (cur) { cur.costBnb = Number(cur.costBnb || 0) * (1 - pct / 100); pos[token.toLowerCase()] = cur; savePos(pos); }
  return { status: r.status, txHash: r.txHash, soldTokens: Number(amt) / 1e18, quoteOut: Number(q.out) / 1e18, hashes: hashes.filter(Boolean) };
}

// ---------- 自动策略：涨 100% 卖 50%，跌 50% 卖 100% ----------
const STRAT = { tpPct: 100, tpSellPct: 50, slPct: -50, slSellPct: 100 };
let stratBusy = false;
async function checkAutoSell() {
  if (stratBusy) return;
  stratBusy = true;
  try {
    const { addr } = cachedWallet();
    const pos = loadPos();
    for (const [token, p] of Object.entries(pos)) {
      if (!p.auto?.enabled) continue;
      const bal = words(await call(token, ABI.balanceOf(addr)))[0];
      if (bal <= 0n) continue;
      const pi = await padInfo(token);
      if (!pi) continue;
      const cw = words(await call(pi.f.pad, ABI.curves(token)));
      const curve = { quote: '0x' + cw[1].toString(16).padStart(40, '0'), real: cw[2], sold: cw[3], gradAmt: cw[4], vQ: cw[5] };
      const q = quoteSell({ ...curve, vt: pi.vt }, pi.vt, bal);
      const valueBnb = Number(q.out) / 1e18;
      const cost = Number(p.costBnb || 0);
      if (cost <= 0) continue;
      const pnlPct = ((valueBnb - cost) / cost) * 100;
      const tp = Number(p.auto.tpPct ?? STRAT.tpPct), tps = Number(p.auto.tpSellPct ?? STRAT.tpSellPct);
      const sl = Number(p.auto.slPct ?? STRAT.slPct), sls = Number(p.auto.slSellPct ?? STRAT.slSellPct);
      if (!p.auto.tpDone && pnlPct >= tp && pnlPct > 0) {
        console.log(`[策略] ${p.symbol || token} 涨 ${pnlPct.toFixed(1)}% ≥ ${tp}% → 卖 ${tps}%`);
        try { await doSell(token, tps, 3); p.auto.tpDone = true; p.auto.lastAction = `止盈 ${tps}% @ ${pnlPct.toFixed(1)}%`; p.auto.lastAt = Date.now(); savePos(pos); } catch (e) { console.warn('[策略] 止盈失败: ' + e.message); }
      } else if (!p.auto.slDone && pnlPct <= sl) {
        console.log(`[策略] ${p.symbol || token} 跌 ${pnlPct.toFixed(1)}% ≤ ${sl}% → 卖 ${sls}%`);
        try { await doSell(token, sls, 3); p.auto.slDone = true; p.auto.lastAction = `止损 ${sls}% @ ${pnlPct.toFixed(1)}%`; p.auto.lastAt = Date.now(); savePos(pos); } catch (e) { console.warn('[策略] 止损失败: ' + e.message); }
      }
    }
  } catch (e) { console.warn('[策略] 检查失败: ' + e.message); }
  finally { stratBusy = false; }
}

// ---------- HTTP ----------
const HTML = readFileSync(path.join(__dir, 'public', 'index.html'), 'utf8');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const t0 = Date.now();
  if (p.startsWith('/api/') && req.method === 'POST') console.log(`[api] ${req.method} ${p}`);
  try {
    if (p === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(HTML); }
    if (p === '/api/state') return ok(res, await getState());
    if (p === '/api/token') {
      const token = (url.searchParams.get('token') || '').trim();
      if (!token) return err(res, 400, '缺 token');
      const bnbAmt = Number(url.searchParams.get('bnb') || 0.1);
      // 1) gang.fun 官方接口（内盘 + 已毕业 都能查到）
      let info = null;
      for (const base of ['https://gang.fun/api/tokens/', 'https://gang.fun/api/stocks/tokens/']) {
        try {
          const r = await fetch(base + token, { headers: { accept: 'application/json' } });
          if (r.status === 200) { const j = await r.json(); if (j && j.address) { info = j; break; } }
        } catch {}
      }
      // 2) 链上 pad（只有内盘未毕业的才有曲线）
      const f = await findPad(token);
      let bal = 0n;
      try { bal = words(await call(token, ABI.balanceOf(FROM)))[0]; } catch {}
      const priceBnb = info ? Number(info.priceBnb ?? info.priceQuote ?? 0) : 0;
      const raised = info ? Number(info.raisedBnb ?? info.raisedQuote ?? 0) : 0;
      const grad = info ? Number(info.gradAmtBnb ?? info.gradAmtQuote ?? 0) : 0;
      // 内盘以链上曲线为准（官方接口对部分盘有滞后）
      const onchain = !!(f && !info?.graduated);
      const out = {
        address: token,
        found: !!info || !!f,
        track: info?.track || (f ? 'main' : null),
        symbol: info?.symbol || (f ? (await tokenMeta(token)).symbol : ''),
        name: info?.name || '',
        graduated: !!info?.graduated,
        progressPct: onchain
          ? Number(f.curve.real) * 100 / (Number(f.curve.gradAmt) || 1)
          : (info ? Number(info.progressPct || 0) : 0),
        priceBnb,
        raisedBnb: onchain ? Number(f.curve.real) / 1e18 : raised,
        gradAmtBnb: onchain ? Number(f.curve.gradAmt) / 1e18 : grad,
        pair: info?.pair || null,
        holders: info?.holders ?? null,
        pad: f ? f.name : null,
        padAddr: f ? f.pad : null,
        myBalance: Number(bal) / 1e18,
        buyableByPad: !!f && !info?.graduated,
      };
      if (f && !info?.graduated) {
        const vt = await virtualToken(f.pad);
        const c = { ...f.curve, vt };
        const tokensOut = quoteBuy(c, vt, BigInt(Math.round(bnbAmt * 1e18)));
        const room = words(await call(f.pad, ABI.walletRoom(token, FROM)))[0];
        out.quote = c.quote;
        out.tokensOut = Number(tokensOut) / 1e18;
        out.room = Number(room) / 1e18;
        // 打满 1% 需要的 BNB（反解曲线）
        if (room > 0n) {
          const K = c.vQ * vt;
          const denom = c.vt - c.sold - room;
          if (denom > 0n) {
            const needNet = K / denom - (c.vQ + c.real);
            const needIn = needNet > 0n ? (needNet * BPS) / (BPS - FEE) : 0n;
            out.fullBnb = Math.ceil(Number(needIn) / 1e18 * 1.02 * 100) / 100; // 加 2% 余量，合约会自动退多余
          }
        }
      }
      if (!out.found) return err(res, 404, 'gang.fun 和链上曲线都查不到这个地址（确认是代币合约地址？）');
      return ok(res, out);
    }
    if (p === '/api/buy' && req.method === 'POST') {
      const buyT0 = Date.now();
      const b = await readBody(req);
      const token = b.token, bnbAmt = Number(b.bnb);
      if (!token || !(bnbAmt > 0)) return err(res, 400, '参数错');
      let f = await findPad(token);
      if (!f) {
        // 可能已毕业：走 Binance 聚合兑换（BNB → 代币）
        let info = null;
        for (const base of ['https://gang.fun/api/tokens/', 'https://gang.fun/api/stocks/tokens/']) {
          try { const r = await fetch(base + token, { headers: { accept: 'application/json' } }); if (r.status === 200) { const j = await r.json(); if (j?.address) { info = j; break; } } } catch {}
        }
        if (!info) return err(res, 404, '找不到这个币');
        if (!info.graduated) return err(res, 400, '该币是内盘但不在已知 pad 上（可能是 V3/新合约），暂不支持买入');
        const sw = await marketSwap(bnbAmt, BNB, token);
        return ok(res, { status: sw.status || 'submitted', orderId: sw.orderId, note: '已毕业，走外盘聚合兑换', spentBnb: bnbAmt, elapsedMs: Date.now() - buyT0 });
      }
      const pi = await padInfo(token);
      const pad = pi?.f?.pad || f.pad;
      const vt = pi?.vt || (await virtualToken(pad));
      const cw = words(await call(pad, ABI.curves(token)));
      const c = { quote: '0x' + cw[1].toString(16).padStart(40, '0'), real: cw[2], sold: cw[3], gradAmt: cw[4], vQ: cw[5], vt };
      if (c.quote.toLowerCase() !== WBNB.toLowerCase()) return err(res, 400, '该盘报价币不是 WBNB，暂不支持');
      const value = BigInt(Math.round(bnbAmt * 1e18));
      const room = words(await call(pad, ABI.walletRoom(token, FROM)))[0];
      if (room <= 0n) return err(res, 400, '已到单钱包 1% 上限');
      const slippage = Number(b.slippage ?? SLIPPAGE);
      const hashes = [];
      // 1) 只在 WBNB 不够时才 wrap（省一笔交易）
      let wbnbBal = words(await call(WBNB, ABI.balanceOf(FROM)))[0];
      if (wbnbBal < value) {
        const need = value - wbnbBal;
        hashes.push((await sendContract({ to: WBNB, valueWei: need, inputData: ABI.deposit(), label: 'wrap' })).txHash);
        const ok2 = await waitFor(async () => { const x = words(await call(WBNB, ABI.balanceOf(FROM)))[0]; return x >= value ? x : null; }, 8000);
        wbnbBal = ok2 || words(await call(WBNB, ABI.balanceOf(FROM)))[0];
      }
      const spend = wbnbBal < value ? wbnbBal : value;
      if (spend <= 0n) return err(res, 500, 'WBNB 没到账');
      // 2) 只在授权不够时才 approve（一次批较大额度，覆盖多笔）
      let allow = words(await call(WBNB, ABI.allowance(FROM, pad)))[0];
      if (allow < spend) {
        const target = spend * 2n > 5n * 10n ** 17n ? spend * 2n : 5n * 10n ** 17n;
        hashes.push((await sendContract({ to: WBNB, inputData: ABI.approve(pad, target), label: 'approve-wbnb' })).txHash);
        const ok3 = await waitFor(async () => { const x = words(await call(WBNB, ABI.allowance(FROM, pad)))[0]; return x >= spend ? x : null; }, 8000);
        allow = ok3 || words(await call(WBNB, ABI.allowance(FROM, pad)))[0];
      }
      // 3) buy
      const out = quoteBuy(c, vt, spend);
      if (out <= 0n) return err(res, 400, '报价为 0');
      const r = await sendContract({ to: pad, inputData: ABI.buyV2(token, spend, minOut(out, slippage)), label: 'buy' });
      // 记成本
      const pos = loadPos();
      const cur = pos[token.toLowerCase()] || pos[token] || { symbol: (await tokenMeta(token)).symbol, costBnb: 0 };
      cur.symbol = (await tokenMeta(token)).symbol;
      cur.costBnb = (Number(cur.costBnb || 0) + Number(spend) / 1e18);
      pos[token.toLowerCase()] = cur; savePos(pos);
      return ok(res, { status: r.status, txHash: r.txHash, spentBnb: Number(spend) / 1e18, tokensOut: Number(out) / 1e18, hashes: hashes.filter(Boolean), elapsedMs: Date.now() - buyT0 });
    }
    if (p === '/api/sell' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        const r = await doSell(b.token, Number(b.pct || 100), Number(b.slippage ?? SLIPPAGE));
        return ok(res, r);
      } catch (e) { return err(res, 400, e.message); }
    }
    if (p === '/api/strategy' && req.method === 'POST') {
      const b = await readBody(req);
      const token = b.token;
      if (!token) return err(res, 400, '缺 token');
      const pos = loadPos();
      const key = token.toLowerCase();
      const cur = pos[key] || pos[token] || { symbol: 'TOKEN', costBnb: 0 };
      if (b.enabled) {
        cur.auto = { enabled: true, tpPct: 100, tpSellPct: 50, slPct: -50, slSellPct: 100, tpDone: false, slDone: false };
      } else if (cur.auto) {
        cur.auto.enabled = false;
        cur.auto.tpDone = false;
        cur.auto.slDone = false;
      }
      pos[key] = cur; savePos(pos);
      return ok(res, { auto: cur.auto || null });
    }
    if (p === '/api/transfer' && req.method === 'POST') {
      const b = await readBody(req);
      const token = b.token;
      if (!token) return err(res, 400, '缺 token');
      const bal = words(await call(token, ABI.balanceOf(FROM)))[0];
      if (bal <= 0n) return err(res, 400, '该代币没有余额');
      // 未给 amount 则转出全部
      const amt = b.amount ? BigInt(Math.round(Number(b.amount) * 1e18)) : bal;
      if (amt <= 0n || amt > bal) return err(res, 400, '数量非法（超过余额）');
      const r = await sendContract({ to: token, inputData: ABI.transfer(RECIPIENT, amt), label: 'transfer-out' });
      // 转出后从持仓记录里按比例扣成本
      const pos = loadPos();
      const cur = pos[token.toLowerCase()] || pos[token];
      if (cur && bal > 0n) { cur.costBnb = Number(cur.costBnb || 0) * (1 - Number(amt) / Number(bal)); pos[token.toLowerCase()] = cur; savePos(pos); }
      return ok(res, { status: r.status, txHash: r.txHash, amount: Number(amt) / 1e18, to: RECIPIENT });
    }
    if (p === '/api/unwrap' && req.method === 'POST') {
      const b = await readBody(req);
      const bal = words(await call(WBNB, ABI.balanceOf(FROM)))[0];
      if (bal <= 0n) return err(res, 400, 'WBNB 没有余额');
      const amt = b.amount ? BigInt(Math.round(Number(b.amount) * 1e18)) : bal;
      if (amt <= 0n || amt > bal) return err(res, 400, '数量非法');
      const r = await sendContract({ to: WBNB, inputData: ABI.withdraw(amt), label: 'unwrap' });
      return ok(res, { status: r.status, txHash: r.txHash, amount: Number(amt) / 1e18 });
    }
    if (p === '/api/usdt2bnb' && req.method === 'POST') {
      const b = await readBody(req);
      const bal = words(await call(USDT, ABI.balanceOf(FROM)))[0];
      if (bal <= 0n) return err(res, 400, 'USDT 没有余额');
      const amt = b.amount ? Number(b.amount) : Number(bal) / 1e18;
      if (!(amt > 0) || amt > Number(bal) / 1e18) return err(res, 400, '数量非法');
      const r = await marketSwap(amt, USDT, BNB);
      return ok(res, { orderId: r.orderId, status: r.status || 'submitted', note: '已提交，用 market-order 完成' });
    }
    if (p === '/api/clipboard') {
      try {
        const text = await readClipboard();
        const m = text.match(/0x[0-9a-fA-F]{40}/);
        return ok(res, { text: text.slice(0, 200), address: m ? m[0] : null });
      } catch (e) { return err(res, 500, '读剪贴板失败: ' + e.message); }
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { err(res, 500, e.message || 'server error'); }
});

server.listen(PORT, '127.0.0.1', () => console.log(`gang-quick 已启动: http://127.0.0.1:${PORT}`));
// 启动后台预热钱包状态（不阻塞）
walletInfo().catch(() => {});
// 自动止盈止损：每 10 秒检查一次（轻量，只读余额+曲线）
setInterval(checkAutoSell, 10_000);
