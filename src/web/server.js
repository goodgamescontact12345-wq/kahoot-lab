/**
 * kahoot-lab web UI server.
 *
 * Serves a single-page control panel plus a JSON API that wraps the existing
 * library (test host, answer resolution, bot swarms, score control). Binds to
 * loopback only - this is a local testing tool.
 *
 * API:
 *   GET  /api/health
 *   GET  /api/fixtures
 *   GET  /api/games
 *   GET  /api/status/:pin
 *   POST /api/mock/start    {fixture, questionTimeMs?, gapMs?, autoStartSec?, loop?}
 *   POST /api/mock/stop     {pin}
 *   POST /api/mock/control  {pin, action: start|next|reset|stop}
 *   POST /api/resolve       {pin?, title?, quizId?, waitSec?}
 *   POST /api/bots/start    {pin, count?, names?, pattern?, strategy?, strategies?, accuracy?, delayMs?, jitterMs?, useAnswers?}
 *   POST /api/bots/stop     {pin}
 *   POST /api/score         {pin, player, add?|remove?|set?}
 */

import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MockKahootServer } from "../host/mock-server.js";
import { loadQuiz } from "../host/quiz-loader.js";
import { resolveQuizAnswers } from "../answers/resolve.js";
import { startSwarm } from "../bots/swarm.js";
import { adjustScore, fetchScoreboard, probeTestHost } from "../scores/controller.js";

