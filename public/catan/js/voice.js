// 房间语音：WebRTC 点对点（经服务器 WebSocket 交换信令，必要时走 TURN 中继）。
// 扬声器默认打开；麦克风默认关闭，打开时才请求麦克风权限。
const LSget = (k, d) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : JSON.parse(v);
  } catch {
    return d;
  }
};
const LSset = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

const SPEAK_THRESHOLD = 0.035;
const AGORA_SDK_VERSION = '4.24.2';
const AGORA_SDK_URLS = ['/catan/vendor/AgoraRTC_N.js', `https://cdn.jsdelivr.net/npm/agora-rtc-sdk-ng@${AGORA_SDK_VERSION}/AgoraRTC_N-production.js`];

let sdkPromise = null;
// 先从本站加载声网 SDK（Docker 构建时下载），失败再用公共 CDN
function loadAgoraSDK() {
  if (window.AgoraRTC) return Promise.resolve(window.AgoraRTC);
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    for (const url of AGORA_SDK_URLS) {
      try {
        await new Promise((resolve, reject) => {
          const sc = document.createElement('script');
          sc.src = url;
          sc.async = true;
          sc.onload = resolve;
          sc.onerror = reject;
          document.head.appendChild(sc);
        });
        if (window.AgoraRTC) return window.AgoraRTC;
      } catch {}
    }
    sdkPromise = null;
    throw new Error('语音组件加载失败');
  })();
  return sdkPromise;
}

export class Voice {
  constructor({ send, onChange, toast }) {
    this.send = send;
    this.onChange = onChange || (() => {});
    this.toast = toast || (() => {});
    this.speakerOn = LSget('catan.speaker', true);
    this.micOn = false;
    this.track = null;
    this.self = null;
    this.ice = [];
    this.roster = [];
    this.peers = new Map(); // cid -> { pc, audio, pending, analyser, speaking, initiator, restarted }
    this.localAnalyser = null;
    this.selfSpeaking = false;
    this.ctx = null;
    // 声网模式
    this.agora = null; // AgoraRTC client
    this.agoraTrack = null;
    this.agoraGen = 0;
    this.agoraLoud = new Map(); // uid -> 最近一次检测到声音的时间
    this.agoraSpeaking = new Set();
    this.box = document.createElement('div');
    this.box.hidden = true;
    document.body.appendChild(this.box);
    this.timer = setInterval(() => this.detectSpeaking(), 60);
    // 自动播放被拦截时，下一次点击后重试
    window.addEventListener('pointerdown', () => this.resumeAudio(), { capture: true });
  }

