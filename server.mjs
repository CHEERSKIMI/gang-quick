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
  '0x15cfd2dc8278fb87a1783ef42111618e20874365': 'V3-15CF',
};
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const BNB = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const RPCs = [
  ...(process.env.BSC_RPC ? [process.env.BSC_RPC] : []),
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
];
// ---------- 本机路径（跨机器自适应：按当前用户家目录解析，不写死某台机器） ----------
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const DSH_DIR = path.join(HOME, '.dsh');
const firstExisting = (list) => list.find((p) => { try { return existsSync(p); } catch { return false; } }) || '';
// baw 路径：优先环境变量 → 本机常见安装位置 → 依赖 PATH 里的 `baw`
const BAW_BIN = process.env.BAW_BIN || firstExisting([
  path.join(DSH_DIR, 'tools', 'pnpm-global', 'bin', 'baw.CMD'),
  path.join(DSH_DIR, 'baw-bin', 'baw.cmd'),
]) || 'baw';
// 构造子进程 PATH：只拼入本机真实存在的目录
function buildPath() {
  const extra = [
    path.join(DSH_DIR, 'tools', 'pnpm-global', 'bin'),
    path.join(DSH_DIR, 'baw-bin'),
    // 注意：不要把 tools\baw\node_modules\.bin 加进来 —— 那里的 baw.cmd 不设 BINANCE_BAW_DIR，
    // 会抢在 WindowsApps 的 shim 前面，导致跑进空 profile（wallet status 变 UNCONNECTED）
    path.join(DSH_DIR, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin'),
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
// 双账号：A 主号（默认会话），B 小号（独立会话目录）
const ACCOUNTS = {
  A: { addr: process.env.ACCT_A_ADDR || '0x176283F80e337CE6725578b039B6b305A27b4535', dir: null },
  // B 小号：独立会话目录（BINANCE_BAW_DIR 指向 account2 profile）
  B: { addr: process.env.ACCT_B_ADDR || '0xB24619585f0Df28367554305CC16e293aA23b143', dir: process.env.ACCT_B_DIR || path.join(DSH_DIR, 'baw-profiles', 'account2') },
};

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
function bawOnce(args, { timeoutMs = 120_000, extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
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
// baw 预演偶尔把「可以执行」的交易判成 execution reverted（同一份 calldata 重试即成功），
// 所以预览失败时重试一次，避免 /api/transfer 这类一次性动作被误杀
async function previewCall(args) {
  try {
    return await baw(args);
  } catch (e) {
    if (/simulation failed|execution reverted/i.test(String(e.message || ''))) {
      await new Promise((r) => setTimeout(r, 800));
      return await baw(args);
    }
    throw e;
  }
}
async function sendContract({ to, valueWei = '0', inputData, label }) {
  const pre = (await previewCall(['contract-call', 'preview', '--binanceChainId', '56', '--from', FROM, '--to', to, '--value', String(valueWei), '--inputData', inputData])).data || {};
  if (!pre.requestId) throw new Error(`${label}: 预演未返回 requestId`);
  const ex = (await baw(['contract-call', 'execute', '--requestId', pre.requestId])).data || {};
  return { status: ex.status, txHash: ex.txHash || null, sim: pre.simulationResult };
}

// ---------- 多网络：Robinhood Chain（mobster.meme，走 mobster CLI）+ Solana ----------
// MOBSTER_BAW：优先环境变量 → 本机默认（存在才用）→ 空（让 mobster 自己探测）
const MOBSTER_BAW = process.env.MOBSTER_BAW || firstExisting([
  path.join(DSH_DIR, 'tools', 'baw', 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js'),
]) || '';
const MOBSTER_V3_PAD = process.env.MOBSTER_V3_PAD || '0x4ED0f046D97d508df86D6B7B058E763DbFb0027f';
const MOBSTER_ROUTER = process.env.MOBSTER_ROUTER || '0x481F370040084ED9977b6ED4140b3188d95CaDCf';
const RH_RPC = process.env.MOBSTER_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const RH_CHAIN = '4663', SOL_CHAIN = 'CT_501';

function mobster(args, { timeoutMs = 150_000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MOBSTER_V3_PAD, MOBSTER_ROUTER };
    if (MOBSTER_BAW) env.MOBSTER_BAW = MOBSTER_BAW;
    env.PATH = buildPath();
    const child = execFile('mobster', [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env, shell: true }, (err, stdout, stderr) => {
      const text = String(stdout || '').trim();
      let j = null; try { j = JSON.parse(text); } catch {}
      if (err) return reject(new Error((j?.error) || String(stderr || err.message).slice(0, 400)));
      if (!j) return reject(new Error('mobster_bad_json: ' + text.slice(0, 200)));
      resolve(j);
    });
    child.on('error', reject);
  });
}
async function rhTokenInfo(token) {
  return cacheGet('rhtok:' + token.toLowerCase(), 10_000, async () => {
    try {
      const r = await fetch('https://mobster.meme/api/tokens/' + token, { headers: { accept: 'application/json' } });
      if (r.status === 200) { const j = await r.json(); if (j?.address) return j; }
    } catch {}
    return null;
  });
}
async function rhTokenBalance(token) {
  try {
    const r = await fetch(RH_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data: sel('balanceOf(address)') + padAddr(FROM) }, 'latest'] }) });
    const j = await r.json();
    return Number(BigInt(j.result)) / 1e18;
  } catch { return 0; }
}
async function rhEthBalance() {
  return cacheGet('rhEth', 30_000, async () => {
    try { const j = await baw(['wallet', 'balance', '--binanceChainId', RH_CHAIN], { timeoutMs: 20000 }); return Number(j.data?.find((x) => x.symbol === 'ETH')?.balance || 0); } catch { return 0; }
  });
}
async function solBalance() {
  try { const j = await baw(['wallet', 'balance', '--binanceChainId', SOL_CHAIN], { timeoutMs: 20000 }); return j.data || []; } catch { return []; }
}
// RH 买入：mobster v3 buy（预览）→ execute
async function rhBuy(token, eth) {
  const pre = await mobster(['v3', 'buy', '--token', token, '--amount', String(eth)]);
  if (!pre.success) throw new Error(pre.error || '预览失败');
  const ex = await mobster(['execute', '--request-id', pre.requestId]);
  return { status: ex.status, txHash: ex.txHash, expectTokens: pre.expectTokens, requestId: pre.requestId };
}
// RH 卖出
async function rhSell(token, pct) {
  const bal = await rhTokenBalance(token);
  if (!(bal > 0)) throw new Error('没有可卖余额');
  const args = pct >= 100 ? ['v3', 'sell', '--token', token, '--all'] : ['v3', 'sell', '--token', token, '--amount', String(bal * pct / 100)];
  const pre = await mobster(args);
  if (!pre.success) throw new Error(pre.error || '预览失败');
  const ex = await mobster(['execute', '--request-id', pre.requestId]);
  return { status: ex.status, txHash: ex.txHash, sold: pct >= 100 ? bal : (bal * pct / 100) };
}

