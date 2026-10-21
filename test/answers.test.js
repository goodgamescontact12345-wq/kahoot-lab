import test from "node:test";
import assert from "node:assert/strict";

import { extractAnswers, quizShape, pickMatchingQuiz } from "../src/answers/kahoot-api.js";
import { fromKahootQuiz, validateQuiz, loadQuiz } from "../src/host/quiz-loader.js";

const kahootQuiz = {
  title: "Sample",
  questions: [
    {
      question: "Pick one",
      type: "quiz",
      choices: [
        { answer: "a", correct: false },
        { answer: "b", correct: true },
        { answer: "c", correct: false },
        { answer: "d", correct: false },
      ],
    },
    {
      question: "Pick several",
      type: "multiple_select_quiz",
      choices: [
        { answer: "a", correct: true },
        { answer: "b", correct: false },
        { answer: "c", correct: true },
      ],
    },
    {
      question: "Order them",
      type: "jumble",
      choices: [{ answer: "1" }, { answer: "2" }, { answer: "3" }, { answer: "4" }],
    },
    {
      question: "Feelings?",
      type: "poll",
      choices: [{ answer: "good" }, { answer: "bad" }],
    },
    {
      question: "Open",
      type: "open_ended",
      choices: [{ answer: "anything" }],
    },
  ],
};

test("extractAnswers reads every answerable type", () => {
  const answers = extractAnswers(kahootQuiz);
  assert.equal(answers.length, 5);
  assert.deepEqual(answers[0], { type: "quiz", choice: 1, correctCount: 1 });
  assert.deepEqual(answers[1], { type: "multiple_select_quiz", choices: [0, 2], correctCount: 2 });
  assert.deepEqual(answers[2], { type: "jumble", order: [0, 1, 2, 3], correctCount: 4 });
  assert.equal(answers[3], null, "polls have no correct answer");
  assert.equal(answers[4], null, "open ended has no correct answer");
});

test("quizShape lists choice counts", () => {
  assert.deepEqual(quizShape(kahootQuiz), [4, 3, 4, 2, 1]);
});

test("pickMatchingQuiz prefers title + shape matches", () => {
  const results = [
    { uuid: "u1", title: "Other", number_of_questions: 5 },
    { uuid: "u2", title: "Sample", number_of_questions: 5 },
    { uuid: "u3", title: "Sample", number_of_questions: 9 },
  ];
  assert.equal(pickMatchingQuiz(results, { shape: [1, 2, 3, 4, 5], title: "Sample" }), "u2");
  assert.equal(pickMatchingQuiz(results, { title: "Sample" }), "u2");
  // shape alone is only decisive when a single candidate has that count
  assert.equal(pickMatchingQuiz(results.filter((r) => r.uuid !== "u2"), { shape: [1, 2, 3, 4, 5] }), "u1");
  assert.equal(pickMatchingQuiz(results, { shape: [1, 2, 3, 4, 5] }), null, "ambiguous shape + no title -> null");
  assert.equal(pickMatchingQuiz([], { title: "x" }), null);
  // ambiguous: same title + count twice and no shape to separate them
  assert.equal(
    pickMatchingQuiz([results[1], { ...results[1], uuid: "u9" }], { title: "Sample" }),
    "u2",
    "exact title still resolves when the shape is unknown"
  );
});

test("fromKahootQuiz converts to the fixture format", () => {
  const fixture = fromKahootQuiz(kahootQuiz);
  assert.equal(fixture.title, "Sample");
  assert.equal(fixture.questions.length, 5);
  assert.equal(fixture.questions[0].choices[1].correct, true);
  assert.equal(fixture.questions[0].choices[0].correct, undefined, "false flags are omitted");
  assert.equal(fixture.questions[0].type, "quiz");
  assert.equal(fixture.questions[0].time, 20000, "defaults are filled in");
});

test("validateQuiz rejects broken fixtures", () => {
  assert.throws(() => validateQuiz({}), /questions/);
  assert.throws(() => validateQuiz({ questions: [{ question: "x", choices: [] }] }), /at least 2 choices/);
});

test("demo fixture loads and is fully answerable", async () => {
  const quiz = await loadQuiz("fixtures/demo-quiz.json");
  const answers = extractAnswers(fromKahootQuiz(quiz));
  assert.equal(quiz.title, "Kahoot Lab Demo Quiz");
  assert.equal(answers[0].choice, 1, "Mars");
  assert.equal(answers[1].choice, 1, "56");
  assert.deepEqual(answers[2].choices, [0, 2], "2 and 13");
  assert.deepEqual(answers[3].order, [0, 1, 2, 3], "jumble in stored order");
  assert.equal(answers[4], null, "poll");
});
