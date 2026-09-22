# Jev / Poly — BTC 5m 决策实验室

参考 [jarrodwatts/jev-trader](https://github.com/jarrodwatts/jev-trader) 的「市场状态 → Jev 分类评分 → 独立执行逻辑 → 实时面板」结构，用于研究 Polymarket BTC 5 分钟 Up/Down 市场。

本版本实现 **真实行情适配器 + Jev 接入 + 模拟交易 + 本地面板**。不接钱包、不提交真实订单。`TRADING_MODE=live` 会在启动时被拒绝。

## 快速启动

需要 Bun（本地验证版本 1.2.6）。

```bash
bun install --frozen-lockfile
bun run demo
```

打开 <http://127.0.0.1:3000>。Demo 使用确定性的合成价格、模拟盘口与 Mock 模型，能完整演示入场、五分钟轮次切换、结算和账本恢复，不能用于评价策略收益。首次启动可能需要等到入场窗口或下一轮才有交易。

### 使用真实行情和 Jev

```bash
cp .env.example .env
```

在本机 `.env` 中设置：

```dotenv
DATA_MODE=live
MODEL=jev
TYPESAFE_AI_API_KEY=你的_TypeSafe_AI_Key
JEV_MODEL_ID=jev-latest
TRADING_MODE=paper
DATA_DIR=data/paper
```

然后先用 Ctrl+C 停止 demo，再启动：

```bash
bun run start
```

只验证真实行情管道时可以先设 `MODEL=mock`。`bun run demo` 总是覆盖为合成行情与 Mock；它不会调用 Jev。缺少 key 时 `MODEL=jev` 启动失败，不会悄悄切回 Mock。API key 仅在服务端使用，并已通过 `.gitignore` 排除。

默认仅监听本机地址。端口冲突可用 `PORT=3050 bun run start`。不要把这个无登录验证的开发面板直接暴露到公网。

## 决策方法

1. 以 UTC 时间计算 `btc-updown-5m-{本轮开盘秒数}`，从 Gamma 查询对应事件。校验确实是 300 秒市场，以结果标签映射 Up/Down token，不能假设 Up 总在数组第一位。
2. 根据市场 `resolutionSource` 选择 Chainlink spot、30 秒 TWAP 或 60 秒 TWAP。当前查到的 BTC 5m 规则使用 **60 秒 TWAP**；程序按每轮元数据识别，不把交易所现货价冒充结算参考。
3. 优先读取 Gamma 的 `eventMetadata.priceToBeat`。没有该字段时，只接受对应 RTDS 流中**时间戳精确等于开盘时刻**的观测。中途启动且无法取得基准价时跳过本轮；不会把启动价格当作开盘价格。
4. 向 Jev 提供基准价、当前参考价、剩余秒数、10/30/60 秒变化与两侧盘口。问题是「本轮结束时是否高于或等于开盘基准」，不是从现在起再预测五分钟。
   另附 **Binance USDⓈ-M BTCUSDT 永续** 的辅助特征（`PERP_FEATURES=on`，默认开启）：前 5/20 档盘口失衡、微价格偏移、10/30/60 秒主动买卖量、10/30/60 秒与本轮开盘以来涨跌、相对 Chainlink spot 的基差。数据来自 `fstream.binance.com` 的 `/public`（depth20@100ms）和 `/market`（aggTrade）路由。这些只是领先指标，**不参与结算判定，也不作为基准价**；数据超过 `MAX_DATA_AGE_MS` 就整体置空，覆盖时长不够的窗口单独置空，Jev 按「未知」处理，缺少这些特征时仍照常决策。
5. 使用与参考项目相同的 `experimental_evaluate` / `@ai-sdk/typesafe-ai`。读取 Up/Down 分类概率，验证合法性，缺失或超时则观望。交易规则单独决定 `UP / DOWN / WAIT`。
6. 决策返回后重新拉取盘口。如果已切换轮次、基准价变化或输入过期，丢弃结果。按当前可见卖盘逐档模拟吃单，不凭空补足深度。
7. 同一时间最多持有一笔。入场条件：某方向含费买入成本比 Jev 概率低 `MIN_EDGE`（默认 5¢）以上。持仓后每次判断都检查：该方向 Polymarket 买一价**高于** Jev 当前对该方向的概率时，沿买盘逐档模拟卖出（扣卖出手续费，深度不足则继续持有）；否则持有至官方结算。卖出后同一轮可再次入场。真实行情模式调用 Data API `/v2/resolutions`，仅在 `status=resolved` 且 payout 合法时记账，支持 50/50 退款。到期但未获确认的仓位保留为待结算；不凭本地价格猜输赢。

Jev 的分类评分**不是经过历史样本校准的真实胜率**。默认先向 0.5 收缩，再用于实验性入场规则：

```text
方向评分 = 0.5 + SCORE_WEIGHT × (原始分类评分 - 0.5)
入场优势 = 方向评分 - 每份含费模拟成本            （≥ MIN_EDGE 买入）
卖出条件 = 持仓方向买一价 > 该方向当前方向评分
```

默认收缩权重 0.5；方向评分至少 0.60，评分优势至少 0.05 才考虑入场。它们是可调整的研究参数，没有已验证的盈利保证。面板同时展示 **Up / Down 原始评分**，大字标出模型倾向；模拟交易动作单独显示，可能买入任意一侧，也可能观望。

每个通过时效和轮次校验的模型结果，会在其输入参考价格处留下绿（Up）/红（Down）判断点，并触发一次扩散光圈。DECISION 卡片和新日志同步高亮，方向反转时显示切换提示；SSE 心跳、历史恢复与重复推送不会冒充新判断。过期评分明确标记为历史判断。

默认按 **2 秒启动一轮** 调度，计算请求已经花费的时间，而不是完成请求后再睡 2 秒。单次在途，超时或慢请求跳过错过的节拍，不叠加并发；失败时指数退避。面板展示目标周期、两次结果的实际返回间隔与处理阶段。行情完整时，即使尚未进入开仓窗口、已在本轮买入或风险额度不足，仍会持续调用模型用于观察；入场限制继续独立生效。缺少可靠行情或暂停时停止模型调用，官方结算检查独立运行。

### 费用与模拟成交

手续费从市场 `feeSchedule` 或 CLOB `/clob-markets/{condition_id}` 的 `fd.r` / `fd.e` 读取；没有可靠配置就跳过。计算使用 `shares × rate × [price × (1-price)]^exponent`，因此支持当前线性曲线与旧的指数曲线。市场明确 `feesEnabled=false` 才可采用零费用。

每笔金额包括成交本金与手续费的现金等值。买入沿卖盘逐档取量，只吃到 `bestAsk + SLIPPAGE_BUFFER`；卖出沿买盘只吃到 `bestBid - SLIPPAGE_BUFFER`，不足则整笔不成交。模拟未复现真实撮合排队、余额精度、买单收取费用的代币单位及网络竞争，统计不能当作实盘可复制收益。显示币种为 USD 等值，未操作实际抵押品。

### 默认参数

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `POLL_SCHEDULE` | `120:2000,240:4000,300:7000` | 按本轮已进行时间调整判断间隔：前 2 分钟 2 秒、2–4 分钟 4 秒、最后 1 分钟 7 秒；设为 `fixed` 改用 `POLL_MS` |
| `POLL_MS` | 2000 | `POLL_SCHEDULE=fixed` 时的固定间隔；慢请求跳过节拍，单次在途 |
| `MODEL_TIMEOUT_MS` | 3000 | 模型请求时限，关闭 SDK 自动重试 |
| `MAX_DATA_AGE_MS` | 15000 | 参考价和盘口最大年龄 |
| `MIN_SECONDS_LEFT` / `MAX_SECONDS_LEFT` | 30 / 240 | 只在剩余 30–240 秒时考虑入场 |
| `BANKROLL_USD` | 1000 | 初始模拟资金 |
| `TRADE_USD` | 10 | 每笔含费预算；同一时间最多一笔持仓 |
| `MAX_OPEN_EXPOSURE_USD` | 50 | 未结算仓位成本上限 |
| `DAILY_LOSS_LIMIT_USD` | 30 | UTC 当日亏损额度，开仓检查同时预留未结算仓位最坏损失；设为 `off` 关闭 |
| `MAX_SPREAD` | 0.06 | 最大允许买卖价差 |
| `MIN_EDGE` | 0.05 | 入场要求：Jev 概率 − 含费买入成本 ≥ 该值 |
| `MIN_SCORE` | 0 | 可选：方向评分下限，0 表示不限制 |
| `SLIPPAGE_BUFFER` | 0.01 | 买卖时最多偏离最优价的跨档范围 |
| `SCORE_WEIGHT` | 0.5 | 分类评分向 0.5 收缩的权重；设为 1 则买卖都直接比较 Jev 原始概率 |

## 项目结构

```text
src/config.ts       环境变量与启动校验
src/polymarket.ts   Gamma / CLOB / RTDS / 官方结算适配
src/model.ts        Jev 请求、输入特征与 Mock
src/policy.ts       费用、模拟扫盘和风险规则
src/engine.ts       单次在途循环、超时、复核盘口、结算
src/cadence.ts      固定周期调度与失败退避
src/store.ts        SQLite 交易账本与决策审计
src/demo.ts         可离线运行的合成行情
src/index.ts        本地 HTTP、SSE、单实例锁
web/                中文监控面板
tests/              行情契约、风险、SDK 适配和账本测试
scripts/smoke.ts    真实行情只读连通性检查
```

`GET /api/state` 提供当前状态、判断点和调度时间，`GET /api/history` 提供最近 200 条审计事件，`GET /events` 是 SSE，`GET /health` 表示循环最近是否成功；健康检查成功并不意味着符合入场条件。面板按钮调用 `POST /api/control` 暂停或恢复模型判断及开仓，暂停期间继续检查已有仓位结算。

本地默认 `LEDGER=sqlite`：账本写入 `DATA_DIR/{live|demo}-{jev|mock}.sqlite`，把不同数据模式和模型隔开。重启不会清空资金、仓位或每轮唯一约束。同一账本只允许一个进程。初始资金与已有账本不一致时拒绝启动；新实验请使用新的 `DATA_DIR`。审计记录包含模型输入采样、评分、盘口和动作，当前不自动清理历史文件。进程锁遇到异常退出会检测原 PID 是否已结束。

## 验证与当前限制

```bash
bun run check    # TypeScript + 自动化测试，不需联网
bun run smoke    # Polymarket 真实行情只读连通性测试，不调用 Jev
bun run check:jev # 使用已配置的 key 发起一次真实 Jev 连通性测试（会产生 API 用量）
```

自动化测试覆盖费用扣除、深度不足、过期行情、错误数据源、缺少开盘价、模型超时、窗口切换、盘口复核、双向买入、重复开仓、账本恢复、官方 payout 映射和幂等结算，以及 2 秒调度、慢请求跳拍、持续判断、结算不阻塞推理和脉冲去重。Jev SDK 测试使用真实 SDK 加模拟 HTTP transport；不是对外部模型服务的联调结果。

本次已通过 `bun run smoke` 读取真实市场 `btc-updown-5m-1789993800`，验证 Gamma 市场识别、Chainlink 60 秒 TWAP、CLOB 双侧盘口，以及实际费用参数 `rate=0.07, exponent=1`。该次检查发生在轮次中途，未取得开盘基准价。最初 Python HTTP 探测收到 403，后续 Bun 客户端检查成功；程序遇到访问错误会退避并保持观望，不会偷偷切为假行情。

2026-09-22（悉尼时间）配置 key 后，已完成一次真实认证的 Jev 推理请求：`jev-latest` 实际返回 `jev-1.13.0`，耗时 2059 ms，使用 355 个输入 token、31 个输出 token。该请求是明确标注的连通性诊断，不是市场预测；验证结果保存在 `DATA_DIR/jev-connectivity.json`，不包含密钥。运行中的面板已切换为真实行情与 Jev 模拟盘。

同日 07:46，已验证真实市场 `btc-updown-5m-1790027100` 的决策链路：捕获开盘时刻的 60 秒 TWAP 基准价、读取双侧盘口、调用真实 Jev，并完成独立入场规则评估。首次市场请求耗时约 1847 ms，输入 2300 token；原始方向评分 Up 0.03 / Down 0.97，收缩后为 0.265 / 0.735。入场规则判定优势或盘口条件不足，因此观望，没有为验证而强制成交。原始请求特征及返回评分保存在 `live-jev.sqlite` 的 `model-evaluation` 审计事件中。随后两笔 Down 模拟仓位均已完成官方结算入账；这只验证执行流程，不表示策略盈利。

同日 08:05:03–08:07:50，在市场 `btc-updown-5m-1790028300` 连续收到 83 次真实 Jev 结果：返回间隔中位数 **2.00 秒**，P95 为 2.17 秒，最大 3.124 秒；模型推理中位耗时约 634 ms。浏览器已验证红绿判断点、新结果光圈、双侧评分和实时返回间隔。外部服务延迟仍会影响个别轮次，2 秒是调度目标而非每次返回的保证。

没有精确开盘数据时，严格跳过可能导致较多空仓；请让进程跨越完整的轮次边界，检查能否记录精确开盘时刻的 RTDS 观测，再开始评估策略表现。

下一阶段应采集真实样本，做按时间隔离的样本外评估，比较 Jev 与盘口隐含概率、简单基准策略，测量费用后的收益、回撤和评分校准。完成这些之后，再单独实现经授权的实盘执行、资金核对和订单恢复；本版本不包含实盘功能。

## 部署（展示用）：引擎在 Railway，面板在 Vercel

与 jev-trader 相同的拆分：引擎需要常驻（每几秒一轮判断、保持 Chainlink / Binance WebSocket），用 Dockerfile 跑在 Railway；Vercel 只托管静态面板，通过 `JEV_API_URL` 连接引擎。

**安全设计**
- API key 只存在 Railway 的环境变量里；不在镜像、代码、面板或 Vercel 上。面板只拿到引擎的公开地址。
- 访客无法触发 Jev 调用：模型只由引擎自己的循环按 `POLL_MS` 调用，费用与访客数量无关。
- 错误信息在展示前会把 key 替换为 `[redacted]`；Bun 开发错误页已关闭。
- `CONTROL=off` 禁用暂停接口；`CORS_ORIGIN` 只允许你的 Vercel 域名读取数据；`MAX_SSE_CLIENTS`（默认 200）限制同时在线的实时连接。
- `.vercelignore` 只上传 `web/` 和构建脚本；`.railwayignore` / `.dockerignore` 排除 `.env` 和 `data/`。

**Railway（引擎）** 环境变量：

| 变量 | 值 |
| --- | --- |
| `TYPESAFE_AI_API_KEY` | 你的 key（在 Railway 面板中设置） |
| `MODEL` | `jev` |
| `LEDGER` | `memory`（Dockerfile 默认） |
| `CONTROL` | `off` |
| `CORS_ORIGIN` | Vercel 地址，如 `https://jev-poly.vercel.app` |
| `POLL_MS` / `SCORE_WEIGHT` / `DAILY_LOSS_LIMIT_USD` | 按需，例如 `6000` / `1` / `off` |

Railway 会注入 `PORT`，Dockerfile 已设置 `HOST=0.0.0.0`。

**Vercel（面板）**：项目环境变量 `JEV_API_URL` 设为 Railway 的公开地址（https、不带路径）。构建命令 `node scripts/build-web.mjs` 会把它写入 `config.js`，并生成只允许连接该地址的 CSP。

注意：`LEDGER=memory` 时重启即清零；Binance 会屏蔽部分地区（如美国）的出口 IP，被屏蔽时合约特征为空，其余流程不受影响。

## 参考

- [jev-trader：架构与 Jev 调用方式](https://github.com/jarrodwatts/jev-trader)
- [Polymarket：市场发现](https://docs.polymarket.com/market-data/discover-markets)
- [Polymarket：Chainlink TWAP / RTDS](https://docs.polymarket.com/market-data/chainlink-twap)
- [Polymarket：交易费用](https://docs.polymarket.com/trading/fees)
- [Polymarket：官方结算状态 API](https://docs.polymarket.com/api-reference/markets/get-resolution-state)
- [核对的 BTC 5m 市场规则](https://polymarket.com/event/btc-updown-5m-1789980900)

文档与接口核对日期：2026-09-21。参考项目使用 MIT 许可；本项目重新实现 Polymarket 数据和模拟执行逻辑，没有沿用 Monad / Kuru 的交易代码。
