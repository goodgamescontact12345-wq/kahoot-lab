import test from "node:test";
import assert from "node:assert/strict";

/**
 * End-to-end against Kahoot's *public* quiz API (no credentials needed).
 * Skip with KAHOOT_LAB_NO_NETWORK=1 when offline.
 */

import { searchQuizzes, fetchQuiz, extractAnswers, quizShape } from "../src/answers/kahoot-api.js";

const skip = process.env.KAHOOT_LAB_NO_NETWORK === "1";

test("live: search public quizzes", { skip, timeout: 30000 }, async () => {
  const results = await searchQuizzes("capitals of the world", { limit: 5 });
  assert.ok(Array.isArray(results));
  assert.ok(results.length > 0, "expected at least one published quiz");
  assert.ok(results[0].uuid && results[0].title, "cards carry uuid + title");
});

test("live: fetch a quiz with correct answers", { skip, timeout: 30000 }, async () => {
  const results = await searchQuizzes("capitals of the world", { limit: 5 });
  const quiz = await fetchQuiz(results[0].uuid);
  assert.ok(quiz.questions.length > 0);
  const answers = extractAnswers(quiz);
  assert.equal(answers.length, quiz.questions.length);
  assert.equal(quizShape(quiz).length, quiz.questions.length);
  const answerable = answers.filter(Boolean);
  assert.ok(answerable.length > 0, "at least one question should have a correct answer");
});
