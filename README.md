# kahoot-lab

A **Kahoot testing utility**: reveal the answers of a quiz, spawn answer bots into a
game, and add/remove points — either against a real Kahoot game PIN or against the
built-in local Kahoot-compatible test host.

Zero runtime dependencies (Node ≥ 20, built-in `fetch` + WebSocket).

> **Use it on games you own or have permission to test.** Bots join other people's
> games as extra participants — run it against your own quizzes (or the local test
> host) to load-test, debug and verify them.

## Install / run

```bash
node bin/kahoot-lab.js --help          # or: npm link  ->  kahoot-lab --help
npm run web                            # browser console -> http://127.0.0.1:4380
npm test                               # unit + end-to-end tests (offline)
KAHOOT_LAB_NO_NETWORK=1 npm test       # ...skip the two live API tests
```

## Commands

### 1. `solve <pin>` — show the answers

```bash
kahoot-lab solve 4819273
kahoot-lab solve 4819273 --title "Capitals of the World"   # no join, instant
kahoot-lab solve 4819273 --quiz <quiz-uuid>                # exact quiz, no search
kahoot-lab solve 4819273 --json
```

How a PIN is resolved to answers:

1. `--quiz <uuid>` / `--title <name>` → fetch the published quiz directly
   (`create.kahoot.it/rest/kahoots/{uuid}` contains every correct answer).
2. Otherwise the utility joins the live game as a throwaway observer, waits for the
   `quizStart` event (which carries the quiz title + choice-count shape), searches
   the public quiz API for that title, validates the shape, then fetches the answers.
3. Local test host → resolved instantly, without joining.

### 2. `bots <pin>` — spawn answer bots

```bash
kahoot-lab bots 4819273 --count 20                       # "Bot 1" .. "Bot 20"
kahoot-lab bots 4819273 --names "Lab Rat,Wildcard" --strategy random
kahoot-lab bots 4819273 --strategies correct,dumb,correct --accuracy 0.8
kahoot-lab bots 4819273 --score "Bot 2:+1200"            # target applied at quiz start
kahoot-lab bots 4819273 --delay 600 --jitter 800 --duration 300
```

| strategy  | behaviour                                                        |
| --------- | ---------------------------------------------------------------- |
| `correct` | answers with the revealed answer (wrong on the `1-accuracy` share) |
| `random`  | uniform random choice                                             |
| `dumb`    | always option 0 / reversed jumble — never correct                 |
| `slow`    | correct, but at the last moment                                   |
| `skip`    | never answers                                                     |

Bots publish a control endpoint to `.kahoot-lab/ctl/<pin>.json`, so **`score` and
`watch` from another terminal drive the running swarm**. On game over each bot prints
its scoreboard and exits (keep them alive with `--stay`).

### 3. `score <pin>` — add / remove / set points

```bash
kahoot-lab score 4819273 --player "Bot 1" --add 1500
kahoot-lab score 4819273 --player "Bot 1" --remove 500
kahoot-lab score 4819273 --player "Bot 1" --set 4000
```

Where the points come from depends on who runs the game:

