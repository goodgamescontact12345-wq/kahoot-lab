/**
 * End-to-end test of the whole utility against the local Kahoot-compatible
 * test host: reserve/session -> cometd join -> answers -> bots playing a full
 * game -> score editing -> CLI commands.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { MockKahootServer } from "../src/host/mock-server.js";
import { loadQuiz } from "../src/host/quiz-loader.js";
import { reserveSession, websocketUrls } from "../src/protocol/session.js";
import { CometClient } from "../src/protocol/comet.js";
import { loginPacket, joinVerifyPacket } from "../src/protocol/packets.js";
import { resolveQuizAnswers } from "../src/answers/resolve.js";
import { startSwarm, readCtl, ctlRequest } from "../src/bots/swarm.js";
import { adjustScore, fetchScoreboard, probeTestHost } from "../src/scores/controller.js";

const quiz = await loadQuiz("fixtures/demo-quiz.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {MockKahootServer} */
let server;
let info;
let swarm = null;
let resolvedAnswers = null;
let humanClient = null;

before(async () => {
  server = new MockKahootServer({
    quiz,
    questionTimeMs: 900,
    questionGapMs: 500,
    autoStartMs: null,
    connectDelayMs: 100,
  });
  info = await server.start();
});

after(async () => {
  if (swarm) await swarm.stop();
  if (humanClient) humanClient.close();
  await server.close();
});

