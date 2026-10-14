# 卡坦岛 在线版

网页端卡坦岛，支持 4 / 6 / 8 人地图、好友联机、电脑玩家、动画与合成音效，
以及账号登录、战绩排行榜和管理员后台。
服务端与前端均为原生 JavaScript，数据保存在 SQLite（Node 内置 `node:sqlite`），
**没有任何第三方依赖**，不需要 `npm install`。

## 房间语音

进入房间后自动加入该房间的语音频道：**扬声器默认打开，麦克风默认关闭**，
点右上角的麦克风按钮开始说话；正在说话的玩家头像会发光。

- **声网 Agora（推荐）**：在声网控制台创建项目（鉴权方式选「App ID + Token」），
  把 App ID 和 App 证书写进服务器的 `.env`：
  ```bash
  AGORA_APP_ID=你的AppID
  AGORA_APP_CERTIFICATE=你的App证书
  ```
  服务器会为每位玩家签发 24 小时有效的 Token（证书不会发给浏览器）。
  声网 Web SDK 在 Docker 构建时下载到本站，玩家从你的服务器加载。
- **未配置声网时**：使用内置的 WebRTC 点对点语音；跨运营商、手机网络下可能连不通。
- **麦克风必须在 HTTPS 下使用**：这是浏览器的限制，与语音服务商无关。
  通过 `http://IP` 访问时只能收听，不能说话。

## AI 玩家（智谱大模型）

房主在大厅可添加两种电脑玩家：**内置电脑**（程序策略，反应快）和 **AI 玩家**（智谱大模型做关键决策）。
在服务器 `.env` 中加入后 `./deploy.sh` 即可启用：

```bash
ZHIPU_API_KEY=你的智谱APIKey
# 可选：默认 glm-4.7-flash（免费）；想更强可换 glm-4.7 / glm-5-turbo 等付费模型
ZHIPU_MODEL=glm-4.7-flash
# 可选：设为 1 开启深度思考（更聪明，但每步慢很多、token 多）
ZHIPU_THINKING=
```

- 程序先算出合法且排好序的候选（位置价值、资源点数、港口、对手威胁），模型只在关键时刻做选择：
  开局选点、每回合的行动计划、强盗位置与偷谁、是否接受交易。掷骰、弃牌等机械步骤沿用内置策略。
- 提示词精简（每次约 400–600 个汉字），模型以 JSON 回答；回答无效、超时或出错时自动回退到内置策略，对局不会卡住。
- 管理员后台显示 AI 调用次数、失败次数与 token 消耗。

## 账号与管理员

- 玩家必须用账号登录才能进入，**账号不需要密码**，由管理员在后台开通。
- 管理员后台：`http://服务器地址/admin`，用环境变量 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录。
  **不要把密码写进代码或提交到仓库**，写在服务器项目目录下的 `.env` 文件里：
  ```bash
  CATAN_PORT=80
  ADMIN_USERNAME=你的管理员账号
  ADMIN_PASSWORD=你的管理员密码
  ```
- 管理员可以批量添加账号、启用 / 禁用、删除。禁用或删除后，该玩家立即被强制下线；
  正在进行的对局由电脑接管。删除账号后，历史战绩里仍保留其名字。
- 管理员登录 12 小时后过期；玩家登录 180 天内有效。

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

### HTTPS（麦克风需要）

仓库自带 Caddy 配置，可直接用 **Let's Encrypt 的 IP 地址证书**（6 天有效，Caddy 自动续期），不需要域名。
在服务器的 `.env` 中加入：

```bash
COMPOSE_PROFILES=https
PUBLIC_IP=你的服务器公网IP
CATAN_BIND=127.0.0.1
CATAN_PORT=3000
TRUST_PROXY=1
```

然后 `./deploy.sh`。防火墙需放行 TCP 80 和 443。`http://` 仍可访问；
网页检测到 HTTPS 可用后会自动跳转过去，并保留登录状态。
查看证书申请情况：`docker compose logs caddy | grep -iE "obtained|error"`。

若改用自己的 Nginx，参考 `nginx.conf.example`（必须转发 WebSocket 的 `Upgrade` 头）。

### 不用 Docker

需要 Node.js 22.13 以上：

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=xxx npm start
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
| `ADMIN_USERNAME` | 无 | 管理员账号，未设置时后台无法登录 |
| `ADMIN_PASSWORD` | 无 | 管理员密码 |
| `AGORA_APP_ID` | 无 | 声网 App ID，设置后语音走声网 |
| `AGORA_APP_CERTIFICATE` | 无 | 声网 App 证书，用于签发 Token |
| `TRUST_PROXY` | 无 | 设为 `1` 时按 `X-Forwarded-For` 识别真实 IP（经反向代理时开启） |
| `ZHIPU_API_KEY` | 无 | 智谱 API Key，设置后可添加 AI 玩家 |
| `ZHIPU_MODEL` | `glm-4.7-flash` | 智谱模型 |
| `ZHIPU_THINKING` | 无 | 设为 `1` 开启深度思考 |
| `DB_PATH` | `data/catan.db` | 数据库文件位置（Docker 中为 `/app/data/catan.db`） |

