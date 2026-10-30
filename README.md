# gang-quick — gang.fun 内盘快速交易工具

单文件 Node 后端 + 一个前端页面。无第三方 npm 依赖（只用 Node 内置模块）。

## 一、在另一台电脑上复现

### 1. 准备环境

- 装 **Node.js 18+**（mac/Linux 用包管理器，Windows 去官网下安装包）。
- 装币安 Agentic Wallet CLI：

```bash
npm install -g @binance/agentic-wallet
# 装完确认能跑：
baw --version
```

### 2. 复制工具

把整个 `gang-quick` 文件夹拷过去（至少这三个文件）：

```
gang-quick/
├── server.mjs        # 后端（已做跨平台，去掉写死的本机路径）
├── public/
│   └── index.html    # 前端
└── positions.json    # 持仓成本 + 自动策略配置（可选，见同步说明）
```

### 3. 启动

```bash
cd gang-quick
node server.mjs
# 打开 http://127.0.0.1:8790
```

可选环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `BAW_BIN` | baw 可执行文件路径 | 自动探测（`baw` 或本机默认） |
| `PORT` | 端口 | 8790 |
| `FROM` | 交易钱包地址 | `0x1762…4535`（主号 A） |
| `TRANSFER_TO` | 「转出」接收地址 | `0xF55F…0de7` |
| `SLIPPAGE` | 默认滑点 | 3 |

### 4. 登录钱包

```bash
baw auth signin
```

用**币安 App 扫二维码**确认即可（每个设备要单独扫一次，会话不能直接复制）。

---

## 二、两台设备之间同步

推荐用 **私有 Git 仓库**（GitHub 私有仓库 / 码云均可）。

### 第一次：把工具推上去

```bash
cd gang-quick
git init
git add server.mjs public/index.html README.md
# positions.json 建议也纳入同步，这样持仓成本/策略一致
git add positions.json
git commit -m "gang-quick v1"
git branch -M main
git remote add origin https://github.com/你的用户名/gang-quick.git
git push -u origin main
```

### 另一台电脑：拉下来

```bash
git clone https://github.com/你的用户名/gang-quick.git
cd gang-quick
node server.mjs
```

### 之后有更新：同步

在改过代码的那台：

```bash
cd gang-quick
git add -A && git commit -m "更新内容" && git push
```

在另一台：

```bash
cd gang-quick
git pull
```

---

## 三、注意事项

1. **钱包会话不能复制**：每台电脑都要 `baw auth signin` 扫一次码登录。会话 48 小时过期，过期重扫。
2. **positions.json 会变**：买入/卖出/开自动策略都会写它。两台设备用 git 同步时，别同时在两台改，否则会冲突——**建议只用一台下单**，另一台只拉取查看。
3. **同一钱包别同时在两台设备操作**：`baw` 每次交易会锁钱包，两台同时发单会互相顶。
4. 如果另一台是 Windows，遇到 `spawn EINVAL`（`.cmd` 无法直接执行），代码里已用 `shell: true` 处理；如果 `baw` 装成了全局 npm，直接 `npm i -g` 后 `baw` 就在 PATH 里，自动识别。

---

## 四、本机 Windows 适配记录（2026-10-30）

这台机器：`C:\Users\Administrator`，Node v24.22.1，无 git、无 pnpm。

| 项 | 处理 |
|---|---|
| 代码里写死的旧机器路径 `C:\Users\chunh\...` | 全部改为按 `%USERPROFILE%` 解析（baw 可执行、子进程 PATH、B 小号 `baw-profiles\account2`、mobster 的 baw、发现 CLI） |
| `baw` | 已装 1.11.0（`~/.dsh/tools/baw`），`baw` 走 account1 profile，已登录；BSC 地址 `0x1762…4535` |
| 价格源 | `api.binance.com` 在本网络 Node 直连被 reset → 优先用镜像 `data-api.binance.vision`，失败再退回原域名，最后才用写死的兜底价 |
| 不在经典 pad 上的币（如 fly 份额盘） | 原来估值 0 会显示 -100%；现在用 gang.fun 官方接口的场内价估值 |
| 启动 | 双击 `start.cmd`，或 `node server.mjs` → http://127.0.0.1:8790 |
| `mobster` CLI | 未安装 → RH 链（mobster）买卖不可用；只读行情仍可看 |
| `crypto-market-rank` skill | 本机不存在，但 `runCli` 已是死代码，不影响运行 |

### gang.fun 新「fly」份额盘（本工具不支持，用官方 CLI）

`track: fly` 的币不在上面 5 个曲线 pad 上，`/api/buy` 会拒绝。官方通道：

```bash
npm i -g @gangfun/cli@latest
gang preflight
gang mint  --token <token> --shares <份数>     # 每份 0.002 BNB，maxPerTx 见接口
gang withdraw --token <token> --all            # 发行前按 mint 价退回
```

**Windows 补丁**：`@gangfun/cli` 的 `src/baw.js` 用 `execFileSync('baw')` 直连，而 Windows 下 Node/libuv 不能直接执行 `baw.cmd`（报 `baw not installed or not on PATH`）。已在该调用加 `shell: process.platform === 'win32'`。**`npm i -g` 升级后会被覆盖，需要重新打一次。**

### 本机的 Git / 推送环境（这台机器原本没有 git）

| 组件 | 位置 |
|---|---|
| MinGit 2.56（便携版，无需安装） | `~/.dsh/tools/mingit/cmd/git.exe` |
| GitHub CLI 2.103.3 | `~/.dsh/tools/gh/bin/gh.exe`（已设备码授权，身份 CHEERSKIMI） |
| 凭据助手 | `credential.https://github.com.helper = !'…/gh.exe' auth git-credential`，已写入全局 gitconfig |

直连 `github.com:443` 时通时不通（`fetch` 匿名可用，`push` 经常连不上），推送走本地代理更稳：

```bash
git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push
```


