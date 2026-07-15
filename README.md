# Kindle Trader AI · MVP

二手数码（首期 Kindle）行情分析 + AI 定价 + AI 文案生成 + 简易库存管理。
根据 `Kindle Trader AI.md` 需求文档实现的 **MVP 四件套**：行情查询、AI 智能定价、AI 文案生成、库存与利润。

> 技术选型说明：需求文档建议 Next.js + Supabase。为在本机**零外部依赖、即开即用**地验证核心价值，
> 本实现采用 Node 原生能力（`node:http` + 内置 `node:sqlite`）单仓一体，并把数据层与业务层解耦，
> 后续可平滑迁移到 Next.js + Supabase（见文末「生产化迁移」）。
ß
> 🚀 **在线 Demo（一键部署）**：点击下方按钮即可把本项目部署到免费的 Render 云，获得一个可公开访问的 demo 链接，无需配置环境。
>
> [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/zaomo/kindle-trader-ai)
> Demo网址（https://kindle-trader-ai.onrender.com/）
> 也支持 **Railway / Koyeb / Docker**（见仓库内 `render.yaml` / `railway.json` / `Dockerfile`）。本地运行只需一条命令：`npm start`（需 Node ≥ 22.5，零依赖）。

## 运行

```bash
npm start            # = node --experimental-sqlite src/server.js
# 打开 http://localhost:3200
```

要求 Node ≥ 22.5（已内置 `node:sqlite`）。无需 `npm install`，零第三方依赖。

可选环境变量：
- `LLM_PROVIDER`：LLM 服务商，取值 `openai`、`anthropic`、`zhipu`（智谱）、`aliyun`（阿里云百炼 / 通义千问）。
- `ANTHROPIC_API_KEY`：当 `LLM_PROVIDER=anthropic` 时配置，定价理由与文案由 Claude 润色。
- `ZHIPU_API_KEY`（或 `GLM_API_KEY`）：当 `LLM_PROVIDER=zhipu` 时配置，调用智谱 GLM 系列（OpenAI 兼容接口，默认模型 `glm-4-flash`，可用 `ZHIPU_MODEL` 覆盖）润色。
- `DASHSCOPE_API_KEY`（或 `ALIYUN_API_KEY`）：当 `LLM_PROVIDER=aliyun` 时配置，调用阿里云百炼通义千问系列（OpenAI 兼容接口，endpoint `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`，默认模型 `qwen-plus`，可用 `DASHSCOPE_MODEL` / `ALIYUN_MODEL` 覆盖，如 `qwen-max`、`qwen-turbo`）润色。
- 不配置任何 Key 时，AI 自动回退本地规则/模板生成（**价格数字仍由真实行情区间计算，LLM 不编造价格**）。
- 也可在管理后台「AI 配置」界面直接添加 / 编辑模型 Key 并保存，**立即生效、无需重启、无需改命令行**；环境变量若已设置则优先于后台界面（后台 Key 保存于 `admin_config` 表，接口返回时一律遮罩，编辑留空则保留原 Key）。
- 后台「AI 配置」采用**框架式多 Key 列表**：每条 Key 自带 `provider` / `base_url` / `model` / `label`，多家服务商可并存；列表显示遮罩、备注、添加时间、[当前] 与停用标记；支持「设为当前」「测试连通性（按已存凭据、不回传明文）」「启用/停用」「编辑」「删除」。调用时优先用 [当前] Key，失败自动轮询其余已启用 Key 兜底；删除当前项会自动顺延到下一个。旧版「单 provider + keys」结构在首次读取时自动迁移为 `api_keys` 列表。
- `ADMIN_PASSWORD`：管理后台密码（默认 `admin123`，请务必修改）。
- `WECHAT_APPID` / `WECHAT_SECRET`：配置后「微信登录」走真实 OAuth2 授权；未配置则进入演示模式（自动创建微信体验账号）。
- `PORT`：端口（默认 3000）。`DB_PATH`：自定义数据库文件路径。

重新生成种子数据：`npm run seed`（或 `node --experimental-sqlite src/db.js --reseed`）。

## 功能对照（需求文档 4.x）

| 模块 | 实现 |
|---|---|
| 4.1 行情查询 | 13 个主流 Kindle 型号，参考成交价区间 + 样本量 + 更新时间 + 近 30/90 天趋势折线图 |
| 4.2 AI 定价 | 基于真实区间 + 成色/配件/屏幕/电池 的规则引擎，输出建议区间 + 自然语言理由（LLM 仅润色） |
| 4.3 文案生成 | 闲鱼 / 转转 / 小红书 三种风格模板化生成，可一键复制（LLM 可选） |
| 4.4 库存利润 | 买入-卖出全流程记录，自动算单台利润、平均周转天数、在库台数、累计利润 |