// ---------- Solana ----------
const SOL_NATIVE = 'So11111111111111111111111111111111111111111';
async function solBalances() {
  return cacheGet('solBal', 30_000, async () => {
    try { const j = await baw(['wallet', 'balance', '--binanceChainId', SOL_CHAIN], { timeoutMs: 20000 }); return j.data || []; } catch { return []; }
  });
}
async function solAddress() {
  return cacheGet('solAddr', 300_000, async () => {
    try { const j = await baw(['wallet', 'address'], { timeoutMs: 20000 }); return j.data?.addresses?.find((a) => a.binanceChainId === 'CT_501')?.address || ''; } catch { return ''; }
  });
}
async function solTokenInfo(mint) {
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mint, { headers: { accept: 'application/json' } });
    const j = await r.json();
    const pair = (j.pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!pair) return null;
    return {
      symbol: pair.baseToken?.symbol || 'TOKEN',
      name: pair.baseToken?.name || '',
      priceUsd: Number(pair.priceUsd || 0),
      priceNative: Number(pair.priceNative || 0),
      liquidityUsd: Number(pair.liquidity?.usd || 0),
      volume24hUsd: Number(pair.volume?.h24 || 0),
      pair: pair.pairAddress || null,
      dexId: pair.dexId || null,
    };
  } catch { return null; }
}
async function solSwap(fromQty, fromToken, toToken, slippage = 3) {
  const j = await baw(['market-order', 'swap', '--fromTokenQty', String(fromQty), '--fromToken', fromToken, '--toToken', toToken, '--binanceChainId', SOL_CHAIN, '--slippage', String(slippage)]);
  return j.data || {};
}
async function solTokenBalance(mint) {
  const bal = await solBalances();
  const hit = bal.find((x) => String(x.address || '').toLowerCase() === String(mint).toLowerCase());
  return Number(hit?.balance || 0);
}

