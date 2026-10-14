# 卡坦岛在线版：零第三方依赖，镜像约 50MB
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

# 以非 root 用户运行
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "server/index.js"]