免费版每日额度（文档 7）：定价 3 次 / 文案 5 次，超限提示升级（MVP 为软限制占位）。

## 用户登录与充值

用户端 App 顶部「登录」入口接入了完整的账号体系，登录后可在「我的」页面充值、开通 Pro 会员（¥19/月）。

- **邮箱登录**：注册（邮箱 + 密码，scrypt 哈希）/ 登录，会话以 `Bearer` token 持久化（30 天）。
- **微信登录**：配置 `WECHAT_APPID` + `WECHAT_SECRET` 后走真实网页授权（code 换 openid）；未配置时进入**演示模式**，自动创建一个微信体验账号，便于本地零依赖体验完整流程。
- **充值**：模拟支付即时到账（¥50/¥100/¥200 预设档，也可自定义金额），余额记录在 `users.balance_cents`。
- **会员**：开通 / 续费 Pro（¥19/月），可「模拟支付直接开通」或「用余额抵扣开通」；会员即时解锁定价/文案**无限次**（限额判定见 `src/server.js` 的 `checkLimit`）。

```bash
# 登录页 / 账户页
http://localhost:3200/login.html
http://localhost:3200/account.html
```

接口总览：

| 接口 | 说明 |
|---|---|
| `POST /api/auth/register` | 邮箱注册（返回 token） |
| `POST /api/auth/login` | 邮箱登录 |
| `POST /api/auth/wechat` | 微信登录（演示或真实 OAuth2） |
| `GET  /api/auth/me` | 当前登录用户（需 token） |
| `POST /api/auth/logout` | 登出（清除会话） |
| `GET  /api/billing/me` | 余额 / 会员状态 / 充值记录（需 token） |
| `POST /api/billing/recharge` | 充值（需 token，模拟支付） |
| `POST /api/billing/membership` | 开通/续费会员（需 token，支持 balance / simulate） |

> **演示模式说明**：支付与微信授权均为 MVP 占位。生产接入真实支付（微信/支付宝/Stripe）只需在回调中调用 `billing.topUp` / `billing.buyMembership`；真实微信登录把 `login.html` 的微信按钮替换为重定向到微信授权页并在回调里 `POST /api/auth/wechat { code }` 即可。

## 管理后台（独立 Admin）

与用户端 App 分离的独立后台，用于运营维护：**用户管理、型号行情库 CRUD、定价规则配置、文案模板配置、AI 用量看板**。

```bash
# 打开后台
http://localhost:3000/admin.html
# 默认密码 admin123（用 ADMIN_PASSWORD 环境变量修改）
```

后台含「用户管理」一栏：用户列表（搜索邮箱/昵称/微信 OpenID、按会员筛选、分页）、用户详情（余额/会员/活跃会话 + 充值消费流水）、管理员调账（正负调整余额并留痕）、授予/撤销 Pro 会员、删除用户。

接口总览（均需 `Authorization: Bearer <token>`）：

| 接口 | 说明 |
|---|---|
| `POST /api/admin/login` | 登录，返回 token（无需鉴权） |
| `POST /api/admin/logout` | 登出 |
| `GET /api/admin/dashboard` | 库存概览 + 今日/累计调用 + **用户概览** |
| `GET /api/admin/usage` | 按日、按用户维度的 AI 调用统计 |
| `GET /api/admin/users` | 用户列表（支持 `q` / `membership` / `page` / `pageSize`，返回统计：总用户/Pro 数/总余额/今日新增） |
| `GET /api/admin/users/:id` | 用户详情（含充值/消费流水、活跃会话数） |
| `PUT /api/admin/users/:id` | 改昵称 / 会员状态（`membership`=`free`\|`pro`，`membershipDays` 授予天数） |
| `POST /api/admin/users/:id/adjust-balance` | 管理员调账（`amount` 元，正负皆可，记一条 `recharges` 留痕；不允许余额变负） |
| `DELETE /api/admin/users/:id` | 删除用户（级联清会话与充值记录） |
| `GET/POST /api/admin/models` | 型号行情库列表 / 新增 |
| `PUT/DELETE /api/admin/models/:id` | 型号更新 / 删除（级联删历史） |
| `POST /api/admin/models/:id/regen-history` | 重生成该型号近 90 天趋势 |
| `GET/PUT /api/admin/config` | 读取 / 保存 定价规则 与 文案模板 |
| `GET /api/admin/config-default` | 拉取默认配置（用于「恢复默认」） |
| `GET /api/admin/llm` | 读取 AI 配置（多 Key 列表 + 当前 + 可用模型，返回一律遮罩） |
| `POST /api/admin/llm/key` | 新增 / 更新 模型 Key（upsert；`set_active` 可设当前） |
| `PUT /api/admin/llm/key/:id` | 编辑指定 Key（`api_key` 留空保留原值，不回显明文） |
| `DELETE /api/admin/llm/key/:id` | 删除 Key（删除当前项自动顺延到下一个） |
| `POST /api/admin/llm/key/:id/activate` | 设为当前 |
| `POST /api/admin/llm/key/:id/test` | 按已存凭据测试连通性（不回传明文） |
| `POST /api/admin/llm/models` | 拉取 / 刷新模型列表（走 `/models`，失败用预设兜底） |
| `GET /api/admin/router` | 读取 Model Router 配置（任务路由 + 模型参数 + presets + 已配模型） |
| `PUT /api/admin/router` | 保存 Router 配置（任务→模型映射、自动降级、最大 Token / 温度 / TopP / 并发 / 超时，均做边界校验） |
| `GET /api/admin/router/cost` | 成本与用量看板（今日/本月 Token、调用次数、各模型成本占比、各任务调用） |

