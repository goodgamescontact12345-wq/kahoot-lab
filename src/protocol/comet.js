/**
 * Minimal Bayeux/cometd client for Kahoot's game websocket.
 *
 * Flow (mirrors the official client):
 *   1. `/meta/handshake` -> clientId + server timesync
 *   2. subscribe to /service/controller, /service/player, /service/status
 *   3. `/meta/connect` loop (heartbeat, carries advice.reconnect = retry)
 *   4. everything else is published on /service/controller and arrives on
 *      /service/player (see ./events.js for the id -> name table).
 */

import { EventEmitter } from "node:events";
import { decodeEvent } from "./events.js";

const SUBSCRIPTIONS = ["/service/controller", "/service/player", "/service/status"];

export class CometClient extends EventEmitter {
  /**
   * @param {string|{urls:string[]}} target websocket url, or {urls} to try several
   * @param {{connectTimeoutMs?:number, log?:function}} [opts]
   */
  constructor(target, opts = {}) {
    super();
    this.urls = typeof target === "string" ? [target] : target.urls;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15000;
    this.log = opts.log || (() => {});
    this.messageId = 0;
    this.clientId = null;
    this.connected = false;
    this.closed = false;
    this.gameid = null;
    /** clock offset: serverNow ≈ localNow + offset */
    this.clockOffset = 0;
    this.networkLag = 0;
    this.ws = null;
    this.url = null;
  }

  /** @type {Map<string,{resolve:Function,reject:Function,timer:NodeJS.Timeout}>} */
  #waiting = new Map();

  /**
   * Connect, handshake and subscribe. Resolves once the server acknowledges
   * the first `/meta/connect`.
   * @returns {Promise<void>}
   */
  async open() {
    let lastError = null;
    for (const url of this.urls) {
      try {
        await this.#connectOnce(url);
        this.url = url;
        return;
      } catch (err) {
        lastError = err;
        this.#teardownSocket();
        if (this.closed) throw err;
      }
    }
    throw lastError || new Error("no websocket urls to try");
  }

  /**
   * @param {string} url
   * @returns {Promise<void>}
   */
  #connectOnce(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`websocket handshake timeout (${this.connectTimeoutMs}ms): ${url}`));
          try { ws.close(); } catch { /* ignore */ }
        }
      }, this.connectTimeoutMs);

      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      ws.addEventListener("open", () => {
        this.emit("socketOpen", url);
        this.#sendRaw([
          {
            channel: "/meta/handshake",
            version: "1.0",
            minimumVersion: "1.0",
            supportedConnectionTypes: ["websocket", "long-polling"],
            advice: { interval: 0, timeout: 60000 },
            ext: { ack: true, timesync: { l: 0, o: 0, tc: Date.now() } },
          },
        ]);
      });

      ws.addEventListener("message", (ev) => {
        let messages;
        try {
          messages = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        } catch {
          return;
        }
        if (!Array.isArray(messages)) messages = [messages];
        for (const msg of messages) {
          this.#handleMessage(msg, () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
          });
        }
      });

      ws.addEventListener("error", () => fail(new Error(`websocket error: ${url}`)));
      ws.addEventListener("close", () => {
        const err = new Error(`websocket closed: ${url}`);
        if (!settled) fail(err);
        this.#onClose();
      });
    });
  }

  /**
   * @param {object} msg
   * @param {function} onReady called once the first connect is acknowledged
   */
  #handleMessage(msg, onReady) {
    const channel = msg.channel || "";

    if (channel === "/meta/handshake") {
      if (!msg.successful || !msg.clientId) {
        this.emit("error", new Error(`handshake rejected: ${JSON.stringify(msg)}`));
        return;
      }
      this.clientId = msg.clientId;
      const ts = (msg.ext && msg.ext.timesync) || null;
      if (ts && typeof ts.tc === "number") {
        this.networkLag = Math.round((Date.now() - ts.tc - (ts.p || 0)) / 2);
        this.clockOffset = (ts.ts ?? ts.tc) - ts.tc - this.networkLag;
      }
      for (const sub of SUBSCRIPTIONS) {
        this.#sendRaw([{ channel: "/meta/subscribe", clientId: this.clientId, subscription: sub }]);
      }
      this.#sendConnect(0);
      return;
    }

    if (channel === "/meta/connect") {
      const firstAck = !this.connected;
      if (msg.advice && msg.advice.reconnect === "retry") this.connected = true;
      else if (msg.successful) this.connected = true;
      if (firstAck && this.connected) onReady();
      // answer the heartbeat so the server keeps the session alive
      this.#sendConnect(msg.ext && msg.ext.ack != null ? msg.ext.ack : 0);
      return;
    }

    if (channel === "/meta/subscribe" && msg.successful === false) {
      this.emit("error", new Error(`subscription rejected: ${msg.subscription}`));
      return;
    }

    // application messages
    if (channel.startsWith("/service/")) {
      this.emit("service", msg);
      const event = decodeEvent(msg);
      if (event) {
        this.emit("event", event);
        this.emit(event.name, event.content, event);
      }
    }

    if (msg.id != null && this.#waiting.has(String(msg.id))) {
      const pending = this.#waiting.get(String(msg.id));
      this.#waiting.delete(String(msg.id));
      clearTimeout(pending.timer);
      pending.resolve(msg);
    }
  }

  /**
   * @param {number} ack
   */
  #sendConnect(ack) {
    this.#sendRaw([
      {
        channel: "/meta/connect",
        clientId: this.clientId,
        connectionType: "websocket",
        advice: { timeout: 0 },
        ext: { ack, timesync: { l: this.networkLag, o: this.clockOffset, tc: Date.now() } },
      },
    ]);
  }

  /**
   * Publish an application message on /service/controller (or a given channel).
   * @param {object} packet packet from ./packets.js (no id/clientId yet)
   * @param {{expectAck?:boolean, timeoutMs?:number}} [opts]
   * @returns {Promise<object|null>} the ack message when expectAck is set
   */
  publish(packet, opts = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("websocket is not open"));
    }
    const id = String(++this.messageId);
    const msg = { ...packet, id, clientId: this.clientId, ext: packet.ext || {} };
    this.#sendRaw([msg]);
    if (!opts.expectAck) return Promise.resolve(null);
    const timeoutMs = opts.timeoutMs ?? 10000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new Error(`timed out waiting for ack of message ${id}`));
      }, timeoutMs);
      this.#waiting.set(id, { resolve, reject, timer });
    });
  }

  /**
   * Send a raw array of cometd messages.
   * @param {object[]} messages
   */
  #sendRaw(messages) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(messages));
      this.log("SEND", JSON.stringify(messages));
    } catch (err) {
      this.emit("error", err);
    }
  }

  /**
   * Server time estimate (used to schedule answers against the game clock).
   * @returns {number} epoch ms
   */
  serverNow() {
    return Date.now() + this.clockOffset;
  }

  /**
   * Gracefully disconnect.
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.#sendRaw([{ channel: "/meta/disconnect", clientId: this.clientId, ext: { timesync: Date.now() } }]);
      } catch { /* ignore */ }
      setTimeout(() => this.#teardownSocket(), 150);
    } else {
      this.#teardownSocket();
    }
  }

  #teardownSocket() {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  #onClose() {
    for (const [, pending] of this.#waiting) {
      clearTimeout(pending.timer);
      pending.reject(new Error("websocket closed"));
    }
    this.#waiting.clear();
    if (!this.closed) {
      this.closed = true;
      this.emit("close");
    }
  }
}
