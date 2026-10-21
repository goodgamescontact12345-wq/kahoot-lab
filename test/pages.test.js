/**
 * Tests for the static (GitHub Pages) edition: the in-browser demo engine
 * that stands in for the Node API, and the site build script.
 *
 * The demo engine is a plain browser script, but it only touches
 * globalThis/timers, so it loads cleanly in Node for black-box testing
 * through the same `handle(method, path, body)` surface the UI calls.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

// the engine attaches itself to globalThis when imported (side-effect module)
await import("../src/web/ui/demo-engine.js");
const demo = globalThis.KahootLabDemo;
const FIXTURE = JSON.parse(await readFile(path.join(ROOT, "fixtures", "demo-quiz.json"), "utf8"));
globalThis.__DEMO_FIXTURES__ = { "demo-quiz.json": FIXTURE };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pin = "";

after(() => {
  // make sure no demo timers outlive the suite
  for (const p of [...demo.engine.games.keys()]) {
    demo.engine.games.get(p).close();
    demo.engine.games.delete(p);
  }
});

test("demo engine: health + fixtures", async () => {
  const health = await demo.handle("GET", "/api/health");
  assert.equal(health.ok, true);
  assert.equal(health.demo, true);

  const fixtures = await demo.handle("GET", "/api/fixtures");
  assert.deepEqual(fixtures.fixtures, ["demo-quiz.json"]);
});

test("demo engine: unknown routes and validation errors", async () => {
  assert.equal((await demo.handle("GET", "/api/nope")).ok, false);
  assert.equal((await demo.handle("POST", "/api/resolve", {})).ok, false);
  assert.equal((await demo.handle("POST", "/api/bots/start", {})).ok, false);
  assert.equal((await demo.handle("POST", "/api/score", { pin: "1", player: "x" })).ok, false);
});

test("demo engine: full game — host, bots, scoring, score edits, reset", async () => {
  const start = await demo.handle("POST", "/api/mock/start", {
    fixture: "demo-quiz.json",
    autoStartSec: 0, // manual start keeps the test deterministic
    questionTimeMs: 300,
    gapMs: 50,
  });
  assert.equal(start.ok, true, JSON.stringify(start));
  pin = start.pin;
  assert.match(pin, /^\d{7}$/);
  assert.equal(start.quiz, FIXTURE.title);

  // one host at a time: a second start replaces the first
  const start2 = await demo.handle("POST", "/api/mock/start", { fixture: "demo-quiz.json", autoStartSec: 0, questionTimeMs: 300, gapMs: 50 });
  assert.equal(start2.ok, true);
  pin = start2.pin;

  let st = await demo.handle("GET", `/api/status/${pin}`);
  assert.equal(st.isTestHost, true);
  assert.equal(st.phase, "lobby");
  assert.equal(st.scoreboard.players.length, 0);

  // start bots: correct bots use the answers, a dumb one never does
  const bots = await demo.handle("POST", "/api/bots/start", {
    pin,
    count: 3,
    strategies: "correct,correct,dumb",
    pattern: "Bot {i}",
    useAnswers: true,
  });
  assert.equal(bots.ok, true, JSON.stringify(bots));
  assert.equal(bots.started, 3);

  st = await demo.handle("GET", `/api/status/${pin}`);
  assert.equal(st.bots.length, 3);
  assert.equal(st.bots.every((b) => b.state === "lobby"), true);
  assert.equal(st.answers.loaded, true);
  assert.equal(st.answers.answerable, 4, "4 of 5 demo questions have a correct answer (poll has none)");

  // bots swarm is idempotent
  assert.equal((await demo.handle("POST", "/api/bots/start", { pin })).alreadyRunning, true);

  // play through the quiz
  await demo.handle("POST", "/api/mock/control", { pin, action: "start" });
  st = await demo.handle("GET", `/api/status/${pin}`);
  assert.equal(st.phase, "question");

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    st = await demo.handle("GET", `/api/status/${pin}`);
    if (st.phase === "ended") break;
    await sleep(100);
  }
  assert.equal(st.phase, "ended", "game runs to completion");

  const players = st.scoreboard.players;
  assert.equal(players.length, 3);
  const correct = players.filter((p) => p.name !== "Bot 3");
  const dumb = players.find((p) => p.name === "Bot 3");
  for (const p of correct) {
    assert.ok(p.score > 0, `${p.name} scored (${p.score})`);
    assert.equal(p.correct, 4, `${p.name} got all 4 answerable questions right`);
  }
  assert.equal(dumb.score, 0, "dumb strategy never scores");
  assert.equal(players[0].rank, 1, "ranks assigned");

  // exact score edits (test-host semantics)
  const set = await demo.handle("POST", "/api/score", { pin, player: "Bot 1", set: 4200 });
  assert.equal(set.ok, true);
  assert.equal(set.score, 4200);
  assert.equal(set.message, "Bot 1: " + set.previousScore + " -> 4200");

  const add = await demo.handle("POST", "/api/score", { pin, player: "bot 2", add: 150 });
  assert.equal(add.ok, true, "player lookup is case-insensitive");

  const missing = await demo.handle("POST", "/api/score", { pin, player: "Nobody", add: 100 });
  assert.equal(missing.ok, false);
  assert.ok(missing.players.includes("Bot 1"));

  // reset reopens the lobby but keeps the room
  await demo.handle("POST", "/api/mock/control", { pin, action: "reset" });
  st = await demo.handle("GET", `/api/status/${pin}`);
  assert.equal(st.phase, "lobby");
  assert.equal(st.scoreboard.players.length, 3, "reset keeps the players");
  assert.equal(st.scoreboard.players.every((p) => p.score === 0), true, "reset zeroes scores");

  // stop bots + host through the API
  const stopBots = await demo.handle("POST", "/api/bots/stop", { pin });
  assert.equal(stopBots.ok, true);
  st = await demo.handle("GET", `/api/status/${pin}`);
  assert.equal(st.bots, null);

  const stopHost = await demo.handle("POST", "/api/mock/stop", { pin });
  assert.equal(stopHost.ok, true);
  st = await demo.handle("GET", `/api/status/${pin}`);
  assert.equal(st.isTestHost, false);

  const again = await demo.handle("POST", "/api/mock/stop", { pin });
  assert.equal(again.ok, false, "stopping twice is an error");
});

test("demo engine: resolve without a host serves the bundled fixture", async () => {
  const res = await demo.handle("POST", "/api/resolve", { title: "anything" });
  assert.equal(res.ok, true);
  assert.equal(res.title, FIXTURE.title);
  assert.equal(res.questions.length, FIXTURE.questions.length);
  const q1 = res.questions[0];
  assert.equal(q1.choices.length, 4);
  assert.equal(q1.answer.choices.includes("Mars"), true, "correct answer revealed");
});

test("demo engine: bots auto-create a room for an unknown PIN", async () => {
  const pin2 = "7654321";
  const res = await demo.handle("POST", "/api/bots/start", { pin: pin2, count: 1 });
  assert.equal(res.ok, true);
  const st = await demo.handle("GET", `/api/status/${pin2}`);
  assert.equal(st.isTestHost, true, "simulated room created");
  assert.equal(st.bots.length, 1);
  demo.engine.games.get(pin2).close();
  demo.engine.games.delete(pin2);
});

test("build-pages: emits a self-contained static site", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kl-pages-"));
  try {
    await run(process.execPath, ["scripts/build-pages.mjs", "--out", dir], { cwd: ROOT });

    const files = (await readdir(dir)).sort();
    for (const expected of [".nojekyll", "app.css", "app.js", "demo-boot.js", "demo-engine.js", "demo-fixtures.js", "index.html"]) {
      assert.ok(files.includes(expected), `site/ contains ${expected} (got: ${files.join(", ")})`);
    }

    const html = await readFile(path.join(dir, "index.html"), "utf8");
    assert.match(html, /href="app\.css"/, "asset paths are relative (Pages serves under /<repo>/)");
    assert.doesNotMatch(html, /href="\/app\.css"/);
    assert.match(html, /window\.__KAHOOT_LAB_DEMO__ = true/);
    // demo backend must load before app.js fetches /api/*
    assert.ok(html.indexOf("demo-engine.js") < html.indexOf('src="app.js"'));
    assert.doesNotMatch(html, /href="\/api\/health"/);

    // UI assets are byte-identical with the ones the local server serves
    for (const f of ["app.css", "app.js", "demo-engine.js", "demo-boot.js"]) {
      const built = await readFile(path.join(dir, f), "utf8");
      const source = await readFile(path.join(ROOT, "src", "web", "ui", f), "utf8");
      assert.equal(built, source, `${f} copied unchanged`);
    }

    const bundle = await readFile(path.join(dir, "demo-fixtures.js"), "utf8");
    const sandbox = {};
    new Function("window", bundle)(sandbox);
    assert.equal(sandbox.__DEMO_FIXTURES__["demo-quiz.json"].title, FIXTURE.title);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
