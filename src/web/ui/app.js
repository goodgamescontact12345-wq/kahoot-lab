/* kahoot·lab web console — vanilla, no dependencies ---------------------- */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const CHOICE_COLORS = ["#f87171", "#60a5fa", "#fbbf24", "#34d399"];
const TYPE_LABEL = {
  quiz: "quiz",
  multiple_select_quiz: "multi select",
  jumble: "jumble",
  poll: "poll (no score)",
  survey: "survey (no score)",
  open_ended: "open ended",
  word_cloud: "word cloud",
  true_false: "true / false",
};

const state = {
  pin: localStorage.getItem("kahoot-lab-pin") || "",
  status: null,
  busy: false,
  logText: "",
};

/* ------------------------------------------------------------- helpers */

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* fall through */
  }
  if (!res.ok || (data && data.ok === false)) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}

function toast(message, kind = "info") {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .3s";
    setTimeout(() => el.remove(), 320);
  }, kind === "err" ? 6000 : 3600);
}

const pinOf = () => $("#pin").value.replace(/\D/g, "");

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  if (busy) btn.dataset.label = btn.textContent;
  if (!busy && btn.dataset.label) btn.textContent = btn.dataset.label;
  if (label) btn.textContent = label;
}

function phaseLabel(st) {
  switch (st.phase) {
    case "lobby": return "lobby";
    case "question": return `question ${(st.questionIndex ?? 0) + 1}`;
    case "gap": return "between questions";
    case "ended": return "game over";
    default: return null;
  }
}

/* ------------------------------------------------------------ test host */

async function loadFixtures() {
  try {
    const data = await api("/api/fixtures");
    const select = $("#fixture");
    select.innerHTML = "";
    for (const name of data.fixtures) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name.replace(/\.json$/i, "");
      select.appendChild(opt);
    }
    if (!data.fixtures.length) {
      const opt = document.createElement("option");
      opt.textContent = "no fixtures found";
      select.appendChild(opt);
    }
  } catch (err) {
    toast(`could not list fixtures: ${err.message}`, "err");
  }
}

$("#host-start").addEventListener("click", async () => {
  const btn = $("#host-start");
  setBusy(btn, true, "Starting…");
  try {
    const body = {
      fixture: $("#fixture").value,
      autoStartSec: $("#auto-start").value === "" ? 3 : Number($("#auto-start").value),
      loop: $("#host-loop").checked,
    };
    const qt = $("#question-time").value;
    if (qt) body.questionTimeMs = Math.max(1, Number(qt)) * 1000; // seconds
    const data = await api("/api/mock/start", body);
    setPin(data.pin);
    toast(`Test host up — PIN ${data.pin} (${data.quiz})`, "ok");
    await refresh();
  } catch (err) {
    toast(err.message, "err");
  } finally {
    setBusy(btn, false);
  }
});

$("#host-stop").addEventListener("click", async () => {
  const pin = pinOf();
  if (!pin) return;
  try {
    await api("/api/mock/stop", { pin });
    toast("Test host stopped", "ok");
    await refresh();
  } catch (err) {
    toast(err.message, "err");
  }
});

$$("#host-controls [data-control]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const pin = pinOf();
    if (!pin) return toast("Enter the game PIN first", "err");
    try {
      const res = await api("/api/mock/control", { pin, action: btn.dataset.control });
      if (!res.ok) throw new Error(res.error);
      await refresh();
    } catch (err) {
      toast(err.message, "err");
    }
  });
});

/* -------------------------------------------------------------- answers */

$("#reveal-btn").addEventListener("click", revealAnswers);
$("#answer-title").addEventListener("keydown", (e) => {
  if (e.key === "Enter") revealAnswers();
});
$("#reveal-clear").addEventListener("click", () => {
  $("#answers-out").hidden = true;
  $("#answers-out").innerHTML = "";
  $("#reveal-clear").hidden = true;
  $("#answers-pill").hidden = true;
});

async function revealAnswers() {
  const pin = pinOf();
  const title = $("#answer-title").value.trim();
  if (!pin && !title) return toast("Enter a game PIN (or a quiz title)", "err");
  const btn = $("#reveal-btn");
  setBusy(btn, true, "Resolving…");

  const out = $("#answers-out");
  out.hidden = false;
  $("#reveal-clear").hidden = false;
  out.innerHTML = `
    <div class="skeleton" style="width:60%"></div>
    <div class="skeleton" style="width:90%"></div>
    <div class="skeleton" style="width:75%"></div>
    <div class="skeleton" style="width:85%"></div>`;

  try {
    const data = await api("/api/resolve", {
      pin: pin || undefined,
      title: title || undefined,
      waitSec: Number($("#answer-wait").value) || 45,
    });
    renderAnswers(data);
    $("#answers-pill").hidden = false;
    $("#answers-pill").className = "pill ok";
    $("#answers-pill").textContent = `${data.questions.filter((q) => q.answer).length}/${data.questions.length} answerable`;
    toast(`“${data.title}” — answers loaded`, "ok");
  } catch (err) {
    out.innerHTML = "";
    out.hidden = true;
    $("#reveal-clear").hidden = true;
    toast(err.message, "err");
  } finally {
    setBusy(btn, false);
  }
}

