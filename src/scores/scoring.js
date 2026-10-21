/**
 * Kahoot's classic scoring formula (mirrored by kahoot.js's challenge handler
 * and Kahoot's own docs):
 *
 *   points = round((1 - elapsed / (2 * time)) * 1000) * pointsMultiplier
 *
 * An instant correct answer is worth 1000, half way through 750, the last
 * millisecond 500; wrong answers and timeouts are worth 0.
 *
 * The planner inverts this so a bot can be told *how many points to bank*
 * (`--add`) or *what score to reach* (`--set`): it decides, per remaining
 * question, whether to answer (and how fast) or to score nothing.
 */

/**
 * @typedef {Object} PlannedAnswer
 * @property {number} questionIndex
 * @property {"answer"|"skip"} action
 * @property {number} points points this answer is expected to bank
 * @property {number} elapsedMs when to answer after the question starts
 * @property {number} multiplier
 * @property {number} timeMs question time budget
 */

/**
 * Bots must not answer instantly (Kahoot ignores sub-250ms answers) and keep
 * a small margin before the timer ends - the planner uses the same bounds so
 * planned scores are actually reachable.
 */
export const MIN_REACTION_MS = 250;
export const END_MARGIN_MS = 300;

/**
 * Achievable points range for one question (as a bot with the reaction clamp
 * would produce).
 * @param {{timeMs:number, pointsMultiplier?:number}} q
 * @returns {{min:number, max:number}}
 */
export function achievableRange({ timeMs, pointsMultiplier = 1 }) {
  const t = Math.max(0, timeMs);
  const maxElapsed = Math.min(MIN_REACTION_MS, t);
  const minElapsed = Math.max(maxElapsed, t - END_MARGIN_MS);
  let max = pointsFor({ elapsedMs: maxElapsed, timeMs: t, pointsMultiplier });
  let min = pointsFor({ elapsedMs: minElapsed, timeMs: t, pointsMultiplier });
  if (min > max) [min, max] = [max, min];
  return { min, max };
}

/**
 * Points for a correct answer after `elapsedMs`.
 * @param {{elapsedMs:number, timeMs:number, pointsMultiplier?:number}} p
 * @returns {number}
 */
export function pointsFor({ elapsedMs, timeMs, pointsMultiplier = 1 }) {
  const t = Math.max(0, Math.min(timeMs, elapsedMs));
  const base = Math.round((1 - t / (2 * timeMs)) * 1000);
  return base * pointsMultiplier;
}

/**
 * Inverse of {@link pointsFor}: how long to wait to bank exactly `points`.
 * Returns null when the target is out of range for this question.
 * @param {{points:number, timeMs:number, pointsMultiplier?:number}} p
 * @returns {number|null} elapsed ms, or null when unreachable
 */
export function timingFor({ points, timeMs, pointsMultiplier = 1 }) {
  const mult = pointsMultiplier || 1;
  const target = Math.round(points / mult);
  if (target < 500 || target > 1000) return null;
  // points = round((1 - t/(2T)) * 1000)  =>  t = 2T * (1 - points/1000)
  const elapsed = 2 * timeMs * (1 - target / 1000);
  // verify the rounding lands on the requested value, adjust if needed
  for (const delta of [0, 1, -1, 2, -2, 3, -3]) {
    const candidate = Math.max(0, Math.min(timeMs, Math.round(elapsed + delta)));
    if (pointsFor({ elapsedMs: candidate, timeMs, pointsMultiplier: mult }) === points) {
      return candidate;
    }
  }
  return null;
}

/**
 * The best score a question can yield (instant correct answer).
 * @param {{timeMs?:number, pointsMultiplier?:number}} [q]
 * @returns {number}
 */
export function maxPointsFor(q = {}) {
  return 1000 * (q.pointsMultiplier || 1);
}

/**
 * The minimum score a correct answer can yield.
 * @param {{timeMs?:number, pointsMultiplier?:number}} [q]
 * @returns {number}
 */
export function minPointsFor(q = {}) {
  return 500 * (q.pointsMultiplier || 1);
}

