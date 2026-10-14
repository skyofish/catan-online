# 卡坦岛 在线版

网页端卡坦岛，支持 4 / 6 / 8 人地图、好友联机、电脑玩家、动画与合成音效。
服务端与前端均为原生 JavaScript，**没有任何第三方依赖**，不需要 `npm install`。

## 快速部署（Docker）

```bash
# 在服务器上，进入项目目录
docker compose up -d --build
# 浏览器访问 http://服务器IP:3000
```

修改对外端口：`CATAN_PORT=8080 docker compose up -d --build`

不用 compose 时：

```bash
docker build -t catan-online .
docker run -d --name catan -p 3000:3000 --restart unless-stopped catan-online
```

> 国内服务器拉取 `node:22-alpine` 较慢时，可在 `/etc/docker/daemon.json` 配置镜像加速，
> 或把 Dockerfile 第一行改成可用的镜像源地址（例如公司内部仓库中的 node:22-alpine）。

### 使用域名 / HTTPS

游戏通过 `/ws` 路径使用 WebSocket。用 Nginx 反向代理时必须转发 `Upgrade` 头，
可直接参考仓库里的 `nginx.conf.example`。页面在 https 下会自动改用 `wss://`。

### 不用 Docker

需要 Node.js 18 以上（运行测试需要 22 以上）：

```bash
node server/index.js          # 或 npm start
```

## 自动部署（GitHub Actions）

推送到 `main` 分支后，Actions 会先运行测试，通过后 SSH 到服务器执行
`git reset --hard origin/main && ./deploy.sh`。

**一次性准备**

1. 服务器上克隆代码并写好端口配置：
   ```bash
   git clone https://github.com/skyofish/catan-online.git ~/catan
   echo "CATAN_PORT=80" > ~/catan/.env
   ```
2. 服务器上生成一把专用于部署的密钥，并允许它登录：
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N "" -C github-actions
   cat ~/.ssh/github_deploy.pub >> ~/.ssh/authorized_keys
   cat ~/.ssh/github_deploy      # 复制输出的全部内容，下一步要用
   ```
3. 在 GitHub 仓库 Settings → Secrets and variables → Actions 添加：

   | Secret | 值 |
   | --- | --- |
   | `SSH_HOST` | 服务器 IP |
   | `SSH_KEY` | 上一步输出的私钥全文（包括 BEGIN / END 行） |
   | `SSH_USER` | 可选，默认 `ubuntu` |
   | `SSH_PORT` | 可选，默认 `22` |
   | `DEPLOY_PATH` | 可选，默认 `~/catan` |

之后每次推送都会自动部署；也可以在 Actions 页面手动点 “Run workflow”。
手动部署：在服务器上 `cd ~/catan && git pull && ./deploy.sh`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `BOT_DELAY_MS` | `900` | 电脑玩家每步的间隔（毫秒），掷骰后自动加长以便看清动画 |
| `AFK_TAKEOVER_MS` | `60000` | 真人掉线多久后由电脑临时代管，重新连上后自动交还 |
| `MAX_ROOMS` | `200` | 同时存在的房间上限 |

健康检查：`GET /health`

## 玩法功能

- **地图**：4 人经典 19 块；6 人扩展 30 块；8 人大岛 43 块。地形、数字、港口每局随机生成，自动避免 6 和 8 相邻。
- **完整规则**：初始放置（蛇形顺序，第二个村庄发资源）、距离规则、掷 7 弃牌与强盗、偷牌、
  银行 4:1 与 3:1 / 2:1 港口、玩家间报价交易、五种发展卡（本回合买的不能用、每回合限一张）、
  最长道路（含被截断的重新计算）、最大军队、银行资源不足时不发放、目标分数可设 8–14。
- **6 / 8 人特殊建造阶段**：每名玩家结束回合后，其余玩家依次获得只能建造的机会（可在房间里关闭）。
- **联机**：房间号 + 邀请链接；刷新或断网后自动重连回到原座位；满员或开局后进入观战；
  房主可添加电脑玩家、移出玩家、让离线玩家由电脑代管；结束后一键回到房间再来一局。
- **动画**：地块落下开场、3D 骰子、产出地块闪光与资源卡飞入手牌、建筑落下弹跳与粒子、
  强盗跳跃移动、偷牌/交易/垄断时卡牌在玩家之间飞行、发展卡翻转展示、回合横幅、
  奖励金光、胜利彩带与骰子点数分布图。系统开启"减少动态效果"时自动简化。
- **音效**：全部由 Web Audio 实时合成（不需要音频文件）——骰子滚动、修路、建村庄、城市、
  各资源不同音色、强盗、掷出 7、偷牌、交易、发展卡、骑士号角、轮到你的钟声、胜利号角，
  以及可开关的生成式背景音乐。音量在右上角 ♪ 中调节。
- **快捷键**：R 掷骰，E 结束回合，T 交易，1–4 建造，Esc 取消，+ / − 缩放，0 复位视角。
- **手机**：竖屏可玩，双指缩放棋盘，玩家列表与聊天为侧边抽屉。

## 项目结构

```
server/
  index.js   HTTP 静态服务 + 房间管理 + 消息处理
  ws.js      零依赖 WebSocket 服务端实现（RFC 6455）
  game.js    规则引擎（服务器权威，按玩家隐藏手牌）
  board.js   4/6/8 人地图生成
  bot.js     电脑玩家
public/
  index.html  页面与 SVG 图标
  css/style.css
  js/app.js     界面、网络、事件动画编排
  js/board.js   SVG 棋盘渲染与平移缩放
  js/fx.js      飞牌、骰子、粒子、横幅、彩带
  js/audio.js   合成音效与背景音乐
test/
  sim.js     36 局电脑对局，校验资源守恒、距离规则、棋子数量
  socket.js  联机冒烟测试（建房、加入、权限、聊天、重连、观战）
```

运行测试：`npm test`

## 说明

- 房间数据保存在内存中，重启容器会清空正在进行的对局。
- 单个进程即可支撑大量房间；如需多实例横向扩展，需要在负载均衡上开启会话保持（同一房间的玩家连到同一实例）。
