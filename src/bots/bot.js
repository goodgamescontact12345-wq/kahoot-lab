/**
 * A single Kahoot bot: reserves a session, joins a game, answers questions
 * according to a strategy (or a precise score plan) and reports events.
 */

import { EventEmitter } from "node:events";
import { reserveSession, websocketUrls } from "../protocol/session.js";
import { CometClient } from "../protocol/comet.js";
import { loginPacket, joinVerifyPacket, answerPacket, twoFactorPacket } from "../protocol/packets.js";
import { planScore, timingFor, MIN_REACTION_MS, END_MARGIN_MS } from "../scores/scoring.js";

/** Answer strategies understood by the CLI/bots. */
export const STRATEGIES = ["correct", "random", "dumb", "slow", "skip"];

export class Bot extends EventEmitter {
  /**
   * @param {{
   *   name:string,
   *   baseUrl?:string,
   *   answers?:Array<object|null>,
   *   strategy?:string,
   *   accuracy?:number,
   *   delayMs?:number,
   *   jitterMs?:number,
   *   twoFactor?:string,
   *   log?:function
   * }} opts
   */
  constructor(opts) {
    super();
    this.name = opts.name;
    this.requestedName = opts.name;
    this.baseUrl = opts.baseUrl;
    this.answers = opts.answers || null;
    this.strategy = opts.strategy || "correct";
    this.accuracy = opts.accuracy ?? 1;
    this.delayMs = opts.delayMs ?? 600;
    this.jitterMs = opts.jitterMs ?? 800;
    this.twoFactor = opts.twoFactor || "";
    this.log = opts.log || (() => {});

    this.client = null;
    this.state = "idle"; // idle|connecting|lobby|playing|done|error|kicked
    this.score = 0;
    this.correct = 0;
    this.rank = null;
    this.currentIndex = -1;
    this.currentQuestion = null;
    this.quizMeta = null;
    /** @type {Map<number, {points:number, action:string}>} */
    this.plan = new Map();
    this.pendingTarget = null;
    this.answeredIndices = new Set();
    this.error = null;
    this.answerLog = [];
  }

