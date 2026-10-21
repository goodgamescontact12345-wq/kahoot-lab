import test from "node:test";
import assert from "node:assert/strict";

import {
  pointsFor,
  timingFor,
  achievableRange,
  planScore,
  describePlan,
} from "../src/scores/scoring.js";

test("pointsFor matches Kahoot's classic speed formula", () => {
  const timeMs = 20000;
  assert.equal(pointsFor({ elapsedMs: 0, timeMs }), 1000);
  assert.equal(pointsFor({ elapsedMs: timeMs / 2, timeMs }), 750);
  assert.equal(pointsFor({ elapsedMs: timeMs, timeMs }), 500);
  assert.equal(pointsFor({ elapsedMs: 5000, timeMs }), 875);
});

test("pointsFor honours the points multiplier", () => {
  assert.equal(pointsFor({ elapsedMs: 0, timeMs: 20000, pointsMultiplier: 2 }), 2000);
  assert.equal(pointsFor({ elapsedMs: 20000, timeMs: 20000, pointsMultiplier: 2 }), 1000);
});

test("pointsFor clamps out of range elapsed values", () => {
  assert.equal(pointsFor({ elapsedMs: -500, timeMs: 20000 }), 1000);
  assert.equal(pointsFor({ elapsedMs: 999999, timeMs: 20000 }), 500);
});

test("timingFor inverts pointsFor within the reachable range", () => {
  const timeMs = 20000;
  for (const points of [500, 512, 700, 811, 900, 1000]) {
    const elapsed = timingFor({ points, timeMs });
    assert.notEqual(elapsed, null, `timing for ${points}`);
    assert.equal(pointsFor({ elapsedMs: elapsed, timeMs }), points);
  }
  assert.equal(timingFor({ points: 499, timeMs }), null);
  assert.equal(timingFor({ points: 1001, timeMs }), null);
});

test("timingFor works with multipliers", () => {
  const timeMs = 4000;
  const elapsed = timingFor({ points: 1500, timeMs, pointsMultiplier: 2 });
  assert.equal(pointsFor({ elapsedMs: elapsed, timeMs, pointsMultiplier: 2 }), 1500);
});

test("achievableRange respects the bot reaction clamp", () => {
  const range = achievableRange({ timeMs: 20000 });
  assert.ok(range.min > 500, `min ${range.min} should exceed the theoretical 500`);
  assert.ok(range.max < 1000, `max ${range.max} should stay below the theoretical 1000`);
  assert.ok(range.min <= range.max);

  const doubled = achievableRange({ timeMs: 20000, pointsMultiplier: 2 });
  assert.equal(doubled.min, range.min * 2);
  assert.equal(doubled.max, range.max * 2);
});

test("planScore hits an exact multi-question target", () => {
  const questions = [
    { timeMs: 900, pointsMultiplier: 1 },
    { timeMs: 900, pointsMultiplier: 2 },
    { timeMs: 900, pointsMultiplier: 1 },
    { timeMs: 900, pointsMultiplier: 1 },
  ];
  const result = planScore({ current: 0, target: 2501, questions });
  assert.equal(result.feasible, true, JSON.stringify(result));
  const banked = result.plan.reduce((s, p) => s + p.points, 0);
  assert.equal(banked, 2501);
  assert.equal(result.projectedScore, 2501);
  // unused questions are skipped
  assert.ok(result.plan.some((p) => p.action === "skip"));
  // every planned answer must be reachable
  for (const p of result.plan.filter((x) => x.action === "answer")) {
    assert.equal(pointsFor({ elapsedMs: p.elapsedMs, timeMs: p.timeMs, pointsMultiplier: p.multiplier }), p.points);
  }
});

test("planScore reports the granularity error on double-points questions", () => {
  const questions = [
    { timeMs: 900, pointsMultiplier: 1 },
    { timeMs: 900, pointsMultiplier: 2 },
    { timeMs: 900, pointsMultiplier: 1 },
    { timeMs: 900, pointsMultiplier: 1 },
  ];
  // 2500 needs 1640 (even) on the double-points question -> lands on 2501
  const result = planScore({ current: 0, target: 2500, questions });
  assert.equal(result.feasible, false);
  assert.equal(result.overshoot, 1);
  assert.equal(result.projectedScore, 2501);
});

test("planScore reports a shortfall when there are not enough questions", () => {
  const questions = [{ timeMs: 900, pointsMultiplier: 1 }];
  const result = planScore({ current: 0, target: 5000, questions });
  assert.equal(result.feasible, false);
  assert.ok(result.shortfall > 0);
  assert.ok(result.projectedScore < 5000);
  assert.match(describePlan(result), /short by \d+/);
});

test("planScore skips everything when the score should hold", () => {
  const questions = [
    { timeMs: 900, pointsMultiplier: 1 },
    { timeMs: 900, pointsMultiplier: 1 },
  ];
  const result = planScore({ current: 1200, delta: 0, questions });
  assert.equal(result.feasible, true);
  assert.ok(result.plan.every((p) => p.action === "skip"));
  assert.equal(result.projectedScore, 1200);
});

test("planScore prefers a later question that fits the exact remainder", () => {
  const questions = [
    { timeMs: 900, pointsMultiplier: 2 }, // min ~1334 - too big for 700
    { timeMs: 900, pointsMultiplier: 1 }, // min ~667 - fits 700
  ];
  const result = planScore({ current: 0, delta: 700, questions });
  assert.equal(result.plan[0].action, "skip");
  assert.equal(result.plan[1].action, "answer");
  assert.equal(result.plan[1].points, 700);
  assert.equal(result.feasible, true);
});

test("planScore clamps negative targets to a hold", () => {
  const result = planScore({ current: 300, target: -50, questions: [] });
  assert.equal(result.projectedScore, 300);
  assert.equal(result.feasible, false); // a negative goal cannot be honoured
});