function renderAnswers(data) {
  const out = $("#answers-out");
  out.innerHTML = "";
  const title = document.createElement("div");
  title.className = "answer-q";
  title.innerHTML = `<div class="q-text"><span class="idx">★</span><span></span></div>
    <div class="q-meta">${data.questions.length} questions · source: ${escapeHtml(data.source)}</div>`;
  title.querySelector("span:last-child").textContent = data.title;
  out.appendChild(title);

  for (const q of data.questions) {
    const wrap = document.createElement("div");
    wrap.className = "answer-q";

    const head = document.createElement("div");
    head.className = "q-text";
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = `${q.index}.`;
    const text = document.createElement("span");
    text.textContent = q.question || "(no question text)";
    head.append(idx, text);
    wrap.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "q-meta";
    const bits = [TYPE_LABEL[q.type] || q.type];
    if (q.pointsMultiplier === 2) bits.push("double points");
    if (q.time) bits.push(`${Math.round(q.time / 1000)}s`);
    meta.textContent = bits.join(" · ");
    wrap.appendChild(meta);

    const list = document.createElement("div");
    list.className = "choices";

    if (!q.answer) {
      const none = document.createElement("div");
      none.className = "choice none";
      none.textContent = q.type === "jumble" ? "jumble — order shown below" : "no correct answer";
      if (q.type !== "jumble") list.appendChild(none);
    }

    if (q.answer && q.answer.type === "jumble") {
      const order = document.createElement("div");
      order.className = "choice correct";
      order.innerHTML = `<span class="swatch" style="background:${CHOICE_COLORS[1]}"></span><span></span><span class="tag">correct order</span>`;
      order.querySelector("span:nth-child(2)").textContent = q.answer.order.join("  →  ");
      list.appendChild(order);
    }

    q.choices.forEach((choice, i) => {
      const correct = q.answer && (
        q.answer.type === "jumble"
          ? false
          : (q.answer.choices || []).includes(choice)
      );
      const row = document.createElement("div");
      row.className = `choice${correct ? " correct" : ""}`;
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = CHOICE_COLORS[i % CHOICE_COLORS.length];
      const label = document.createElement("span");
      label.textContent = `${String.fromCharCode(65 + i)}) ${choice}`;
      row.append(swatch, label);
      if (correct) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "correct";
        row.appendChild(tag);
      }
      list.appendChild(row);
    });

    wrap.appendChild(list);
    out.appendChild(wrap);
  }
  out.scrollTop = 0;
}

/* ----------------------------------------------------------------- bots */

$("#bots-start").addEventListener("click", async () => {
  const pin = pinOf();
  if (!pin) return toast("Enter a game PIN first", "err");
  const btn = $("#bots-start");
  setBusy(btn, true, "Joining…");
  try {
    const strategies = $("#bot-strategies").value.trim();
    const body = {
      pin,
      count: Number($("#bot-count").value) || 1,
      strategy: $("#bot-strategy").value,
      accuracy: Number($("#bot-accuracy").value),
      pattern: $("#bot-pattern").value.trim() || "Bot {i}",
      useAnswers: $("#bot-answers").checked,
    };
    if (strategies) body.strategies = strategies;
    const data = await api("/api/bots/start", body);
    toast(`${data.started} bots launched for PIN ${pin}`, "ok");
    await refresh();
  } catch (err) {
    toast(err.message, "err");
  } finally {
    setBusy(btn, false);
  }
});

$("#bots-stop").addEventListener("click", async () => {
  const pin = pinOf();
  if (!pin) return;
  try {
    await api("/api/bots/stop", { pin });
    toast("Bots stopped", "ok");
    await refresh();
  } catch (err) {
    toast(err.message, "err");
  }
});

/* ------------------------------------------------------------- scoreboard */

