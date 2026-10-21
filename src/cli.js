/**
 * kahoot-lab command line interface.
 *
 * Commands:
 *   solve  <pin>            reveal the answers of a quiz/game
 *   bots   <pin>            spawn answer bots into a game
 *   score  <pin>            add/remove/set points (test host or my bots)
 *   watch  <pin>            live scoreboard
 *   mock   <quiz.json>      run a local Kahoot-compatible test game
 *   serve                    web UI + JSON API (browser control panel)
 *   quiz   search|fetch     look up public quizzes / export them as fixtures
 */

import { mkdir, writeFile, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { resolveQuizAnswers } from "./answers/resolve.js";
import { searchQuizzes, fetchQuiz, extractAnswers } from "./answers/kahoot-api.js";
import { formatAnswerSheet, formatScoreboard, makeColorizer } from "./answers/format.js";
import { startSwarm, readCtl } from "./bots/swarm.js";
import { adjustScore, fetchScoreboard, probeTestHost } from "./scores/controller.js";
import { MockKahootServer } from "./host/mock-server.js";
import { loadQuiz, fromKahootQuiz } from "./host/quiz-loader.js";
import { KahootError } from "./protocol/session.js";

const MOCK_FILE = path.join(".kahoot-lab", "mock.json");

const USAGE = `kahoot-lab - a Kahoot testing utility

Usage:
  kahoot-lab solve <pin> [--quiz <uuid>] [--title <name>] [--wait <sec>]
  kahoot-lab bots <pin> [--count <n>] [--pattern <p>] [--strategy correct|random|dumb|slow|skip]
                        [--strategies s1,s2,...] [--accuracy <0..1>] [--names a,b,c]
                        [--quiz <uuid>] [--title <name>]
                        [--score <name>:+800]... [--duration <sec>] [--no-answers]
  kahoot-lab score <pin> --player <name> (--add <n>|--remove <n>|--set <n>)
  kahoot-lab watch <pin> [--once] [--interval <sec>]
  kahoot-lab mock <quiz.json> [--port <n>] [--pin <pin>] [--auto-start <sec>|--manual]
                        [--question-time <ms>] [--gap <ms>] [--loop]
  kahoot-lab serve [--port <n>] [--bind <addr>]   web UI + API (default http://127.0.0.1:4380)
  kahoot-lab quiz search "<query>"
  kahoot-lab quiz fetch <uuid|url|title> [--out <file>]

Common options:
  --host <url>    game base URL (default https://kahoot.it, or a local mock)
  --api <url>     quiz API base (default https://create.kahoot.it, same as --host when local)
  --json          machine readable output
  --no-color      disable ANSI colors
  -h, --help      show this help

Examples:
  kahoot-lab quiz fetch "capitals of the world" --out world.json
  kahoot-lab mock world.json                 # -> PIN 4711035
  kahoot-lab bots 4711035 --count 5
  kahoot-lab solve 4711035
  kahoot-lab score 4711035 --player "Bot 1" --add 1500
  kahoot-lab watch 4711035 --once
`;

/**
 * Tiny argument parser: --key value | --key=value | --flag | positional.
 * @param {string[]} argv
 */
const BOOLEAN_FLAGS = new Set([
  "help", "json", "noColor", "verbose", "once", "manual", "loop", "stay",
  "noAnswers", "noJoin", "quiet",
]);

export function parseArgs(argv) {
  const opts = { _: [], multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      let key, value;
      if (eq >= 0) {
        key = arg.slice(2, eq);
        value = arg.slice(eq + 1);
      } else {
        key = arg.slice(2);
        const next = argv[i + 1];
        if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
          value = next;
          i++;
        } else {
          value = true;
        }
      }
      const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (camel === "score") {
        (opts.multi.score ||= []).push(value);
      } else {
        opts[camel] = value;
      }
      continue;
    }
    opts._.push(arg);
  }
  return opts;
}

/**
 * Resolve game + quiz API bases (and whether we are talking to a local host).
 * Auto-discovers a local test host started for this exact PIN (the mock
 * publishes `.kahoot-lab/mock.json`), verifying it is actually alive.
 * @param {object} opts
 */