> **实时生效**：在后台修改「定价规则」或「文案模板」并保存后，用户端的定价与文案**立即按新配置计算**，无需重启。
> 配置持久化在 `admin_config` 表；未配置时回退到代码内置 `DEFAULT_PRICING` / `DEFAULT_COPYWRITING`。

鉴权说明：MVP 采用「单管理员 + 内存会话（8h 过期）」最简方案，足够隔离前后台；
生产化请替换为数据库持久化会话 + 多账号 + 强哈希密码（见文末迁移）。

## AI 模型调度中心（Model Router，V2.0）

参考《Kindle Trader AI V2.0》第 4 章：系统不再绑定单一模型，而是由 Model Router 按**任务类型**自动调用最合适的模型，并支持**自动降级（Failover）**与**成本控制**。

- **任务路由**：内置 10 类任务（行情分析 / AI 定价 / 利润解释 / 风险评分 / 图片验机 / OCR / 文案生成 / 案例总结 / SOP 推荐 / **采购决策**），各自可配置默认模型（默认按文档映射到 Qwen3 系列，采购决策默认 `Qwen3-235B-A22B-Instruct`）。运行时 `routerComplete(task, system, userPrompt)` 按目标模型优先排序候选 Key，失败自动降级到下一个可用 Key，全部失败回退本地生成。
- **模型参数**：`max_tokens` / `temperature` / `top_p` / 最大并发 / API 超时 在调用时生效；`auto_degrade` 开关控制是否降级；`multi_model` 为多模型协同预留。
- **成本看板**：每次成功调用写入 `model_calls` 表（模型、厂商、任务、Token 估算、估算成本、耗时），后台「模型调度中心 → 成本与用量看板」汇总今日/本月 Token、调用次数、各模型成本占比、各任务调用。
- **配置位置**：后台新增独立一栏「模型调度中心」（任务路由策略 + 模型配置中心 + 成本看板）；模型 Key 仍由「AI 配置」管理。用户端「AI 智能定价」页顶部有突出的 Model Router 高亮卡片，并实时显示当前调度状态（`GET /api/router/status`，公开、不含 Key）。
- **安全**：公开状态接口只返回掩码信息（active 厂商/模型、自动降级开关、任务映射），绝不返回任何 API Key。

### AI 采购决策（用户端 · 定价页）

参考《Kindle Trader AI V2.0》第 4.3 / 4.9 节。用户端「AI 智能定价」页在定价卡片下方新增**采购决策**区块：输入型号 / 我的收购价 / 预期售出价 / 渠道 / 成色 / 采购信息文本 → 系统经 Model Router 路由到「采购决策」任务（默认 Qwen3-235B），**读取知识库**（型号真实参考区间与样本量、近 12 日走势、本店同型号历史成交）→ 本地规则引擎先算 ROI / 风险 / 目标价 → 由大模型综合推理输出采购建议（是否值得收、目标价、风险点、议价要点）。未配置 LLM 时自动回退本地规则生成建议。