$("#score-table").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-op]");
  if (!btn) return;
  const row = btn.closest("tr");
  const input = row.querySelector("input");
  const value = input.value;
  if (value === "" || !Number.isFinite(Number(value))) {
    return toast("enter a points value first", "warn");
  }
  const pin = pinOf();
  if (!pin) return toast("Enter a game PIN first", "err");
  const op = { pin, player: row.dataset.name };
  op[btn.dataset.op] = Number(value);
  btn.disabled = true;
  try {
    const res = await api("/api/score", op);
    if (!res.ok) throw new Error(res.error);
    toast(res.message || `${row.dataset.name}: ${JSON.stringify(op[btn.dataset.op])}`, res.feasible === false ? "warn" : "ok");
    await refresh();
  } catch (err) {
    toast(err.message, "err");
  } finally {
    btn.disabled = false;
  }
});

/* --------------------------------------------------------------- render */

function render(st) {
  renderHost(st);
  renderBots(st);
  renderScore(st);
  renderLog(st);
  renderSheetFromStatus(st);
}

/** Show the answer sheet whenever the server already knows the answers —
 * not only right after clicking Reveal in this tab. */
function renderSheetFromStatus(st) {
  const a = st.answers;
  if (!a || !a.loaded || !Array.isArray(a.questions) || !a.questions.length) return;
  const sig = `${st.pin}|${a.title}|${a.questions.length}|${a.source}`;
  if (state.sheetSig === sig) return;
  state.sheetSig = sig;
  renderAnswers(a);
  $("#answers-out").hidden = false;
  $("#reveal-clear").hidden = false;
  const pill = $("#answers-pill");
  pill.hidden = false;
  pill.className = "pill ok";
  pill.textContent = `${a.questions.filter((q) => q.answer).length}/${a.questions.length} answerable`;
}

function hideAnswersSheet() {
  state.sheetSig = null;
  $("#answers-out").hidden = true;
  $("#answers-out").innerHTML = "";
  $("#reveal-clear").hidden = true;
  $("#answers-pill").hidden = true;
}

function renderHost(st) {
  const running = st.isTestHost;
  $("#host-start").hidden = running;
  $("#host-stop").hidden = !running;
  $("#host-controls").hidden = !running;
  $("#fixture").disabled = running;
  const pill = $("#host-pill");
  if (running) {
    const phase = phaseLabel(st);
    pill.hidden = false;
    pill.className = `pill ${st.phase === "ended" ? "" : "ok"}`;
    pill.textContent = `PIN ${st.pin} · ${phase}`;
  } else {
    pill.hidden = true;
  }
}