  get micSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);
  }

  // ---------- 服务器消息 ----------
  handleRoster(d) {
    const rejoined = d.self !== this.self;
    if (rejoined) {
      this.closeAll();
      this.agoraLeave();
    }
    this.self = d.self;
    // 断线重连后服务器默认视为静音，同步一次真实的麦克风状态
    if (rejoined && this.micOn && d.peers && d.peers.length) this.send('voiceState', { muted: false });
    if (d.ice) this.ice = d.ice;
    this.roster = d.peers || [];
    const live = new Set(this.roster.map((p) => p.cid));
    for (const cid of [...this.peers.keys()]) if (!live.has(cid)) this.closePeer(cid);
    for (const cid of d.initiate || []) if (!this.peers.has(cid)) this.createPeer(cid, true);
    if (d.agora) this.agoraJoin(d.agora);
    this.onChange();
  }

  // ---------- 声网 Agora ----------
  async agoraJoin(info) {
    const gen = ++this.agoraGen;
    let AgoraRTC;
    try {
      AgoraRTC = await loadAgoraSDK();
    } catch (e) {
      this.toast('语音组件加载失败，请检查网络后刷新页面', 'error');
      return;
    }
    if (gen !== this.agoraGen) return; // 加载期间已离开房间
    AgoraRTC.setLogLevel(3);
    if (AgoraRTC.disableLogUpload) AgoraRTC.disableLogUpload();
    AgoraRTC.onAutoplayFailed = () => (this.needResume = true);
    const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
    client.on('user-published', async (user, mediaType) => {
      if (mediaType !== 'audio') return;
      try {
        await client.subscribe(user, 'audio');
        user.audioTrack.setVolume(this.speakerOn ? 100 : 0);
        user.audioTrack.play();
      } catch (e) {
        console.warn('[voice] 订阅失败', e);
      }
      this.onChange();
    });
    client.on('user-unpublished', () => this.onChange());
    client.on('user-left', (user) => {
      this.agoraLoud.delete(user.uid);
      this.onChange();
    });
    client.on('token-privilege-will-expire', () => this.send('voiceToken', {}));
    client.on('connection-state-change', () => this.onChange());
    try {
      await client.join(info.appId, info.channel, info.token || null, info.uid);
    } catch (e) {
      console.warn('[voice] 加入语音频道失败', e);
      this.toast('加入语音频道失败：' + (e && e.code ? e.code : '未知错误'), 'error');
      return;
    }
    if (gen !== this.agoraGen) {
      client.leave().catch(() => {});
      return;
    }
    this.agora = client;
    this.AgoraRTC = AgoraRTC;
    if (this.micOn) await this.agoraPublish();
    this.onChange();
  }

  async agoraRenew(info) {
    if (this.agora && info && info.token) await this.agora.renewToken(info.token).catch(() => {});
  }

  async agoraPublish() {
    if (!this.agora || !this.AgoraRTC) return;
    try {
      this.agoraTrack = this.agoraTrack || (await this.AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true }));
      await this.agora.publish(this.agoraTrack);
    } catch (e) {
      console.warn('[voice] 发布麦克风失败', e);
      throw e;
    }
  }

  async agoraUnpublish() {
    const t = this.agoraTrack;
    this.agoraTrack = null;
    if (!t) return;
    if (this.agora) await this.agora.unpublish(t).catch(() => {});
    t.close();
  }

  agoraLeave() {
    this.agoraGen++;
    const client = this.agora;
    this.agora = null;
    this.agoraLoud.clear();
    this.agoraSpeaking.clear();
    if (this.agoraTrack) {
      this.agoraTrack.close();
      this.agoraTrack = null;
    }
    if (client) client.leave().catch(() => {});
  }

  async handleSignal({ from, kind, data }) {
    try {
      if (kind === 'offer') {
        const peer = this.peers.get(from) || this.createPeer(from, false);
        await peer.pc.setRemoteDescription(data);
        const tr = peer.pc.getTransceivers()[0];
        if (tr) {
          tr.direction = 'sendrecv';
          await tr.sender.replaceTrack(this.track);
        }
        await this.flushIce(peer);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        this.send('rtc', { to: from, kind: 'answer', data: peer.pc.localDescription });
      } else if (kind === 'answer') {
        const peer = this.peers.get(from);
        if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
        await peer.pc.setRemoteDescription(data);
        await this.flushIce(peer);
      } else if (kind === 'ice') {
        const peer = this.peers.get(from);
        if (!peer || !data) return;
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data).catch(() => {});
        else peer.pending.push(data);
      }
    } catch (e) {
      console.warn('[voice] 信令处理失败', kind, e);
    }
  }

  async flushIce(peer) {
    const list = peer.pending.splice(0);
    for (const c of list) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  // ---------- 点对点连接 ----------
  createPeer(cid, initiator) {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const peer = { pc, audio: null, pending: [], analyser: null, speaking: false, initiator, restarted: false };
    this.peers.set(cid, peer);
    pc.onicecandidate = (e) => e.candidate && this.send('rtc', { to: cid, kind: 'ice', data: e.candidate.toJSON() });
    pc.ontrack = (e) => this.attachAudio(cid, e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && peer.initiator && !peer.restarted) {
        peer.restarted = true;
        this.offer(cid, peer, true);
      }
      this.onChange();
    };
    if (initiator) {
      const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
      if (this.track) tr.sender.replaceTrack(this.track);
      this.offer(cid, peer, false);
    }
    return peer;
  }

  async offer(cid, peer, iceRestart) {
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart }));
      this.send('rtc', { to: cid, kind: 'offer', data: peer.pc.localDescription });
    } catch (e) {
      console.warn('[voice] 创建 offer 失败', e);
    }
  }

  attachAudio(cid, stream) {
    const peer = this.peers.get(cid);
    if (!peer) return;
    if (!peer.audio) {
      peer.audio = document.createElement('audio');
      peer.audio.autoplay = true;
      peer.audio.playsInline = true;
      this.box.appendChild(peer.audio);
    }
    peer.audio.srcObject = stream;
    peer.audio.muted = !this.speakerOn;
    peer.audio.play().catch(() => (this.needResume = true));
    peer.analyser = this.makeAnalyser(stream);
  }

  closePeer(cid) {
    const peer = this.peers.get(cid);
    if (!peer) return;
    try {
      peer.pc.close();
    } catch {}
    if (peer.audio) {
      peer.audio.srcObject = null;
      peer.audio.remove();
    }
    this.peers.delete(cid);
  }

  closeAll() {
    for (const cid of [...this.peers.keys()]) this.closePeer(cid);
  }

  // 离开房间
  leave() {
    this.closeAll();
    this.agoraLeave();
    this.roster = [];
    this.self = null;
    if (this.micOn) this.setMic(false, true);
    this.onChange();
  }

  // ---------- 麦克风 / 扬声器 ----------
  async setMic(on, silent = false) {
    if (on === this.micOn) return;
    if (on) {
      if (!this.micSupported) {
        this.toast('麦克风需要通过 HTTPS 访问网站才能使用，目前只能收听', 'warn');
        return;
      }
      if (this.agora) {
        try {
          await this.agoraPublish();
        } catch (e) {
          const denied = e && /PERMISSION_DENIED|NotAllowed/i.test(String(e.code || e.name || e.message));
          this.toast(denied ? '没有麦克风权限，请在浏览器设置里允许本网站使用麦克风' : '无法打开麦克风', 'error');
          return;
        }
        this.micOn = true;
        this.send('voiceState', { muted: false });
        if (!silent) this.onChange();
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        this.track = stream.getAudioTracks()[0];
      } catch (e) {
        this.toast(e && e.name === 'NotAllowedError' ? '没有麦克风权限，请在浏览器设置里允许本网站使用麦克风' : '无法打开麦克风', 'error');
        return;
      }
      this.micOn = true;
      this.localAnalyser = this.makeAnalyser(new MediaStream([this.track]));
    } else {
      this.micOn = false;
      if (this.agoraTrack) this.agoraUnpublish();
      if (this.track) this.track.stop();
      this.track = null;
      this.localAnalyser = null;
      this.selfSpeaking = false;
    }
    for (const peer of this.peers.values()) {
      const tr = peer.pc.getTransceivers()[0];
      if (tr) tr.sender.replaceTrack(this.track).catch(() => {});
    }
    this.send('voiceState', { muted: !this.micOn });
    if (!silent) this.onChange();
  }

  toggleMic() {
    return this.setMic(!this.micOn);
  }

  toggleSpeaker() {
    this.speakerOn = !this.speakerOn;
    LSset('catan.speaker', this.speakerOn);
    for (const peer of this.peers.values()) if (peer.audio) peer.audio.muted = !this.speakerOn;
    if (this.agora) for (const u of this.agora.remoteUsers) if (u.audioTrack) u.audioTrack.setVolume(this.speakerOn ? 100 : 0);
    this.resumeAudio();
    this.onChange();
  }

  resumeAudio() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    if (!this.needResume) return;
    this.needResume = false;
    for (const peer of this.peers.values()) if (peer.audio) peer.audio.play().catch(() => {});
    if (this.agora) for (const u of this.agora.remoteUsers) if (u.audioTrack && !u.audioTrack.isPlaying) u.audioTrack.play();
  }

  // ---------- 说话检测 ----------
  makeAnalyser(stream) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = this.ctx || new AC();
      const src = this.ctx.createMediaStreamSource(stream);
      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      return { an, buf: new Uint8Array(an.fftSize) };
    } catch {
      return null;
    }
  }

  level(a) {
    if (!a) return 0;
    a.an.getByteTimeDomainData(a.buf);
    let sum = 0;
    for (const v of a.buf) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    return Math.sqrt(sum / a.buf.length);
  }

  detectSpeaking() {
    // 超过阈值后保持 450ms，避免说话间隙导致指示灯闪烁
    const now = performance.now();
    const HOLD = 450;
    let changed = false;
    for (const [cid, peer] of this.peers) {
      const entry = this.roster.find((r) => r.cid === cid);
      const active = !!(entry && !entry.muted && this.speakerOn);
      if (active && this.level(peer.analyser) > SPEAK_THRESHOLD) peer.loudAt = now;
      const sp = active && now - (peer.loudAt || 0) < HOLD;
      if (sp !== peer.speaking) {
        peer.speaking = sp;
        changed = true;
      }
    }
    if (this.agora) {
      for (const u of this.agora.remoteUsers) {
        if (u.audioTrack && this.speakerOn && u.audioTrack.getVolumeLevel() > 0.06) this.agoraLoud.set(u.uid, now);
        const sp = now - (this.agoraLoud.get(u.uid) || 0) < HOLD;
        if (sp !== this.agoraSpeaking.has(u.uid)) {
          if (sp) this.agoraSpeaking.add(u.uid);
          else this.agoraSpeaking.delete(u.uid);
          changed = true;
        }
      }
      if (this.agoraTrack && this.agoraTrack.getVolumeLevel() > 0.06) this.selfLoudAt = now;
    }
    if (this.micOn && this.level(this.localAnalyser) > SPEAK_THRESHOLD) this.selfLoudAt = now;
    const me = this.micOn && now - (this.selfLoudAt || 0) < HOLD;
    if (me !== this.selfSpeaking) {
      this.selfSpeaking = me;
      changed = true;
    }
    if (changed) this.onChange();
  }

  // 给界面用：按玩家 id 汇总语音状态
  stateByPid() {
    const out = {};
    for (const r of this.roster) {
      if (!r.pid) continue;
      const self = r.cid === this.self;
      const peer = this.peers.get(r.cid);
      const remote = this.agora ? this.agoraSpeaking.has(r.uid) : !!(peer && peer.speaking);
      out[r.pid] = { muted: self ? !this.micOn : r.muted, speaking: self ? this.selfSpeaking : remote };
    }
    return out;
  }

  listeners() {
    return this.roster.length;
  }
}
