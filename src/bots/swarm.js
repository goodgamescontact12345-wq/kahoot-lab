/**
 * A swarm of bots plus the local control endpoint used by `kahoot-lab score`
 * and `kahoot-lab watch` from another terminal.
 *
 * Control endpoint: a loopback TCP socket speaking newline-delimited JSON.
 * Its coordinates are published to `.kahoot-lab/ctl/<pin>.json` (with a
 * random token), so any command targeting the same PIN can find it.
 */

import net from "node:net";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { Bot } from "./bot.js";
import { buildNames } from "./names.js";
import { describePlan } from "../scores/scoring.js";

const CTL_DIR = path.join(".kahoot-lab", "ctl");

export class Swarm extends EventEmitter {
  /**
   * @param {{
   *   pin:string,
   *   baseUrl?:string,
   *   count?:number,
   *   names?:string[],
   *   pattern?:string,
   *   strategy?:string,
   *   accuracy?:number,
   *   delayMs?:number,
   *   jitterMs?:number,
   *   answers?:Array<object|null>,
   *   staggerMs?:number,
   *   twoFactor?:string,
   *   ctl?:boolean,
   *   log?:function
   * }} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.pin = String(opts.pin).replace(/\D/g, "");
    this.baseUrl = opts.baseUrl;
    this.strategy = opts.strategy || "correct";
    this.answers = opts.answers || null;
    this.staggerMs = opts.staggerMs ?? 400;
    this.log = opts.log || (() => {});
    this.bots = [];
    this.ctlServer = null;
    this.ctlFile = null;
    this.ctlToken = randomBytes(16).toString("hex");
    this.ctlPort = null;
    this.stopped = false;
  }

  /**
   * Create, stagger and join all bots.
   * @returns {Promise<Bot[]>}
   */
  async start() {
    const names = buildNames(this.opts);
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
      throw new Error("bot names must be unique");
    }
    const strategyList = this.opts.strategies
      ? (Array.isArray(this.opts.strategies)
          ? this.opts.strategies
          : String(this.opts.strategies).split(",").map((s) => s.trim()).filter(Boolean))
      : null;
    if (this.opts.ctl !== false) await this.#startCtl();