// ---------- 曲线 ----------
async function findPad(token) {
  for (const [pad, name] of Object.entries(PADS)) {
    try {
      const w = words(await call(pad, ABI.curves(token)));
      if (w[1] !== 0n) return { name, pad, curve: { creator: '0x' + w[0].toString(16).padStart(40, '0'), quote: '0x' + w[1].toString(16).padStart(40, '0'), real: w[2], sold: w[3], gradAmt: w[4], vQ: w[5], graduated: (w[6] || 0n) === 1n } };
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
// gang.fun 官方接口：给不在经典 pad 上的币（如 fly 份额盘）取符号 / 场内价
async function gangTokenInfo(token) {
  return cacheGet('gtok:' + String(token).toLowerCase(), 10_000, async () => {
    for (const base of ['https://gang.fun/api/tokens/', 'https://gang.fun/api/stocks/tokens/']) {
      try {
        const r = await fetch(base + token, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
        if (r.status !== 200) continue;
        const j = await r.json();
        if (j && j.address) return j;
      } catch {}
    }
    return null;
  });
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
// 价格源：部分网络下 api.binance.com 会被 reset，官方镜像 data-api.binance.vision 可直连，优先用它
const PRICE_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com', 'https://api2.binance.com'];
async function binancePrice(symbol) {
  for (const h of PRICE_HOSTS) {
    try {
      const r = await fetch(`${h}/api/v3/ticker/price?symbol=${symbol}`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (Number(j?.price) > 0) return Number(j.price);
    } catch {}
  }
  return 0;
}
// BNB 的 USDT 价（60 秒缓存，多级兜底）
async function getBnbUsd() {
  return cacheGet('bnbUsd', 60_000, async () => {
    const p = await binancePrice('BNBUSDT');
    if (p > 0) return p;
    try {
      const r2 = await fetch('https://gang.fun/api/tokens/0x0c6302401aa5325c2e36f170f52c00b1d220b405', { headers: { accept: 'application/json' } });
      const j2 = await r2.json();
      if (Number(j2?.quoteUsd) > 0) return Number(j2.quoteUsd);
    } catch {}
    return 735; // 兜底
  });
}

// ---------- ETH 的 USDT 价 ----------
async function getEthUsd() {
  return cacheGet('ethUsd', 60_000, async () => {
    const p = await binancePrice('ETHUSDT');
    if (p > 0) return p;
    return 2350;
  });
}
// ---------- SOL 的 USDT 价 ----------
async function getSolUsd() {
  return cacheGet('solUsd', 60_000, async () => {
    const p = await binancePrice('SOLUSDT');
    if (p > 0) return p;
    return 200;
  });
}

// ---------- 核心：状态（余额 + 持仓） ----------
async function getState(chain = 'bsc') {
  const { status, addr } = cachedWallet();
  const pos = loadPos();

  if (chain === 'rh') {
    const [eth, ethUsd] = await Promise.all([rhEthBalance(), getEthUsd()]);
    const positions = [];
    for (const [token, p] of Object.entries(pos)) {
      if ((p.chain || 'bsc') !== 'rh') continue;
      const [bal, info] = await Promise.all([rhTokenBalance(token), rhTokenInfo(token)]);
      const value = bal * Number(info?.price || 0);
      const cost = Number(p.costBnb || 0);
      const pnl = value - cost;
      const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
      positions.push({ token, symbol: p.symbol || info?.symbol || 'TOKEN', balance: bal, costBnb: cost, valueBnb: value, pnlBnb: pnl, pnlPct,
        costUsd: cost * ethUsd, valueUsd: value * ethUsd, pnlUsd: pnl * ethUsd, chain: 'rh' });
    }
    return { chain: 'rh', addr, status, eth, ethUsd, positions };
  }

  if (chain === 'sol') {
    const [bal, saddr, solUsd] = await Promise.all([solBalances(), solAddress(), getSolUsd()]);
    const sol = Number(bal.find((x) => x.symbol === 'SOL')?.balance || 0);
    return { chain: 'sol', addr: saddr || addr, status, sol, solUsd, positions: [] };
  }

  // BSC（默认）
  const [bnb, wbnb, usdt, bnbUsd] = await Promise.all([
    rpc('eth_getBalance', [addr, 'latest']).then((x) => Number(BigInt(x)) / 1e18).catch(() => 0),
    call(WBNB, ABI.balanceOf(addr)).then((x) => Number(words(x)[0]) / 1e18).catch(() => 0),
    call(USDT, ABI.balanceOf(addr)).then((x) => Number(words(x)[0]) / 1e18).catch(() => 0),
    getBnbUsd(),
  ]);
  const positions = [];
  for (const [token, p] of Object.entries(pos)) {
    if ((p.chain || 'bsc') !== 'bsc') continue;
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
    } else if (bal > 0n) {
      // 不在经典 pad 上（如 gang.fun 新的 fly 份额盘）：用官方接口的场内价估值
      const gi = await gangTokenInfo(token);
      const px = Number(gi?.priceQuote ?? gi?.priceBnb ?? 0);
      if (px > 0) {
        valueBnb = (Number(bal) / 1e18) * px;
        symbol = p.symbol || gi?.symbol || symbol;
      }
    }
    const cost = Number(p.costBnb || 0);
    const pnl = valueBnb - cost;
    const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
    positions.push({ token, symbol, balance: Number(bal) / 1e18, costBnb: cost, valueBnb, pnlBnb: pnl, pnlPct,
      costUsd: cost * bnbUsd, valueUsd: valueBnb * bnbUsd, pnlUsd: pnl * bnbUsd, auto: p.auto || null, chain: 'bsc' });
  }
  return { chain: 'bsc', addr, status, bnb, wbnb, usdt, bnbUsd, positions };
}
// 状态缓存（800ms）：切链/多标签同时刷新时去重，减少 RPC 压力
function getStateCached(chain) {
  return cacheGet('state:' + chain, 800, () => getState(chain));
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

// ---------- 发现（BSC 聪明钱在打什么） ----------
const SKILL_CLI = process.env.SKILL_CLI || path.join(HOME, 'Documents', 'deepseek-harness', 'default-workspace', '.agents', 'skills', 'crypto-market-rank', 'scripts', 'cli.mjs');
function runCli(cmd, params) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    env.PATH = buildPath();
    execFile(process.execPath, [SKILL_CLI, cmd, JSON.stringify(params)], { timeout: 60000, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).slice(0, 300)));
      try { resolve(JSON.parse(String(stdout || '').trim())); } catch (e) { reject(new Error('discover 返回非 JSON')); }
    });
  });
}
async function discoverBsc(period = '30m') {
  // 主数据源：BSC 链上 agent/聪明钱 实时交易流（按时间窗口过滤）
  const winSec = { '5m': 300, '30m': 1800, '1h': 3600, '24h': 86400 }[period] || 1800;
  let trades;
  try { trades = await agentTrades(winSec); } catch (e) { trades = { list: [], totalTrades: 0 }; }
  const list = trades.list.map((t) => ({
    name: t.name,
    ca: t.ca,
    inflow: t.netUsd,
    priceChange: 0,
    price: t.price,
    marketCap: t.marketCap,
    volume: 0,
    holders: null,
    risk: t.risk,
    platform: `${t.buys}买/${t.sells}卖 · ${t.traders}个地址`,
    icon: '',
    links: [],
    isAgent: true,
    mine: false,
    agentTrade: true,
  }));
  return { list, period, total: trades.totalTrades, agentCount: list.length, mineCount: 0 };
}

