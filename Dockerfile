# Kindle Trader AI · MVP
# 零依赖 Node 应用，使用内置 node:sqlite（需要 Node >= 22.5）
FROM node:22-alpine

WORKDIR /app

# 仅复制运行所需文件（无需 npm install，零第三方依赖）
COPY package.json ./
COPY src ./src
COPY public ./public

# 确保数据目录存在且可写（SQLite 在此自动建库 + 种子）
RUN mkdir -p /app/data && chmod 777 /app/data

ENV PORT=3000
EXPOSE 3000

# --experimental-sqlite 是启用内置 SQLite 模块所必需的
# 注意：不要在此硬编码 PORT，云端平台会注入自己的 $PORT
CMD ["node", "--experimental-sqlite", "src/server.js"]