- 端点：`POST /api/purchase-advice` `{ modelId, myPurchasePrice, expectedSellPrice, channel, condition, note }`
- 返回：`{ modelName, verdict, targetMax, targetIdeal, riskLevel, risks[], roi, suggestion, knowledge[], llmUsed, modelUsed }`
- 调用同样写入 `model_calls`（task=`purchase`）供成本看板统计。

### 历史建议（用户端 · 定价页查看以往）

生成定价 / 采购 / 文案后自动落库，用户端在各自结果下方展示**历史列表**：定价与采购可「查看详情」回看完整建议；文案支持「查看 / 修改 / 删除」三种管理操作，全部可一键清空（按类型）。

- 落库：每次 `POST /api/pricing`、`POST /api/purchase-advice`、`POST /api/copywriting` 成功后写入 `advice_history` 表（type / model_id / model_name / data_json / created_at），运行时字段（如 usage）不入库。
- 列表：`GET /api/(pricing|purchase|copywriting)/history?limit=30`，返回最新在前（limit 默认 20，最大 100）。
- 清空：`DELETE /api/(pricing|purchase|copywriting)/history`，按类型隔离删除，不影响另一类。
- 单条删除：`DELETE /api/(pricing|purchase|copywriting)/history/:id`，按 id + type 精确删除。
- 修改（仅文案）：`PATCH /api/copywriting/history/:id` 传 `{ results: {平台: 文案} }` 覆盖对应平台文案，其余平台保留；其余类型返回 404（暂不支持修改建议类记录）。
- 数据层：`db.js` 提供 `saveAdvice(type, modelId, modelName, result)`、`listAdvice(type, limit)`、`updateAdvice(id, type, patch)`（合并写回 data_json），均导出可用。

## 目录

```
src/
  db.js          数据层：SQLite schema + 13 型号种子 + 90 天趋势 + admin_config（可平移到 Supabase）
  pricing.js     AI 定价引擎（规则为主、LLM 润色为辅；规则来自 admin_config，含 DEFAULT_PRICING）
  copywriting.js 文案生成（模板为主、LLM 可选；模板来自 admin_config，含 DEFAULT_COPYWRITING）
  purchase.js    AI 采购决策引擎（知识库读取 + 本地规则 ROI/风险 + Model Router 调 Qwen3-235B；无 LLM 回退本地）
  inventory.js   库存 CRUD + 利润汇总
  llm.js         框架式 LLM 客户端 + Model Router：Provider 注册表（openai / anthropic / zhipu / aliyun），多 Key 列表轮询兜底，按任务路由 + 自动降级，无 Key 自动回退本地生成；含连通性测试、模型拉取、成本埋点（model_calls）
  admin.js       管理后台支撑：登录鉴权 + 配置读写 + 用量/库存/用户聚合
  auth.js        用户鉴权：邮箱(scrypt) + 微信(OAuth2/演示) + 会话 + 会员判定
  billing.js     充值与会员：模拟充值、开通/续费 Pro 会员
  server.js      Node 内置 http 路由（用户端 + 受保护 /api/admin/* / /api/billing/*）+ 静态托管
public/
  index.html / styles.css / app.js   移动端优先用户端（含登录态、用量胶囊）
  login.html / login.css / login.js  登录/注册页（邮箱 + 微信）
  account.html / account.css / account.js  账户页（余额、充值、会员、记录）
  admin.html / admin.css / admin.js  独立管理后台（暗色控制台风格）
```

## 合规与风险（文档 8）

- 行情数据为**人工采样维护的参考库**，非自动爬虫，规避平台 ToS / 合规风险。
- AI 定价严格基于真实参考区间，避免 LLM「自信编造」具体价格误导交易决策。
- Kindle 二手市场体量有限，建议尽早验证向 iPad 等品类复制。

## 生产化迁移（文档 6）

1. **前端/后端**：将 `server.js` 的接口迁移到 Next.js App Router 的 Route Handlers，前端直接用 Next 页面。
2. **数据库**：把 `src/db.js` 的建表/种子 SQL 平移到 Supabase(PostgreSQL)，业务层改为调用 Supabase JS SDK，数据层接口保持不变。
3. **鉴权与付费**：用 Supabase Auth 替换 `src/auth.js` 的本地会话 + `src/admin.js` 的内存会话，实现多账号 + 角色权限；接入真实支付网关回调调用 `billing.topUp` / `billing.buyMembership`，按真实会员状态放行无限次（文档 7 的 19 元/月档）。
4. **AI**：保留「真实区间 + LLM 润色」双层结构，可并行接入多家 LLM 做兜底。
5. **数据采集**：用户量验证后，再评估 Playwright 半自动采集（二期），并确认合规边界。
