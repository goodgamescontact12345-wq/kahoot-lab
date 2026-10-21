/**
 * A tiny RFC 6455 WebSocket server (text frames, ping/pong, fragmentation).
 * Just enough to host Kahoot's cometd protocol locally with zero deps.
 */

import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD = 8 * 1024 * 1024;

class Connection {
  /** @param {import('node:net').Socket} socket */
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.currentOpcode = 0;
    this.closed = false;
    /** @type {Record<string, Function[]>} */
    this.handlers = { message: [], close: [] };
    socket.on("data", (chunk) => this.#feed(chunk));
    socket.on("close", () => this.#emitClose());
    socket.on("error", () => this.#emitClose());
  }

  /**
   * @param {"message"|"close"} event
   * @param {Function} cb
   */
  on(event, cb) {
    (this.handlers[event] ||= []).push(cb);
  }

  /**
   * @param {string} text
   */
  send(text) {
    if (this.closed || this.socket.destroyed) return;
    const payload = Buffer.from(String(text), "utf8");
    this.socket.write(encodeFrame(0x1, payload));
  }

  /**
   * @param {number} [code]
   */
  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    try {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      this.socket.write(encodeFrame(0x8, payload));
    } catch { /* ignore */ }
    this.socket.end();
  }

  #emitClose() {
    if (this.handlers.closeEmitted) return;
    this.handlers.closeEmitted = true;
    this.closed = true;
    for (const cb of this.handlers.close) cb();
  }

  /** @param {Buffer} chunk */
  #feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_PAYLOAD * 2) {
      this.close(1009);
      return;
    }
    // parse as many complete frames as are buffered
    for (;;) {
      const frame = tryDecodeFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.size);
      this.#handleFrame(frame);
      if (this.closed) return;
    }
  }

  /** @param {{opcode:number, payload:Buffer, fin:boolean}} frame */
  #handleFrame(frame) {
    const { opcode, payload, fin } = frame;
    if (opcode === 0x9) {
      // ping -> pong
      this.socket.write(encodeFrame(0xa, payload));
      return;
    }
    if (opcode === 0xa) return; // pong
    if (opcode === 0x8) {
      this.close();
      return;
    }
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      if (opcode === 0x1 || opcode === 0x2) this.currentOpcode = opcode;
      this.fragments.push(payload);
      if (!fin) return;
      const data = Buffer.concat(this.fragments);
      this.fragments = [];
      const type = this.currentOpcode || opcode;
      this.currentOpcode = 0;
      if (type === 0x1) {
        for (const cb of this.handlers.message) cb(data.toString("utf8"));
      }
    }
  }
}

/**
 * @param {Buffer} buf
 * @returns {{size:number, opcode:number, fin:boolean, payload:Buffer, firstOpcode:number}|null}
 */
function tryDecodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(MAX_PAYLOAD)) throw new Error("frame too large");
    len = Number(big);
    offset += 8;
  }
  if (len > MAX_PAYLOAD) throw new Error("frame too large");
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (maskKey) {
    const unmasked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
    payload = unmasked;
  } else {
    payload = Buffer.from(payload);
  }
  return { size: offset + len, opcode, fin, payload, firstOpcode: opcode };
}

/**
 * @param {number} opcode
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode, server frames are unmasked
  return Buffer.concat([header, payload]);
}

/**
 * Upgrade an HTTP server to WebSocket.
 * @param {import('node:http').Server} httpServer
 * @param {{onConnection:(conn:Connection, req:import('node:http').IncomingMessage)=>void}} opts
 */
export function attachWebSocket(httpServer, { onConnection }) {
  httpServer.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const upgrade = String(req.headers.upgrade || "").toLowerCase();
    if (!key || upgrade !== "websocket") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const conn = new Connection(socket);
    try {
      onConnection(conn, req);
    } catch {
      conn.close(1011);
    }
  });
}

export { Connection as WebSocketConnection };