| target                                   | result                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| any participant, local test host          | **exact, instant** edit (the test host owns the scoreboard)             |
| one of *my* bots (running swarm)          | planned: the bot banks exactly that many points over the remaining questions |
| other people in a **real** Kahoot game    | **not possible** — see [Limitations](#limitations)                      |

Raising a bot's score is always possible while questions remain. Lowering it needs a
fresh session, so the bot rejoins (score restarts at 0) and then rebuilds to the
target — pass `--remove`/`--set` and the tool tells you what it did. If the goal is
not reachable with the questions left, the command reports the shortfall/overshoot
instead of pretending.

### 4. `watch <pin>` — live scoreboard

```bash
kahoot-lab watch 4819273              # refreshes every 2s (test host or running swarm)
kahoot-lab watch 4819273 --once --json
```

### 5. `mock <quiz.json>` — local Kahoot-compatible test host

```bash
kahoot-lab quiz fetch "capitals of the world" --out world.json   # grab a real quiz
kahoot-lab mock world.json                                       # prints a game PIN
kahoot-lab mock fixtures/demo-quiz.json --question-time 8000 --gap 1000 --auto-start 2
```

The test host speaks the same protocol surface kahoot-lab uses against kahoot.it:

- `GET /reserve/session/{pin}` → challenge + `x-kahoot-session-token` + `x-kahoot-gameserver`
- `WS  /cometd/{pin}/{token}` → bayeux handshake, login, join-verify, answers,
  `quizStart` / `questionStart` / `answerResponse` / `questionEnd` / `podium` events
- `GET /rest/kahoots/?query=` and `/rest/kahoots/{uuid}` → public quiz API shape (with answers)
- `*   /admin/*` → operator API (start/next/kick/reset/**score**, loopback only)

so the entire flow — answers, bots, score editing — is testable offline. The running
host publishes `.kahoot-lab/mock.json`; commands that are given the same PIN
auto-discover it (stale files are probed and ignored).

`reset` (button, admin API, CLI) reopens the lobby **without disconnecting anyone**:
connected players keep their seats with scores zeroed, so a running bot swarm plays
the next game too — the same way a Kahoot host can replay a quiz in the same room.

Flags: `--port`, `--pin`, `--auto-start <sec>` (default 3 after the first join),
`--manual`, `--question-time <ms>`, `--gap <ms>`, `--loop`, `--json`.

### 6. `quiz search | fetch`

```bash
kahoot-lab quiz search "world capitals"
kahoot-lab quiz fetch <uuid|url|title> --out my-quiz.json
```

`fetch` downloads a published quiz (questions **and** correct answers) in the fixture
format used by `mock`.

### 7. `serve` — the web console

```bash
npm run web                 # alias for: kahoot-lab serve  ->  http://127.0.0.1:4380
kahoot-lab serve --port 8080
```

A zero-dependency browser UI over the same modules the CLI uses:

- **Local test host** — start/stop a fixture game and step it (`start`/`next`/`end`/
  `reset`), with question time, auto-start delay and loop mode
- **Reveal answers** — the full answer sheet for the current PIN (or a title search)
- **Answer bots** — count, strategies, accuracy, per-bot overrides; live bot table
- **Scoreboard** — exact `−`/`+`/`=` edits for anyone on the test host (planned edits
  for bots elsewhere), plus a rolling activity log

It auto-adopts a test host started from the CLI in another terminal. Everything is
plain JSON underneath: `GET /api/health|fixtures|games|status/:pin`,
`POST /api/mock/start|stop|control`, `/api/resolve`, `/api/bots/start|stop`,
`/api/score`. Loop mode reopens the lobby after every game and starts the next one
while the room still has players.

### 8. GitHub Pages — the hosted console

```bash
npm run build:pages        # static build -> site/
```

The same console, deployable as a static site (`.github/workflows/pages.yml` builds
and publishes it on every push to `main`). A static host cannot run the Node server,
and Kahoot's APIs don't send CORS headers to third-party origins, so browsers can't
talk to kahoot.it directly — the hosted build therefore ships an **in-browser demo
backend** (`src/web/ui/demo-engine.js`) that implements the whole `/api/*` contract
in the tab: test host, bot swarm with every strategy, Kahoot's scoring formula and
exact score edits, all against the bundled fixture quiz. `app.js` runs unchanged —
`demo-boot.js` shims `window.fetch`, and a banner points to `npm run web` for
real-game features.

## How the live protocol works

Reverse-engineered from Kahoot's own client (same approach as the public
`kahoot.js` / `Pyhoot` libraries):

1. `GET https://kahoot.it/reserve/session/{pin}/?<ts>` → body carries an obfuscated
   `challenge`; headers carry `x-kahoot-session-token` (base64) and optionally
   `x-kahoot-gameserver`.
2. Solve the challenge (three formats handled: py-style `this, 'msg' ... offset = `,
   `'msg' = expr`, and the legacy angular expression) → secret.
3. `sessionToken = base64decode(header) XOR secret` → connect to
   `wss://…/cometd/{pin}/{sessionToken}`.
4. Bayeux handshake → subscribe `/service/{controller,player,status}` → `/meta/connect`
   heartbeat loop (timesync gives the server clock offset used to schedule answers).
5. `/service/controller` publish `login` → `loginResponse` → **join-verify (id 16)**,
   without which the player never appears in the host lobby.
6. Events arrive on `/service/player`: `quizStart(9)`, `questionReady(1)`,
   `questionStart(2)`, `answerResponse(7)`, `questionEnd(8)`, `timeOver(4)`,
   `quizEnd(3)`, `podium(13)`, `nameAccept(14)`, `disconnect(10)`, 2FA `50/51/52/53`.
7. Answers go out as `id 45` with `{questionIndex, choice|text, meta:{lag}, type}`.

### Scoring

Kahoot's classic formula (implemented in [src/scores/scoring.js](src/scores/scoring.js)):

```
points = round((1 - elapsed / (2 × time)) × 1000) × pointsMultiplier
```

instant = 1000, half-way = 750, last millisecond = 500, wrong/timeout = 0.
The planner inverts it (respecting the 250 ms minimum reaction and a 300 ms end
margin) to decide *when* a bot must answer to bank an exact number of points.

## Layout

```
bin/kahoot-lab.js        CLI entry
src/cli.js               commands: solve | bots | score | watch | mock | quiz
src/protocol/            challenge solver, reserve/session, cometd client, packets, events
src/answers/             public quiz API, PIN→answers resolution, terminal formatting
src/bots/                bot, name patterns, swarm + control endpoint
src/scores/              scoring math + planner, score command controller
src/host/                local test host (HTTP + minimal RFC6455 WebSocket server)
src/web/                 web console: JSON API + static UI (serve command)
src/web/ui/demo-*.js     in-browser demo backend for the GitHub Pages build
scripts/build-pages.mjs  static-site build (site/)
fixtures/demo-quiz.json  sample quiz for the test host
test/                    unit + full end-to-end suite (51 tests)
```

## Limitations

* **Editing other people's scores in a real Kahoot game is not possible.** Kahoot
  computes participant scores server-side; the live protocol exposes no score-edit
  channel to other clients (only *your own* answers move *your own* score). The
  utility therefore offers: exact edits anywhere on the **local test host**, exact
  planned edits for **bots it controls**, and a clear error otherwise. To test
  scoreboard scenarios for humans, run the game on `kahoot-lab mock`.
* Answer reveal needs the quiz to be **published** (Kahoot only serves answers for
  published quizzes; private/draft quizzes need `--quiz <uuid>` with access).
* Two-factor games: pass `--two-factor rbyg` to have bots solve the colour code.
* Team/collaboration game modes are not driven by the local test host (classic only).
* The live paths follow public reverse engineering and the two live-API tests, but a
  production Kahoot session cannot be exercised in CI — run against your own game
  and please report breakage.

## Testing

```bash
npm test                 # 51 tests: protocol, scoring, planner, answers, web console, demo engine, full E2E
npm run test:unit        # fast offline subset
npm run test:e2e         # mock host + swarm + CLI end-to-end (~10s)
```

The E2E suite starts the local test host, resolves answers through a live join, runs
4 bots through a full game (including a mid-game rejoin to lower a score), edits
scores both through the admin API and the swarm control endpoint, and exercises the
`solve` / `score` / `watch` / `quiz` CLI commands as child processes. The web suite
drives the console's JSON API through host, answers, bots, score edits and the game
lifecycle — including a second game after a lobby reset to prove a kept swarm plays
again.
