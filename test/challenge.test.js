import test from "node:test";
import assert from "node:assert/strict";

import {
  solveChallenge,
  solvePyStyle,
  solveAssignment,
  solveLegacy,
  deriveSessionToken,
  xorTokens,
  decodeHeaderToken,
} from "../src/protocol/challenge.js";

const decode = (message, offset) => {
  let out = "";
  for (let i = 0; i < message.length; i++) {
    out += String.fromCharCode(((message.charCodeAt(i) * i + offset) % 77) + 48);
  }
  return out;
};

test("py-style challenge (this, 'msg' ... offset = expr;)", () => {
  const message = "modern-challenge-message-0042";
  const challenge = `function(){return null}.call(this, '${message}') /* offset = 7; */`;
  assert.equal(solvePyStyle(challenge), decode(message, 7));
  assert.equal(solveChallenge(challenge), decode(message, 7));
});

test("assignment-style challenge ('msg' = expr;)", () => {
  const message = "assignmentMessage";
  const challenge = `'${message}' = 11;`;
  assert.equal(solveAssignment(challenge), decode(message, 11));
  assert.equal(solveChallenge(challenge), decode(message, 11));
});

test("legacy challenge (plain expression)", () => {
  assert.equal(solveChallenge("'legacy-secret'"), "legacy-secret");
  // the legacy shim is String.prototype.replace-shaped: (str, pattern, repl)
  assert.equal(solveLegacy("_.replace('hello abc', 'abc', 'xyz')"), "hello xyz");
});

test("legacy normalization handles angular-style guards", () => {
  const challenge = "this.angular.isObject(offset) ? 'nope' : 'yep'";
  // both branches of the guard become true after normalization
  assert.equal(solveChallenge(challenge), "nope");
});

test("deriveSessionToken XORs base64 header with the solved challenge", () => {
  const message = "mock-challenge";
  const offset = 0;
  const challenge = `x.call(this, '${message}') /* offset = ${offset}; */`;
  const secret = decode(message, offset);
  const sessionToken = "LabSessionToken123";
  const headerRaw = xorTokens(sessionToken, secret);
  const headerB64 = Buffer.from(headerRaw, "utf8").toString("base64");

  assert.equal(decodeHeaderToken(headerB64), headerRaw);
  assert.equal(deriveSessionToken(headerB64, challenge), sessionToken);
});

test("xorTokens is symmetric and ignores header padding", () => {
  assert.equal(xorTokens(xorTokens("abc", "k"), "k"), "abc");
  // long secrets cycle
  assert.equal(xorTokens("hello world", "xy"), "hello world".split("").map((c, i) =>
    String.fromCharCode(c.charCodeAt(0) ^ "xy".charCodeAt(i % 2))
  ).join(""));
});

test("solveChallenge rejects garbage", () => {
  assert.throws(() => solveChallenge(""), /missing challenge/);
  assert.throws(() => solveChallenge("no quotes no equals"), /unable to solve/);
});