function waitPhase(phase, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (server.snapshot().phase === phase) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for phase "${phase}" (currently ${server.snapshot().phase})`));
      }
    }, 50);
  });
}

function runCli(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/kahoot-lab.js", ...args], { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test("reserve session + cometd handshake", { timeout: 20000 }, async () => {
  const reserved = await reserveSession(info.pin, { baseUrl: info.baseUrl });
  assert.equal(reserved.pin, info.pin);
  assert.ok(reserved.sessionId, "session token derived from the challenge");
  const client = new CometClient({ urls: websocketUrls(reserved) });
  await client.open();
  assert.ok(client.clientId, "cometd clientId assigned");
  assert.equal(client.connected, true, "first /meta/connect acknowledged");
  client.close();
});

test("invalid PIN is reported clearly", { timeout: 15000 }, async () => {
  await assert.rejects(
    () => reserveSession("1234567", { baseUrl: info.baseUrl }),
    /not found/
  );
});

test("solve: PIN -> join -> quizStart -> answers", { timeout: 30000 }, async () => {
  const resolving = resolveQuizAnswers({
    pin: info.pin,
    baseUrl: info.baseUrl,
    apiBase: info.baseUrl,
    waitMs: 15000,
    observerName: "Answer Scout",
  });
  await sleep(500); // let the observer join the lobby
  server.startGame();

  const result = await resolving;
  resolvedAnswers = result.answers;
  assert.equal(result.source, "live-pin");
  assert.equal(result.quiz.title, quiz.title);
  assert.equal(result.answers.length, 5);
  assert.equal(result.answers[0].choice, 1, "Mars");
  assert.deepEqual(result.answers[2].choices, [0, 2]);
  assert.equal(result.answers[4], null, "poll has no answer");
});

test("bots join, play a full game and hit a planned score", { timeout: 60000 }, async () => {
  server.reset(); // back to a clean lobby
  assert.equal(server.snapshot().phase, "lobby");

  swarm = await startSwarm({
    pin: info.pin,
    baseUrl: info.baseUrl,
    names: ["Fast Bot", "Dumb Bot", "Plan Bot", "Cruise Bot"],
    strategies: ["correct", "dumb", "correct", "correct"],
    answers: resolvedAnswers,
    staggerMs: 150,
    ctl: true,
    delayMs: 300,
    jitterMs: 100,
  });
  const joined = swarm.bots.filter((b) => b.state === "lobby");
  assert.equal(joined.length, 4, `all bots should join (${swarm.bots.map((b) => b.error).join("; ")})`);

  // the control endpoint that `kahoot-lab score` / `watch` talk to
  const ctl = readCtl(info.pin);
  assert.ok(ctl, "control file published");
  const pong = await ctlRequest(ctl, { cmd: "ping" });
  assert.equal(pong.ok, true);
  assert.equal(pong.bots, 4);

  // a plain (human-like) participant joins - not controlled by any swarm
  humanClient = await joinRaw(info.pin, info.baseUrl, "Human Player");

  // score target set before the quiz starts -> queued until quizStart
  const deferred = await swarm.adjust("Plan Bot", { set: 2500 });
  assert.equal(deferred.deferred, true, JSON.stringify(deferred));

  // rebuild Fast Bot mid-game: lower its score after question 1
  let rebuildResult = null;
  swarm.on("questionEnd", (evt) => {
    if (evt.name === "Fast Bot" && evt.questionIndex === 0 && !rebuildResult) {
      rebuildResult = swarm
        .adjust("Fast Bot", { set: 600 })
        .catch((err) => ({ ok: false, error: String(err) }));
    }
  });

  server.startGame();
  await waitPhase("ended", 45000);
  assert.notEqual(rebuildResult, null, "the mid-game rebuild was triggered");
  rebuildResult = await rebuildResult;
  assert.equal(rebuildResult.ok, true, JSON.stringify(rebuildResult));
  assert.equal(rebuildResult.rebuilt, true, "lowering a score requires a fresh session");

  const state = server.snapshot();
  const scores = Object.fromEntries(state.players.map((p) => [p.name, p.score]));

  // planned score lands within tolerance of the target
  assert.ok(
    Math.abs(scores["Plan Bot"] - 2500) <= 60,
    `Plan Bot ${scores["Plan Bot"]} vs target 2500`
  );
  // rebuild target 600 -> closest achievable bank was 667 (overshoot reported)
  assert.ok(
    Math.abs(scores["Fast Bot"] - 667) <= 120,
    `Fast Bot ${scores["Fast Bot"]} vs expected ~667`
  );
  assert.equal(scores["Dumb Bot"], 0, "always-first-choice answers score nothing");
  assert.ok(scores["Cruise Bot"] >= 3800, `Cruise Bot ${scores["Cruise Bot"]}`);
  assert.equal(scores["Human Player"], 0, "the human never answered");
});

test("score: test host can add/remove/set points for anyone", { timeout: 20000 }, async () => {
  let res = await adjustScore({ pin: info.pin, player: "Human Player", add: 500, baseUrl: info.baseUrl });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.source, "test-host");
  assert.equal(res.score, 500);

  res = await adjustScore({ pin: info.pin, player: "Human Player", remove: 200, baseUrl: info.baseUrl });
  assert.equal(res.score, 300);

  res = await adjustScore({ pin: info.pin, player: "Human Player", set: 42, baseUrl: info.baseUrl });
  assert.equal(res.score, 42);

  res = await adjustScore({ pin: info.pin, player: "Human Player", add: -50, baseUrl: info.baseUrl });
  assert.equal(res.ok, true, "negative add still works");
  assert.equal(res.score, 42 - 50 < 0 ? 0 : 42 - 50, "floored at zero");

  res = await adjustScore({ pin: info.pin, player: "Ghost", add: 10, baseUrl: info.baseUrl });
  assert.equal(res.ok, false, "unknown player is rejected");
  assert.ok(Array.isArray(res.players) && res.players.includes("Plan Bot"));
});

test("score: swarm reports honestly when points cannot be added", { timeout: 20000 }, async () => {
  const ctl = readCtl(info.pin);
  assert.ok(ctl);
  // no questions left -> the addition is impossible and must be reported
  const res = await ctlRequest(ctl, { cmd: "adjust", name: "Dumb Bot", add: 700 });
  assert.equal(res.ok, true);
  assert.equal(res.feasible, false);
  assert.ok(res.shortfall >= 700, JSON.stringify(res));

  // bots only: humans are not controllable through the live protocol
  const viaController = await adjustScore({
    pin: info.pin,
    player: "Human Player",
    add: 10,
    baseUrl: "https://kahoot.it", // pretend there is no test host around
  });
  assert.equal(viaController.ok, false, "without a test host, humans cannot be edited");
  assert.match(viaController.error, /not one of my bots|no running swarm/i);
});

test("scoreboard is visible to watch/controller", { timeout: 15000 }, async () => {
  const board = await fetchScoreboard({ pin: info.pin, baseUrl: info.baseUrl });
  assert.ok(board);
  assert.equal(board.source, "test-host");
  assert.equal(board.players.length, 5, "4 bots + human");
  assert.ok(board.players.every((p) => typeof p.rank === "number"));

  const state = await probeTestHost(info.baseUrl);
  assert.equal(state.pin, info.pin);
});

test("CLI: solve / score / watch against the test host", { timeout: 60000 }, async () => {
  const solved = await runCli(["solve", info.pin, "--host", info.baseUrl, "--json"]);
  assert.equal(solved.code, 0, solved.stderr || solved.stdout);
  const sheet = JSON.parse(solved.stdout);
  assert.equal(sheet.questions.length, 5);
  assert.equal(sheet.questions[0].answer.indexes[0], 1, "CLI shows Mars as the answer");
  assert.equal(sheet.questions[4].answer, null, "poll shown as unanswerable");

  const scored = await runCli([
    "score", info.pin,
    "--player", "Human Player",
    "--set", "100",
    "--host", info.baseUrl,
    "--json",
  ]);
  assert.equal(scored.code, 0, scored.stderr || scored.stdout);
  assert.equal(JSON.parse(scored.stdout).score, 100);

  const watched = await runCli(["watch", info.pin, "--once", "--host", info.baseUrl, "--json"]);
  assert.equal(watched.code, 0, watched.stderr || watched.stdout);
  const board = JSON.parse(watched.stdout);
  const human = board.players.find((p) => p.name === "Human Player");
  assert.equal(human.score, 100);
});

test("CLI: quiz search + fetch round trip", { timeout: 30000 }, async () => {
  const searched = await runCli(["quiz", "search", "Demo", "--host", info.baseUrl, "--json"]);
  assert.equal(searched.code, 0, searched.stderr || searched.stdout);
  const results = JSON.parse(searched.stdout);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, quiz.title);

  const fetched = await runCli(["quiz", "fetch", results[0].uuid, "--host", info.baseUrl, "--json"]);
  assert.equal(fetched.code, 0, fetched.stderr || fetched.stdout);
  const fixture = JSON.parse(fetched.stdout);
  assert.equal(fixture.questions.length, 5);
  assert.equal(fixture.questions[0].choices[1].correct, true);
});

test("swarm shutdown removes its control file", { timeout: 15000 }, async () => {
  await swarm.stop();
  assert.equal(readCtl(info.pin), null, "control file cleaned up");
  swarm = null;
});

/* ------------------------------------------------------------------ utils */

/**
 * Join the test host with a bare cometd client (a "human" participant).
 * @param {string} pin
 * @param {string} baseUrl
 * @param {string} name
 * @returns {Promise<CometClient>}
 */
async function joinRaw(pin, baseUrl, name) {
  const reserved = await reserveSession(pin, { baseUrl });
  const client = new CometClient({ urls: websocketUrls(reserved) });
  await client.open();
  const ack = await client.publish(loginPacket({ gameid: pin, name, userAgent: "human" }), {
    expectAck: true,
  });
  assert.ok(ack && ack.data && !ack.data.error, JSON.stringify(ack));
  await client.publish(joinVerifyPacket({ gameid: pin }));
  return client;
}
