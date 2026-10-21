/**
 * Quiz fixture IO: load the kahoot-lab fixture format and convert Kahoot's
 * public quiz JSON into it (used by `kahoot-lab quiz fetch`).
 */

import { readFile } from "node:fs/promises";

/**
 * @typedef {Object} FixtureQuestion
 * @property {string} question
 * @property {string} type quiz|multiple_select_quiz|jumble|poll|survey|open_ended|word_cloud
 * @property {number} time ms
 * @property {number} pointsMultiplier
 * @property {Array<{answer:string, correct?:boolean}>} choices
 */

/**
 * @typedef {Object} FixtureQuiz
 * @property {string} title
 * @property {string} [description]
 * @property {FixtureQuestion[]} questions
 */

/**
 * Load and validate a quiz fixture.
 * @param {string} path
 * @returns {Promise<FixtureQuiz>}
 */
export async function loadQuiz(path) {
  const raw = await readFile(path, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
  return validateQuiz(data, path);
}

/**
 * @param {any} data
 * @param {string} [source]
 * @returns {FixtureQuiz}
 */
export function validateQuiz(data, source = "quiz") {
  if (!data || typeof data !== "object") throw new Error(`${source}: expected an object`);
  if (!Array.isArray(data.questions) || data.questions.length === 0) {
    throw new Error(`${source}: "questions" must be a non-empty array`);
  }
  data.questions.forEach((q, i) => {
    if (!q || typeof q !== "object") throw new Error(`${source}: question ${i + 1} is not an object`);
    q.type = q.type || "quiz";
    if (!Array.isArray(q.choices)) q.choices = [];
    const needsChoices = new Set(["quiz", "multiple_select_quiz", "jumble", "true_false", "poll", "survey"]);
    if (needsChoices.has(q.type) && q.choices.length < 2) {
      throw new Error(`${source}: question ${i + 1} needs at least 2 choices`);
    }
    q.time = Number(q.time) > 0 ? Number(q.time) : 20000;
    q.pointsMultiplier = Number(q.pointsMultiplier) > 0 ? Number(q.pointsMultiplier) : 1;
  });
  data.title = data.title || "Untitled quiz";
  return data;
}

/**
 * Convert a Kahoot public quiz object (from the quiz API) into a fixture.
 * @param {object} kahootQuiz
 * @returns {FixtureQuiz}
 */
export function fromKahootQuiz(kahootQuiz) {
  return validateQuiz({
    title: kahootQuiz.title || "Untitled quiz",
    description: kahootQuiz.description || "",
    questions: (kahootQuiz.questions || []).map((q) => ({
      question: q.question || "",
      type: q.type || "quiz",
      time: q.time || 20000,
      pointsMultiplier: q.pointsMultiplier || 1,
      layout: q.layout,
      choices: (q.choices || []).map((c) => ({
        answer: c.answer == null ? "" : String(c.answer),
        ...(c.correct ? { correct: true } : {}),
      })),
    })),
  });
}
