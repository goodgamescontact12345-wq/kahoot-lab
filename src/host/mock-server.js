/**
 * A Kahoot-compatible local test host.
 *
 * Implements enough of Kahoot's surface for kahoot-lab (and any cometd
 * client) to work offline:
 *
 *   GET  /reserve/session/{pin}/     challenge + session token headers
 *   WS   /cometd/{pin}/{token}       bayeux handshake / login / game events
 *   GET  /rest/kahoots/?query=       public quiz search  (same shape as Kahoot)
 *   GET  /rest/kahoots/{uuid}        quiz incl. answers
 *   *    /admin/*                    test operator API (score editing, start...)
 *
 * Scores use Kahoot's classic speed formula:
 *   points = round((1 - elapsed/(2*time)) * 1000) * pointsMultiplier
 * so a correct answer is worth 1000 (instant) down to 500 (last millisecond),
 * and a wrong/missing answer is worth 0.
 */

import http from "node:http";
import { randomBytes } from "node:crypto";
import { attachWebSocket } from "./ws-server.js";
import { validateQuiz } from "./quiz-loader.js";
import { solveChallenge } from "../protocol/challenge.js";

const RAW_MESSAGE = "kahoot-lab local test host challenge message v1";
const CHALLENGE = `function(){return null}.call(this, '${RAW_MESSAGE}') /* offset = 0; */`;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);
const SESSION_TTL_MS = 10 * 60 * 1000;
/** Question types that can earn points. */
const SCORABLE_TYPES = new Set(["quiz", "true_false", "multiple_select_quiz", "jumble"]);

