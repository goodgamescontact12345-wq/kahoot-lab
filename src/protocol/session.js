/**
 * `GET /reserve/session/{pin}` - the entry point of the live-game protocol.
 *
 * Response body carries the challenge (see ./challenge.js), response headers:
 *   x-kahoot-session-token  base64 secret, XOR'd with the challenge solution
 *   x-kahoot-gameserver     websocket host for this session (optional)
 *   x-kahoot-live-game-id   session id (informational)
 */

import { deriveSessionToken } from "./challenge.js";

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export class KahootError extends Error {
  /**
   * @param {string} message
   * @param {string} code machine readable code, e.g. "invalid-pin"
   */
  constructor(message, code) {
    super(message);
    this.name = "KahootError";
    this.code = code || "kahoot-error";
  }
}

/**
 * @typedef {Object} ReservedSession
 * @property {string} pin
 * @property {string} headerToken base64 header value
 * @property {string} sessionId   websocket path token (already derived)
 * @property {string|null} gameserver raw x-kahoot-gameserver header
 * @property {string|null} liveGameId
 * @property {object} body        reserve/session JSON body
 * @property {string} baseUrl     http(s) base used for the request
 */

/**
 * Reserve a session for a game PIN.
 * @param {string|number} pin
 * @param {{baseUrl?:string, fetchImpl?:typeof fetch, retries?:number}} [opts]
 * @returns {Promise<ReservedSession>}
 */
export async function reserveSession(pin, opts = {}) {
  const baseUrl = (opts.baseUrl || "https://kahoot.it").replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl || fetch;
  const retries = opts.retries ?? 3;
  const pinStr = String(pin).replace(/\D/g, "");
  if (!/^\d{6,10}$/.test(pinStr)) {
    throw new KahootError(`invalid game PIN: ${pin}`, "invalid-pin");
  }

  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const url = `${baseUrl}/reserve/session/${pinStr}/?${Date.now()}`;
      const res = await fetchImpl(url, {
        headers: {
          "User-Agent": DEFAULT_UA,
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.8",
          Referer: `${baseUrl}/`,
          Origin: baseUrl,
        },
      });
      const text = await res.text();
      if (res.status === 404 || text.trim() === "Not found") {
        throw new KahootError(
          `PIN ${pinStr} was not found - double check the PIN or wait until the host has started the game`,
          "invalid-pin"
        );
      }
      if (!res.ok) {
        throw new Error(`reserve/session HTTP ${res.status}`);
      }
      const headerToken = res.headers.get("x-kahoot-session-token");
      if (!headerToken) {
        throw new KahootError(
          "no session token in response (PIN does not exist or bot protection kicked in)",
          "no-session-token"
        );
      }
      let body = {};
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error("reserve/session returned a non-JSON body");
      }
      return {
        pin: pinStr,
        headerToken,
        sessionId: deriveSessionToken(headerToken, body.challenge),
        gameserver: res.headers.get("x-kahoot-gameserver"),
        liveGameId: res.headers.get("x-kahoot-live-game-id"),
        body,
        baseUrl,
      };
    } catch (err) {
      if (err instanceof KahootError && (err.code === "invalid-pin" || err.code === "no-session-token")) {
        throw err;
      }
      lastError = err;
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }
  throw new KahootError(
    `reserve/session failed for PIN ${pinStr}: ${lastError ? lastError.message : "unknown error"}`,
    "reserve-failed"
  );
}

/**
 * Candidate websocket bases, most specific first.
 * @param {ReservedSession} session
 * @returns {string[]}
 */
export function websocketBases(session) {
  const bases = [];
  const gs = session.gameserver;
  if (gs) {
    bases.push(gs.includes("://") ? gs.replace(/\/+$/, "") : `wss://${gs}`);
  }
  const derived = session.baseUrl.replace(/^http/, "ws");
  if (derived.startsWith("ws")) bases.push(derived.replace(/\/+$/, ""));
  if (session.baseUrl.includes("kahoot.it")) {
    bases.push("wss://play.kahoot.it", "wss://kahoot.it");
  }
  return [...new Set(bases)];
}

/**
 * Full websocket URL candidates for a reserved session.
 * @param {ReservedSession} session
 * @returns {string[]}
 */
export function websocketUrls(session) {
  return websocketBases(session).map(
    (base) => `${base}/cometd/${session.pin}/${encodeURIComponent(session.sessionId)}`
  );
}
