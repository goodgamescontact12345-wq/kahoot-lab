/**
 * kahoot·lab demo engine — the browser-side backend for the static
 * (GitHub Pages) build of the console.
 *
 * GitHub Pages can only serve static files, and Kahoot's own APIs refuse
 * cross-origin browser calls (no CORS headers for third-party origins), so
 * the hosted console runs a faithful *simulation* instead: an in-memory test
 * host, a bot swarm with every strategy from the CLI, and Kahoot's classic
 * scoring formula. The UI (app.js) is untouched — demo-boot.js shims
 * window.fetch so its /api/* calls land here.
 *
 * The file is loaded as a classic <script> in the browser and as an ES module
 * side-effect import in the test-suite (it attaches to globalThis).
 */
(function (global) {
  "use strict";

  /* ----------------------------------------------------------- fixtures */

  /** Bundled quiz fixtures, injected by the build as window.__DEMO_FIXTURES__. */
  function fixtures() {
    return global.__DEMO_FIXTURES__ || {};
  }

  function firstFixtureName() {
    const names = Object.keys(fixtures());
    return names[0] || null;
  }

  /* ------------------------------------------------------------- math */

  const SCORABLE = new Set(["quiz", "true_false", "multiple_select_quiz", "jumble"]);

  /** Kahoot's classic formula (same as src/scores/scoring.js). */
  function pointsFor({ elapsedMs, timeMs, pointsMultiplier }) {
    const t = Math.max(0, Math.min(timeMs, elapsedMs));
    return Math.round((1 - t / (2 * timeMs)) * 1000) * (pointsMultiplier || 1);
  }

  function correctIndexes(q) {
    if (q.type === "jumble") return q.choices.map((_, i) => i);
    return q.choices.reduce((acc, c, i) => (c.correct ? (acc.push(i), acc) : acc), []);
  }

  function gradeAnswer(q, content) {
    const type = q.type || "quiz";
    if (type === "jumble") {
      const choice = Array.isArray(content.choice) ? content.choice.map(Number) : null;
      const expected = q.choices.map((_, i) => i);
      return Boolean(choice && choice.join(",") === expected.join(","));
    }
    if (type === "multiple_select_quiz") {
      const choice = Array.isArray(content.choice) ? content.choice.map(Number).sort((a, b) => a - b) : [];
      const expected = correctIndexes(q).sort((a, b) => a - b);
      return choice.length > 0 && choice.join(",") === expected.join(",");
    }
    if (type === "quiz" || type === "true_false") {
      const expected = correctIndexes(q);
      return expected.length > 0 && Number(content.choice) === expected[0];
    }
    // poll / survey / open_ended / word_cloud: no right answer, no points
    return true;
  }

  /** Answer plan (what a bot "knows"), mirroring src/answers/resolve.js. */
  function answerPlanFor(q) {
    const type = q.type || "quiz";
    if (type === "jumble") return { order: q.choices.map((_, i) => i) };
    if (type === "multiple_select_quiz") {
      const choices = correctIndexes(q);
      return choices.length ? { type, choices } : null;
    }
    if (type === "quiz" || type === "true_false") {
      const idx = correctIndexes(q)[0];
      return idx === undefined ? null : { type, choice: idx };
    }
    return null; // poll / survey / open_ended / word_cloud
  }

  /** Sheet serialization, mirroring serializeAnswer() in src/web/server.js. */
  function serializeAnswer(plan, q) {
    if (!plan) return null;
    if (plan.order) {
      return { type: "jumble", order: plan.order.map((i) => (q.choices[i] || {}).answer) };
    }
    const indexes = plan.choices || [plan.choice];
    return {
      type: plan.type,
      indexes,
      choices: indexes.map((i) => (q.choices[i] || {}).answer),
    };
  }

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* -------------------------------------------------------------- game */

  class DemoGame {
    /**
     * @param {{pin:string, quiz:object, questionTimeMs?:number, gapMs?:number,
     *          autoStartMs?:number|null, loop?:boolean, log:function}} opts
     */
    constructor(opts) {
      this.pin = opts.pin;
      this.quiz = opts.quiz;
      this.questionTimeMs = Number(opts.questionTimeMs) > 0 ? Number(opts.questionTimeMs) : null;
      this.gapMs = Number(opts.gapMs) > 0 ? Number(opts.gapMs) : 1200;
      this.autoStartMs = opts.autoStartMs;
      this.loop = Boolean(opts.loop);
      this.log = opts.log; // (line) => void, already timestamped by the owner

      this.phase = "lobby"; // lobby | question | gap | ended
      this.questionIndex = -1;
      this.questionStartAt = 0;
      /** @type {Map<string, object>} name -> player */
      this.players = new Map();
      this.timers = new Set();
      this.autoStartTimer = null;
      this.answerBook = null; // Array<plan|null> once resolved
      this.swarm = null; // {bots: [...]} while bots are attached
    }

    /* ------------------------------------------------------- players */

    join(name, { isBot = false } = {}) {
      const taken = [...this.players.values()].some(
        (p) => p.name.toLowerCase() === String(name).toLowerCase()
      );
      if (taken) throw new Error("Duplicate name");
      const player = {
        name: String(name),
        score: 0,
        correct: 0,
        answered: new Set(),
        isBot,
        strategy: null,
        accuracy: 1,
        state: "lobby",
      };
      this.players.set(player.name, player);
      this.log(`+ ${player.name} joined (${this.players.size} players)`);
      if (this.phase === "lobby" && this.autoStartMs != null && !this.autoStartTimer) {
        this.autoStartTimer = this.#timer(() => {
          this.autoStartTimer = null;
          if (this.phase === "lobby" && this.players.size > 0) this.startGame();
        }, this.autoStartMs);
      }
      return player;
    }

    remove(name) {
      const player = this.players.get(name);
      if (!player) return false;
      this.players.delete(name);
      this.log(`- ${player.name} left`);
      return true;
    }

    /* ----------------------------------------------------------- flow */

    startGame() {
      if (this.phase !== "lobby") throw new Error(`game is already ${this.phase}`);
      if (this.players.size === 0) throw new Error("no players in the room yet");
      this.#clearTimers();
      for (const p of this.players.values()) {
        p.score = 0;
        p.correct = 0;
        p.answered = new Set();
        p.state = "playing";
      }
      this.questionIndex = 0;
      this.log(`game started: "${this.quiz.title}"`);
      this.#beginQuestion();
    }

    #beginQuestion() {
      this.phase = "question";
      this.questionStartAt = Date.now();
      const q = this.quiz.questions[this.questionIndex];
      const time = this.#questionTime(q);
      this.log(`Q${this.questionIndex + 1}/${this.quiz.questions.length} — ${q.question || "(no text)"}`);
      // bots pick (and time) their answers
      for (const p of this.players.values()) {
        if (p.isBot) this.#scheduleBotAnswer(p, q, time);
      }
      this.#timer(() => this.#endQuestion(), time);
    }

    #endQuestion() {
      if (this.phase !== "question") return;
      const index = this.questionIndex;
      const q = this.quiz.questions[index];
      this.#clearTimers(true);
      // rank + report
      const ranked = this.#ranked();
      for (const p of ranked) {
        if (!p.isBot) continue;
        const plan = p.pending || null;
        const isCorrect = Boolean(plan && plan.correct);
        this.log(
          `${p.name}: Q${index + 1} ${isCorrect ? "correct" : "wrong"} -> ${p.score} (rank ${p.rank})`
        );
        p.pending = null;
      }
      if (index + 1 < this.quiz.questions.length) {
        this.phase = "gap";
        this.#timer(() => {
          this.questionIndex += 1;
          this.#beginQuestion();
        }, this.gapMs);
      } else {
        this.#finish();
      }
    }

    /** Next button: settle the running question or skip the gap. */
    advance() {
      if (this.phase === "question") return this.#endQuestion();
      if (this.phase === "gap") {
        this.#clearTimers(true);
        this.questionIndex += 1;
        return this.#beginQuestion();
      }
      if (this.phase === "lobby") return this.startGame();
      throw new Error("game is already over — reset the lobby to play again");
    }

    /** End button: settle the running question and stop on the podium screen. */
    endGame() {
      if (this.phase === "lobby" || this.phase === "ended") return;
      this.#clearTimers(true);
      if (this.phase === "question") {
        const index = this.questionIndex;
        for (const p of this.#ranked()) {
          if (p.isBot) {
            const correct = Boolean(p.pending && p.pending.correct);
            this.log(`${p.name}: Q${index + 1} ${correct ? "correct" : "wrong"} -> ${p.score} (rank ${p.rank})`);
          }
          p.pending = null;
        }
      }
      this.#finish();
    }

    /** Reset button: reopen the lobby, keep the room, zero the scores. */
    reset() {
      this.#clearTimers();
      for (const p of this.players.values()) {
        p.score = 0;
        p.correct = 0;
        p.answered = new Set();
        p.state = "lobby";
        p.pending = null;
      }
      this.phase = "lobby";
      this.questionIndex = -1;
      this.log("lobby reopened — scores reset, players kept");
    }

    #finish() {
      this.phase = "ended";
      this.#clearTimers();
      for (const p of this.#ranked()) {
        this.log(`game over - ${p.name}: ${p.score} points (rank ${p.rank})`);
      }
      if (this.loop && this.players.size > 0) {
        this.#timer(() => {
          if (this.phase !== "ended") return;
          this.reset();
          if (this.players.size > 0) {
            this.startGame();
            this.log("loop: next game started");
          }
        }, 3000);
      }
    }

    /* -------------------------------------------------------- scoring */

    #questionTime(q) {
      return this.questionTimeMs || q.time || 20000;
    }

    #scheduleBotAnswer(player, q, time) {
      const known = this.answerBook ? this.answerBook[this.questionIndex] : null;
      const type = q.type || "quiz";
      const n = Number(q.numberOfChoices) || (q.choices || []).length || 4;

      let delay;
      let content = null;

      if (type === "word_cloud" || type === "open_ended") {
        content = { text: `${player.name} says hi` };
        delay = this.#botDelay(time);
      } else if (player.strategy === "skip") {
        return; // never answers
      } else if (player.strategy === "dumb") {
        content = this.#choicePayload(type, n, { dumb: true });
        delay = this.#botDelay(time);
      } else if (player.strategy === "random") {
        content = this.#choicePayload(type, n, { random: true });
        delay = this.#botDelay(time);
      } else {
        // correct / slow: answer with the revealed plan (accuracy decides)
        const accurate = player.accuracy >= 1 || Math.random() < player.accuracy;
        const plan = known && accurate ? known : null;
        if (!plan) {
          content = this.#choicePayload(type, n, { random: true });
          delay = this.#botDelay(time);
        } else {
          content = plan.order
            ? { choice: [...plan.order] }
            : { choice: plan.choices ? [...plan.choices] : plan.choice };
          delay =
            player.strategy === "slow"
              ? clamp(time - (400 + Math.random() * 800), 60, time - 30)
              : this.#botDelay(time);
        }
      }

      delay = clamp(delay, 30, Math.max(30, time - 20));
      this.#timer(() => this.#answer(player, content), delay);
    }

    #botDelay(time) {
      return clamp(600 + Math.random() * 800, 60, Math.max(60, time * 0.8));
    }

    #choicePayload(type, n, { dumb = false, random = false }) {
      if (type === "jumble") {
        const order = [0, 1, 2, 3].slice(0, Math.max(2, Math.min(4, n)));
        return { choice: dumb ? [...order].reverse() : shuffle(order) };
      }
      if (type === "multiple_select_quiz") {
        return { choice: dumb ? [0] : [Math.floor(Math.random() * n)] };
      }
      return { choice: dumb ? 0 : Math.floor(Math.random() * n) };
    }

    #answer(player, content) {
      if (this.phase !== "question" || player.answered.has(this.questionIndex)) return;
      const index = this.questionIndex;
      const q = this.quiz.questions[index];
      const time = this.#questionTime(q);
      const elapsed = Date.now() - this.questionStartAt;
      const correct = SCORABLE.has(q.type || "quiz") && gradeAnswer(q, content);
      const points = correct
        ? pointsFor({ elapsedMs: elapsed, timeMs: time, pointsMultiplier: q.pointsMultiplier })
        : 0;
      player.answered.add(index);
      player.score += points;
      if (correct) player.correct += 1;
      player.pending = { correct, points };
      this.log(`${player.name} answered Q${index + 1}: ${correct ? "correct" : "wrong"} (+${points})`);
    }

    #ranked() {
      const list = [...this.players.values()].sort((a, b) => b.score - a.score);
      list.forEach((p, i) => {
        p.rank = i + 1;
      });
      return list;
    }

    rankOf(player) {
      this.#ranked();
      return player.rank;
    }

    /* --------------------------------------------------------- scores */

    adjustScore({ name, add, remove, set }) {
      const player = this.players.get(
        [...this.players.keys()].find((k) => k.toLowerCase() === String(name || "").toLowerCase())
      );
      if (!player) return null;
      const previousScore = player.score;
      if (typeof set === "number") player.score = Math.max(0, Math.round(set));
      else if (typeof add === "number") player.score = Math.max(0, player.score + Math.round(add));
      else if (typeof remove === "number") player.score = Math.max(0, player.score - Math.round(remove));
      else return null;
      return { name: player.name, previousScore, score: player.score, rank: this.rankOf(player) };
    }

    /* ------------------------------------------------------- internals */

    #timer(fn, ms) {
      const t = setTimeout(() => {
        this.timers.delete(t);
        fn();
      }, ms);
      this.timers.add(t);
      return t;
    }

    #clearTimers(keepAutoStart = false) {
      for (const t of this.timers) clearTimeout(t);
      this.timers.clear();
      if (!keepAutoStart && this.autoStartTimer) {
        clearTimeout(this.autoStartTimer);
        this.autoStartTimer = null;
      }
    }

    close() {
      this.#clearTimers();
    }

    /* --------------------------------------------------------- status */

    snapshot() {
      return {
        pin: this.pin,
        phase: this.phase,
        questionIndex: this.questionIndex,
        quiz: {
          title: this.quiz.title,
          uuid: "demo-" + this.pin,
          questions: this.quiz.questions.length,
        },
        players: this.#ranked().map((p, i) => ({
          rank: i + 1,
          name: p.name,
          score: p.score,
          correct: p.correct,
          answered: p.answered.size,
          connected: true,
          isBot: p.isBot,
        })),
      };
    }

    botStatus() {
      if (!this.swarm) return null;
      this.#ranked(); // refresh ranks
      return this.swarm.bots.map((b) => {
        const p = this.players.get(b.name);
        return {
          name: b.name,
          state: p ? (this.phase === "lobby" ? "lobby" : "playing") : "stopped",
          score: p ? p.score : 0,
          correct: p ? p.correct : 0,
          rank: p ? p.rank : null,
          question: (this.questionIndex >= 0 ? this.questionIndex : 0) + 1,
          strategy: b.strategy,
          error: null,
        };
      });
    }
  }

  /* ------------------------------------------------------------ engine */

  class DemoEngine {
    constructor() {
      /** @type {Map<string, DemoGame>} */
      this.games = new Map();
      /** @type {Map<string, {quiz:object, answers:Array, source:string}>} */
      this.answerBooks = new Map();
      /** @type {Map<string, string[]>} */
      this.logs = new Map();
      this.LOG_CAP = 200;
    }

    log(pin, line) {
      const at = new Date().toLocaleTimeString();
      const buf = this.logs.get(pin) || [];
      buf.push(`[${at}] ${line}`);
      if (buf.length > this.LOG_CAP) buf.splice(0, buf.length - this.LOG_CAP);
      this.logs.set(pin, buf);
    }

    #pin() {
      let pin;
      do {
        pin = String(Math.floor(1000000 + Math.random() * 9000000));
      } while (this.games.has(pin));
      return pin;
    }

    /* ------------------------------------------------------- routing */

    /**
     * Handle one API call. Mirrors the JSON API of src/web/server.js.
     * @param {string} method
     * @param {string} path
     * @param {object} [body]
     * @returns {Promise<object>} response payload (never throws)
     */
    async handle(method, path, body = {}) {
      const clean = String(path || "").split("?")[0].replace(/\/+$/, "") || "/";
      const route = `${String(method || "GET").toUpperCase()} ${clean}`;
      try {
        switch (route) {
          case "GET /api/health":
            return { ok: true, mocks: this.games.size, swarms: this.games.size, demo: true };
          case "GET /api/fixtures":
            return { ok: true, fixtures: Object.keys(fixtures()) };
          case "GET /api/games":
            return {
              ok: true,
              games: [...this.games.values()].map((g) => ({
                pin: g.pin,
                mock: true,
                bots: Boolean(g.swarm),
                answers: this.answerBooks.has(g.pin),
              })),
            };
          case "POST /api/mock/start":
            return this.#mockStart(body);
          case "POST /api/mock/stop":
            return this.#mockStop(body);
          case "POST /api/mock/control":
            return this.#mockControl(body);
          case "POST /api/resolve":
            return this.#resolve(body);
          case "POST /api/bots/start":
            return this.#botsStart(body);
          case "POST /api/bots/stop":
            return this.#botsStop(body);
          case "POST /api/score":
            return this.#score(body);
          default: {
            if (clean.startsWith("/api/status/")) {
              const pin = clean.split("/").pop().replace(/\D/g, "");
              return this.#status(pin);
            }
            return { ok: false, error: `unknown route: ${route}` };
          }
        }
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }

    /* --------------------------------------------------- test host */

    #mockStart(body) {
      const fixtureName = body.fixture || firstFixtureName();
      const all = fixtures();
      const quiz = all[fixtureName];
      if (!quiz) {
        throw new Error(`unknown fixture: ${fixtureName} (demo ships: ${Object.keys(all).join(", ") || "none"})`);
      }
      // one demo host at a time keeps the UI unambiguous (same as the server)
      if (this.games.size) this.#mockStop({ pin: [...this.games.keys()][0] });

      const autoStartSec = body.autoStartSec === undefined ? 3 : Number(body.autoStartSec);
      const pin = this.#pin();
      const game = new DemoGame({
        pin,
        quiz,
        questionTimeMs: body.questionTimeMs ? Number(body.questionTimeMs) : null,
        gapMs: body.gapMs ? Number(body.gapMs) : 1200,
        autoStartMs: Number.isFinite(autoStartSec) && autoStartSec > 0 ? autoStartSec * 1000 : null,
        loop: Boolean(body.loop),
        log: (line) => this.log(pin, line),
      });
      this.games.set(pin, game);
      this.log(pin, `demo test host started: "${quiz.title}"`);
      return { ok: true, pin, baseUrl: "(browser demo)", quiz: quiz.title, fixture: fixtureName };
    }

    #mockStop(body) {
      const pin = String(body.pin || "").replace(/\D/g, "");
      const game = this.games.get(pin);
      if (!game) return { ok: false, error: `no test host for PIN ${pin || "?"}` };
      game.close();
      this.games.delete(pin);
      this.log(pin, "demo test host stopped");
      return { ok: true, pin };
    }

    #mockControl(body) {
      const pin = String(body.pin || "").replace(/\D/g, "");
      const game = this.games.get(pin);
      if (!game) return { ok: false, error: `no test host for PIN ${pin || "?"}` };
      const action = body.action;
      if (action === "start") game.startGame();
      else if (action === "next") game.advance();
      else if (action === "reset") game.reset();
      else if (action === "stop") game.endGame();
      else return { ok: false, error: `unknown action: ${action}` };
      return { ok: true, pin, action, phase: game.phase };
    }

    /* ----------------------------------------------------- answers */

    #resolve(body) {
      const pin = body.pin ? String(body.pin).replace(/\D/g, "") : undefined;
      if (!pin && !body.title && !body.quizId) {
        throw new Error("give a PIN, title or quiz id");
      }
      const game = pin ? this.games.get(pin) : null;
      const all = fixtures();
      const quiz = game ? game.quiz : all[firstFixtureName()];
      if (!quiz) throw new Error("no quiz fixtures available in the demo build");

      const answers = quiz.questions.map((q) => answerPlanFor(q));
      if (pin) {
        this.answerBooks.set(pin, { quiz, answers, source: "demo fixture" });
        const g = this.games.get(pin);
        if (g) g.answerBook = answers;
        this.log(pin, `answers loaded: "${quiz.title}"`);
      }
      return {
        ok: true,
        pin,
        source: game ? "demo test host" : "demo fixture (offline)",
        title: quiz.title,
        questions: quiz.questions.map((q, i) => ({
          index: i + 1,
          question: q.question,
          type: q.type,
          time: q.time,
          pointsMultiplier: q.pointsMultiplier,
          choices: (q.choices || []).map((c) => c.answer),
          answer: serializeAnswer(answers[i], q),
        })),
      };
    }

    /* -------------------------------------------------------- bots */

    #botsStart(body) {
      const pin = String(body.pin || "").replace(/\D/g, "");
      if (!pin) throw new Error("game PIN is required");
      let game = this.games.get(pin);
      if (!game) {
        // No room for that PIN yet — spin up a simulated one so any PIN works.
        const all = fixtures();
        const quiz = all[body.fixture] || all[firstFixtureName()];
        if (!quiz) throw new Error("no quiz fixtures available in the demo build");
        this.log(pin, `demo: no room for PIN ${pin} — creating a simulated one`);
        game = new DemoGame({
          pin,
          quiz,
          autoStartMs: 3000,
          log: (line) => this.log(pin, line),
        });
        this.games.set(pin, game);
      }
      if (game.swarm) return { ok: true, pin, alreadyRunning: true };

      const count = Math.max(1, Math.min(100, Number(body.count) || 1));
      const pattern = body.pattern || "Bot {i}";
      const strategyList = body.strategies
        ? String(body.strategies)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : null;
      const useAnswers = body.useAnswers !== false && body.useAnswers !== "false";
      const bots = [];
      for (let i = 1; i <= count; i++) {
        const name = pattern
          .replaceAll("{i}", String(i))
          .replaceAll("{n}", String(i).padStart(String(count).length, "0"))
          .replaceAll("{name}", "Bot");
        const player = game.join(name, { isBot: true });
        player.strategy = (strategyList && strategyList[i - 1]) || body.strategy || "correct";
        player.accuracy = body.accuracy === undefined ? 1 : Number(body.accuracy);
        bots.push({ name: player.name, strategy: player.strategy, state: "lobby", score: 0, correct: 0, rank: null });
      }
      game.swarm = { bots };
      // answers resolve instantly in the demo (the fixture already has them)
      if (useAnswers && !game.answerBook) {
        game.answerBook = game.quiz.questions.map((q) => answerPlanFor(q));
        this.answerBooks.set(pin, { quiz: game.quiz, answers: game.answerBook, source: "demo fixture" });
        this.log(pin, `answers loaded: "${game.quiz.title}"`);
      }
      this.log(pin, `${bots.length}/${bots.length} bots joined`);
      return { ok: true, pin, started: bots.length, joined: bots.length, baseUrl: "(browser demo)" };
    }

    #botsStop(body) {
      const pin = String(body.pin || "").replace(/\D/g, "");
      const game = this.games.get(pin);
      if (!game || !game.swarm) return { ok: false, error: `no running bots for PIN ${pin || "?"}` };
      for (const b of game.swarm.bots) game.remove(b.name);
      game.swarm = null;
      this.log(pin, "bots stopped");
      return { ok: true, pin };
    }

    /* ------------------------------------------------------- score */

    #score(body) {
      const pin = String(body.pin || "").replace(/\D/g, "");
      const player = body.player;
      if (!player) throw new Error("player name is required");
      const op = {};
      if (body.add !== undefined && body.add !== null && body.add !== "") op.add = Number(body.add);
      if (body.remove !== undefined && body.remove !== null && body.remove !== "") op.remove = Number(body.remove);
      if (body.set !== undefined && body.set !== null && body.set !== "") op.set = Number(body.set);
      if (!Object.keys(op).length) throw new Error("give add, remove or set");
      for (const [key, value] of Object.entries(op)) {
        if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
      }

      const game = this.games.get(pin);
      if (!game) {
        return {
          ok: false,
          error: `no demo game for PIN ${pin || "?"} — start the test host or bots first`,
        };
      }
      const result = game.adjustScore({ name: player, ...op });
      if (!result) {
        return {
          ok: false,
          error: `no player named "${player}" in this game`,
          players: [...game.players.keys()],
        };
      }
      this.log(pin, `score ${result.name}: ${result.previousScore} -> ${result.score}`);
      return {
        ok: true,
        source: "test-host",
        name: result.name,
        previousScore: result.previousScore,
        score: result.score,
        rank: result.rank,
        message: `${result.name}: ${result.previousScore} -> ${result.score}`,
      };
    }

    /* ------------------------------------------------------ status */

    #status(pin) {
      const game = this.games.get(pin);
      const answers = this.answerBooks.get(pin);
      const log = (this.logs.get(pin) || []).slice(-100);
      if (!game) {
        return {
          ok: true,
          pin,
          baseUrl: "(browser demo)",
          isTestHost: false,
          phase: null,
          questionIndex: null,
          quiz: null,
          scoreboard: null,
          bots: null,
          answers: { loaded: false },
          log,
        };
      }
      const snap = game.snapshot();
      return {
        ok: true,
        pin,
        baseUrl: "(browser demo)",
        isTestHost: true,
        phase: snap.phase,
        questionIndex: snap.questionIndex >= 0 ? snap.questionIndex : null,
        quiz: snap.quiz,
        scoreboard: {
          source: "test-host",
          phase: snap.phase,
          questionIndex: snap.questionIndex >= 0 ? snap.questionIndex : null,
          quiz: snap.quiz,
          players: snap.players,
        },
        bots: game.botStatus(),
        answers: answers
          ? {
              loaded: true,
              title: answers.quiz.title,
              source: answers.source,
              answerable: answers.answers.filter(Boolean).length,
              total: answers.answers.length,
              questions: answers.quiz.questions.map((q, i) => ({
                index: i + 1,
                question: q.question,
                type: q.type,
                time: q.time,
                pointsMultiplier: q.pointsMultiplier,
                choices: (q.choices || []).map((c) => c.answer),
                answer: serializeAnswer(answers.answers[i], q),
              })),
            }
          : { loaded: false },
        log,
      };
    }
  }

  /* ------------------------------------------------------------- export */

  const engine = new DemoEngine();
  global.KahootLabDemo = { engine, handle: (m, p, b) => engine.handle(m, p, b), DemoEngine };
})(typeof globalThis !== "undefined" ? globalThis : window);
