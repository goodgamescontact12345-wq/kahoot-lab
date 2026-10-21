/**
 * Kahoot's public quiz API (no auth required). This is the same surface the
 * official web client uses when it renders a published quiz:
 *
 *   GET {apiBase}/rest/kahoots/?query=...        -> search published quizzes
 *   GET {apiBase}/rest/kahoots/{uuid}            -> full quiz incl. answers
 *
 * Against a local test host (see ../host/mock-server.js) the same paths are
 * served, so every code path is testable offline.
 */

import { DEFAULT_UA } from "../protocol/session.js";

export const DEFAULT_API_BASE = "https://create.kahoot.it";

/**
 * @param {string} path
 * @param {string} apiBase
 * @param {typeof fetch} [fetchImpl]
 */
async function getJson(path, apiBase, fetchImpl) {
  const url = `${apiBase.replace(/\/+$/, "")}${path}`;
  const res = await fetchImpl(url, {
    headers: {
      "User-Agent": DEFAULT_UA,
      Accept: "application/json",
      Referer: `${apiBase}/`,
    },
  });
  if (!res.ok) {
    const err = new Error(`quiz API HTTP ${res.status} for ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Search published quizzes by free text.
 * @param {string} query
 * @param {{limit?:number, apiBase?:string, fetchImpl?:typeof fetch}} [opts]
 * @returns {Promise<Array<{uuid:string,title:string,number_of_questions:number,type:string}>>}
 */
export async function searchQuizzes(query, opts = {}) {
  const limit = opts.limit ?? 25;
  const apiBase = opts.apiBase || DEFAULT_API_BASE;
  const fetchImpl = opts.fetchImpl || fetch;
  const path =
    `/rest/kahoots/?query=${encodeURIComponent(query)}` +
    `&cursor=0&limit=${limit}&topics=&grades=&orderBy=relevance` +
    `&searchCluster=1&includeExtendedCounters=false`;
  const data = await getJson(path, apiBase, fetchImpl);
  return (data.entities || []).map((e) => {
    const card = e.card || {};
    return {
      uuid: card.uuid,
      title: card.title || "",
      type: card.type || "quiz",
      number_of_questions: card.number_of_questions ?? null,
      cover: card.cover || null,
    };
  });
}

/**
 * Fetch a quiz by uuid, including correct answers.
 * @param {string} uuid
 * @param {{apiBase?:string, fetchImpl?:typeof fetch}} [opts]
 * @returns {Promise<object>} Kahoot quiz object ({title, questions:[...]})
 */
export async function fetchQuiz(uuid, opts = {}) {
  const apiBase = opts.apiBase || DEFAULT_API_BASE;
  const fetchImpl = opts.fetchImpl || fetch;
  const quiz = await getJson(`/rest/kahoots/${encodeURIComponent(uuid)}`, apiBase, fetchImpl);
  if (!quiz || !Array.isArray(quiz.questions)) {
    throw new Error(`quiz ${uuid} has no questions array`);
  }
  return quiz;
}

/**
 * Extract per-question correct answers from a Kahoot quiz object.
 *
 * @param {object} quiz
 * @returns {Array<null|{
 *   type:string,
 *   choice?:number,
 *   choices?:number[],
 *   order?:number[],
 *   correctCount:number
 * }>}
 *   one entry per question; `null` means the question has no correct answer
 *   (poll/survey/open ended/...).
 */
export function extractAnswers(quiz) {
  return (quiz.questions || []).map((q) => {
    const type = q.type || "quiz";
    const choices = q.choices || [];
    if (type === "jumble") {
      // Kahoot stores jumble choices already in the correct order
      return { type, order: choices.map((_, i) => i), correctCount: choices.length };
    }
    const correctIndexes = choices.reduce((acc, c, i) => {
      if (c && c.correct) acc.push(i);
      return acc;
    }, []);
    if (correctIndexes.length === 0) return null;
    if (type === "multiple_select_quiz") {
      return { type, choices: correctIndexes, correctCount: correctIndexes.length };
    }
    if (type === "quiz" || type === "true_false") {
      return { type, choice: correctIndexes[0], correctCount: 1 };
    }
    // sliders/scales with an explicit correct value fall back to first correct
    if (typeof q.correctAnswerIndex === "number") {
      return { type, choice: q.correctAnswerIndex, correctCount: 1 };
    }
    return null;
  });
}

/**
 * Shape signature of a quiz: how many choices every question has. Used to
 * validate that a searched quiz really is the one being played.
 * @param {object} quiz
 * @returns {number[]}
 */
export function quizShape(quiz) {
  return (quiz.questions || []).map((q) => (q.choices || []).length);
}

/**
 * Pick the search result that matches the played quiz's shape, else the only
 * result, else null.
 * @param {Array<{uuid:string,title:string,number_of_questions:number|null}>} results
 * @param {{shape?:number[], title?:string}} expected
 * @returns {string|null} uuid
 */
export function pickMatchingQuiz(results, expected) {
  if (!results || results.length === 0) return null;
  const wanted = expected.shape || null;
  if (wanted) {
    const byCount = results.filter(
      (r) => r.number_of_questions == null || r.number_of_questions === wanted.length
    );
    for (const r of byCount) {
      // exact title match with matching question count wins outright
      if (expected.title && r.title === expected.title) return r.uuid;
    }
    if (byCount.length === 1) return byCount[0].uuid;
  }
  if (expected.title) {
    const exact = results.find((r) => r.title === expected.title);
    if (exact) return exact.uuid;
  }
  if (results.length === 1) return results[0].uuid;
  return null;
}