export class MockKahootServer {
  /**
   * @param {{
   *   quiz:object,
   *   pin?:string,
   *   port?:number,
   *   host?:string,
   *   autoStartMs?:number|null,
   *   questionTimeMs?:number|null,
   *   questionGapMs?:number,
   *   connectDelayMs?:number,
   *   log?:function
   * }} opts
   */
  constructor(opts) {
    this.quiz = validateQuiz(opts.quiz);
    this.pin = String(opts.pin || randomPin());
    this.host = opts.host || "127.0.0.1";
    this.port = opts.port ?? 0;
    this.autoStartMs = opts.autoStartMs ?? null;
    this.questionTimeMs = opts.questionTimeMs ?? null;
    this.questionGapMs = opts.questionGapMs ?? 1200;
    this.connectDelayMs = opts.connectDelayMs ?? 700;
    this.log = opts.log || (() => {});
    this.quizUuid = randomBytes(16).toString("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");

    this.secret = null;
    this.phase = "lobby"; // lobby | question | gap | ended
    this.questionIndex = -1;
    this.questionStartAt = 0;
    this.players = new Map(); // cid -> player
    this.sessions = new Map(); // sessionId -> {pin, createdAt}
    this.timers = new Set();
    this.autoStartTimer = null;
    /** @type {null | {resolve:Function, timer:NodeJS.Timeout}} */
    this.pendingAdvance = null;

    this.server = http.createServer((req, res) => this.#http(req, res));
    attachWebSocket(this.server, { onConnection: (conn, req) => this.#ws(conn, req) });
    this.secret = solveChallenge(CHALLENGE); // mock and client agree by construction
  }

  /** @returns {Promise<{pin:string, port:number, baseUrl:string}>} */
  start() {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        resolve({
          pin: this.pin,
          port: this.port,
          baseUrl: `http://${this.host}:${this.port}`,
        });
      });
    });
  }

  async close() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.autoStartTimer) clearTimeout(this.autoStartTimer);
    if (this.pendingAdvance) clearTimeout(this.pendingAdvance.timer);
    for (const player of this.players.values()) {
      try { player.conn.close(); } catch { /* ignore */ }
    }
    await new Promise((resolve) => this.server.close(resolve));
  }

  /* ------------------------------------------------------------------ HTTP */

  #http(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const send = (status, body, headers = {}) => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, {
        "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers":
          "x-kahoot-session-token,x-kahoot-gameserver,x-kahoot-live-game-id",
        ...headers,
      });
      res.end(payload);
    };

    // reserve/session
    const reserve = path.match(/^\/reserve\/session\/(\d+)$/);
    if (reserve) {
      if (reserve[1] !== this.pin) return send(404, "Not found");
      const sessionId = randomBytes(18).toString("base64url");
      const headerRaw = xorChars(sessionId, this.secret);
      this.#pruneSessions();
      this.sessions.set(sessionId, { pin: this.pin, createdAt: Date.now() });
      return send(
        200,
        {
          challenge: CHALLENGE,
          gameType: "normal",
          namerator: false,
          twoFactorAuth: false,
          gameMode: "classic",
        },
        {
          "x-kahoot-session-token": Buffer.from(headerRaw, "utf8").toString("base64"),
          "x-kahoot-gameserver": `ws://${this.host}:${this.port}`,
          "x-kahoot-live-game-id": this.pin,
        }
      );
    }

    // public quiz API
    if (path === "/rest/kahoots") {
      const query = (url.searchParams.get("query") || "").toLowerCase();
      const entities = this.quiz.title.toLowerCase().includes(query) || !query
        ? [{ card: this.#card() }]
        : [];
      return send(200, { entities });
    }
    const quizById = path.match(/^\/rest\/kahoots\/([^/]+)$/);
    if (quizById) {
      if (decodeURIComponent(quizById[1]) !== this.quizUuid) return send(404, "Not found");
      return send(200, this.#kahootShapedQuiz());
    }

    // operator API (loopback only)
    if (path.startsWith("/admin/")) {
      const remote = req.socket.remoteAddress || "";
      if (!LOOPBACK.has(remote)) return send(403, "admin API is loopback only");
      return this.#admin(req, res, path, send);
    }

    return send(404, "Not found");
  }

  #card() {
    return {
      uuid: this.quizUuid,
      type: "quiz",
      title: this.quiz.title,
      description: this.quiz.description || "",
      number_of_questions: this.quiz.questions.length,
      cover: `https://media.kahoot.it/${this.quizUuid}`,
    };
  }

  #kahootShapedQuiz() {
    return {
      uuid: this.quizUuid,
      title: this.quiz.title,
      description: this.quiz.description || "",
      questions: this.quiz.questions.map((q) => ({
        question: q.question,
        type: q.type,
        time: q.time,
        pointsMultiplier: q.pointsMultiplier,
        layout: q.layout || (q.type === "quiz" ? "DEFAULT" : undefined),
        choices: q.choices.map((c) => ({
          answer: c.answer,
          ...(q.type === "jumble" ? {} : { correct: Boolean(c.correct) }),
        })),
      })),
    };
  }

  #admin(req, res, path, send) {
    const action = path.slice("/admin/".length);
    const handle = async () => {
      const body = await readJson(req);
      switch (action) {
        case "state":
          return send(200, this.snapshot());
        case "start":
          this.startGame();
          return send(200, { ok: true, phase: this.phase });
        case "next":
          this.advance();
          return send(200, { ok: true, phase: this.phase, questionIndex: this.questionIndex });
        case "score": {
          const result = this.adjustScore(body);
          if (!result) return send(404, "no player with that name");
          return send(200, result);
        }
        case "kick": {
          const ok = this.kick(body.name);
          return ok ? send(200, { ok: true }) : send(404, "no player with that name");
        }
        case "reset":
          this.reset();
          return send(200, { ok: true });
        case "stop":
          this.endGame();
          return send(200, { ok: true });
        default:
          return send(404, "unknown admin action");
      }
    };
    handle().catch((err) => send(500, String(err && err.message)));
  }

  /* -------------------------------------------------------------------- WS */

  #ws(conn, req) {
    const url = new URL(req.url, "http://localhost");
    const match = url.pathname.match(/^\/cometd\/(\d+)\/(.+)$/);
    const token = match ? decodeURIComponent(match[2]) : "";
    const known = this.sessions.get(token);
    if (!match || match[1] !== this.pin || !known || known.pin !== this.pin) {
      conn.close(1008);
      return;
    }
    this.sessions.delete(token);
    const session = {
      conn,
      clientId: randomBytes(8).toString("hex"),
      player: null,
      connectTimer: null,
      lastConnectReplyAt: 0,
      pendingConnect: null,
      pendingConnectTc: null,
      handshakeTc: null,
    };
    conn.on("message", (text) => {
      let messages;
      try {
        messages = JSON.parse(text);
      } catch {
        return;
      }
      if (!Array.isArray(messages)) messages = [messages];
      for (const msg of messages) this.#onClientMessage(session, msg);
    });
    conn.on("close", () => this.#onDisconnect(session));
  }

  #send(session, msg) {
    try {
      session.conn.send(JSON.stringify([msg]));
    } catch { /* ignore */ }
  }

  #onClientMessage(session, msg) {
    const channel = msg.channel || "";
    if (channel === "/meta/handshake") {
      session.handshakeTc = msg.ext && msg.ext.timesync ? msg.ext.timesync.tc : null;
      this.#send(session, {
        channel: "/meta/handshake",
        successful: true,
        clientId: session.clientId,
        version: "1.0",
        minimumVersion: "1.0",
        advice: { reconnect: "retry", interval: 0, timeout: 60000 },
        ext: { timesync: { tc: session.handshakeTc, ts: Date.now(), p: 0 } },
        id: msg.id,
      });
      return;
    }
    if (channel === "/meta/subscribe") {
      this.#send(session, {
        channel: "/meta/subscribe",
        subscription: msg.subscription,
        successful: true,
        clientId: session.clientId,
        id: msg.id,
      });
      return;
    }
    if (channel === "/meta/connect") {
      session.pendingConnect = msg;
      session.pendingConnectTc = msg.ext && msg.ext.timesync ? msg.ext.timesync.tc : null;
      this.#scheduleConnectReply(session);
      return;
    }
    if (channel === "/meta/disconnect") {
      this.#send(session, {
        channel: "/meta/disconnect",
        successful: true,
        clientId: session.clientId,
        id: msg.id,
      });
      this.#onDisconnect(session);
      setTimeout(() => { try { session.conn.close(); } catch { /* ignore */ } }, 50);
      return;
    }
    if (channel === "/service/controller" && msg.data) {
      this.#onController(session, msg);
    }
  }

  #scheduleConnectReply(session) {
    if (session.connectTimer) return;
    const wait = Math.max(0, this.connectDelayMs - (Date.now() - session.lastConnectReplyAt));
    const timer = setTimeout(() => {
      session.connectTimer = null;
      session.lastConnectReplyAt = Date.now();
      const req = session.pendingConnect || {};
      this.#send(session, {
        channel: "/meta/connect",
        successful: true,
        clientId: session.clientId,
        advice: { reconnect: "retry", interval: 0, timeout: 60000 },
        ext: { timesync: { tc: session.pendingConnectTc, ts: Date.now(), p: 0 } },
        id: req.id,
      });
    }, wait);
    session.connectTimer = timer;
  }

  #onController(session, msg) {
    const data = msg.data;
    const ack = (extra = {}) =>
      this.#send(session, {
        channel: "/service/controller",
        successful: true,
        clientId: session.clientId,
        id: msg.id,
        ...extra,
      });

    if (data.type === "login") {
      const name = String(data.name || "").trim() || "Player";
      const taken = [...this.players.values()].some(
        (p) => p.connected && p.name.toLowerCase() === name.toLowerCase()
      );
      if (taken) {
        return ack({
          data: { type: "loginResponse", error: true, description: "Duplicate name" },
        });
      }
      const cid = String(this.players.size + 1 + Math.floor(Math.random() * 1000));
      const player = {
        cid,
        name,
        score: 0,
        correct: 0,
        answered: new Set(),
        outcomes: new Map(), // questionIndex -> {correct, points}
        connected: true,
        conn: session.conn,
        session,
      };
      this.players.set(cid, player);
      session.player = player;
      this.log(`+ ${name} joined (${this.players.size} players)`);
      if (this.phase === "lobby" && this.autoStartMs != null && !this.autoStartTimer) {
        this.autoStartTimer = setTimeout(() => {
          this.autoStartTimer = null;
          if (this.phase === "lobby" && this.players.size > 0) this.startGame();
        }, this.autoStartMs);
      }
      return ack({
        data: {
          type: "loginResponse",
          cid,
          participantId: Number(cid),
          twoFactorAuth: false,
          namerator: false,
          gameMode: "classic",
          questionMode: "quiz",
        },
      });
    }

    if (data.type === "message" && Number(data.id) === 16) {
      // join verify / namerator - without this the player never shows up
      ack();
      if (session.player) {
        this.#toPlayer(session.player, 14, { playerName: session.player.name });
      }
      return;
    }

    if (data.type === "message" && Number(data.id) === 45) {
      ack();
      this.#onAnswer(session, data);
      return;
    }

    ack();
  }

  #onDisconnect(session) {
    const player = session.player;
    if (player) {
      player.connected = false;
      player.session = null;
      if (player.answerTimer) clearTimeout(player.answerTimer);
      // free the name so a rejoin (fresh score) works
      this.players.delete(player.cid);
      this.log(`- ${player.name} left`);
      session.player = null;
      this.#broadcastRanks();
    }
    if (session.connectTimer) clearTimeout(session.connectTimer);
  }

  /* ----------------------------------------------------------------- game */

  /**
   * @param {{name:string, add?:number, remove?:number, set?:number}} op
   */
  adjustScore({ name, add, remove, set }) {
    const player = [...this.players.values()].find(
      (p) => p.name.toLowerCase() === String(name || "").toLowerCase()
    );
    if (!player) return null;
    const previousScore = player.score;
    if (typeof set === "number") player.score = Math.max(0, Math.round(set));
    else if (typeof add === "number") player.score = Math.max(0, player.score + Math.round(add));
    else if (typeof remove === "number")
      player.score = Math.max(0, player.score - Math.round(remove));
    else return null;
    this.#toPlayer(player, 7, { totalScore: player.score, rank: this.#rankOf(player) });
    return { name: player.name, previousScore, score: player.score };
  }

  kick(name) {
    const player = [...this.players.values()].find(
      (p) => p.name.toLowerCase() === String(name || "").toLowerCase()
    );
    if (!player) return false;
    this.#toPlayer(player, 10, { kickCode: 1, description: "Kicked by host" });
    const session = player.session;
    this.players.delete(player.cid);
    if (session) {
      session.player = null;
      setTimeout(() => { try { session.conn.close(); } catch { /* ignore */ } }, 100);
    }
    return true;
  }

  /**
   * Reopen the lobby for another game. Connected players stay in the room
   * (score zeroed) — the same way Kahoot keeps participants when the host
   * replays a quiz — so a running bot swarm survives a reset and can play
   * the next game without rejoining.
   */
  reset() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.autoStartTimer) clearTimeout(this.autoStartTimer);
    this.autoStartTimer = null;
    if (this.pendingAdvance) clearTimeout(this.pendingAdvance.timer);
    this.pendingAdvance = null;
    for (const player of this.players.values()) {
      player.score = 0;
      player.correct = 0;
      player.answered = new Set();
      player.outcomes = new Map();
    }
    this.phase = "lobby";
    this.questionIndex = -1;
    this.log(`game reset (lobby open, ${this.players.size} players kept)`);
  }

  startGame() {
    if (this.phase !== "lobby") throw new Error(`cannot start from phase "${this.phase}"`);
    this.phase = "gap";
    this.questionIndex = -1;
    const counts = this.quiz.questions.map(quizQuestionCount);
    for (const player of this.players.values()) {
      player.score = 0;
      player.correct = 0;
      player.answered = new Set();
      player.outcomes = new Map();
      this.#toPlayer(player, 9, {
        quizName: this.quiz.title,
        quizTitle: this.quiz.title,
        quizType: "quiz",
        gameBlockCount: this.quiz.questions.length,
        quizQuestionAnswers: counts,
        gameOptions: { question_timer: true, answer_streak: true },
        upcomingGameBlockData: this.quiz.questions.map((q) => ({
          type: q.type,
          layout: q.layout || "DEFAULT",
          pointsMultiplier: q.pointsMultiplier,
          numberOfChoices: q.choices.length,
          timeAvailable: this.questionTimeMs || q.time || 20000,
        })),
      });
    }
    this.log(`game started: "${this.quiz.title}" (${this.quiz.questions.length} questions)`);
    this.#schedule(() => this.#startQuestion(0), 600);
  }

  /** End the current step as fast as possible (lobby -> start -> next question). */
  advance() {
    if (this.phase === "lobby") return this.startGame();
    if (this.phase === "ended") throw new Error("game already ended");
    if (this.phase === "question") return this.#endQuestion();
    // gap: jump straight to the next question
    if (this.pendingAdvance) {
      clearTimeout(this.pendingAdvance.timer);
      this.timers.delete(this.pendingAdvance.timer);
      this.pendingAdvance = null;
      this.#startQuestion(this.questionIndex + 1);
    }
    return undefined;
  }

  endGame() {
    if (this.phase === "lobby") return;
    if (this.phase === "question") {
      // settle the running question first
      this.#endQuestion(true);
    }
    if (this.phase === "ended") return;
    this.#finishGame();
  }

  #schedule(fn, ms) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  #startQuestion(index) {
    if (index >= this.quiz.questions.length) return this.#finishGame();
    this.phase = "question";
    this.questionIndex = index;
    const q = this.quiz.questions[index];
    const time = this.questionTimeMs || q.time || 20000;
    this.questionTime = time;
    this.questionStartAt = Date.now();
    const counts = this.quiz.questions.map(quizQuestionCount);
    for (const player of this.players.values()) {
      player.answered.delete(index);
      this.#toPlayer(player, 1, {
        questionIndex: index,
        timeAvailable: time,
        quizQuestionAnswers: counts,
      });
      this.#toPlayer(player, 2, {
        questionIndex: index,
        gameBlockIndex: index,
        totalGameBlockCount: this.quiz.questions.length,
        gameBlockType: q.type,
        gameBlockLayout: q.layout || "DEFAULT",
        type: q.type,
        layout: q.layout || "DEFAULT",
        timeAvailable: time,
        numberOfChoices: q.choices.length,
        quizQuestionAnswers: counts,
        question: q.question,
        choices: q.choices.map((c) => ({ answer: c.answer })),
        pointsMultiplier: q.pointsMultiplier,
      });
    }
    this.log(`Q${index + 1}/${this.quiz.questions.length}: ${q.question}`);
    this.#schedule(() => this.#endQuestion(), time);
  }

  #endQuestion(immediate = false) {
    if (this.phase !== "question") return;
    const index = this.questionIndex;
    const q = this.quiz.questions[index];
    this.phase = "gap";
    // cancel this question's auto-end timer (this.timers only holds game-flow timers)
    for (const timer of [...this.timers]) {
      clearTimeout(timer);
      this.timers.delete(timer);
    }
    for (const player of this.players.values()) {
      this.#toPlayer(player, 4, { questionIndex: index });
      const outcome = player.outcomes.get(index) || { correct: false, points: 0 };
      this.#toPlayer(player, 8, {
        questionIndex: index,
        isCorrect: outcome.correct,
        correctChoices: correctIndexes(q),
        rank: this.#rankOf(player),
        totalScore: player.score,
        pointsData: {
          questionPoints: outcome.points,
          totalPointsWithBonuses: player.score,
          totalPointsWithoutBonuses: player.score,
          answerStreakPoints: {
            streakLevel: player.correct,
            streakBonus: 0,
            totalStreakPoints: 0,
            previousStreakLevel: Math.max(0, player.correct - (outcome.correct ? 1 : 0)),
            previousStreakBonus: 0,
          },
          lastGameBlockIndex: index,
        },
      });
    }
    const next = index + 1;
    if (next >= this.quiz.questions.length) {
      this.#schedule(() => this.#finishGame(), immediate ? 0 : Math.max(300, this.questionGapMs));
      return;
    }
    const delay = immediate ? 200 : Math.max(300, this.questionGapMs);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.pendingAdvance = null;
      this.#startQuestion(next);
    }, delay);
    this.timers.add(timer);
    this.pendingAdvance = { timer, index };
    this.log(`Q${index + 1} answered: ${[...this.players.values()].filter((p) => p.answered.has(index)).length}/${this.players.size}`);
  }

  #finishGame() {
    if (this.phase === "ended") return;
    this.phase = "ended";
    this.pendingAdvance = null;
    const ranked = this.#rankedPlayers();
    for (const player of this.players.values()) {
      const rank = ranked.findIndex((p) => p.cid === player.cid) + 1;
      this.#toPlayer(player, 3, {
        quizId: this.quizUuid,
        quizTitle: this.quiz.title,
        quizName: this.quiz.title,
        gameBlockCount: this.quiz.questions.length,
      });
      this.#toPlayer(player, 13, {
        rank,
        totalScore: player.score,
        correctCount: player.correct,
        incorrectCount: player.answered.size - player.correct,
        podiumMedalType: rank === 1 ? "gold" : rank === 2 ? "silver" : rank === 3 ? "bronze" : null,
        quizId: this.quizUuid,
        quizTitle: this.quiz.title,
      });
    }
    this.log(`game over - winner: ${ranked[0] ? ranked[0].name : "(nobody)"} with ${ranked[0] ? ranked[0].score : 0}`);
  }

  #onAnswer(session, data) {
    const player = session.player;
    if (!player || this.phase !== "question") return;
    const index = this.questionIndex;
    let content;
    try {
      content = JSON.parse(data.content || "{}");
    } catch {
      return;
    }
    if (Number(content.questionIndex) !== index || player.answered.has(index)) return;
    const q = this.quiz.questions[index];
    const elapsed = Math.max(0, Math.min(this.questionTime, Date.now() - this.questionStartAt));
    const { correct: graded } = gradeAnswer(q, content);
    // only point-bearing question types score (polls/surveys/open never do)
    const correct = SCORABLE_TYPES.has(q.type) && graded;
    const points = correct
      ? Math.round((1 - (elapsed / this.questionTime) / 2) * 1000) * (q.pointsMultiplier || 1)
      : 0;
    player.answered.add(index);
    if (correct) player.correct += 1;
    player.outcomes.set(index, { correct, points });
    player.score += points;
    this.#toPlayer(player, 7, {
      questionIndex: index,
      totalScore: player.score,
      rank: this.#rankOf(player),
      points,
      isCorrect: correct,
      reactionTime: Math.round(elapsed),
    });
    this.log(`${player.name} answered Q${index + 1}: ${correct ? "correct" : "wrong"} (+${points})`);
  }

  /* ------------------------------------------------------------- helpers */

  #toPlayer(player, id, content) {
    const session = player.session;
    if (!session || !player.connected) return;
    this.#send(session, {
      channel: "/service/player",
      clientId: session.clientId,
      data: { id, content: JSON.stringify(content) },
    });
  }

  #rankedPlayers() {
    return [...this.players.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  #rankOf(player) {
    const ranked = this.#rankedPlayers();
    return ranked.findIndex((p) => p.cid === player.cid) + 1;
  }

  #broadcastRanks() {
    for (const player of this.players.values()) {
      this.#toPlayer(player, 7, { totalScore: player.score, rank: this.#rankOf(player) });
    }
  }

  #pruneSessions() {
    const now = Date.now();
    for (const [key, value] of this.sessions) {
      if (now - value.createdAt > SESSION_TTL_MS) this.sessions.delete(key);
    }
  }

  /** Machine readable snapshot (admin API + tests). */
  snapshot() {
    return {
      pin: this.pin,
      phase: this.phase,
      questionIndex: this.questionIndex,
      quiz: { title: this.quiz.title, uuid: this.quizUuid, questions: this.quiz.questions.length },
      players: this.#rankedPlayers().map((p, i) => ({
        rank: i + 1,
        cid: p.cid,
        name: p.name,
        score: p.score,
        correct: p.correct,
        answered: p.answered.size,
        connected: p.connected,
      })),
    };
  }
}

