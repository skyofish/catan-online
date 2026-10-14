#!/usr/bin/env bash
# 服务器端部署脚本：用当前目录的代码重建并重启容器，然后做健康检查。
# GitHub Actions 自动部署会调用它，也可以在服务器上手动运行：./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

# 读取 .env 里的端口（docker compose 也会自动读取这个文件）
PORT=3000
if [ -f .env ] && grep -q '^CATAN_PORT=' .env; then
  PORT=$(grep '^CATAN_PORT=' .env | tail -1 | cut -d= -f2)
fi

# 当前用户能直接用 docker 就不加 sudo
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then DOCKER="sudo -n docker"; fi

echo "==> 版本 $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "==> 构建并重启容器（端口 $PORT）"
$DOCKER compose up -d --build --remove-orphans

echo "==> 健康检查"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "✅ 部署成功：http://127.0.0.1:${PORT}"
    $DOCKER image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 1
done

echo "❌ 30 秒内健康检查未通过，最近日志："
$DOCKER compose logs --tail 50
exit 1
