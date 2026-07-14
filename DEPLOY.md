# 部署指南：把 Kindle Trader AI 部署到 GitHub 并分享 Demo

> 目标：把桌面上的 `kindle-trader-ai-optimized_GitHub` 推到 GitHub，并让其他人能「点一下就跑起来」。

---

## 一、项目里已就绪的部署文件

我已经在项目根目录准备好了这些文件，直接提交即可：

| 文件 | 作用 |
|---|---|
| `.gitignore` | 排除运行时数据库 `data/*.db*`、`.env`、`.vscode`、`.DS_Store`，只提交源码 |
| `Dockerfile` | 基于 `node:22-alpine`，用 Node 内置的 `node:sqlite` |
| `render.yaml` | Render 一键部署配置（已锁 Node 22，startCommand = `node --experimental-sqlite src/server.js`） |
| `railway.json` | Railway 一键部署配置 |

应用启动时会**自动建库 + 种子数据**（`seedIfEmpty()`），所以不用提交 `data/` 里的数据库文件，云端首次运行会自动初始化。

---

## 二、推送到 GitHub（在你自己的电脑上操作）

你本地能正常访问 github.com，所以用普通 `git push` 即可（WorkBuddy 沙箱里因代理限制才需要走 API 通道）。

### 1. 准备环境
- **Git**：macOS 一般已装；没有就 `xcode-select --install`
- **Node.js ≥ 22.5**：官网下载，或用 `nvm install 22`
- 验证：`node -v`（应 ≥ 22.5）、`git --version`

### 2. 初始化并提交
```bash
cd ~/Desktop/kindle-trader-ai-optimized_GitHub
git init -b main
git add -A
git commit -m "Initial commit: Kindle Trader AI MVP"
```
> `git add -A` 会包含已加好的部署文件，并自动跳过被 `.gitignore` 排除的数据库 / 密钥。

### 3. 在 GitHub 网页创建仓库
1. 打开 https://github.com/new
2. Repository name 填 `kindle-trader-ai`
3. **不要**勾选 "Add a README file" / "Add .gitignore"（本地已有）
4. 可见性选 **Public**（方便分享 demo；要私有也行）
5. 点 **Create repository**

### 4. 关联远程并推送
把 `<你的GitHub用户名>` 换成你的用户名：
```bash
git remote add origin https://github.com/<你的GitHub用户名>/kindle-trader-ai.git
git push -u origin main
```
> 首次推送会弹出 GitHub 登录框，用你 Chrome 已登录的账号授权即可；或用 `gh auth login` 登录后再推。

推送成功后，仓库地址即：
```
https://github.com/<你的GitHub用户名>/kindle-trader-ai
```

---

## 三、让别人「点击就能跑」

### 方式 A：一键部署到 Render（推荐 · 免费 · 拿公网链接）
1. 在浏览器打开（把用户名换掉）：
   ```
   https://render.com/deploy?repo=https://github.com/<你的GitHub用户名>/kindle-trader-ai
   ```
   或者：先把本仓库 README 顶部「Deploy to Render」按钮里的 `YOUR_USERNAME` 改成你的用户名，然后直接点按钮。
2. 用 GitHub 登录 Render → 它会读取 `render.yaml` → 点 **Create Web Service**
3. 等待构建（免费实例首次约 1–2 分钟；之后可能休眠，访问时自动唤醒）
4. 完成后拿到类似 `https://kindle-trader-ai.onrender.com` 的公网地址，发给任何人即可点击使用

要点：
- `render.yaml` 已锁 Node 22，并强制 `startCommand` 为 `node --experimental-sqlite src/server.js`（**不能**写 `PORT=3200`，否则云平台健康检查会失败）
- 数据库在云端首次运行自动建库 + 种子，无需手动导入
- 管理员密码会在 Render 环境变量里**随机生成**（键 `ADMIN_PASSWORD`），可在 Render 后台查看 / 修改；后台地址 `/admin.html`

### 方式 B：本地运行（零依赖）
```bash
cd ~/Desktop/kindle-trader-ai-optimized_GitHub
npm start          # = node --experimental-sqlite src/server.js
# 浏览器打开 http://localhost:3200
```
无需 `npm install`（零第三方依赖）。管理后台：`http://localhost:3200/admin.html`（默认密码 `admin123`）。

### 方式 C：Docker / Railway / Koyeb
- **Docker**：`docker build -t kindle-trader-ai . && docker run -p 3000:3000 kindle-trader-ai`
- **Railway**：导入仓库时选「Deploy from repo」，会读 `railway.json`
- **Koyeb**：同样导入 GitHub 仓库，运行命令 `node --experimental-sqlite src/server.js`

---

## 四、安全与注意事项
- **不要提交真实密钥**：`.env` 已被 `.gitignore` 忽略；仓库里只有 `.env.example`，安全。
- **公网 demo 改管理员密码**：公开部署时建议覆盖 `ADMIN_PASSWORD` 环境变量为强密码，避免默认 `admin123` 被人登录后台。
- **数据库不持久**：免费云实例的文件系统是临时的，重启 / 重新部署会重置数据库（自动重新种子）。MVP demo 足够；生产请用 Supabase / PostgreSQL（见 README「生产化迁移」）。
- **Node 版本**：`node:sqlite` 需要 Node ≥ 22.5，部署平台务必选 Node 22。

---

## 五、常见问题
- **部署后健康检查失败 / 页面打不开**：确认启动命令是 `node --experimental-sqlite src/server.js`（没有 `PORT=3200`），且监听 `process.env.PORT`。
- **`node:sqlite` 报错 `not supported`**：Node 版本低于 22.5，升级 Node。
- **推送被拒绝（non-fast-forward）**：`git pull --rebase origin main` 后再 `git push`。