const UI_DIR = fileURLToPath(new URL("./ui/", import.meta.url));
const MOCK_FILE = path.join(".kahoot-lab", "mock.json");
const DEFAULT_HOST = "https://kahoot.it";
const DEFAULT_API = "https://create.kahoot.it";
const LOG_CAP = 200;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export class KahootLabServer {
  /**
   * @param {{port?:number, host?:string, fixturesDir?:string, quiet?:boolean}} [opts]
   */
  constructor(opts = {}) {
    this.port = opts.port ?? 4380;
    this.host = opts.host || "127.0.0.1";
    this.fixturesDir = opts.fixturesDir || "fixtures";
    this.quiet = Boolean(opts.quiet);

    /** @type {Map<string, {server:MockKahootServer, info:object, fixture:string}>} */
    this.mocks = new Map();
    /** @type {Map<string, import('../bots/swarm.js').Swarm>} */
    this.swarms = new Map();
    /** @type {Map<string, {quiz:object, answers:Array, source:string}>} */
    this.answerBooks = new Map();
    /** @type {Map<string, string[]>} */
    this.logs = new Map();

    this.server = http.createServer((req, res) => this.#handle(req, res));
  }

  /** @returns {Promise<{url:string, port:number}>} */
  start() {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        resolve({ url: `http://${this.host}:${this.port}`, port: this.port });
      });
    });
  }

  async close() {
    const closing = [];
    for (const swarm of this.swarms.values()) closing.push(swarm.stop().catch(() => {}));
    for (const entry of this.mocks.values()) closing.push(entry.server.close().catch(() => {}));
    await Promise.all(closing);
    this.swarms.clear();
    this.mocks.clear();
    await new Promise((resolve) => this.server.close(resolve));
  }

  log(pin, line) {
    const at = new Date().toLocaleTimeString();
    const entry = `[${at}] ${line}`;
    const buf = this.logs.get(pin) || [];
    buf.push(entry);
    if (buf.length > LOG_CAP) buf.splice(0, buf.length - LOG_CAP);
    this.logs.set(pin, buf);
    if (!this.quiet) console.log(`[${pin}] ${line}`);
  }

  /* ------------------------------------------------------------- routing */

  async #handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (pathname.startsWith("/api/")) return await this.#api(req, res, url);
      return await this.#static(req, res, pathname);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      this.#json(res, status, {
        ok: false,
        error: String((err && err.message) || err),
      });
    }
  }

  async #static(req, res, pathname) {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.normalize(path.join(UI_DIR, rel));
    if (!file.startsWith(path.normalize(UI_DIR))) {
      return this.#json(res, 403, { ok: false, error: "forbidden" });
    }
    if (!existsSync(file)) {
      return this.#json(res, 404, { ok: false, error: "not found" });
    }
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  #json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  async #body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw Object.assign(new Error("body too large"), { status: 413 });
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Object.assign(new Error("invalid JSON body"), { status: 400 });
    }
  }

  async #api(req, res, url) {
    const route = `${req.method} ${url.pathname.replace(/\/+$/, "") || "/"}`;
    const body = req.method === "POST" ? await this.#body(req) : {};

    switch (route) {
      case "GET /api/health":
        return this.#json(res, 200, { ok: true, mocks: this.mocks.size, swarms: this.swarms.size });

      case "GET /api/fixtures":
        return this.#json(res, 200, { ok: true, fixtures: await this.#listFixtures() });

      case "GET /api/games":
        return this.#json(res, 200, { ok: true, games: this.#games() });

      case "POST /api/mock/start":
        return this.#json(res, 200, await this.#mockStart(body));

      case "POST /api/mock/stop":
        return this.#json(res, 200, await this.#mockStop(body));

      case "POST /api/mock/control":
        return this.#json(res, 200, await this.#mockControl(body));

      case "POST /api/resolve":
        return this.#json(res, 200, await this.#resolve(body));

      case "POST /api/bots/start":
        return this.#json(res, 200, await this.#botsStart(body));

      case "POST /api/bots/stop":
        return this.#json(res, 200, await this.#botsStop(body));

      case "POST /api/score":
        return this.#json(res, 200, await this.#score(body));

      default:
        if (url.pathname.startsWith("/api/status/")) {
          const pin = url.pathname.split("/").pop().replace(/\D/g, "");
          return this.#json(res, 200, await this.#status(pin));
        }
        return this.#json(res, 404, { ok: false, error: `unknown route: ${route}` });
    }
  }

  /* --------------------------------------------------------------- mocks */

  async #listFixtures() {
    try {
      const files = await readdir(this.fixturesDir);
      return files.filter((f) => f.endsWith(".json")).sort();
    } catch {
      return [];
    }
  }

  async #mockStart(body) {
    const fixtureName = body.fixture || "demo-quiz.json";
    const fixturePath = path.isAbsolute(fixtureName)
      ? fixtureName
      : path.join(this.fixturesDir, path.basename(fixtureName));
    const quiz = await loadQuiz(fixturePath);

    // one test host at a time keeps the UI unambiguous
    if (this.mocks.size) await this.#mockStop({ pin: [...this.mocks.keys()][0] });

    const autoStartSec = body.autoStartSec === undefined ? 3 : Number(body.autoStartSec);
    const server = new MockKahootServer({
      quiz,
      questionTimeMs: body.questionTimeMs ? Number(body.questionTimeMs) : null,
      questionGapMs: body.gapMs ? Number(body.gapMs) : 1200,
      autoStartMs: Number.isFinite(autoStartSec) && autoStartSec > 0 ? autoStartSec * 1000 : null,
      log: (line) => this.log(server.pin, line),
    });
    const info = await server.start();
    this.mocks.set(info.pin, { server, info, fixture: fixtureName });
    this.log(info.pin, `test host started: "${quiz.title}" on ${info.baseUrl}`);

    if (body.loop && Number.isFinite(autoStartSec) && autoStartSec > 0) {
      // keep games rolling: reopen the lobby shortly after each finish and,
      // while the room still has players, kick off the next game right away
      let scheduling = false;
      const loopTimer = setInterval(() => {
        const entry = this.mocks.get(info.pin);
        if (!entry) return clearInterval(loopTimer);
        if (scheduling || entry.server.snapshot().phase !== "ended") return;
        scheduling = true;
        setTimeout(() => {
          scheduling = false;
          const current = this.mocks.get(info.pin);
          if (!current) return;
          try {
            current.server.reset();
            if (current.server.snapshot().players.length > 0) {
              current.server.startGame();
              this.log(info.pin, "loop: next game started");
            } else {
              this.log(info.pin, "loop: lobby reopened");
            }
          } catch { /* ignore */ }
        }, 3000);
      }, 1000);
      server.onClose = () => clearInterval(loopTimer);
    }

    return { ok: true, pin: info.pin, baseUrl: info.baseUrl, quiz: quiz.title, fixture: fixtureName };
  }

  async #mockStop(body) {
    const pin = String(body.pin || "").replace(/\D/g, "");
    const entry = this.mocks.get(pin);
    if (!entry) return { ok: false, error: `no test host for PIN ${pin || "?"}` };
    await entry.server.close();
    this.mocks.delete(pin);
    if (typeof entry.server.onClose === "function") entry.server.onClose();
    this.log(pin, "test host stopped");
    return { ok: true, pin };
  }

  async #mockControl(body) {
    const pin = String(body.pin || "").replace(/\D/g, "");
    const entry = this.mocks.get(pin);
    if (!entry) return { ok: false, error: `no test host for PIN ${pin || "?"}` };
    const action = body.action;
    const server = entry.server;
    try {
      if (action === "start") server.startGame();
      else if (action === "next") server.advance();
      else if (action === "reset") server.reset();
      else if (action === "stop") server.endGame();
      else return { ok: false, error: `unknown action: ${action}` };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
    return { ok: true, pin, action, phase: server.snapshot().phase };
  }

  /* ------------------------------------------------------------ resolution */

  /**
   * Which base URL should be used for this PIN (in-memory test host first,
   * then a test host started outside this process, then real Kahoot).
   * @param {string} pin
   */
  async hostFor(pin) {
    const entry = this.mocks.get(pin);
    if (entry) return entry.info.baseUrl;
    if (pin && existsSync(MOCK_FILE)) {
      try {
        const mock = JSON.parse(readFileSync(MOCK_FILE, "utf8"));
        if (mock.pin === pin && (await probeTestHost(mock.baseUrl))) return mock.baseUrl;
      } catch { /* stale */ }
    }
    return DEFAULT_HOST;
  }

  async apiFor(baseUrl) {
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(baseUrl);
    return isLocal ? baseUrl : DEFAULT_API;
  }

  async #resolve(body) {
    const pin = body.pin ? String(body.pin).replace(/\D/g, "") : undefined;
    const waitSec = Number.isFinite(Number(body.waitSec)) ? Number(body.waitSec) : 45;
    if (!pin && !body.title && !body.quizId) {
      throw Object.assign(new Error("give a PIN, title or quiz id"), { status: 400 });
    }
    const baseUrl = pin ? await this.hostFor(pin) : DEFAULT_HOST;
    const apiBase = await this.apiFor(baseUrl);

    const result = await resolveQuizAnswers({
      pin,
      quizId: body.quizId || undefined,
      quizTitle: body.title || undefined,
      baseUrl,
      apiBase,
      waitMs: waitSec * 1000,
      log: (line) => pin && this.log(pin, line),
    });
    if (pin) this.answerBooks.set(pin, { quiz: result.quiz, answers: result.answers, source: result.source });
    if (pin) this.#pushAnswersToSwarm(pin, result.answers);
    return {
      ok: true,
      pin,
      source: result.source,
      title: result.quiz.title,
      questions: this.#sheetFor(result.quiz, result.answers),
    };
  }

  /** Answer-sheet payload shared by /api/resolve and /api/status. */
  #sheetFor(quiz, answers) {
    return (quiz.questions || []).map((q, i) => ({
      index: i + 1,
      question: q.question,
      type: q.type,
      time: q.time,
      pointsMultiplier: q.pointsMultiplier,
      choices: (q.choices || []).map((c) => c.answer),
      answer: serializeAnswer(answers[i], q),
    }));
  }

  /* ----------------------------------------------------------------- bots */

  async #botsStart(body) {
    const pin = String(body.pin || "").replace(/\D/g, "");
    if (!pin) throw Object.assign(new Error("game PIN is required"), { status: 400 });
    if (this.swarms.has(pin)) return { ok: true, pin, alreadyRunning: true };

    const baseUrl = await this.hostFor(pin);
    const names = body.names
      ? String(body.names).split(",").map((s) => s.trim()).filter(Boolean)
      : null;

    const swarm = await startSwarm({
      pin,
      baseUrl,
      count: Math.max(1, Math.min(100, Number(body.count) || 1)),
      names,
      pattern: body.pattern || "{name} {i}",
      strategy: body.strategy || "correct",
      strategies: body.strategies || null,
      accuracy: body.accuracy === undefined ? 1 : Number(body.accuracy),
      delayMs: body.delayMs === undefined ? 600 : Number(body.delayMs),
      jitterMs: body.jitterMs === undefined ? 800 : Number(body.jitterMs),
      staggerMs: body.staggerMs === undefined ? 350 : Number(body.staggerMs),
      answers: null,
      ctl: true,
      log: (line) => this.log(pin, line),
    });
    this.swarms.set(pin, swarm);

    for (const evt of ["answered", "questionEnd", "gameOver", "kicked", "botError", "scorePlan"]) {
      swarm.on(evt, (payload) => {
        if (evt === "questionEnd") {
          this.log(pin, `${payload.name}: Q${(payload.questionIndex ?? -1) + 1} ${payload.isCorrect ? "correct" : "wrong"} -> ${payload.totalScore} (${payload.rank})`);
        } else if (evt === "botError") {
          this.log(pin, `! ${payload.name}: ${payload.error}`);
        } else if (evt === "gameOver") {
          this.log(pin, `game over - ${payload.name}: ${payload.score} points (rank ${payload.rank})`);
        } else if (evt === "scorePlan") {
          this.log(pin, `score plan: ${payload.message || JSON.stringify(payload)}`);
        } else if (evt === "kicked") {
          this.log(pin, `${payload.name} was kicked`);
        }
      });
    }

    const joined = swarm.bots.filter((b) => b.state === "lobby" || b.state === "playing").length;
    this.log(pin, `${joined}/${swarm.bots.length} bots joined`);

    // resolve answers in the background and push them to every bot
    if (body.useAnswers !== false && body.useAnswers !== "false" && !this.answerBooks.has(pin)) {
      this.#backgroundAnswers(pin, baseUrl, body);
    } else if (this.answerBooks.has(pin)) {
      swarm.setAnswers(this.answerBooks.get(pin).answers);
    }

    return { ok: true, pin, started: swarm.bots.length, joined, baseUrl };
  }

  #backgroundAnswers(pin, baseUrl, body) {
    this.apiFor(baseUrl)
      .then((apiBase) =>
        resolveQuizAnswers({
          pin,
          quizId: body.quizId || undefined,
          quizTitle: body.title || undefined,
          baseUrl,
          apiBase,
          waitMs: (Number(body.waitSec) || 45) * 1000,
          log: (line) => this.log(pin, line),
        })
      )
      .then((result) => {
        this.answerBooks.set(pin, { quiz: result.quiz, answers: result.answers, source: result.source });
        this.#pushAnswersToSwarm(pin, result.answers);
        this.log(pin, `answers loaded: "${result.quiz.title}"`);
      })
      .catch((err) => this.log(pin, `answers unavailable: ${err.message}`));
  }

  #pushAnswersToSwarm(pin, answers) {
    const swarm = this.swarms.get(pin);
    if (swarm) swarm.setAnswers(answers);
  }

  async #botsStop(body) {
    const pin = String(body.pin || "").replace(/\D/g, "");
    const swarm = this.swarms.get(pin);
    if (!swarm) return { ok: false, error: `no running bots for PIN ${pin || "?"}` };
    await swarm.stop();
    this.swarms.delete(pin);
    this.log(pin, "bots stopped");
    return { ok: true, pin };
  }

  /* ---------------------------------------------------------------- score */

  async #score(body) {
    const pin = String(body.pin || "").replace(/\D/g, "");
    const player = body.player;
    if (!player) throw Object.assign(new Error("player name is required"), { status: 400 });
    const op = {};
    if (body.add !== undefined && body.add !== null && body.add !== "") op.add = Number(body.add);
    if (body.remove !== undefined && body.remove !== null && body.remove !== "") op.remove = Number(body.remove);
    if (body.set !== undefined && body.set !== null && body.set !== "") op.set = Number(body.set);
    if (!Object.keys(op).length) {
      throw Object.assign(new Error("give add, remove or set"), { status: 400 });
    }
    for (const [key, value] of Object.entries(op)) {
      if (!Number.isFinite(value)) {
        throw Object.assign(new Error(`${key} must be a number`), { status: 400 });
      }
    }

    // 1) shared controller: local test host first (exact, instant), then the
    //    swarm control endpoint - same precedence as the CLI
    const baseUrl = await this.hostFor(pin);
    let result = await adjustScore({ pin, player, ...op, baseUrl });

    // 2) fallback: in-process swarm without a control file
    if (!result.ok && this.swarms.has(pin)) {
      const swarm = this.swarms.get(pin);
      if (swarm.find(player)) {
        const direct = await swarm.adjust(player, op);
        if (direct.ok) result = { ...direct, source: "swarm" };
      }
    }

    if (result.ok) this.log(pin, `score ${result.name || player}: ${result.message || JSON.stringify(op)}`);
    else this.log(pin, `score failed: ${result.error}`);
    return result;
  }

  /* --------------------------------------------------------------- status */

  #games() {
    const pins = new Set([...this.mocks.keys(), ...this.swarms.keys()]);
    return [...pins].map((pin) => ({
      pin,
      mock: this.mocks.has(pin),
      bots: this.swarms.has(pin),
      answers: this.answerBooks.has(pin),
    }));
  }

  async #status(pin) {
    const baseUrl = this.mocks.get(pin)?.info.baseUrl || (await this.hostFor(pin));
    const [scoreboard, probe] = await Promise.all([
      fetchScoreboard({ pin, baseUrl }).catch(() => null),
      pin ? probeTestHost(baseUrl).catch(() => null) : Promise.resolve(null),
    ]);
    const swarm = this.swarms.get(pin);
    const answers = this.answerBooks.get(pin);
    return {
      ok: true,
      pin,
      baseUrl,
      isTestHost: Boolean(probe && probe.pin === pin),
      phase: probe ? probe.phase : null,
      questionIndex: probe ? probe.questionIndex : null,
      quiz: probe ? probe.quiz : null,
      scoreboard,
      bots: swarm ? swarm.status() : null,
      answers: answers
        ? {
            loaded: true,
            title: answers.quiz.title,
            source: answers.source,
            answerable: answers.answers.filter(Boolean).length,
            total: answers.answers.length,
            questions: this.#sheetFor(answers.quiz, answers.answers),
          }
        : { loaded: false },
      log: (this.logs.get(pin) || []).slice(-100),
    };
  }
}

function serializeAnswer(plan, question) {
  if (!plan) return null;
  if (plan.order) {
    return { type: "jumble", order: plan.order.map((i) => (question.choices[i] || {}).answer) };
  }
  const indexes = plan.choices || [plan.choice];
  return {
    type: plan.type,
    indexes,
    choices: indexes.map((i) => (question.choices[i] || {}).answer),
  };
}

/**
 * @param {ConstructorParameters<typeof KahootLabServer>[0]} [opts]
 * @returns {Promise<KahootLabServer & {url:string}>}
 */
export async function startKahootLabServer(opts = {}) {
  const server = new KahootLabServer(opts);
  const { url, port } = await server.start();
  return Object.assign(server, { url, port });
}