// BSC 链上 agent/聪明钱 实时交易流（baw tracker tx query --tag-type smy）
const TRADE_SIDE = { 11: 'buy', 19: 'buy', 100002: 'buy', 100001: 'sell', 21: 'sell', 29: 'sell' };
async function agentTrades(winSec = 1800) {
  const r = await baw(['tracker', 'tx', 'query', '-c', '56', '--tag-type', 'smy'], { timeoutMs: 30000, attempts: 2 });
  const now = Math.floor(Date.now() / 1000);
  const rows = (r.data || []).filter((t) => now - Number(t.ts || 0) <= winSec);
  const byCa = new Map();
  for (const t of rows) {
    if (!t.ca) continue;
    const ca = t.ca.toLowerCase();
    const side = TRADE_SIDE[t.tradeSideCategory] || 'buy';
    const usd = Number(t.txUsdValue || 0);
    let e = byCa.get(ca);
    if (!e) {
      e = { ca, name: t.tokenName || 'TOKEN', buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, lastTs: 0, price: Number(t.currentPrice || t.tokenPrice || 0), marketCap: Number(t.marketCap || 0), risk: t.tokenRiskLevel, addrs: new Set() };
      byCa.set(ca, e);
    }
    if (side === 'buy') { e.buys++; e.buyUsd += usd; } else { e.sells++; e.sellUsd += usd; }
    e.lastTs = Math.max(e.lastTs, Number(t.ts || 0));
    if (t.address) e.addrs.add(t.address);
  }
  const list = [...byCa.values()].map((e) => ({
    ca: e.ca, name: e.name, buys: e.buys, sells: e.sells,
    buyUsd: Math.round(e.buyUsd), sellUsd: Math.round(e.sellUsd), netUsd: Math.round(e.buyUsd - e.sellUsd),
    lastTs: e.lastTs, price: e.price, marketCap: e.marketCap, risk: e.risk, traders: e.addrs.size,
  })).sort((a, b) => b.lastTs - a.lastTs);
  return { list, totalTrades: rows.length };
}