function renderBots(st) {
  const tbody = $("#bot-table tbody");
  const pill = $("#bots-pill");
  const running = Array.isArray(st.bots);
  $("#bots-start").hidden = running;
  $("#bots-stop").hidden = !running;

  if (running) {
    const joined = st.bots.filter((b) => b.state === "lobby" || b.state === "playing").length;
    pill.hidden = false;
    pill.className = `pill ${joined === st.bots.length ? "ok" : "warn"}`;
    pill.textContent = `${joined}/${st.bots.length} joined`;
  } else {
    pill.hidden = true;
  }

  $("#bots-empty").hidden = running && st.bots.length > 0;
  if (!running || !st.bots.length) {
    tbody.innerHTML = "";
    return;
  }
  if (tbody.contains(document.activeElement)) return; // don't clobber focus

  tbody.innerHTML = st.bots
    .map(
      (b, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td class="name">${escapeHtml(b.name)}</td>
        <td><span class="state ${escapeHtml(b.state)}">${escapeHtml(b.state)}</span></td>
        <td class="num score-cell">${b.score}</td>
        <td class="num">${b.rank || "–"}</td>
        <td class="num">${b.question || "–"}</td>
      </tr>`
    )
    .join("");
}

function renderScore(st) {
  const board = st.scoreboard;
  const tbody = $("#score-table tbody");
  const pill = $("#score-pill");
  const hint = $("#score-hint");

  if (!board || !board.players || !board.players.length) {
    tbody.innerHTML = "";
    $("#score-empty").hidden = false;
    pill.hidden = true;
    hint.textContent = "Add, remove or set points for any player — exact and instant on the local test host; planned over the remaining questions for bots.";
    return;
  }
  $("#score-empty").hidden = true;

  const phase = phaseLabel(st);
  pill.hidden = false;
  pill.className = `pill ${board.source === "test-host" ? "ok" : ""}`;
  pill.textContent = board.source === "test-host"
    ? `${board.players.length} players · ${phase || "live"}`
    : `${board.players.length} bots · swarm`;

  if (board.source === "test-host") {
    hint.innerHTML = "Exact, instant edits — the local test host owns this scoreboard. For a <strong>real</strong> Kahoot game, points can only be planned for bots this tool controls.";
  } else {
    hint.innerHTML = "Bot scores are reached by planning the remaining answers; lowering a score makes the bot rejoin with a fresh session.";
  }

  if (tbody.contains(document.activeElement)) return; // don't clobber focus

  const botNames = new Set((st.bots || []).map((b) => b.name));
  tbody.innerHTML = board.players
    .map((p, i) => {
      const isBot = p.isBot || botNames.has(p.name);
      const rank = p.rank || i + 1;
      return `<tr data-name="${escapeHtml(p.name)}">
        <td class="num ${rank === 1 ? "rank-1" : ""}">${rank}</td>
        <td class="name">${escapeHtml(p.name)}${isBot ? '<span class="bot-tag">bot</span>' : ""}</td>
        <td class="num score-cell">${p.score ?? 0}</td>
        <td class="num">${p.correct ?? "–"}</td>
        <td class="adjust">
          <div class="adjust-group">
            <input type="number" placeholder="0" step="100" aria-label="points" />
            <button class="btn small" data-op="remove" title="remove points">−</button>
            <button class="btn small" data-op="add" title="add points">+</button>
            <button class="btn small" data-op="set" title="set exact score">=</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");
}

function renderLog(st) {
  const el = $("#log");
  const pill = $("#log-pill");
  const text = (st.log || []).join("\n");
  pill.hidden = !(st.log && st.log.length);
  if (st.log && st.log.length) {
    pill.className = "pill";
    pill.textContent = `${st.log.length} lines`;
  }
  if (text === state.logText) return;

  const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  state.logText = text;
  if (!text) {
    el.innerHTML = '<div class="log-empty">events for the current PIN appear here</div>';
    return;
  }
  el.innerHTML = (st.log || [])
    .map((line) => {
      let cls = "line";
      if (/\bcorrect\b|joined|answers loaded|game over|score plan|started/i.test(line)) cls += " good";
      if (/wrong|error|failed|!|kicked|unavailable/i.test(line)) cls += " bad";
      if (/score |answerable/i.test(line)) cls += " accent";
      return `<div class="${cls}">${escapeHtml(line)}</div>`;
    })
    .join("");
  if (stick) el.scrollTop = el.scrollHeight;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/* -------------------------------------------------------------- polling */

async function refresh() {
  const pin = pinOf();
  if (pin !== state.pin) {
    state.pin = pin;
    state.logText = "";
    hideAnswersSheet();
    localStorage.setItem("kahoot-lab-pin", pin);
  }
  if (!pin) {
    state.status = null;
    $("#host-pill").hidden = true;
    $("#bots-pill").hidden = true;
    $("#score-pill").hidden = true;
    $("#log-pill").hidden = true;
    $("#bot-table tbody").innerHTML = "";
    $("#score-table tbody").innerHTML = "";
    $("#bots-empty").hidden = false;
    $("#score-empty").hidden = false;
    $("#bots-start").hidden = false;
    $("#bots-stop").hidden = true;
    $("#host-start").hidden = false;
    $("#host-stop").hidden = true;
    $("#host-controls").hidden = true;
    return;
  }
  try {
    const st = await api(`/api/status/${pin}`);
    state.status = st;
    render(st);
  } catch (err) {
    // transient (server restarting etc.) - keep the last view
    $("#health-dot").className = "dot off";
    $("#health-text").textContent = "disconnected";
  }
}

async function checkHealth() {
  try {
    await api("/api/health");
    $("#health-dot").className = "dot on";
    $("#health-text").textContent = "connected";
  } catch {
    $("#health-dot").className = "dot off";
    $("#health-text").textContent = "disconnected";
  }
}

/* ----------------------------------------------------------------- boot */

function setPin(pin) {
  $("#pin").value = pin;
  state.pin = pin;
  state.logText = "";
  hideAnswersSheet();
  localStorage.setItem("kahoot-lab-pin", pin);
}

$("#pin").addEventListener("input", () => {
  const cleaned = $("#pin").value.replace(/\D/g, "");
  if (cleaned !== $("#pin").value) $("#pin").value = cleaned;
  refresh();
});

$("#pin").addEventListener("keydown", (e) => {
  if (e.key === "Enter") revealAnswers();
});

/** Adopt a test host that was started outside this page (CLI / another
 * terminal) so the console never sits on a stale PIN while a game runs. */
async function adoptActiveGame() {
  try {
    const data = await api("/api/games");
    const games = data.games || [];
    if (!games.length) return;
    const current = pinOf();
    if (current && games.some((g) => g.pin === current)) return;
    setPin(games[0].pin);
    toast(`Adopted running test host — PIN ${games[0].pin}`, "ok");
  } catch {
    /* server not ready yet - refresh loop will catch up */
  }
}

(async function boot() {
  if (state.pin) $("#pin").value = state.pin;
  await loadFixtures();
  await checkHealth();
  await adoptActiveGame();
  await refresh();
  setInterval(refresh, 1500);
  setInterval(checkHealth, 6000);
})();
