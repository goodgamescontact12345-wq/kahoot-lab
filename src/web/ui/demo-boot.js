/**
 * kahoot·lab demo boot — activates the in-browser demo backend.
 *
 * The static (GitHub Pages) build injects this script *before* app.js and
 * sets window.__KAHOOT_LAB_DEMO__ = true. It routes the console's /api/*
 * fetches to demo-engine.js and adds a small "demo" badge, so the UI code
 * stays byte-identical with the version served by `kahoot-lab serve`.
 *
 * When served by the real Node server this file is never loaded.
 */
(function () {
  "use strict";
  if (!window.__KAHOOT_LAB_DEMO__ || !window.KahootLabDemo) return;

  const nativeFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    if (!url || !/^\/api(\/|$)/.test(url)) return nativeFetch(input, init);
    const method = (init && init.method) || (typeof input === "object" && input.method) || "GET";
    let body = null;
    if (init && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = {};
      }
    }
    return window.KahootLabDemo.handle(method, url, body || {}).then(
      (data) =>
        new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
  };

  // "demo" badge next to the health indicator + banner note under the topbar
  document.addEventListener("DOMContentLoaded", () => {
    const health = document.querySelector(".top-right .health");
    if (health) {
      const badge = document.createElement("span");
      badge.className = "pill warn";
      badge.textContent = "demo mode";
      badge.title =
        "Static demo: the game, bots and scoring run in your browser. " +
        "For the full tool against real Kahoot games, run: npm run web";
      health.insertAdjacentElement("beforebegin", badge);
    }
    const banner = document.createElement("div");
    banner.style.cssText =
      "padding:8px 26px;font-size:13px;color:#fbbf24;background:#fbbf2412;" +
      "border-bottom:1px solid #fbbf2433;";
    banner.innerHTML =
      "Browsers can't call Kahoot's API from another origin (no CORS), so this hosted build " +
      "simulates the whole flow locally — test host, bots and scoring all run in this tab. " +
      "Run <code>kahoot-lab serve</code> on your machine for real-game features.";
    const topbar = document.querySelector(".topbar");
    if (topbar && topbar.parentNode) topbar.insertAdjacentElement("afterend", banner);
  });
})();