    for (const [i, name] of names.entries()) {
      if (i > 0) await sleep(this.staggerMs);
      if (this.stopped) break;
      const strategy = (strategyList && strategyList[i]) || this.opts.strategy || "correct";
      const bot = new Bot({
        name,
        baseUrl: this.baseUrl,
        answers: this.answers,
        strategy,
        accuracy: this.opts.accuracy ?? 1,
        delayMs: this.opts.delayMs ?? 600,
        jitterMs: this.opts.jitterMs ?? 800,
        twoFactor: this.opts.twoFactor,
        log: this.log,
      });
      bot.configure({ pin: this.pin, baseUrl: this.baseUrl, answers: this.answers });
      for (const event of ["answered", "score", "questionEnd", "quizStart", "gameOver", "kicked", "planSkipped", "scorePlan"]) {
        bot.on(event, (payload) => this.emit(event, { name: bot.name, ...payload }));
      }
      bot.on("error", (err) => this.emit("botError", { name: bot.name, error: String(err && err.message) }));
      this.bots.push(bot);
      try {
        await bot.start();
      } catch (err) {
        bot.state = "error";
        bot.error = String(err && err.message);
        this.emit("botError", { name: bot.name, error: bot.error });
      }
    }
    return this.bots;
  }

  /** @returns {Array<ReturnType<Bot['status']>>} */
  status() {
    return this.bots.map((b) => b.status());
  }

  /**
   * Hand the resolved answer book to every bot (also for questions already
   * in flight).
   * @param {Array<object|null>} answers
   */
  setAnswers(answers) {
    this.answers = answers || null;
    for (const bot of this.bots) bot.setAnswers(answers);
  }

  /**
   * Find a bot by (current or requested) name.
   * @param {string} name
   */
  find(name) {
    const wanted = String(name || "").toLowerCase();
    return (
      this.bots.find((b) => b.name.toLowerCase() === wanted) ||
      this.bots.find((b) => b.requestedName.toLowerCase() === wanted) ||
      null
    );
  }

  /**
   * Add/remove/set a bot's score.
   *
   * Raising is done by planning the remaining answers; lowering requires a
   * fresh session (a rejoin restarts the bot at 0 points) after which the new
   * target is planned.
   *
   * @param {string} name
   * @param {{add?:number, remove?:number, set?:number}} op
   * @returns {Promise<object>}
   */
  async adjust(name, op = {}) {
    const bot = this.find(name);
    if (!bot) {
      return {
        ok: false,
        error: `"${name}" is not a bot I control`,
        controlled: this.bots.map((b) => b.name),
      };
    }
    let target;
    if (typeof op.set === "number") target = Math.max(0, Math.round(op.set));
    else if (typeof op.add === "number") target = bot.score + Math.round(op.add);
    else if (typeof op.remove === "number") target = Math.max(0, bot.score - Math.round(op.remove));
    else return { ok: false, error: "give one of: add, remove, set" };

    const previousScore = bot.score;
    let rebuilt = false;
    if (target < bot.score) {
      await bot.rejoin();
      rebuilt = true;
    }
    if (target === bot.score) {
      return {
        ok: true,
        name: bot.name,
        previousScore,
        score: bot.score,
        rebuilt,
        feasible: true,
        message: "score already at target",
      };
    }
    const result = bot.applyTarget(target);
    if (result === null) {
      return {
        ok: true,
        name: bot.name,
        previousScore,
        target,
        rebuilt,
        deferred: true,
        message: "quiz has not started yet - target queued, applied when the quiz starts",
      };
    }
    return {
      ok: true,
      name: bot.name,
      previousScore,
      target,
      rebuilt,
      feasible: result.feasible,
      projectedScore: result.projectedScore,
      shortfall: result.shortfall,
      questionsUsed: result.plan.filter((p) => p.action === "answer").length,
      message: describePlan(result),
    };
  }

  /**
   * @returns {Promise<void>}
   */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const bot of this.bots) {
      try { bot.stop(); } catch { /* ignore */ }
    }
    await this.#stopCtl();
    this.emit("stopped");
  }

  /* ------------------------------------------------------------------ ctl */

  async #startCtl() {
    await mkdir(CTL_DIR, { recursive: true });
    this.ctlFile = path.join(CTL_DIR, `${this.pin}.json`);
    this.ctlServer = net.createServer((socket) => this.#handleCtl(socket));
    await new Promise((resolve, reject) => {
      this.ctlServer.once("error", reject);
      this.ctlServer.listen(0, "127.0.0.1", () => {
        this.ctlPort = this.ctlServer.address().port;
        resolve();
      });
    });
    await writeFile(
      this.ctlFile,
      JSON.stringify(
        { pin: this.pin, port: this.ctlPort, token: this.ctlToken, pid: process.pid, createdAt: Date.now() },
        null,
        2
      )
    );
  }

  #handleCtl(socket) {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let response;
        try {
          const msg = JSON.parse(line);
          if (msg.token !== this.ctlToken) response = { ok: false, error: "bad token" };
          else response = await this.#ctlCommand(msg);
        } catch (err) {
          response = { ok: false, error: String(err && err.message) };
        }
        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
    socket.on("error", () => { /* ignore */ });
  }

  /**
   * @param {{cmd:string, name?:string, add?:number, remove?:number, set?:number}} msg
   */
  async #ctlCommand(msg) {
    switch (msg.cmd) {
      case "ping":
        return { ok: true, pin: this.pin, bots: this.bots.length };
      case "status":
        return { ok: true, pin: this.pin, bots: this.status() };
      case "adjust":
        return this.adjust(msg.name, { add: msg.add, remove: msg.remove, set: msg.set });
      case "stop":
        setTimeout(() => this.stop().catch(() => {}), 50);
        return { ok: true, stopping: true };
      default:
        return { ok: false, error: `unknown command: ${msg.cmd}` };
    }
  }

  async #stopCtl() {
    if (this.ctlServer) {
      await new Promise((resolve) => this.ctlServer.close(resolve));
      this.ctlServer = null;
    }
    if (this.ctlFile && existsSync(this.ctlFile)) {
      await unlink(this.ctlFile).catch(() => {});
      this.ctlFile = null;
    }
  }
}

/**
 * @param {ConstructorParameters<typeof Swarm>[0]} opts
 * @returns {Promise<Swarm>}
 */
export async function startSwarm(opts) {
  const swarm = new Swarm(opts);
  await swarm.start();
  return swarm;
}

/* -------------------------------------------------------------- ctl client */

/**
 * Read a swarm's control file for a PIN.
 * @param {string} pin
 * @returns {{file:string, port:number, token:string, pid:number}|null}
 */
export function readCtl(pin) {
  const file = path.join(CTL_DIR, `${String(pin).replace(/\D/g, "")}.json`);
  if (!existsSync(file)) return null;
  try {
    const info = JSON.parse(readFileSync(file, "utf8"));
    if (typeof info.port !== "number" || !info.token) return null;
    return { file, ...info };
  } catch {
    return null;
  }
}

/**
 * Send one command to a swarm control endpoint.
 * @param {{port:number, token:string}} ctl
 * @param {object} msg
 * @returns {Promise<object>}
 */
export function ctlRequest(ctl, msg) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: ctl.port }, () => {
      socket.write(`${JSON.stringify({ ...msg, token: ctl.token })}\n`);
    });
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("control request timed out"));
    }, 15000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (err) {
        reject(err);
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
