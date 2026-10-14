'use strict';
// 极简 WebSocket 服务端（RFC 6455），仅依赖 Node 内置模块。
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 256 * 1024;

class WSConn extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.open = true;
    this.alive = true;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.onClose());
    socket.on('error', () => this.onClose());
  }

  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > MAX_PAYLOAD * 2) return this.close(1009);
    while (this.open) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > MAX_PAYLOAD) return this.close(1009);
      if (!masked) return this.close(1002);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this.handleFrame(fin, op, payload);
    }
  }

  handleFrame(fin, op, payload) {
    if (op === 0x8) return this.close(1000);
    if (op === 0x9) return this.sendFrame(0xa, payload);
    if (op === 0xa) {
      this.alive = true;
      return;
    }
    if (op === 0x1 || op === 0x2 || op === 0x0) {
      this.frags.push(payload);
      if (!fin) return;
      const msg = Buffer.concat(this.frags).toString('utf8');
      this.frags = [];
      this.alive = true;
      this.emit('message', msg);
    }
  }

  sendFrame(op, data) {
    if (!this.open) return;
    const len = data.length;
    let head;
    if (len < 126) {
      head = Buffer.from([0x80 | op, len]);
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | op;
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([head, data]));
    } catch {
      this.onClose();
    }
  }

  send(obj) {
    this.sendFrame(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8'));
  }

  ping() {
    this.sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (!this.open) return;
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code, 0);
    this.sendFrame(0x8, b);
    this.socket.end();
    this.onClose();
  }

  onClose() {
    if (!this.open) return;
    this.open = false;
    try {
      this.socket.destroy();
    } catch {}
    this.emit('close');
  }
}

function attachWS(server, path, onConn) {
  const conns = new Set();
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      return socket.destroy();
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const c = new WSConn(socket, req);
    conns.add(c);
    c.on('close', () => conns.delete(c));
    onConn(c, req);
  });
  // 心跳：清理半开连接
  const timer = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        c.onClose();
        continue;
      }
      c.alive = false;
      c.ping();
    }
  }, 25000);
  timer.unref();
  return conns;
}

module.exports = { attachWS };
