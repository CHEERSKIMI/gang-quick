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
