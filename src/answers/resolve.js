/**
 * Resolve the answers of a *live* game identified by its PIN.
 *
 * A live game does not hand out the quiz uuid up front, so the flow is:
 *
 *   reserve session -> join as a throwaway observer -> wait for quizStart
 *   (id 9, carries `quizName` + `quizQuestionAnswers`) -> search the public
 *   quiz API for that title -> validate the choice-count shape -> fetch
 *   answers.
 *
 * A quiz uuid/title can also be supplied directly to skip the live join.
 */

import { reserveSession, websocketUrls, KahootError } from "../protocol/session.js";
import { CometClient } from "../protocol/comet.js";
import { loginPacket, joinVerifyPacket } from "../protocol/packets.js";
import {
  searchQuizzes,
  fetchQuiz,
  extractAnswers,
  quizShape,
  pickMatchingQuiz,
  DEFAULT_API_BASE,
} from "./kahoot-api.js";

const OBSERVER_NAME = "LabAnswers";

/**
 * @typedef {Object} ResolvedQuiz
 * @property {object} quiz        Kahoot quiz object
 * @property {Array<object|null>} answers per-question answer plan
 * @property {string} source      "quiz-id" | "quiz-title" | "live-pin"
 * @property {string} [observerName] set when a live join was required
 */

/**
 * Fetch a quiz's answers.
 * @param {{
 *   pin?:string,
 *   quizId?:string,
 *   quizTitle?:string,
 *   baseUrl?:string,
 *   apiBase?:string,
 *   waitMs?:number,
 *   observerName?:string,
 *   fetchImpl?:typeof fetch,
 *   log?:function
 * }} opts
 * @returns {Promise<ResolvedQuiz>}
 */
export async function resolveQuizAnswers(opts) {
  const log = opts.log || (() => {});
  const apiBase = opts.apiBase || DEFAULT_API_BASE;
  const fetchImpl = opts.fetchImpl || fetch;

  if (opts.quizId) {
    const quiz = await fetchQuiz(opts.quizId, { apiBase, fetchImpl });
    return { quiz, answers: extractAnswers(quiz), source: "quiz-id" };
  }

  if (opts.quizTitle) {
    const quiz = await resolveByTitle(opts.quizTitle, { apiBase, fetchImpl, shape: opts.shape });
    return { quiz, answers: extractAnswers(quiz), source: "quiz-title" };
  }

  if (!opts.pin) {
    throw new KahootError("nothing to resolve: pass a PIN, --quiz <uuid> or --title <name>", "invalid-pin");
  }

  const live = await waitForQuizStart(opts, log);
  const quiz = await resolveByTitle(live.quizName, {
    apiBase,
    fetchImpl,
    shape: live.shape,
    log,
  });
  return {
    quiz,
    answers: extractAnswers(quiz),
    source: "live-pin",
    observerName: live.observerName,
  };
}

/**
 * Search the public API for a quiz title, validating against the played
 * quiz's shape when known.
 * @param {string} title
 * @param {{apiBase:string, fetchImpl:typeof fetch, shape?:number[], log?:function}} opts
 */
