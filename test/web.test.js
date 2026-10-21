/**
 * End-to-end tests for the kahoot-lab web console: static UI + JSON API,
 * driving a real test host and a real bot swarm through HTTP.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";

import { startKahootLabServer } from "../src/web/server.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {Awaited<ReturnType<typeof startKahootLabServer>>} */
let server;
let base;
let pin = "";

before(async () => {
  server = await startKahootLabServer({ port: 0, quiet: true, fixturesDir: "fixtures" });
  base = server.url;
});

after(async () => {
  await server.close();
});

async function get(path) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  return { status: res.status, text, json, headers: res.headers };
}

async function post(path, body = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/**
 * @param {() => Promise<boolean>} predicate
 * @param {number} timeoutMs
 * @param {string} what
 */
async function waitFor(predicate, timeoutMs, what) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

const status = async () => (await get(`/api/status/${pin}`)).json;

test("serves the web console and health endpoint", { timeout: 15000 }, async () => {
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.text, /kahoot/);
  assert.match(page.text, /Game PIN/);
  assert.match(page.text, /Reveal answers/);
  assert.match(page.text, /Scoreboard/);

  const css = await get("/app.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);

  const js = await get("/app.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);

  const health = await get("/api/health");
  assert.equal(health.json.ok, true);

  const missing = await get("/api/nope");
  assert.equal(missing.status, 404);
  assert.equal(missing.json.ok, false);
});

test("lists fixtures", { timeout: 10000 }, async () => {
  const res = await get("/api/fixtures");
  assert.equal(res.json.ok, true);
  assert.ok(res.json.fixtures.includes("demo-quiz.json"), JSON.stringify(res.json));
});

test("starts a test host through the API", { timeout: 20000 }, async () => {
  const res = await post("/api/mock/start", {
    fixture: "demo-quiz.json",
    autoStartSec: 0, // manual start so the resolve test can join first
    questionTimeMs: 4000,
    gapMs: 500,
  });
  assert.equal(res.json.ok, true, JSON.stringify(res.json));
  assert.match(res.json.pin, /^\d{7}$/);
  assert.ok(res.json.baseUrl.startsWith("http://127.0.0.1:"));
  pin = res.json.pin;

  const st = await status();
  assert.equal(st.isTestHost, true);
  assert.equal(st.phase, "lobby");
});

test("reveals answers for the PIN through the API", { timeout: 30000 }, async () => {
  // resolve in the background; it must join the lobby before the quiz starts
  const resolving = post("/api/resolve", { pin, waitSec: 15 });
  await waitFor(
    async () => {
      const st = await status();
      return st.scoreboard && st.scoreboard.players.length >= 1;
    },
    10000,
    "the answer observer to join the lobby"
  );
  const started = await post("/api/mock/control", { pin, action: "start" });
  assert.equal(started.json.ok, true, JSON.stringify(started.json));

  const res = await resolving;
  assert.equal(res.json.ok, true, JSON.stringify(res.json));
  assert.equal(res.json.source, "live-pin");
  assert.equal(res.json.questions.length, 5);
  assert.deepEqual(res.json.questions[0].answer.indexes, [1], "Mars is the answer");
  assert.equal(res.json.questions[4].answer, null, "poll has no answer");

  const st = await status();
  assert.equal(st.answers.loaded, true);
  assert.equal(st.answers.answerable, 4);
  assert.equal(st.answers.questions.length, 5, "status carries the answer sheet");
  assert.deepEqual(st.answers.questions[0].answer.indexes, [1], "Mars in the status sheet");
  assert.equal(st.answers.questions[4].answer, null, "poll has no answer");
});

test("starts a bot swarm through the API", { timeout: 30000 }, async () => {
  const res = await post("/api/bots/start", {
    pin,
    count: 2,
    strategies: "correct,dumb",
    useAnswers: true,
  });
  assert.equal(res.json.ok, true, JSON.stringify(res.json));
  assert.equal(res.json.started, 2);

  await waitFor(
    async () => {
      const st = await status();
      return (
        st.bots &&
        st.bots.length === 2 &&
        st.bots.every((b) => ["lobby", "playing", "done"].includes(b.state))
      );
    },
    15000,
    "both bots to join"
  );

  const st = await status();
  assert.equal(st.bots.length, 2);
  assert.equal(st.answers.loaded, true, "answer book shared with the swarm");
  assert.ok(st.log.length > 0, "activity log has entries");
});

test("adjusts scores through the API", { timeout: 20000 }, async () => {
  const res = await post("/api/score", { pin, player: "Bot 1", add: 500 });
  assert.equal(res.json.ok, true, JSON.stringify(res.json));
  assert.equal(res.json.source, "test-host");
  assert.equal(res.json.score - res.json.previousScore, 500, "exact 500 point addition");

  const set = await post("/api/score", { pin, player: "Bot 2", set: 42 });
  assert.equal(set.json.ok, true, JSON.stringify(set.json));
  assert.equal(set.json.score, 42, "exact score set");

  const unknown = await post("/api/score", { pin, player: "Ghost", add: 10 });
  assert.equal(unknown.json.ok, false, "unknown player rejected");
  assert.ok(Array.isArray(unknown.json.players));

  const missingField = await post("/api/score", { pin, player: "Bot 1" });
  assert.equal(missingField.status, 400, "no operation -> 400");
});

test("controls the game lifecycle through the API", { timeout: 20000 }, async () => {
  const end = await post("/api/mock/control", { pin, action: "stop" });
  assert.equal(end.json.ok, true, JSON.stringify(end.json));
  await waitFor(async () => (await status()).phase === "ended", 10000, "game over");

  // stamp a known score while the game is over (nothing can score now), so
  // the reset below has a meaningful precondition
  const stamp = await post("/api/score", { pin, player: "Bot 2", set: 42 });
  assert.equal(stamp.json.ok, true, JSON.stringify(stamp.json));
  const before = await status();
  const bot2Before = before.scoreboard.players.find((p) => p.name === "Bot 2");
  assert.ok(bot2Before && bot2Before.score === 42, `Bot 2 sits at 42 (${JSON.stringify(before.scoreboard.players)})`);

  // reset reopens the lobby but keeps the room: connected players survive
  // with zeroed scores so a running swarm can play the next game
  const reset = await post("/api/mock/control", { pin, action: "reset" });
  assert.equal(reset.json.ok, true);
  const st = await status();
  assert.equal(st.phase, "lobby");
  assert.equal(st.scoreboard.players.length, 2, "reset keeps the connected players");
  assert.ok(
    st.scoreboard.players.every((p) => p.score === 0),
    `reset zeroes every score (${JSON.stringify(st.scoreboard.players)})`
  );

  // and a restarted game must be playable again: the same bots answer afresh
  // (regression: stale answeredIndices used to silence them after a reset)
  const started = await post("/api/mock/control", { pin, action: "start" });
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  await waitFor(
    async () => {
      const s = await status();
      return s.phase === "question" && s.questionIndex >= 1;
    },
    15000,
    "the second game to reach question 2"
  );
  const after = await status();
  const bot1 = after.bots && after.bots.find((b) => b.name === "Bot 1");
  assert.ok(bot1 && bot1.score > 0, `correct bot scores again in game 2 (${JSON.stringify(after.bots)})`);
  assert.ok(bot1.correct >= 1, `correct bot answered correctly again (${JSON.stringify(bot1)})`);
});

test("stops bots and the test host through the API", { timeout: 20000 }, async () => {
  const bots = await post("/api/bots/stop", { pin });
  assert.equal(bots.json.ok, true, JSON.stringify(bots.json));
  const afterBots = await status();
  assert.equal(afterBots.bots, null, "swarm gone");

  const host = await post("/api/mock/stop", { pin });
  assert.equal(host.json.ok, true, JSON.stringify(host.json));
  const afterHost = await status();
  assert.equal(afterHost.isTestHost, false, "test host gone");

  const again = await post("/api/mock/stop", { pin });
  assert.equal(again.json.ok, false, "stopping twice is an error");
});