/* ------------------------------------------------------------------ utils */

/**
 * XOR two ASCII strings char-wise (the session token derivation).
 * @param {string} a
 * @param {string} b
 */
function xorChars(a, b) {
  let out = "";
  for (let i = 0; i < a.length; i++) {
    out += String.fromCharCode(a.charCodeAt(i) ^ b.charCodeAt(i % b.length));
  }
  return out;
}

function randomPin() {
  // Kahoot live pins are 7 digits; challenge pins start with 0
  return String(1000000 + Math.floor(Math.random() * 9000000));
}

/**
 * Value for `quizQuestionAnswers[i]`: how many choices the question has, or
 * null for free-form questions (Kahoot omits them there).
 * @param {object} q fixture question
 * @returns {number|null}
 */
function quizQuestionCount(q) {
  if (q.type === "open_ended" || q.type === "word_cloud" || q.type === "feedback") return null;
  return q.choices.length;
}

function correctIndexes(q) {
  if (q.type === "jumble") return q.choices.map((_, i) => i);
  return q.choices.reduce((acc, c, i) => (c.correct ? (acc.push(i), acc) : acc), []);
}

/**
 * Grade an answer packet against a fixture question.
 * @param {object} q fixture question
 * @param {{choice?:number|number[], text?:string, pin?:object}} content
 * @returns {{correct:boolean}}
 */