async function resolveByTitle(title, opts) {
  const log = opts.log || (() => {});
  const results = await searchQuizzes(title, { apiBase: opts.apiBase, fetchImpl: opts.fetchImpl, limit: 25 });
  if (!results.length) {
    throw new KahootError(`no published quiz found matching "${title}"`, "quiz-not-found");
  }

  const shapeMatches = (quiz) => {
    if (!opts.shape) return true;
    const actual = quizShape(quiz);
    if (actual.length !== opts.shape.length) return false;
    // null/undefined entries in quizQuestionAnswers are wildcards (Kahoot
    // omits counts for free-form questions)
    return opts.shape.every((expected, i) => expected == null || expected === actual[i]);
  };

  // 1) direct pick (exact title, unique question count)
  const uuid = pickMatchingQuiz(results, { shape: opts.shape, title });
  if (uuid) {
    const quiz = await fetchQuiz(uuid, { apiBase: opts.apiBase, fetchImpl: opts.fetchImpl });
    if (shapeMatches(quiz)) {
      log(`resolved quiz "${quiz.title}" (${uuid})`);
      return quiz;
    }
  }

  // 2) ambiguous search results: fetch the plausible candidates and compare
  //    the full choice-count shape against the live game
  if (opts.shape) {
    const candidates = results
      .filter((r) => r.number_of_questions == null || r.number_of_questions === opts.shape.length)
      .slice(0, 6);
    for (const candidate of candidates) {
      try {
        const quiz = await fetchQuiz(candidate.uuid, { apiBase: opts.apiBase, fetchImpl: opts.fetchImpl });
        if (shapeMatches(quiz)) {
          log(`resolved quiz "${quiz.title}" (${candidate.uuid}) by shape`);
          return quiz;
        }
      } catch { /* try the next candidate */ }
    }
  }

  throw new KahootError(
    `found ${results.length} quizzes titled "${title}" but none matched the live game ` +
      `(${(opts.shape || []).length} questions) - pass --quiz <uuid> to disambiguate`,
    "quiz-ambiguous"
  );
}

/**
 * Join a live game just long enough to learn its quiz name/shape from the
 * `quizStart` (id 9) message.
 * @param {object} opts
 * @param {function} log
 * @returns {Promise<{quizName:string, shape:number[], observerName:string}>}
 */
export async function waitForQuizStart(opts, log) {
  const waitMs = opts.waitMs ?? 300000;
  const observerName = opts.observerName || OBSERVER_NAME;
  const reserved = await reserveSession(opts.pin, { baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });
  const client = new CometClient({ urls: websocketUrls(reserved) });
  try {
    await client.open();
    const loginAck = await client.publish(
      loginPacket({ gameid: reserved.pin, name: observerName, userAgent: "kahoot-lab" }),
      { expectAck: true, timeoutMs: 10000 }
    );
    const loginData = (loginAck && loginAck.data) || {};
    if (loginData.error || loginData.description === "Duplicate name") {
      if (String(loginData.description || "").toLowerCase().includes("duplicate")) {
        // retry once with a suffixed name
        const alt = `${observerName}-${Math.floor(Math.random() * 900 + 100)}`;
        await client.publish(
          loginPacket({ gameid: reserved.pin, name: alt, userAgent: "kahoot-lab" }),
          { expectAck: true }
        );
        return await awaitQuizStart(client, reserved.pin, alt, waitMs, log);
      }
      throw new KahootError(`join rejected: ${loginData.description || loginData.error}`, "join-rejected");
    }
    await client.publish(
      joinVerifyPacket({ gameid: reserved.pin, usingNamerator: Boolean(reserved.body.namerator) })
    );
    return await awaitQuizStart(client, reserved.pin, observerName, waitMs, log);
  } finally {
    client.close();
  }
}

/**
 * @param {CometClient} client
 * @param {string} pin
 * @param {string} observerName
 * @param {number} waitMs
 * @param {function} log
 */
function awaitQuizStart(client, pin, observerName, waitMs, log) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new KahootError(
          `the game PIN ${pin} was joined but the quiz has not started yet - ` +
            `wait for the host to start, or pass --quiz <uuid> / --title <name>`,
          "quiz-not-started"
        )
      );
    }, waitMs);
    const onEvent = (event) => {
      if (event.name !== "quizStart") return;
      clearTimeout(timer);
      const content = event.content || {};
      const quizName = content.quizName || content.quizTitle || content.name;
      const shape = Array.isArray(content.quizQuestionAnswers) ? content.quizQuestionAnswers : null;
      if (!quizName) {
        cleanup();
        reject(new KahootError("quizStart event did not carry a quiz name", "quiz-not-found"));
        return;
      }
      if (!shape) {
        cleanup();
        reject(new KahootError("quizStart event did not carry question metadata", "quiz-not-found"));
        return;
      }
      cleanup();
      log(`live game started: "${quizName}" (${shape.length} questions)`);
      resolve({ quizName, shape, observerName });
    };
    function cleanup() {
      client.off("event", onEvent);
    }
    client.on("event", onEvent);
  });
}
