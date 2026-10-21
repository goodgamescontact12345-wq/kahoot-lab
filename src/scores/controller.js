/**
 * The `score` / `watch` backend.
 *
 * Score editing authority depends on where the game runs:
 *
 *   local test host (kahoot-lab mock)  -> full control over every player
 *   running swarm (kahoot-lab bots)    -> full control over *our* bots
 *   real Kahoot live game              -> scores are computed server-side;
 *                                         the protocol exposes no edit
 *                                         channel for other players
 */

import { ctlRequest, readCtl } from "../bots/swarm.js";

/**
 * Detect whether `baseUrl` is a kahoot-lab test host (it exposes /admin/state).
 * @param {string} baseUrl
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<object|null>}
 */
export async function probeTestHost(baseUrl, fetchImpl = fetch) {
  if (!baseUrl) return null;
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/admin/state`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && typeof data.pin === "string" && Array.isArray(data.players)) return data;
    return null;
  } catch {
    return null;
  }
}

/**
 * Adjust a player's score.
 * @param {{
 *   pin:string,
 *   player:string,
 *   add?:number,
 *   remove?:number,
 *   set?:number,
 *   baseUrl?:string,
 *   fetchImpl?:typeof fetch
 * }} opts
 * @returns {Promise<object>} machine readable result
 */
export async function adjustScore(opts) {
  const { pin, player, add, remove, set, baseUrl, fetchImpl = fetch } = opts;
  if (!player) return { ok: false, error: "give the player name with --player" };
  if (typeof add !== "number" && typeof remove !== "number" && typeof set !== "number") {
    return { ok: false, error: "give one of: --add <points>, --remove <points>, --set <points>" };
  }

  // 1) local test host owns every scoreboard
  const hostState = await probeTestHost(baseUrl, fetchImpl);
  if (hostState && (!pin || hostState.pin === String(pin))) {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/admin/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: player, add, remove, set }),
    });
    if (res.status === 404) {
      const state = await (await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/admin/state`)).json();
      return {
        ok: false,
        error: `no player named "${player}" in this game`,
        players: state.players.map((p) => p.name),
      };
    }
    const data = await res.json();
    if (!data || data == null) return { ok: false, error: "score adjustment failed" };
    return {
      ok: true,
      source: "test-host",
      ...data,
      message: `${data.name}: ${data.previousScore} -> ${data.score}`,
    };
  }

  // 2) a swarm we launched for this PIN
  const ctl = pin ? readCtl(pin) : null;
  if (ctl) {
    let status;
    try {
      status = await ctlRequest(ctl, { cmd: "status" });
    } catch (err) {
      return {
        ok: false,
        error: `found a control endpoint for PIN ${pin} but it did not answer (${err.message}) - is the bots process still running?`,
      };
    }
    if (!status.ok) return status;
    const names = (status.bots || []).map((b) => b.name);
    const wanted = String(player).toLowerCase();
    const isBot = names.some((n) => n.toLowerCase() === wanted);
    if (!isBot) {
      return {
        ok: false,
        error:
          `"${player}" is not one of my bots, and Kahoot's live protocol does not allow ` +
          `changing another participant's score (the server owns it). ` +
          `I control: ${names.join(", ") || "(none)"}. ` +
          `To edit arbitrary players, run the game on the local test host: ` +
          `kahoot-lab mock <quiz.json>`,
        controlled: names,
      };
    }
    const result = await ctlRequest(ctl, {
      cmd: "adjust",
      name: player,
      add,
      remove,
      set,
    });
    return { ...result, source: "swarm" };
  }

  // 3) nothing to talk to
  return {
    ok: false,
    error:
      `no running swarm for PIN ${pin || "?"} and no test host at ${baseUrl || "(kahoot.it)"}. ` +
      `Start bots with: kahoot-lab bots ${pin || "<pin>"} - start a local game with: kahoot-lab mock <quiz.json>`,
  };
}

/**
 * Fetch the best scoreboard we can see for a PIN.
 * @param {{pin:string, baseUrl?:string, fetchImpl?:typeof fetch}} opts
 * @returns {Promise<{source:string, phase?:string, players:Array}|null>}
 */
export async function fetchScoreboard(opts) {
  const { pin, baseUrl, fetchImpl = fetch } = opts;
  const hostState = await probeTestHost(baseUrl, fetchImpl);
  if (hostState && (!pin || hostState.pin === String(pin))) {
    return {
      source: "test-host",
      phase: hostState.phase,
      questionIndex: hostState.questionIndex,
      quiz: hostState.quiz,
      players: hostState.players.map((p) => ({
        name: p.name,
        score: p.score,
        correct: p.correct,
        rank: p.rank,
        connected: p.connected,
      })),
    };
  }
  const ctl = pin ? readCtl(pin) : null;
  if (ctl) {
    try {
      const status = await ctlRequest(ctl, { cmd: "status" });
      if (status.ok) {
        return {
          source: "swarm",
          players: status.bots.map((b) => ({
            name: b.name,
            score: b.score,
            correct: b.correct,
            rank: b.rank,
            isBot: true,
            state: b.state,
          })),
        };
      }
    } catch {
      return null;
    }
  }
  return null;
}
