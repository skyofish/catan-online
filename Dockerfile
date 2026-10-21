# 卡坦岛在线版：零第三方 npm 依赖，数据保存在 SQLite（Node 内置 node:sqlite）
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/catan.db

WORKDIR /app

# 声网语音 Web SDK：构建时下载到本站，玩家从本服务器加载（下载失败时网页会改用公共 CDN）
ARG AGORA_SDK_VERSION=4.24.2
RUN mkdir -p /app/public/catan/vendor && \
    (wget -qO- "https://registry.npmjs.org/agora-rtc-sdk-ng/-/agora-rtc-sdk-ng-${AGORA_SDK_VERSION}.tgz" \
       | tar -xzO package/AgoraRTC_N-production.js > /app/public/catan/vendor/AgoraRTC_N.js \
     && test -s /app/public/catan/vendor/AgoraRTC_N.js \
     || (echo "⚠️  声网 SDK 下载失败，将使用公共 CDN" && rm -f /app/public/catan/vendor/AgoraRTC_N.js))

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
