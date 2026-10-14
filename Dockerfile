# 卡坦岛在线版：零第三方依赖，数据保存在 SQLite（Node 内置 node:sqlite）
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/catan.db

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

# 数据目录交给 node 用户；挂载命名数据卷时会继承这个权限
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

# node:sqlite 在 Node 22 中标记为实验性功能，关闭对应的启动警告
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