export function gradeAnswer(q, content) {
  const type = q.type || "quiz";
  if (type === "jumble") {
    const choice = Array.isArray(content.choice) ? content.choice.map(Number) : null;
    const expected = q.choices.map((_, i) => i);
    return { correct: Boolean(choice && choice.join(",") === expected.join(",")) };
  }
  if (type === "multiple_select_quiz") {
    const choice = Array.isArray(content.choice) ? content.choice.map(Number).sort((a, b) => a - b) : [];
    const expected = correctIndexes(q).sort((a, b) => a - b);
    return { correct: choice.length > 0 && choice.join(",") === expected.join(",") };
  }
  if (type === "quiz" || type === "true_false") {
    const expected = correctIndexes(q);
    const choice = Number(content.choice);
    return { correct: expected.length > 0 && choice === expected[0] };
  }
  if (type === "poll" || type === "survey" || type === "open_ended" || type === "word_cloud") {
    return { correct: true }; // no right answer, no points
  }
  return { correct: false };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 65536) req.destroy();
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/**
 * Convenience wrapper: start a server for a fixture path.
 * @param {ConstructorParameters<typeof MockKahootServer>[0]} opts
 * @returns {Promise<MockKahootServer>}
 */
export async function startMockServer(opts) {
  const server = new MockKahootServer(opts);
  await server.start();
  return server;
}