  /**
   * Reserve + connect + join.
   * @returns {Promise<void>}
   */
  async start() {
    this.state = "connecting";
    const reserved = await reserveSession(this.#pin(), { baseUrl: this.baseUrl });
    this.client = new CometClient({ urls: websocketUrls(reserved) });
    this.#wire(this.client);
    await this.client.open();
    const ack = await this.client.publish(
      loginPacket({ gameid: this.#pin(), name: this.name, userAgent: "kahoot-lab bot" }),
      { expectAck: true, timeoutMs: 10000 }
    );
    const data = (ack && ack.data) || {};
    if (data.error && String(data.description || "").toLowerCase().includes("duplicate")) {
      this.name = `${this.requestedName}-${Math.floor(Math.random() * 900 + 100)}`;
      await this.client.publish(
        loginPacket({ gameid: this.#pin(), name: this.name, userAgent: "kahoot-lab bot" }),
        { expectAck: true, timeoutMs: 10000 }
      );
    } else if (data.error) {
      const err = new Error(`join rejected: ${data.description || data.error}`);
      this.state = "error";
      this.error = err.message;
      throw err;
    }
    await this.client.publish(
      joinVerifyPacket({ gameid: this.#pin(), usingNamerator: Boolean(reserved.body && reserved.body.namerator) })
    );
    if (this.state === "connecting") this.state = "lobby";
    this.emit("joined", { name: this.name });
  }

  #pin() {
    if (!this._pin) throw new Error("bot has no PIN - call configure({pin}) first");
    return this._pin;
  }

  /**
   * @param {{pin:string, baseUrl?:string, answers?:Array<object|null>}} opts
   */
  configure(opts) {
    if (opts.pin) this._pin = String(opts.pin).replace(/\D/g, "");
    if (opts.baseUrl) this.baseUrl = opts.baseUrl;
    if (opts.answers) this.answers = opts.answers;
    return this;
  }

  #wire(client) {
    client.on("event", (event) => {
      try {
        this.#onEvent(event);
      } catch (err) {
        this.emit("error", err);
      }
    });
    client.on("close", () => {
      if (this.state === "done" || this.state === "kicked") return;
      if (this.state === "connecting") return;
      this.state = this.state === "lobby" ? "error" : this.state;
      this.emit("left");
    });
    client.on("error", (err) => {
      this.error = String(err && err.message);
      this.emit("error", err);
    });
  }

  /** @param {import('../protocol/events.js').DecodedEvent} event */
  #onEvent(event) {
    switch (event.name) {
      case "nameAccept":
        this.state = "lobby";
        this.emit("lobby", event.content);
        break;

      case "quizStart": {
        const content = event.content || {};
        this.quizMeta = {
          title: content.quizName || content.quizTitle || null,
          questionCount: content.gameBlockCount ||
            (Array.isArray(content.quizQuestionAnswers) ? content.quizQuestionAnswers.length : null),
          shape: content.quizQuestionAnswers || null,
          multipliers: (content.upcomingGameBlockData || []).map((q) => q.pointsMultiplier || 1),
          times: (content.upcomingGameBlockData || []).map((q) => q.timeAvailable || null),
        };
        // a new game starts from question 0: clear the per-game answer
        // bookkeeping so questions already answered in a previous run of the
        // quiz are answered again (mid-game rejoins never see quizStart, so
        // their progress still survives)
        if (this._answerTimer) {
          clearTimeout(this._answerTimer);
          this._answerTimer = null;
        }
        this.answeredIndices = new Set();
        this.currentIndex = -1;
        this.currentQuestion = null;
        this.plan = new Map();
        this.state = "playing";
        if (this.pendingTarget != null && this.quizMeta.questionCount) {
          const target = this.pendingTarget;
          this.pendingTarget = null;
          const result = this.applyTarget(target);
          if (result) this.emit("scorePlan", result);
        }
        this.emit("quizStart", this.quizMeta);
        break;
      }

      case "questionStart": {
        const content = event.content || {};
        this.currentIndex = Number(content.questionIndex ?? content.gameBlockIndex ?? 0);
        this.currentQuestion = content;
        this.#scheduleAnswer(content);
        this.emit("questionStart", content);
        break;
      }

      case "answerResponse": {
        const content = event.content || {};
        if (typeof content.totalScore === "number") this.score = content.totalScore;
        if (content.rank) this.rank = content.rank;
        this.emit("score", { score: this.score, rank: this.rank, content });
        break;
      }

      case "questionEnd": {
        const content = event.content || {};
        if (typeof content.totalScore === "number") this.score = content.totalScore;
        if (content.rank) this.rank = content.rank;
        if (content.isCorrect) this.correct += 1;
        this.emit("questionEnd", content);
        break;
      }

      case "timeOver":
        this.emit("timeOver", event.content);
        break;

      case "quizEnd":
        this.emit("quizEnd", event.content);
        break;

      case "podium": {
        this.state = "done";
        const content = event.content || {};
        if (typeof content.totalScore === "number") this.score = content.totalScore;
        if (content.rank) this.rank = content.rank;
        this.emit("gameOver", { name: this.name, score: this.score, rank: this.rank, correct: this.correct });
        break;
      }

      case "disconnect":
        this.state = "kicked";
        this.emit("kicked", event.content);
        break;

      case "twoFactorReset":
        this.emit("twoFactorRequired");
        if (this.twoFactor && this.client) {
          const sequence = this.twoFactor.split("").map((ch) => "rbyg".indexOf(ch.toLowerCase()));
          if (sequence.every((n) => n >= 0)) {
            this.client.publish(twoFactorPacket({ gameid: this.#pin(), sequence }));
          }
        }
        break;

      case "twoFactorCorrect":
        this.emit("twoFactorCorrect");
        break;

      default:
        break;
    }
  }

  /**
   * Pick what to send for the current question and when.
   * @param {object} content questionStart content
   */  #scheduleAnswer(content) {
    const index = this.currentIndex;
    const type = content.gameBlockType || content.type || "quiz";
    const timeMs = Number(content.timeAvailable) || 20000;
    const planEntry = this.plan.get(index);
    // a planned "skip" means the score must hold - do not answer at all
    if (planEntry && planEntry.action !== "answer") return;
    const planned = planEntry || null;

    if (this.strategy === "skip" && !planned) return;
    if (this.answeredIndices.has(index)) return;

    let choice;
    if (planned) {
      const answer = this.#knownAnswer(index);
      if (!answer) {
        // cannot guarantee points without knowing the answer
        this.emit("planSkipped", { index, reason: "answers unknown for this question" });
        return;
      }
      choice = answer.order ? answer.order : answer.choices ? answer.choices : answer.choice;
    } else {
      choice = this.#strategyChoice(index, type, content);
      if (choice == null) return; // skip
    }

    let delay;
    if (planned) {
      delay = planned.points != null
        ? timingFor({ points: planned.points, timeMs, pointsMultiplier: planned.multiplier || content.pointsMultiplier || 1 })
        : planned.elapsedMs;
      delay = clamp(delay ?? this.#strategyDelay(timeMs), MIN_REACTION_MS, Math.max(MIN_REACTION_MS, timeMs - END_MARGIN_MS));
    } else {
      delay = this.#strategyDelay(timeMs);
    }

    const lag = Math.max(1, this.client ? this.client.networkLag : 1);
    const timer = setTimeout(() => {
      this.#sendAnswer(index, type, choice, timeMs, planned);
    }, Math.max(0, delay - lag / 2));
    this._answerTimer = timer;
  }

  #strategyDelay(timeMs) {
    const base = this.delayMs + Math.random() * this.jitterMs;
    if (this.strategy === "slow") {
      return clamp(Math.max(base, timeMs - 400 - Math.random() * 800), MIN_REACTION_MS, Math.max(MIN_REACTION_MS, timeMs - 250));
    }
    return clamp(base, MIN_REACTION_MS, Math.max(MIN_REACTION_MS, timeMs - 500));
  }

  /**
   * @param {number} index
   * @param {string} type
   * @param {object} content
   * @returns {number|number[]|string|null} choice payload, null = don't answer
   */
  #strategyChoice(index, type, content) {
    const n = Number(content.numberOfChoices) || 4;

    if (type === "word_cloud" || type === "open_ended" || type === "feedback") {
      return type === "feedback" ? "Great" : `${this.name} says hi`;
    }

    // "dumb": never look at the answers, always the first plausible option
    if (this.strategy === "dumb") {
      if (type === "jumble") return [3, 2, 1, 0]; // deterministic wrong order
      if (type === "multiple_select_quiz" || type === "multiple_select_poll") return [0];
      return 0;
    }

    // "random": pure random choice
    if (this.strategy === "random") {
      if (type === "jumble") return shuffle([0, 1, 2, 3]);
      if (type === "multiple_select_quiz" || type === "multiple_select_poll") {
        return [Math.floor(Math.random() * n)];
      }
      return Math.floor(Math.random() * n);
    }

    const known = this.#knownAnswer(index);
    const accurate = this.accuracy >= 1 || Math.random() < this.accuracy;

    if (type === "poll" || type === "survey") {
      return Math.floor(Math.random() * n);
    }
    if (type === "jumble") {
      if (known && known.order && accurate) return known.order;
      return shuffle([0, 1, 2, 3]);
    }
    if (type === "multiple_select_quiz" || type === "multiple_select_poll") {
      if (known && known.choices && accurate) return known.choices;
      return [Math.floor(Math.random() * n)];
    }
    if (known && accurate) return known.choice ?? 0;
    if (known) {
      // deliberately wrong when accuracy says so
      const wrong = [];
      for (let i = 0; i < n; i++) if (i !== known.choice) wrong.push(i);
      return wrong.length ? wrong[Math.floor(Math.random() * wrong.length)] : 0;
    }
    return Math.floor(Math.random() * n);
  }

  #knownAnswer(index) {
    if (!this.answers) return null;
    const plan = this.answers[index];
    if (plan === undefined || plan === null) return null;
    if (plan.order) return { order: plan.order };
    if (plan.choices) return { choices: plan.choices, choice: plan.choices[0] };
    if (typeof plan.choice === "number") return { choice: plan.choice };
    return null;
  }

  #sendAnswer(index, type, choice, timeMs, planned) {
    if (!this.client || this.answeredIndices.has(index)) return;
    const payload = { questionIndex: index, type, lag: Math.round(this.client.networkLag || 1) };
    if (Array.isArray(choice)) payload.choice = choice;
    else if (typeof choice === "string") payload.text = choice;
    else payload.choice = choice;
    this.answeredIndices.add(index);
    this.client
      .publish(answerPacket({ gameid: this.#pin(), ...payload }))
      .then(() => {
        const entry = {
          index,
          choice: payload.choice ?? payload.text,
          plannedPoints: planned ? planned.points : null,
          delay: timeMs,
        };
        this.answerLog.push(entry);
        this.emit("answered", entry);
      })
      .catch((err) => this.emit("error", err));
  }

  /**
   * Update the answer book (possibly after the bot already joined). Re-runs
   * the answer decision for a question that has not been answered yet.
   * @param {Array<object|null>} answers
   */
  setAnswers(answers) {
    this.answers = answers || null;
    if (
      this.state === "playing" &&
      this.currentQuestion &&
      this.currentIndex >= 0 &&
      !this.answeredIndices.has(this.currentIndex)
    ) {
      if (this._answerTimer) clearTimeout(this._answerTimer);
      this.#scheduleAnswer(this.currentQuestion);
    }
  }

  /**
   * Apply a score target (from the score planner). When the quiz has not
   * started yet the target is applied on quizStart.
   * @param {number} target desired final score
   * @returns {{feasible:boolean, projectedScore:number, shortfall:number, plan:Array}|null}
   */
  applyTarget(target) {
    if (!this.quizMeta || !this.quizMeta.questionCount) {
      this.pendingTarget = target;
      return null;
    }
    const remaining = this.remainingQuestions();
    const result = planScore({
      current: this.score,
      target,
      questions: remaining,
    });
    this.plan = new Map(result.plan.map((p) => [p.questionIndex, p]));
    return result;
  }

  /**
   * Questions that have not been answered yet (from the bot's perspective).
   * @returns {Array<{timeMs:number, pointsMultiplier:number, questionIndex:number}>}
   */
  remainingQuestions() {
    const meta = this.quizMeta || { questionCount: 0, multipliers: [], times: [] };
    const total = meta.questionCount || 0;
    const fallbackTime = (this.currentQuestion && Number(this.currentQuestion.timeAvailable)) || 20000;
    const out = [];
    for (let i = Math.max(0, this.currentIndex); i < total; i++) {
      if (this.answeredIndices.has(i)) continue;
      out.push({
        questionIndex: i,
        timeMs: meta.times[i] || fallbackTime,
        pointsMultiplier: meta.multipliers[i] || 1,
      });
    }
    return out;
  }

  /**
   * Leave and rejoin with the same name - a rejoin starts from 0 points.
   * @returns {Promise<void>}
   */
  async rejoin() {
    if (this._answerTimer) clearTimeout(this._answerTimer);
    if (this.client) this.client.close();
    // a rejoin is a brand new participant: 0 points, but the *game* progress
    // (which questions exist / which are already played) is kept so the new
    // session can plan the remaining questions.
    this.score = 0;
    this.correct = 0;
    this.rank = null;
    this.currentQuestion = null;
    this.plan = new Map();
    this.state = "idle";
    this.emit("rejoining");
    await new Promise((r) => setTimeout(r, 300));
    await this.start();
  }

  /** Stop the bot (leave game). */
  stop() {
    if (this._answerTimer) clearTimeout(this._answerTimer);
    if (this.client) this.client.close();
    this.state = "stopped";
  }

  /** Machine readable status. */
  status() {
    return {
      name: this.name,
      requestedName: this.requestedName,
      state: this.state,
      score: this.score,
      correct: this.correct,
      rank: this.rank,
      question: this.currentIndex + 1,
      strategy: this.strategy,
      error: this.error,
    };
  }
}

/* ------------------------------------------------------------------ utils */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