// ---------- 双账号：A/B 余额 + 持仓 ----------
async function getAccountState(name) {
  const acct = ACCOUNTS[name];
  if (!acct) return null;
  const addr = acct.addr;
  const [bnb, wbnb, usdt] = await Promise.all([
    rpc('eth_getBalance', [addr, 'latest']).then((x) => Number(BigInt(x)) / 1e18).catch(() => 0),
    call(WBNB, ABI.balanceOf(addr)).then((x) => Number(words(x)[0]) / 1e18).catch(() => 0),
    call(USDT, ABI.balanceOf(addr)).then((x) => Number(words(x)[0]) / 1e18).catch(() => 0),
  ]);
  // 持仓代币（positions.json 里记录过的 + 固定几个，含 0 余额也展示，避免遗漏）
  const pos = loadPos();
  const tokens = [];
  const seen = new Set([WBNB.toLowerCase(), USDT.toLowerCase()]);
  for (const [token, p] of Object.entries(pos)) {
    const t = token.toLowerCase();
    if (seen.has(t)) continue;
    if (p.chain && p.chain !== 'bsc') continue;  // 只展示 BSC 链的代币
    seen.add(t);
    let bal = 0;
    try { bal = Number(words(await call(token, ABI.balanceOf(addr)))[0]) / 1e18; } catch {}
    tokens.push({ token, symbol: p.symbol || 'TOKEN', balance: bal, note: p.note || '' });
  }
  const out = [
    { token: WBNB, symbol: 'WBNB', balance: wbnb },
    { token: USDT, symbol: 'USDT', balance: usdt },
    ...tokens,
  ];
  return { name, addr, bnb, tokens: out };
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
    if (p === '/api/state') return ok(res, await getStateCached(url.searchParams.get('chain') || 'bsc'));
    if (p === '/api/token') {
      const chain = url.searchParams.get('chain') || 'bsc';
      const token = (url.searchParams.get('token') || '').trim();
      if (!token) return err(res, 400, '缺 token');
      if (chain === 'rh') {
        const info = await rhTokenInfo(token);
        if (!info) return err(res, 404, 'mobster 查不到这个地址');
        const bal = await rhTokenBalance(token);
        return ok(res, {
          chain: 'rh', address: token, found: true, symbol: info.symbol, name: info.name,
          graduated: !!info.graduated, progressPct: Number(info.progressPct || 0),
          priceBnb: Number(info.price || 0), priceUsd: Number(info.priceUsd || 0),
          raisedBnb: Number(info.raised || 0), gradAmtBnb: Number(info.target || 0),
          holders: info.holders ?? null, pair: info.pair || null, myBalance: bal,
          quote: info.quote?.symbol || 'ETH', buyableByPad: !info.graduated,
        });
      }
      if (chain === 'sol') {
        const info = await solTokenInfo(token);
        if (!info) return err(res, 404, 'DexScreener 查不到这个 mint（可能无流动性或地址不对）');
        return ok(res, { chain: 'sol', address: token, found: true, symbol: info.symbol, name: info.name,
          priceUsd: info.priceUsd, priceNative: info.priceNative, liquidityUsd: info.liquidityUsd,
          volume24hUsd: info.volume24hUsd, pair: info.pair, dexId: info.dexId, quote: 'SOL' });
      }
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
      const onchain = !!(f && !f.curve.graduated && !info?.graduated);
      const quoteSym = (a) => {
        const x = String(a || '').toLowerCase();
        if (x === WBNB.toLowerCase()) return 'WBNB';
        if (x === '0x0c6302401aa5325c2e36f170f52c00b1d220b405') return 'GANG';
        if (x === USDT.toLowerCase()) return 'USDT';
        return 'TOKEN';
      };
      const out = {
        address: token,
        found: !!info || !!f,
        track: info?.track || (f ? 'main' : null),
        symbol: info?.symbol || (f ? (await tokenMeta(token)).symbol : ''),
        name: info?.name || '',
        graduated: !!(f?.curve?.graduated || info?.graduated),
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
        buyableByPad: !!f && !(f.curve.graduated || info?.graduated),
        quoteSymbol: f ? quoteSym(f.curve.quote) : (info?.quote?.symbol || ''),
      };
      if (f && !f.curve.graduated && !info?.graduated) {
        const vt = await virtualToken(f.pad);
        const c = { ...f.curve, vt };
        const isWbnbQuote = c.quote.toLowerCase() === WBNB.toLowerCase();
        const room = words(await call(f.pad, ABI.walletRoom(token, FROM)))[0];
        out.quote = c.quote;
        out.room = Number(room) / 1e18;
        // 只有当报价币是 WBNB 时，才能直接用 BNB 金额报价
        if (isWbnbQuote) {
          const tokensOut = quoteBuy(c, vt, BigInt(Math.round(bnbAmt * 1e18)));
          out.tokensOut = Number(tokensOut) / 1e18;
          if (room > 0n) {
            const K = c.vQ * vt;
            const denom = c.vt - c.sold - room;
            if (denom > 0n) {
              const needNet = K / denom - (c.vQ + c.real);
              const needIn = needNet > 0n ? (needNet * BPS) / (BPS - FEE) : 0n;
              out.fullBnb = Math.ceil(Number(needIn) / 1e18 * 1.02 * 100) / 100;
            }
          }
        } else {
          out.tokensOut = null;  // 非 WBNB 计价（如 GANG），需要先换报价币
        }
      }
      if (!out.found) return err(res, 404, 'gang.fun 和链上曲线都查不到这个地址（确认是代币合约地址？）');
      return ok(res, out);
    }
    if (p === '/api/buy' && req.method === 'POST') {
      const buyT0 = Date.now();
      const b = await readBody(req);
      const token = b.token;
      if (b.chain === 'rh') {
        const eth = Number(b.amount);
        if (!token || !(eth > 0)) return err(res, 400, '参数错');
        try {
          const r = await rhBuy(token, eth);
          const pos = loadPos();
          const key = token.toLowerCase();
          const cur = pos[key] || { symbol: 'TOKEN', chain: 'rh', costBnb: 0 };
          cur.symbol = (await rhTokenInfo(token))?.symbol || cur.symbol;
          cur.chain = 'rh';
          cur.costBnb = Number(cur.costBnb || 0) + eth;
          pos[key] = cur; savePos(pos);
          return ok(res, { ...r, spentEth: eth, elapsedMs: Date.now() - buyT0 });
        } catch (e) { return err(res, 400, e.message); }
      }
      if (b.chain === 'sol') {
        const qty = Number(b.amount);
        if (!token || !(qty > 0)) return err(res, 400, '参数错');
        try {
          const r = await solSwap(qty, SOL_NATIVE, token, Number(b.slippage || 3));
          return ok(res, { ...r, spentSol: qty, elapsedMs: Date.now() - buyT0 });
        } catch (e) { return err(res, 400, e.message); }
      }
      const bnbAmt = Number(b.bnb);
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
      // 曲线已毕业（migrated）：也走外盘聚合兑换
      if (f.curve.graduated) {
        const sw = await marketSwap(bnbAmt, BNB, token);
        return ok(res, { status: sw.status || 'submitted', orderId: sw.orderId, note: '该币已毕业（已迁移到外盘），走聚合兑换', spentBnb: bnbAmt, elapsedMs: Date.now() - buyT0 });
      }
      const pi = await padInfo(token);
      const pad = pi?.f?.pad || f.pad;
      const vt = pi?.vt || (await virtualToken(pad));
      const cw = words(await call(pad, ABI.curves(token)));
      const c = { quote: '0x' + cw[1].toString(16).padStart(40, '0'), real: cw[2], sold: cw[3], gradAmt: cw[4], vQ: cw[5], vt };
      const GANG = '0x0c6302401aa5325c2e36f170f52c00b1d220b405';
      const isWbnb = c.quote.toLowerCase() === WBNB.toLowerCase();
      const quoteSym = isWbnb ? 'WBNB' : (c.quote.toLowerCase() === GANG ? 'GANG' : 'TOKEN');
      const value = BigInt(Math.round(bnbAmt * 1e18));
      const room = words(await call(pad, ABI.walletRoom(token, FROM)))[0];
      if (room <= 0n) return err(res, 400, '已到单钱包 1% 上限');
      const slippage = Number(b.slippage ?? SLIPPAGE);
      const hashes = [];
      let spend;
      if (isWbnb) {
        // 1) 只在 WBNB 不够时才 wrap（省一笔交易）
        let wbnbBal = words(await call(WBNB, ABI.balanceOf(FROM)))[0];
        if (wbnbBal < value) {
          const need = value - wbnbBal;
          hashes.push((await sendContract({ to: WBNB, valueWei: need, inputData: ABI.deposit(), label: 'wrap' })).txHash);
          const ok2 = await waitFor(async () => { const x = words(await call(WBNB, ABI.balanceOf(FROM)))[0]; return x >= value ? x : null; }, 8000);
          wbnbBal = ok2 || words(await call(WBNB, ABI.balanceOf(FROM)))[0];
        }
        spend = wbnbBal < value ? wbnbBal : value;
        if (spend <= 0n) return err(res, 500, 'WBNB 没到账');
      } else {
        // 非 WBNB 报价币（如 GANG）：先用 BNB 通过 Binance 聚合换成报价币
        const before = words(await call(c.quote, ABI.balanceOf(FROM)))[0];
        const sw = await marketSwap(Number(bnbAmt), BNB, c.quote);
        if (sw.status === 'FAILED') return err(res, 500, `BNB→${quoteSym} 兑换失败`);
        // 轮询等报价币到账（取增量）
        const got = await waitFor(async () => {
          const x = words(await call(c.quote, ABI.balanceOf(FROM)))[0];
          return x > before ? x : null;
        }, 30000, 1000);
        const after = got || words(await call(c.quote, ABI.balanceOf(FROM)))[0];
        spend = after > before ? after - before : 0n;
        if (spend <= 0n) return err(res, 500, `BNB→${quoteSym} 还没到账（订单可能要几秒），请稍后重试`);
      }
      // 2) 授权报价币给 pad（不够才授权，一次批较大额度）
      let allow = words(await call(c.quote, ABI.allowance(FROM, pad)))[0];
      if (allow < spend) {
        const target = spend * 2n > 5n * 10n ** 17n ? spend * 2n : 5n * 10n ** 17n;
        hashes.push((await sendContract({ to: c.quote, inputData: ABI.approve(pad, target), label: 'approve-' + quoteSym })).txHash);
        const ok3 = await waitFor(async () => { const x = words(await call(c.quote, ABI.allowance(FROM, pad)))[0]; return x >= spend ? x : null; }, 15000);
        allow = ok3 || words(await call(c.quote, ABI.allowance(FROM, pad)))[0];
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
      return ok(res, { status: r.status, txHash: r.txHash, spentBnb: Number(spend) / 1e18, spentQuote: Number(spend) / 1e18, quoteSymbol: quoteSym, tokensOut: Number(out) / 1e18, hashes: hashes.filter(Boolean), elapsedMs: Date.now() - buyT0 });
    }
    if (p === '/api/sell' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.chain === 'rh') {
        const pct = Number(b.pct || 100);
        try {
          const r = await rhSell(b.token, pct);
          const pos = loadPos();
          const cur = pos[b.token.toLowerCase()];
          if (cur) { cur.costBnb = Number(cur.costBnb || 0) * (1 - pct / 100); pos[b.token.toLowerCase()] = cur; savePos(pos); }
          return ok(res, r);
        } catch (e) { return err(res, 400, e.message); }
      }
      if (b.chain === 'sol') {
        const pct = Number(b.pct || 100);
        const bal = await solTokenBalance(b.token);
        if (!(bal > 0)) return err(res, 400, '没有可卖余额');
        const qty = pct >= 100 ? bal : (bal * pct / 100);
        try {
          const r = await solSwap(qty, b.token, SOL_NATIVE, Number(b.slippage || 3));
          return ok(res, { ...r, sold: qty });
        } catch (e) { return err(res, 400, e.message); }
      }
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
    if (p === '/api/discover') {
      const period = url.searchParams.get('period') || '24h';
      try { return ok(res, await discoverBsc(period)); } catch (e) { return err(res, 500, '发现失败: ' + e.message); }
    }
    if (p === '/api/accounts') {
      try {
        const [A, B] = await Promise.all([getAccountState('A'), getAccountState('B')]);
        return ok(res, { A, B, recipient: RECIPIENT });
      } catch (e) { return err(res, 500, '读取账号失败: ' + e.message); }
    }
    if (p === '/api/transfer-from' && req.method === 'POST') {
      const b = await readBody(req);
      const account = String(b.account || 'A').toUpperCase();
      const acct = ACCOUNTS[account];
      if (!acct) return err(res, 400, '账号参数错');
      const token = b.token;
      if (!token) return err(res, 400, '缺 token');
      const bal = words(await call(token, ABI.balanceOf(acct.addr)))[0];
      if (bal <= 0n) return err(res, 400, '该账号这个代币没有余额');
      const amt = b.amount ? BigInt(Math.round(Number(b.amount) * 1e18)) : bal;
      if (amt <= 0n || amt > bal) return err(res, 400, '数量非法');
      const inputData = ABI.transfer(RECIPIENT, amt);
      const extraEnv = acct.dir ? { BINANCE_BAW_DIR: acct.dir } : {};
      try {
        const pre = (await baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', acct.addr, '--to', token, '--value', '0', '--inputData', inputData], { extraEnv })).data || {};
        if (!pre.requestId) return err(res, 500, '预演未返回 requestId');
        const ex = (await baw(['contract-call', 'execute', '--requestId', pre.requestId], { extraEnv })).data || {};
        return ok(res, { status: ex.status, txHash: ex.txHash, amount: Number(amt) / 1e18, from: acct.addr, to: RECIPIENT });
      } catch (e) { return err(res, 500, e.message); }
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { err(res, 500, e.message || 'server error'); }
});

server.listen(PORT, '127.0.0.1', () => console.log(`gang-quick 已启动: http://127.0.0.1:${PORT}`));
// 启动后台预热钱包状态（不阻塞）
walletInfo().catch(() => {});
// 自动止盈止损：每 10 秒检查一次（轻量，只读余额+曲线）
setInterval(checkAutoSell, 10_000);