健康检查：`GET /health`

## 玩法功能

- **地图**：4 人经典 19 块；6 人扩展 30 块；8 人大岛 43 块。地形、数字、港口每局随机生成，自动避免 6 和 8 相邻。
- **完整规则**：初始放置（蛇形顺序，第二个村庄发资源）、距离规则、掷 7 弃牌与强盗、偷牌、
  银行 4:1 与 3:1 / 2:1 港口、玩家间报价交易、五种发展卡（本回合买的不能用、每回合限一张）、
  最长道路（含被截断的重新计算）、最大军队、银行资源不足时不发放、目标分数可设 8–14。
- **6 / 8 人特殊建造阶段**：每名玩家结束回合后，其余玩家依次获得只能建造的机会（可在房间里关闭）。
- **地图预览**：房间大厅里预览本局地图，房主不满意可以「换一张」，开局就用这张。
- **邀请**：在房间大厅里可看到所有在线玩家（空闲 / 在房间中 / 对局中），一键邀请；对方收到弹窗后可直接加入或忽略。
- **联机**：房间号 + 邀请链接；刷新、断网或主动离开后都能回到原座位（离开期间电脑代打）；满员或开局后进入观战；
  房主可添加电脑玩家、移出玩家、让离线玩家由电脑代管；结束后一键回到房间再来一局。
- **动画**：地块落下开场、3D 骰子、产出地块闪光与资源卡飞入手牌、建筑落下弹跳与粒子、
  强盗跳跃移动、偷牌/交易/垄断时卡牌在玩家之间飞行、发展卡翻转展示、回合横幅、
  奖励金光、胜利彩带与骰子点数分布图。系统开启"减少动态效果"时自动简化。
- **音效**：全部由 Web Audio 实时合成（不需要音频文件）——骰子滚动、修路、建村庄、城市、
  各资源不同音色、强盗、掷出 7、偷牌、交易、发展卡、骑士号角、轮到你的钟声、胜利号角，
  以及可开关的生成式背景音乐。音量在右上角 ♪ 中调节。
- **快捷键**：R 掷骰，E 结束回合，T 交易，1–4 建造，Esc 取消，+ / − 缩放，0 复位视角。
- **手机**：竖屏可玩，双指缩放棋盘，玩家列表与聊天为侧边抽屉。
- **战绩**：每局结束自动记录；首页有排行榜（按胜场、胜率排序）和「我的战绩」（最近 10 局）。
- **续玩**：进行中的对局实时写入数据库，部署或重启后自动恢复，玩家刷新页面即可回到原座位。

## 项目结构

```
server/
  index.js   HTTP 静态服务 + 登录 / 管理员 API + 房间管理 + 对局持久化
  db.js      SQLite 数据层（账号、会话、房间快照、战绩）
  vendor/agora/  声网官方 Token 生成代码（MIT，仅依赖 Node 内置模块）
  ws.js      零依赖 WebSocket 服务端实现（RFC 6455）
  game.js    规则引擎（服务器权威，按玩家隐藏手牌）
  board.js   4/6/8 人地图生成
  bot.js     内置电脑玩家（也为 AI 提供候选评分）
  ai.js      智谱 AI 玩家（提示词、候选生成、回退）
public/
  index.html  页面与 SVG 图标
  admin.html  管理员后台
  js/admin.js   后台逻辑
  js/voice.js   房间语音（声网 / WebRTC 点对点）
  css/style.css
  js/app.js     界面、网络、事件动画编排
  js/board.js   SVG 棋盘渲染与平移缩放
  js/fx.js      飞牌、骰子、粒子、横幅、彩带
  js/audio.js   合成音效与背景音乐
test/
  sim.js     36 局电脑对局，校验资源守恒、距离规则、棋子数量
  socket.js  端到端测试（管理员、登录、禁用踢出、重启续玩、战绩排行）
```

运行测试：`npm test`

## 说明

- 数据库保存在 Docker 数据卷 `catan-data` 中，重建镜像、重启容器都不会丢失。
  备份（在线一致性快照）：
  ```bash
  docker compose exec catan node -e "new (require('node:sqlite').DatabaseSync)('/app/data/catan.db').exec(\"VACUUM INTO '/tmp/backup.db'\")"
  docker compose cp catan:/tmp/backup.db ./catan-backup-$(date +%F).db
  ```
- 单个进程即可支撑大量房间；如需多实例横向扩展，需要在负载均衡上开启会话保持（同一房间的玩家连到同一实例）。
