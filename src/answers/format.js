/**
 * Terminal rendering helpers (answer sheets, scoreboards, question logs).
 * No dependencies; honours NO_COLOR / --no-color / non-TTY output.
 */

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

/**
 * @param {{noColor?:boolean}} [opts]
 * @returns {(code:keyof typeof ANSI, text:string) => string}
 */
export function makeColorizer(opts = {}) {
  const enabled =
    !opts.noColor && !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
  return (code, text) => (enabled ? `${ANSI[code] || ""}${text}${ANSI.reset}` : text);
}

const CHOICE_COLORS = ["red", "blue", "yellow", "green"];
const CHOICE_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];

/**
 * Render a full answer sheet for a quiz.
 * @param {{quiz:object, answers:Array<object|null>, noColor?:boolean}} p
 * @returns {string}
 */
export function formatAnswerSheet({ quiz, answers, noColor }) {
  const c = makeColorizer({ noColor });
  const lines = [];
  lines.push(c("bold", quiz.title || "Untitled quiz"));
  const qCount = (quiz.questions || []).length;
  lines.push(c("dim", `${qCount} question${qCount === 1 ? "" : "s"} · answers revealed`));
  lines.push("");

  (quiz.questions || []).forEach((q, i) => {
    const plan = answers[i];
    lines.push(`${c("cyan", `[${i + 1}]`)} ${c("bold", stripFormat(q.question || "(no question text)"))}`);
    const choices = q.choices || [];
    const correct = plan
      ? plan.order
        ? plan.order
        : plan.choices || [plan.choice]
      : [];

    if (plan && plan.order) {
      lines.push(
        `    ${c("green", "correct order:")} ` +
          plan.order.map((idx) => stripFormat((choices[idx] || {}).answer || "?")).join(" → ")
      );
    }

    choices.forEach((choice, ci) => {
      const isCorrect = correct.includes(ci);
      const marker = isCorrect ? c("green", "✔") : " ";
      const color = CHOICE_COLORS[ci % CHOICE_COLORS.length];
      const label = CHOICE_LABELS[ci] || String(ci);
      const text = stripFormat(choice.answer == null ? "" : String(choice.answer));
      lines.push(`    ${marker} ${c(color, label)}) ${text}${isCorrect ? c("green", "  ← correct") : ""}`);
    });

    if (!plan) {
      lines.push(c("dim", "    (no correct answer - poll/survey/open ended)"));
    }
    if (q.pointsMultiplier === 2) lines.push(c("magenta", "    double points"));
    if (q.video && q.video.fullUrl) lines.push(c("dim", `    video: ${q.video.fullUrl}`));
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * Render a scoreboard table.
 * @param {Array<{name:string, score:number, correct?:number, isBot?:boolean}>} players
 * @param {{noColor?:boolean, title?:string}} [opts]
 * @returns {string}
 */
export function formatScoreboard(players, opts = {}) {
  const c = makeColorizer({ noColor: opts.noColor });
  const sorted = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
  const lines = [];
  lines.push(c("bold", opts.title || "Scoreboard"));
  const nameWidth = Math.max(4, ...sorted.map((p) => p.name.length), 4);
  lines.push(
    c("dim", `${"#".padEnd(4)} ${"name".padEnd(nameWidth)}  ${"score".padStart(7)}  ${"correct".padStart(7)}`)
  );
  sorted.forEach((p, i) => {
    const rank = c(i < 3 ? "yellow" : "dim", String(i + 1).padEnd(4));
    const label = `${p.name}${p.isBot ? c("dim", " (bot)") : ""}`;
    const score = c(i === 0 ? "green" : "reset", String(p.score || 0).padStart(7));
    const correct = p.correct == null ? "      -" : String(p.correct).padStart(7);
    lines.push(`${rank} ${label.padEnd(nameWidth + (p.isBot ? 7 : 0))}  ${score}  ${correct}`);
  });
  return lines.join("\n");
}

/**
 * @param {string} text Kahoot rich text (bold/markdown-ish)
 * @returns {string}
 */
export function stripFormat(text) {
  return String(text)
    .replace(/\*\*?([^*]+)\*\*?/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * mm:ss helper for timers.
 * @param {number} ms
 */
export function formatMs(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