/**
 * Plan how a bot should answer the remaining questions to move `current`
 * score by exactly `delta`.
 *
 * Each question banks 0, or any value inside its achievable range (see
 * {@link achievableRange}) - chosen through answer timing.
 *
 * @param {{
 *   current?:number,
 *   delta?:number,
 *   target?:number,
 *   questions:Array<{timeMs:number, pointsMultiplier:number, questionIndex?:number}>,
 *   used?:number
 * }} p
 * @returns {{
 *   feasible:boolean,
 *   plan:PlannedAnswer[],
 *   projectedScore:number,
 *   shortfall:number,
 *   overshoot:number
 * }}
 */
export function planScore({ current = 0, delta, target, questions = [], used = 0 }) {
  let goal;
  if (typeof target === "number") goal = Math.max(0, Math.round(target)) - Math.round(current);
  else goal = Math.round(delta || 0);

  const plan = [];

  if (goal <= 0) {
    // nothing to gain: hold the score by scoring zero from here on
    for (const [i, q] of questions.entries()) {
      plan.push({
        questionIndex: q.questionIndex ?? i + used,
        action: "skip",
        points: 0,
        elapsedMs: 0,
        multiplier: q.pointsMultiplier,
        timeMs: q.timeMs,
      });
    }
    return {
      feasible: goal === 0,
      plan,
      projectedScore: Math.round(current),
      shortfall: Math.max(0, -goal),
      overshoot: 0,
    };
  }

  const entries = questions.map((q, i) => ({
    index: q.questionIndex ?? i + used,
    timeMs: q.timeMs,
    mult: q.pointsMultiplier,
    ...achievableRange(q),
  }));

  let remaining = goal;
  for (let i = 0; i < entries.length; i++) {
    const q = entries[i];
    if (remaining <= 0) {
      plan.push({ questionIndex: q.index, action: "skip", points: 0, elapsedMs: 0, multiplier: q.mult, timeMs: q.timeMs });
      continue;
    }
    // when this question cannot land the exact remaining amount, look ahead:
    // maybe a later question can.
    if (remaining < q.min && i < entries.length - 1) {
      const laterFits = entries.slice(i + 1).some((later) => later.min <= remaining && remaining <= later.max);
      if (laterFits) {
        plan.push({ questionIndex: q.index, action: "skip", points: 0, elapsedMs: 0, multiplier: q.mult, timeMs: q.timeMs });
        continue;
      }
    }
    if (remaining < q.min) {
      // nowhere left to be exact: this question would overshoot by
      // (min - remaining), or we stay short by `remaining`.
      // pick the smaller error.
      const overshootBy = q.min - remaining;
      if (overshootBy >= remaining) {
        plan.push({ questionIndex: q.index, action: "skip", points: 0, elapsedMs: 0, multiplier: q.mult, timeMs: q.timeMs });
        continue;
      }
    }
    let bank = Math.max(q.min, Math.min(q.max, remaining));
    bank = Math.round(bank / q.mult) * q.mult;
    bank = Math.max(q.min, Math.min(q.max, bank));
    const elapsedMs = timingFor({ points: bank, timeMs: q.timeMs, pointsMultiplier: q.mult });
    if (elapsedMs == null) {
      plan.push({ questionIndex: q.index, action: "skip", points: 0, elapsedMs: 0, multiplier: q.mult, timeMs: q.timeMs });
      continue;
    }
    plan.push({
      questionIndex: q.index,
      action: "answer",
      points: bank,
      elapsedMs,
      multiplier: q.mult,
      timeMs: q.timeMs,
    });
    remaining = Math.max(0, remaining - bank);
  }

  const banked = plan.reduce((sum, p) => sum + p.points, 0);
  const error = banked - goal;
  return {
    feasible: error === 0,
    plan,
    projectedScore: Math.round(current) + banked,
    shortfall: Math.max(0, -error),
    overshoot: Math.max(0, error),
  };
}

/**
 * Human readable description of a plan.
 * @param {ReturnType<typeof planScore>} result
 */
export function describePlan(result) {
  const answers = result.plan.filter((p) => p.action === "answer");
  const total = answers.reduce((sum, p) => sum + p.points, 0);
  if (result.feasible) {
    return `will bank ${total} points over ${answers.length} answer${answers.length === 1 ? "" : "s"} (score → ${result.projectedScore})`;
  }
  if (result.shortfall > 0) {
    return `can bank ${total} points over ${answers.length} answer(s) - short by ${result.shortfall} ` +
      `(score → ${result.projectedScore}; not enough questions left)`;
  }
  return `will bank ${total} points over ${answers.length} answer(s) - overshoots the target by ${result.overshoot} (score → ${result.projectedScore})`;
}