export async function resolveBases(opts) {
  const envHost = process.env.KAHOOT_LAB_HOST;
  let host = opts.host || envHost || null;
  let discovered = false;
  if (!host && opts._[1] && existsSync(MOCK_FILE)) {
    try {
      const mock = JSON.parse(readFileSync(MOCK_FILE, "utf8"));
      const pin = String(opts._[1]).replace(/\D/g, "");
      if (mock.pin === pin && (await probeTestHost(mock.baseUrl))) {
        host = mock.baseUrl;
        discovered = true;
      }
    } catch { /* stale mock file - fall through to the real Kahoot */ }
  }
  host = host || "https://kahoot.it";
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(host);
  const api = opts.api || (isLocal ? host : "https://create.kahoot.it");
  return { host: host.replace(/\/+$/, ""), api: api.replace(/\/+$/, ""), isLocal, discovered };
}

function numberize(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseScoreSpecs(specs = []) {
  return specs.map((spec) => {
    const match = String(spec).match(/^(.*?):\s*([+-]\d+|\d+)$/);
    if (!match) throw new Error(`--score expects "name:+1000" (got "${spec}")`);
    const points = Number(match[2]);
    return { name: match[1].trim(), op: points >= 0 ? { add: points } : { remove: -points } };
  });
}

function printer(opts) {
  const color = makeColorizer({ noColor: Boolean(opts.noColor) });
  if (opts.json) {
    return { info: () => {}, data: (obj) => console.log(JSON.stringify(obj)), color };
  }
  return {
    info: (line = "") => console.log(line),
    data: (obj) => console.log(JSON.stringify(obj, null, 2)),
    color,
  };
}

/* ------------------------------------------------------------------ solve */

async function cmdSolve(opts, out) {
  const pin = opts._[1];
  const quizId = normalizeQuizId(opts.quiz);
  const title = opts.title;
  if (!pin && !quizId && !title) {
    out.info(USAGE);
    process.exitCode = 1;
    return;
  }
  const { host, api } = await resolveBases(opts);
  const waitSec = numberize(opts.wait) ?? 180;
  const started = Date.now();

  let source;
  let quiz = null;
  let answers = null;

  // a running local test host can answer instantly (no join needed)
  if (!quizId && !title && pin) {
    const state = await probeTestHost(host);
    if (state && state.pin === String(pin).replace(/\D/g, "")) {
      quiz = await fetchQuiz(state.quiz.uuid, { apiBase: api });
      answers = extractAnswers(quiz);
      source = "test-host";
    }
  }

  if (!quiz) {
    const result = await resolveQuizAnswers({
      pin: pin ? String(pin).replace(/\D/g, "") : undefined,
      quizId,
      quizTitle: title,
      baseUrl: host,
      apiBase: api,
      waitMs: waitSec * 1000,
      log: (line) => !opts.json && out.info(out.color("dim", `… ${line}`)),
    });
    quiz = result.quiz;
    answers = result.answers;
    source = result.source;
  }

  if (opts.json) {
    out.data({
      source,
      title: quiz.title,
      questions: (quiz.questions || []).map((q, i) => ({
        index: i + 1,
        question: q.question,
        type: q.type,
        answer: serializeAnswer(answers[i], q),
      })),
      elapsedMs: Date.now() - started,
    });
    return;
  }
  out.info(formatAnswerSheet({ quiz, answers, noColor: Boolean(opts.noColor) }));
  out.info(out.color("dim", `source: ${source}`));
}

function normalizeQuizId(value) {
  if (!value) return undefined;
  const str = String(value);
  const uuid = str.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuid ? uuid[0] : str;
}

function serializeAnswer(plan, question) {
  if (!plan) return null;
  if (plan.order) return { type: "jumble", order: plan.order.map((i) => question.choices[i].answer) };
  const indexes = plan.choices || [plan.choice];
  return { type: plan.type, indexes, choices: indexes.map((i) => (question.choices[i] || {}).answer) };
}

/* ------------------------------------------------------------------- bots */

async function cmdBots(opts, out) {
  const pin = String(opts._[1] || "").replace(/\D/g, "");
  if (!pin) {
    out.info(USAGE);
    process.exitCode = 1;
    return;
  }
  const { host, api, discovered } = await resolveBases(opts);
  if (discovered) out.info(out.color("dim", `… using local test host ${host}`));

  const count = numberize(opts.count) ?? 1;
  const names = opts.names ? String(opts.names).split(",").map((s) => s.trim()).filter(Boolean) : null;
  const strategy = opts.strategy || "correct";
  if (!["correct", "random", "dumb", "slow", "skip"].includes(strategy)) {
    throw new Error(`unknown strategy "${strategy}" (use correct|random|dumb|slow|skip)`);
  }
  const strategies = opts.strategies
    ? String(opts.strategies).split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  if (strategies) {
    for (const s of strategies) {
      if (!["correct", "random", "dumb", "slow", "skip"].includes(s)) {
        throw new Error(`unknown strategy "${s}" (use correct|random|dumb|slow|skip)`);
      }
    }
  }

  const swarm = await startSwarm({
    pin,
    baseUrl: host,
    count,
    names,
    pattern: opts.pattern || "{name} {i}",
    strategy,
    strategies,
    accuracy: numberize(opts.accuracy) ?? 1,
    delayMs: numberize(opts.delay) ?? 600,
    jitterMs: numberize(opts.jitter) ?? 800,
    staggerMs: numberize(opts.stagger) ?? 400,
    twoFactor: opts.twoFactor,
    ctl: opts.ctl !== "false",
    log: (line) => !opts.json && opts.verbose && out.info(out.color("dim", `… ${line}`)),
  });

  const joined = swarm.bots.filter((b) => b.state === "lobby" || b.state === "playing").length;
  if (opts.json) out.data({ pin, host, joined, bots: swarm.status() });
  else {
    out.info(
      out.color(joined === swarm.bots.length ? "green" : "yellow",
        `${joined}/${swarm.bots.length} bots joined PIN ${pin}`) +
        (joined < swarm.bots.length
          ? `\n${swarm.bots.filter((b) => b.state === "error").map((b) => `  ! ${b.name}: ${b.error}`).join("\n")}`
          : "")
    );
    if (readCtl(pin)) out.info(out.color("dim", `control endpoint ready - try: kahoot-lab score ${pin} --player "${swarm.bots[0]?.name}" --add 1000`));
  }

  // deferred score targets (applied once, when the quiz starts)
  const scoreSpecs = parseScoreSpecs(opts.multi.score);
  let announcedStart = false;
  swarm.on("quizStart", async (meta) => {
    if (announcedStart) return;
    announcedStart = true;
    for (const spec of scoreSpecs) {
      try {
        const res = await swarm.adjust(spec.name, spec.op);
        if (!opts.json) out.info(out.color("cyan", `score target ${spec.name}: ${JSON.stringify(spec.op)} -> ${res.message || res.error}`));
      } catch (err) {
        if (!opts.json) out.info(out.color("red", `score target failed: ${err.message}`));
      }
    }
    if (!opts.json) {
      out.info(out.color("bold", `quiz started: ${meta.title || "?"} (${meta.questionCount || "?"} questions)`));
    }
  });
  swarm.on("scorePlan", (plan) => {
    if (opts.json) return;
    out.info(
      out.color(plan.feasible ? "cyan" : "yellow", `score plan applied: ${plan.message || JSON.stringify(plan)}`)
    );
  });

  // answers: resolve in the background as soon as the quiz identity is known
  const noAnswers = Boolean(opts.noAnswers) || opts.answers === "false";
  if (!noAnswers) {
    resolveAnswersForSwarm({ pin, quizId: opts.quiz, title: opts.title, host, api, waitSec: numberize(opts.wait) ?? 180, swarm, out, opts });
  }

  if (!opts.json) {
    swarm.on("answered", (p) => {
      if (opts.verbose) out.info(out.color("dim", `${p.name} answered Q${p.index + 1}`));
    });
    swarm.on("questionEnd", (p) => {
      if (opts.json) return;
      const bot = swarm.find(p.name);
      if (bot) {
        out.info(
          `  ${p.name}: Q${(p.questionIndex ?? -1) + 1} ${p.isCorrect ? out.color("green", "correct") : out.color("red", "wrong")} ` +
            `· total ${out.color("bold", String(bot.score))} (rank ${p.rank})`
        );
      }
    });
    swarm.on("gameOver", (p) => {
      out.info(out.color("yellow", `game over - ${p.name}: ${p.score} points (rank ${p.rank})`));
    });
    swarm.on("botError", (p) => out.info(out.color("red", `! ${p.name}: ${p.error}`)));
    swarm.on("kicked", (p) => out.info(out.color("red", `${p.name} was kicked`)));
  }

  // lifetime
  const durationSec = numberize(opts.duration);
  const stop = async (signal) => {
    if (!opts.json) out.info(`\nstopping bots (${signal})…`);
    const finalStatus = swarm.status();
    if (!opts.json) out.info(formatScoreboard(finalStatus.map((b) => ({ name: b.name, score: b.score, correct: b.correct, isBot: true })), { noColor: Boolean(opts.noColor), title: "Bot scores" }));
    await swarm.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  if (durationSec) setTimeout(() => stop("--duration"), durationSec * 1000);

  const waitForGameEnd = new Promise((resolve) => {
    swarm.on("gameOver", () => resolve("gameOver"));
    swarm.on("stopped", () => resolve("stopped"));
  });
  const winner = await waitForGameEnd;
  if (winner === "gameOver" && opts.stay !== true && opts.stay !== "true") {
    await stop("game over");
  }
}
/**
 * Resolve quiz answers and push them to every bot (also handles answers
 * arriving after the bots already joined).
 */
function resolveAnswersForSwarm({ pin, quizId, title, host, api, waitSec, swarm, out, opts }) {
  resolveQuizAnswers({
    pin: quizId || title ? undefined : pin,
    quizId: quizId ? normalizeQuizId(quizId) : undefined,
    quizTitle: title,
    baseUrl: host,
    apiBase: api,
    waitMs: waitSec * 1000,
    log: (line) => !opts.json && opts.verbose && out.info(out.color("dim", `… ${line}`)),
  })
    .then((result) => {
      for (const bot of swarm.bots) bot.setAnswers(result.answers);
      if (!opts.json) {
        out.info(out.color("green", `answers loaded: "${result.quiz.title}" (${result.answers.filter(Boolean).length}/${result.answers.length} answerable)`));
      }
    })
    .catch((err) => {
      if (!opts.json) {
        out.info(
          out.color("yellow", `answers unavailable (${err.message}) - bots will play by strategy: ${opts.strategy || "correct"} falls back to random`)
        );
      }
    });
}

/* ------------------------------------------------------------------ score */

async function cmdScore(opts, out) {
  const pin = String(opts._[1] || "").replace(/\D/g, "");
  if (!pin) {
    out.info(USAGE);
    process.exitCode = 1;
    return;
  }
  const { host } = await resolveBases(opts);
  const result = await adjustScore({
    pin,
    player: opts.player,
    add: numberize(opts.add),
    remove: numberize(opts.remove),
    set: numberize(opts.set),
    baseUrl: host,
  });
  if (opts.json) {
    out.data(result);
    if (!result.ok) process.exitCode = 1;
  } else if (result.ok) {
    out.info(
      out.color("green", "ok") +
        ` - ${result.message || `${result.name}: ${result.previousScore} -> ${result.score}`}` +
        (result.rebuilt ? out.color("dim", " (rejoined with a fresh score)") : "") +
        (result.deferred ? out.color("dim", " (queued until the quiz starts)") : "")
    );
    if (result.feasible === false) {
      out.info(out.color("yellow", `warning: ${result.message}`));
    }
    if (result.source === "swarm" && !result.deferred) {
      out.info(out.color("dim", "note: live scores accumulate - the target is banked over the remaining questions"));
    }
  } else {
    out.info(out.color("red", `error: ${result.error}`));
    if (result.players) out.info(out.color("dim", `players in game: ${result.players.join(", ")}`));
    if (result.controlled) out.info(out.color("dim", `bots I control: ${result.controlled.join(", ")}`));
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ watch */

async function cmdWatch(opts, out) {
  const pin = String(opts._[1] || "").replace(/\D/g, "");
  if (!pin) {
    out.info(USAGE);
    process.exitCode = 1;
    return;
  }
  const { host, discovered } = await resolveBases(opts);
  if (discovered && !opts.json) out.info(out.color("dim", `… watching via local test host ${host}`));
  const intervalSec = numberize(opts.interval) ?? 2;
  const once = Boolean(opts.once) || opts.once === "true";

  const renderOnce = async () => {
    const board = await fetchScoreboard({ pin, baseUrl: host });
    if (!board) {
      return false;
    }
    if (opts.json) {
      out.data(board);
      return true;
    }
    const header =
      board.source === "test-host"
        ? `Scoreboard · ${board.quiz ? board.quiz.title : ""} · phase ${board.phase}` +
          (board.questionIndex >= 0 ? ` · Q${board.questionIndex + 1}` : "")
        : "Bot scores (swarm)";
    const lines = formatScoreboard(
      board.players.map((p) => ({ name: p.name, score: p.score, correct: p.correct, isBot: Boolean(p.isBot) })),
      { noColor: Boolean(opts.noColor), title: header }
    );
    if (!process.stdout.isTTY) {
      out.info(lines);
    } else {
      process.stdout.write(`\x1b[2J\x1b[H${lines}\n`);
    }
    return true;
  };

  const ok = await renderOnce();
  if (!ok && !opts.json) {
    out.info(
      out.color("yellow", `nothing to watch for PIN ${pin} yet.`) +
        `\nStart something first: kahoot-lab mock <quiz.json> + kahoot-lab bots <pin>, or kahoot-lab bots <pin>.`
    );
    process.exitCode = 1;
    return;
  }
  if (once || opts.json) return;

  const timer = setInterval(async () => {
    try {
      await renderOnce();
    } catch { /* ignore transient errors */ }
  }, intervalSec * 1000);
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.exit(0);
  });
}

/* ------------------------------------------------------------------- mock */

async function cmdMock(opts, out) {
  const quizPath = opts._[1];
  if (!quizPath) {
    out.info(USAGE);
    process.exitCode = 1;
    return;
  }
  const quiz = await loadQuiz(quizPath);
  const server = new MockKahootServer({
    quiz,
    pin: opts.pin,
    port: numberize(opts.port) ?? 0,
    autoStartMs: opts.manual ? null : (numberize(opts.autoStart) ?? 3) * 1000,
    questionTimeMs: numberize(opts.questionTime),
    questionGapMs: numberize(opts.gap) ?? 1200,
    log: (line) => {
      if (!opts.json) out.info(out.color("dim", `[game] ${line}`));
    },
  });
  const info = await server.start();

  await mkdir(path.dirname(MOCK_FILE), { recursive: true });
  await writeFile(MOCK_FILE, JSON.stringify({ pin: info.pin, baseUrl: info.baseUrl, port: info.port, pid: process.pid }, null, 2));

  if (opts.json) {
    out.data({ started: true, ...info, quiz: quiz.title });
  } else {
    out.info("");
    out.info(out.color("bold", `Local Kahoot test host running: ${quiz.title}`));
    out.info(`  PIN   : ${out.color("cyan", info.pin)}`);
    out.info(`  URL   : ${info.baseUrl}`);
    out.info(`  start : ${opts.manual ? "manual (kahoot-lab does not auto-start; use --auto-start)" : `auto-start ${numberize(opts.autoStart) ?? 3}s after the first player joins`}`);
    out.info("");
    out.info(`Run these in other terminals:`);
    out.info(`  kahoot-lab bots ${info.pin} --count 3`);
    out.info(`  kahoot-lab solve ${info.pin}`);
    out.info(`  kahoot-lab watch ${info.pin}`);
    out.info(`  kahoot-lab score ${info.pin} --player "Bot 1" --add 1500`);
    out.info("");
    out.info(out.color("dim", "Ctrl+C to stop"));
  }

  let lastSnapshot = "";
  let loopScheduled = false;
  const ticker = setInterval(async () => {
    try {
      const state = server.snapshot();
      const line = JSON.stringify(state.players);
      if (line !== lastSnapshot) {
        lastSnapshot = line;
        if (opts.json) out.data(state);
        else if (state.phase !== "lobby") {
          const board = formatScoreboard(
            state.players.map((p) => ({ name: p.name, score: p.score, correct: p.correct })),
            { noColor: Boolean(opts.noColor), title: `Scoreboard · phase ${state.phase}` }
          );
          if (process.stdout.isTTY && !opts.quiet) process.stdout.write(`\x1b[2J\x1b[H${board}\n`);
        }
      }
      if (state.phase === "ended" && opts.loop && !loopScheduled) {
        loopScheduled = true;
        setTimeout(() => {
          loopScheduled = false;
          try {
            server.reset();
            const rolling = server.snapshot().players.length > 0;
            if (rolling) server.startGame();
            if (!opts.json) {
              out.info(out.color("dim", rolling ? "[game] loop: next game started" : "[game] loop: lobby reopened"));
            }
          } catch { /* ignore */ }
        }, 3000);
      }
    } catch { /* ignore */ }
  }, 1000);

  const shutdown = async () => {
    clearInterval(ticker);
    await server.close();
    await unlink(MOCK_FILE).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/* ----------------------------------------------------------------- serve */

async function cmdServe(opts, out) {
  const { startKahootLabServer } = await import("./web/server.js");
  const server = await startKahootLabServer({
    port: numberize(opts.port) ?? 4380,
    host: opts.bind || "127.0.0.1",
    quiet: Boolean(opts.quiet) || Boolean(opts.json),
  });
  if (opts.json) {
    out.data({ ok: true, url: server.url, port: server.port });
  } else {
    out.info("");
    out.info(`${out.color("bold", "kahoot·lab web console")}  ${out.color("dim", "(testing dashboard)")}`);
    out.info(`  open : ${out.color("cyan", server.url)}`);
    out.info(`  api  : ${server.url}/api/health`);
    out.info("");
    out.info(out.color("dim", "Ctrl+C to stop"));
  }
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/* ------------------------------------------------------------------- quiz */

async function cmdQuiz(opts, out) {
  const sub = opts._[1];
  const { api } = await resolveBases(opts);
  if (sub === "search") {
    const query = opts._.slice(2).join(" ");
    if (!query) throw new Error("usage: kahoot-lab quiz search \"<query>\"");
    const results = await searchQuizzes(query, { apiBase: api, limit: numberize(opts.limit) ?? 10 });
    if (opts.json) return out.data(results);
    if (!results.length) return out.info("no results");
    results.forEach((r, i) => {
      out.info(
        `${String(i + 1).padStart(2)}. ${r.title} ${out.color("dim", `· ${r.number_of_questions ?? "?"} questions`)}` +
          `\n     ${out.color("cyan", r.uuid)}`
      );
    });
    return;
  }
  if (sub === "fetch") {
    const arg = opts._.slice(2).join(" ").trim();
    if (!arg) throw new Error("usage: kahoot-lab quiz fetch <uuid|url|title> [--out <file>]");
    let quiz;
    if (/^[0-9a-f-]{36}$/i.test(arg) || arg.includes("kahoot")) {
      const uuid = normalizeQuizId(arg);
      quiz = await fetchQuiz(uuid, { apiBase: api });
    } else {
      const results = await searchQuizzes(arg, { apiBase: api, limit: 5 });
      if (!results.length) throw new Error(`no published quiz found for "${arg}"`);
      quiz = await fetchQuiz(results[0].uuid, { apiBase: api });
    }
    const fixture = fromKahootQuiz(quiz);
    if (opts.json) return out.data(fixture);
    const outPath = opts.out || `${slugify(fixture.title)}.json`;
    await writeFile(outPath, JSON.stringify(fixture, null, 2));
    out.info(out.color("green", `saved ${fixture.questions.length} questions to ${outPath}`));
    return;
  }
  out.info(USAGE);
  process.exitCode = 1;
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "quiz";
}

/* ------------------------------------------------------------------ main */

/**
 * @param {string[]} argv
 */
export async function main(argv) {
  const opts = parseArgs(argv);
  const out = printer(opts);
  const command = opts._[0];

  if (opts.flags && opts.flags.has("help")) opts.help = true;
  if (opts.help || !command) {
    out.info(USAGE);
    return;
  }

  try {
    switch (command) {
      case "solve":
        await cmdSolve(opts, out);
        break;
      case "bots":
        await cmdBots(opts, out);
        break;
      case "score":
        await cmdScore(opts, out);
        break;
      case "watch":
        await cmdWatch(opts, out);
        break;
      case "mock":
        await cmdMock(opts, out);
        break;
      case "serve":
      case "web":
        await cmdServe(opts, out);
        break;
      case "quiz":
        await cmdQuiz(opts, out);
        break;
      default:
        out.info(out.color("red", `unknown command: ${command}`));
        out.info(USAGE);
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof KahootError) {
      out.info(out.color("red", `error: ${err.message}`));
    } else {
      out.info(out.color("red", `error: ${err && err.message ? err.message : String(err)}`));
    }
    process.exitCode = 1;
  }
}
