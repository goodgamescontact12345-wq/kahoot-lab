/**
 * Kahoot session challenge solver.
 *
 * `GET /reserve/session/{pin}` returns a JSON body with a `challenge`: an
 * obfuscated expression that evaluates to a secret string. The websocket path
 * token is the XOR of the base64 `x-kahoot-session-token` header with that
 * secret.
 *
 * Three formats have been observed in the wild (handled in order of priority,
 * mirroring how kahoot.js, Pyhoot and kahoot-bot-panel approach it):
 *   1. "py-style":   ... this, 'MESSAGE' ... offset = <expr> ; ...
 *   2. "assignment": 'MESSAGE' = <expr> ;
 *   3. "legacy":     an angular-era JS expression evaluated as `return <expr>`
 */

/**
 * Decode a message with the known substitution:
 * out[i] = String.fromCharCode((code(i) * i + offset) % 77 + 48)
 * @param {string} message
 * @param {number} offset
 * @returns {string}
 */
function decodeMessage(message, offset) {
  let out = "";
  for (let position = 0; position < message.length; position++) {
    out += String.fromCharCode(((message.charCodeAt(position) * position + offset) % 77) + 48);
  }
  return out;
}

/**
 * Safely evaluate a short arithmetic expression (the challenge offset).
 * The expression comes from Kahoot's server; it is evaluated in an empty
 * scope, exactly like the reference implementations do.
 * @param {string} expr
 * @returns {number}
 */
function evalOffset(expr) {
  const value = Function(`"use strict"; return (${expr});`)();
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`challenge offset is not a number: ${String(value)}`);
  }
  return value;
}

/**
 * Format 1 - modern "py-style": message after `this, '`, offset after `offset = `.
 * @param {string} challenge
 * @returns {string|null}
 */
export function solvePyStyle(challenge) {
  const text = challenge.replace(/\t/g, "").replace(/[^\x00-\x7F]/g, "");
  const parts = text.split("offset = ");
  if (parts.length < 2) return null;
  const offset = evalOffset(parts[1].split(";")[0]);
  const msgParts = text.split("this, '");
  if (msgParts.length < 2) return null;
  const message = msgParts[1].split("'")[0];
  if (!message) return null;
  return decodeMessage(message, offset);
}

/**
 * Format 2 - assignment style: `'MESSAGE' = <expr> ;`
 * @param {string} challenge
 * @returns {string|null}
 */
export function solveAssignment(challenge) {
  const quoteMatch = /'([^']+)'/.exec(challenge);
  if (!quoteMatch) return null;
  const eqPos = challenge.indexOf("=");
  if (eqPos < 0) return null;
  const rest = challenge.slice(eqPos + 1);
  const semi = rest.indexOf(";");
  const expr = (semi >= 0 ? rest.slice(0, semi) : rest).trim();
  if (!expr) return null;
  return decodeMessage(quoteMatch[1], evalOffset(expr));
}

/**
 * Format 3 - legacy angular-era expression. Normalised then evaluated as
 * `return <challenge>` with a tiny `_`/`log` shim (same trick as kahoot.js).
 * @param {string} challenge
 * @returns {string}
 */
export function solveLegacy(challenge) {
  let c = challenge
    .replace(/(\u0009|\u2003)/mg, "")
    .replace(/this /mg, "this")
    .replace(/ *\. */mg, ".")
    .replace(/ *\( */mg, "(")
    .replace(/ *\) */mg, ")")
    .replace("console.", "")
    .replace("this.angular.isObject(offset)", "true")
    .replace("this.angular.isString(offset)", "true")
    .replace("this.angular.isDate(offset)", "true")
    .replace("this.angular.isArray(offset)", "true");
  const solver = Function(
    "var _={replace:function(){var a=arguments;return String(a[0]).replace(a[1],a[2]);}};" +
      "var log=function(){};return " + c
  );
  return String(solver());
}

/**
 * Solve any of the known challenge formats.
 * @param {string} challenge
 * @returns {string} the challenge secret
 */
export function solveChallenge(challenge) {
  if (typeof challenge !== "string" || !challenge.trim()) {
    throw new Error("missing challenge in reserve/session response");
  }
  const attempts = [solvePyStyle, solveAssignment, solveLegacy];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const result = attempt(challenge);
      if (result) return result;
    } catch (err) {
      lastError = lastError || err;
    }
  }
  throw new Error(`unable to solve challenge: ${lastError ? lastError.message : "no format matched"}`);
}

/**
 * Base64-decode the session token header as UTF-8.
 * @param {string} headerToken
 * @returns {string}
 */
export function decodeHeaderToken(headerToken) {
  return Buffer.from(headerToken, "base64").toString("utf8");
}

/**
 * XOR the header token with the challenge secret -> websocket path token.
 * @param {string} headerToken base64 header value
 * @param {string} challenge challenge body
 * @returns {string}
 */
export function deriveSessionToken(headerToken, challenge) {
  return xorTokens(decodeHeaderToken(headerToken), solveChallenge(challenge));
}

/**
 * @param {string} decodedHeader raw (already base64-decoded) header token
 * @param {string} secret challenge solution
 * @returns {string}
 */
export function xorTokens(decodedHeader, secret) {
  if (!secret) throw new Error("empty challenge secret");
  let out = "";
  for (let i = 0; i < decodedHeader.length; i++) {
    out += String.fromCharCode(
      decodedHeader.charCodeAt(i) ^ secret.charCodeAt(i % secret.length)
    );
  }
  return out;
}
