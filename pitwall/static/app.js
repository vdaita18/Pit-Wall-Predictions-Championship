/* Pit Wall — single-page front end */
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const view = $("#view");
  let S = null;            // championship state from /api/state
  let RV = null;           // race weekend detail
  let charts = [];
  let schedule = null;

  // ------------------------------------------------------------------ utils
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const flagEmoji = (cc) => (cc && cc.length === 2) ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "";
  const EMPTY = new Set(["", "----", null, undefined]);
  const playerById = (id) => S.players.find((p) => p.id === Number(id));
  const driverByName = (n) => S.drivers.find((d) => d.name === n);
  const teamColor = (n) => (driverByName(n) || {}).team_color || "transparent";
  const fmt = (v, d = 2) => (v === null || v === undefined) ? "—" : Number(v).toFixed(d);
  const pts = (v) => { const n = Math.round((Number(v) || 0) * 100) / 100; return Number.isInteger(n) ? String(n) : String(n); };
  const pct = (v) => (v === null || v === undefined) ? "—" : Math.round(v * 100) + "%";

  let ME = { passcode_required: false, signed_in: true, player_id: null };
  // identifies this browser so it can tell its own changes from the other player's
  const DEVICE = (() => {
    const fresh = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { const k = "pitwall-device"; const v = localStorage.getItem(k) || fresh; localStorage.setItem(k, v); return v; }
    catch (e) { return fresh; }
  })();
  let knownRev = 0;

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, headers: Object.assign({ "X-Pitwall-Device": DEVICE }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined, credentials: "same-origin",
    });
    const rev = Number(res.headers.get("X-Pitwall-Rev"));
    if (rev) knownRev = Math.max(knownRev, rev);
    let data = {};
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) {
      const err = new Error(data.error || "Something went wrong saving that. Try again.");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ------------------------------------------------------------------ who's playing
  const canEdit = () => !ME.passcode_required || (ME.signed_in && !!ME.player_id);
  const canPick = (pid) => !ME.passcode_required || (canEdit() && ME.player_id === Number(pid));

  async function loadMe() {
    ME = await api("GET", "/api/me");
    knownRev = Math.max(knownRev, ME.rev || 0);
    renderWho();
  }
  function renderWho() {
    const box = $("#who"); if (!box) return;
    if (!ME.passcode_required) { box.innerHTML = ""; return; }
    const p = ME.player_id && S ? playerById(ME.player_id) : null;
    box.innerHTML = p
      ? `<div class="who-chip"><span class="dot" style="--c:${p.color}"></span><span>Playing as <b>${esc(p.name)}</b></span></div>
         <div class="who-links"><button class="who-link" data-who="switch">Switch player</button><button class="who-link" data-who="out">Sign out</button></div>`
      : `<div class="who-chip muted">Viewing only</div><button class="btn small" data-who="in">Sign in to play</button>`;
  }
  function openSignIn(message) {
    const d = $("#signin");
    $("#signin-msg").textContent = message || "";
    $("#signin-pass-row").hidden = !ME.passcode_required || ME.signed_in;
    $("#signin-players").innerHTML = S.players.map((p) => `
      <label class="who-pick" style="--c:${p.color}">
        <input type="radio" name="player" value="${p.id}" ${p.id === ME.player_id ? "checked" : ""}>
        <span class="dot" style="--c:${p.color}"></span>${esc(p.name)}</label>`).join("");
    if (!d.open) d.showModal();
    setTimeout(() => (($("#signin-pass-row").hidden ? null : $("#signin-pass")) || $("#signin-players input"))?.focus(), 30);
  }
  $("#signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (e.submitter && e.submitter.value === "cancel") { $("#signin").close(); return; }
    const pid = Number(new FormData(e.target).get("player"));
    try {
      await api("POST", "/api/login", { passcode: $("#signin-pass").value, player_id: pid });
      $("#signin").close(); $("#signin-pass").value = "";
      await loadMe(); await refresh();
      toast(`Signed in as ${playerById(pid).name}. Your column is unlocked.`);
    } catch (err) { $("#signin-msg").textContent = err.message; }
  });
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-who]"); if (!b) return;
    if (b.dataset.who === "out") { await api("POST", "/api/logout"); await loadMe(); await refresh(); toast("Signed out. You can still view everything."); }
    else openSignIn(b.dataset.who === "switch" ? "Pick who's playing on this device." : "");
  });

  // ------------------------------------------------------------------ live updates from the other player
  let pendingRemote = null;
  const editingNow = () => { const a = document.activeElement; return a && view.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName); };
  async function applyRemote() {
    if (!pendingRemote || editingNow() || $("#signin").open || $("#confirm").open) return;
    const info = pendingRemote; pendingRemote = null;
    if (RV && /^#\/(race|weekend)/.test(location.hash || "")) { await reloadRace().catch(() => {}); weekendFx({ reveal: true }); }
    else if (/^#\/replay/.test(location.hash || "")) await loadState().catch(() => {});
    else await refresh().catch(() => {});
    toast(`${info.by || "Your friend"} ${info.what}.`, "live", 4500);
  }
  async function poll() {
    if (document.hidden) return;
    try {
      const r = await fetch("/api/rev", { credentials: "same-origin" }).then((x) => x.json());
      if (r.rev > knownRev) {
        knownRev = r.rev;
        const mine = r.device ? r.device === DEVICE : String(r.by_id || "") === String(ME.player_id || "");
        if (!mine) { pendingRemote = r; applyRemote(); }
      }
    } catch (e) { /* offline for a moment; try again next tick */ }
  }
  setInterval(poll, 4000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  view.addEventListener("focusout", () => setTimeout(applyRemote, 150));

  window.PitToast = (m, k) => toast(m, k || "ok", 2200);
  function toast(msg, kind = "ok", ms = 4200) {
    const t = document.createElement("div");
    t.className = "toast " + (kind === "ok" ? "" : kind);
    t.textContent = msg;
    $("#toasts").appendChild(t);
    setTimeout(() => { t.style.transition = "opacity .3s"; t.style.opacity = 0; setTimeout(() => t.remove(), 300); }, ms);
  }
  let savedTimer;
  function flashSaved() {
    const s = $("#saving"); s.classList.add("show");
    clearTimeout(savedTimer); savedTimer = setTimeout(() => s.classList.remove("show"), 1100);
  }
  function confirmBox(title, text, yes = "Confirm") {
    const d = $("#confirm");
    $("#confirm-title").textContent = title; $("#confirm-text").textContent = text; $("#confirm-yes").textContent = yes;
    d.showModal();
    return new Promise((resolve) => {
      const done = (v) => { d.close(); $("#confirm-yes").onclick = $("#confirm-no").onclick = null; resolve(v); };
      $("#confirm-yes").onclick = () => done(true);
      $("#confirm-no").onclick = () => done(false);
      d.oncancel = () => done(false);
    });
  }

  async function loadState() { S = await api("GET", "/api/state"); $("#brand-season").textContent = S.season + " season"; renderWho(); }

  // ------------------------------------------------------------------ driver chip select
  const colorOf = (name, pool) => ((pool || []).find((d) => d.name === name) || {}).team_color || teamColor(name);
  /* pool: the drivers to offer (a weekend's line-up); others: also list everyone else under "Other drivers" */
  /* standings: true adds each driver's championship position and points to the options */
  function driverSelect(attrs, value, standings, locked, pool, others) {
    if (locked) attrs += " disabled";
    pool = pool || S.drivers;
    const groups = new Map();
    pool.forEach((d) => {
      const k = d.team || "Reserves";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    });
    if (others) {
      const rest = S.drivers.filter((d) => !pool.some((x) => x.name === d.name));
      if (rest.length) groups.set("Other drivers", rest);
    }
    const has = !EMPTY.has(value);
    const listed = [...groups.values()].flat();
    let opts = `<option value="----">${has ? "Clear pick" : "Pick a driver"}</option>`;
    if (has && !listed.some((d) => d.name === value)) opts += `<option selected>${esc(value)}</option>`;
    for (const [team, ds] of groups) {
      opts += `<optgroup label="${esc(team)}">` + ds.map((d) =>
        `<option value="${esc(d.name)}" ${d.name === value ? "selected" : ""}>${esc(d.name)}${d.stand_in ? " (in for " + esc(d.replaces) + ")" : ""}${standings === "standings" ? standingTag(d.name) : ""}</option>`).join("") + "</optgroup>";
    }
    return `<span class="dsel ${has ? "set" : "empty-val"}" style="--team:${has ? colorOf(value, pool) : "transparent"}">
      <select ${attrs} aria-label="Driver">${opts}</select></span>`;
  }

  const standingOf = (name) => (S.driver_standings || []).find((x) => x.driver === name);
  const standingTag = (name) => { const x = standingOf(name); return x ? ` · P${x.position}, ${pts(x.points)} pts` : ""; };
  const infoOf = (session, driver) => (((RV && RV.info) || {})[session] || {})[driver] || null;

  // ------------------------------------------------------------------ router
  const routes = {
    "": viewStandings, calendar: viewCalendar, weekend: viewWeekend, race: viewRace,
    analytics: viewAnalytics, replay: viewReplay, rules: viewRules, cards: viewCards, season: viewSeason, grid: viewGrid,
  };
  async function route(animate = true) {
    const [, name = "", arg] = (location.hash || "#/").split("/");
    const fn = routes[name] || viewStandings;
    const navKey = name === "race" ? "weekend" : (name || "standings");
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === navKey));
    const more = $("#nav-more");
    if (more) { more.classList.toggle("active", !!$("#nav-extra a.active")); closeMore(); }
    let html;
    try { html = await fn(arg); } catch (e) { html = `<div class="empty"><h2>Couldn't load this page</h2><p>${esc(e.message)}</p></div>`; }
    const swap = () => {
      charts.forEach((c) => c.destroy()); charts = [];
      if (window.PitReplay) PitReplay.stop();
      view.innerHTML = html;
      if (fn.after) fn.after(arg);
    };
    if (animate && document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const t = document.startViewTransition(swap);   // skipped animations (e.g. the phone's address bar resizing) are fine
      t.ready.catch(() => {}); t.finished.catch(() => {});
    } else {
      swap();
      if (animate) { view.classList.remove("fallback-in"); void view.offsetWidth; view.classList.add("fallback-in"); }
    }
    if (animate) window.scrollTo({ top: 0 });
  }
  window.addEventListener("hashchange", () => route(true));
  // phones: the less-used pages live behind a More button above the tab bar
  function closeMore() { const x = $("#nav-extra"), b = $("#nav-more"); if (x) x.classList.remove("open"); if (b) b.setAttribute("aria-expanded", "false"); }
  $("#nav-more").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !$("#nav-extra").classList.contains("open");
    $("#nav-extra").classList.toggle("open", open); $("#nav-more").setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#nav-extra")) closeMore(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMore(); });
  const go = (hash) => { if (location.hash === hash) route(true); else location.hash = hash; };
  async function refresh() { await loadState(); await route(false); }

  // ================================================================== STANDINGS
  async function viewStandings() {
    const st = S.standings;
    if (!S.races.length) {
      return `<div class="page-head"><div><h1>Lights out soon</h1><p class="sub">Add the first race weekend to start the championship.</p></div></div>
        <div class="empty"><h2>No races yet</h2><p>Head to the calendar, type the host city, and a predictions sheet is ready in a second.</p>
        <a class="btn" href="#/calendar">Add a race</a></div>`;
    }
    const leader = st[0], second = st[1];
    const gap = second ? leader.total - second.total : 0;
    const total = st.reduce((a, s) => a + s.total, 0) || 1;
    const latest = S.races[S.races.length - 1];
    const pending = S.races.filter((r) => !r.has_results);
    const nextRace = pending[0] || latest;
    const fp = playerById(nextRace.first_picker);
    const battle = st.length === 2 ? `
      <section class="panel battle">
        <div class="battle-names">
          ${st.map((s, i) => `<div class="battle-side ${i ? "right" : ""}">
            <div class="battle-name" style="color:${s.color}">${esc(s.name)}</div>
            <div class="battle-pts">${pts(s.total)}<small>pts</small></div></div>`).join("")}
        </div>
        <div class="battle-bar" aria-hidden="true">
          ${st.map((s) => `<span style="--c:${s.color}" data-w="${(s.total / total * 100).toFixed(1)}"></span>`).join("")}
        </div>
        <div class="battle-note">
          <span>${gap === 0 ? "Dead level after " + S.races.filter(r => r.has_results).length + " results" : `<b>${esc(leader.name)}</b> leads by ${pts(gap)}`}</span>
          <span class="leader-extra">${st.some((s) => s.season_points) ? "Includes season-prediction points" : ""}</span>
        </div>
      </section>` : `
      <section class="panel board-n">${st.map((s, i) => `
        <div class="lb-row" style="--c:${s.color}">
          <span class="lb-pos">P${i + 1}</span><span class="lb-name">${esc(s.name)}</span>
          <span class="lb-bar"><span data-w="${(st[0].total ? s.total / st[0].total * 100 : 0).toFixed(1)}"></span></span>
          <span class="lb-pts">${pts(s.total)}</span>
          <span class="lb-gap">${i ? (st[0].total - s.total ? "−" + pts(st[0].total - s.total) : "level") : "leader"}</span></div>`).join("")}
        ${st.some((s) => s.season_points) ? `<p class="leader-extra" style="margin:10px 0 0">Includes season-prediction points</p>` : ""}
      </section>`;

    const form = S.players.map((p) => `
      <div><span class="dot" style="--c:${p.color}"></span> <b>${esc(p.name)}</b></div>
      <div class="form-row">${S.stats.per_race.map((r) => {
        if (!r.has_results) return `<a class="form-cell" href="#/race/${r.id}" title="${esc(r.title)}: waiting for results">–</a>`;
        const mine = r.points[p.id]; const best = Math.max(...S.players.filter(o => o.id !== p.id).map((o) => r.points[o.id]));
        const cls = mine > best ? "w" : mine === best ? "t" : "";
        return `<a class="form-cell ${cls}" style="--c:${p.color}" href="#/race/${r.id}" title="${esc(r.title)}: ${pts(mine)} pts">${pts(mine)}</a>`;
      }).join("")}</div>`).join("");

    return `
      <div class="page-head"><div><h1>Championship</h1><p class="sub">${S.races.length} race weekends · ${S.season}</p></div></div>
      <div class="stack">
        ${battle}
        <div class="grid-2">
          <section class="panel">
            <h3 class="muted">${pending.length ? "Up next" : "Latest weekend"}</h3>
            <div class="next-up">
              <div style="flex:1">
                <div class="race-word"><span class="flag">${flagEmoji(nextRace.flag)}</span> ${esc(nextRace.title)}</div>
                <div class="cal-meta">Round ${nextRace.round} ${nextRace.is_sprint ? '<span class="tag sprint">Sprint weekend</span>' : ""}
                  ${fp ? `<span><span class="dot" style="--c:${fp.color}"></span> ${esc(fp.name)} picks first</span>` : ""}</div>
              </div>
              <a class="btn" href="#/race/${nextRace.id}">${nextRace.has_results ? "Review weekend" : "Make predictions"}</a>
            </div>
          </section>
          <section class="panel">
            <h3 class="muted">Weekend form</h3>
            <div class="form-guide">${form}</div>
          </section>
        </div>
      </div>`;
  }
  viewStandings.after = () => {
    requestAnimationFrame(() => setTimeout(() => {
      document.querySelectorAll(".battle-bar span, .lb-bar span").forEach((s) => { s.style.width = s.dataset.w + "%"; });
    }, 80));
  };

  // ================================================================== CALENDAR
  async function viewCalendar() {
    const rows = S.races.map((r) => {
      const fp = playerById(r.first_picker);
      return `<li><a class="cal-row" href="#/race/${r.id}">
        <span class="cal-round">${r.round}</span>
        <span>
          <span class="cal-title"><span class="flag">${flagEmoji(r.flag)}</span>${esc(r.title)} ${r.is_sprint ? '<span class="tag sprint">Sprint</span>' : ""}</span>
          <span class="cal-meta">${fp ? `<span class="dot" style="--c:${fp.color}"></span> ${esc(fp.name)} picks first` : ""}</span>
        </span>
        <span class="cal-points">${S.players.map((p) => `<span><span class="dot" style="--c:${p.color}"></span>${pts(r.points[p.id] ?? 0)}</span>`).join("")}</span>
        <span class="cal-status">${r.has_results ? '<span class="tag done">Results in</span>' : '<span class="tag live">Predicting</span>'}</span>
      </a></li>`;
    }).join("");
    return `
      <div class="page-head"><div><h1>Calendar</h1><p class="sub">Add each race as its weekend starts. Put “Sprint” in the name for sprint weekends.</p></div></div>
      <div class="stack">
        <section class="panel">
          <form class="add-race" id="add-race" autocomplete="off">
            <input type="text" name="title" placeholder="Host city, e.g. Mexico or Miami Sprint" list="sched-list" aria-label="Race name">
            <datalist id="sched-list">${(schedule || []).filter(s => !s.added).map((s) => `<option value="${esc(s.suggested)}">`).join("")}</datalist>
            <button class="btn" type="submit">Add race</button>
            <button class="btn ghost" type="button" data-action="load-schedule">Show official calendar</button>
            <button class="btn ghost" type="button" data-action="full-calendar">Add the whole season</button>
          </form>
          <div id="sched-box"></div>
        </section>
        ${S.races.length ? `<ul class="cal">${rows}</ul>` :
          `<div class="empty"><h2>The calendar is empty</h2><p>Add your first race above. The predictions sheet is created straight away.</p></div>`}
      </div>`;
  }
  viewCalendar.after = () => { if (schedule) renderSchedule(); };
  function renderSchedule() {
    const box = $("#sched-box"); if (!box) return;
    box.innerHTML = `<h3 style="margin-top:20px">${S.season} calendar</h3><div class="sched">` + schedule.map((s) => `
      <div class="sched-item"><span><b>${flagEmoji(s.flag)} ${esc(s.suggested)}</b><small>Round ${s.round} · ${esc(s.date || "")}</small></span>
      ${s.added ? '<span class="tag done">Added</span>' : `<button class="btn small" data-action="add-official" data-round="${s.round}">Add</button>`}</div>`).join("") + "</div>";
  }

  // ================================================================== WEEKEND
  async function viewWeekend() {
    if (!S.races.length) {
      return `<div class="page-head"><h1>This weekend</h1></div><div class="empty"><h2>No race weekend yet</h2>
        <p>Add the race on the calendar and its predictions open here.</p><a class="btn" href="#/calendar">Go to calendar</a></div>`;
    }
    const target = S.races.find((r) => !r.has_results) || S.races[S.races.length - 1];
    return viewRace(target.id);
  }
  viewWeekend.after = () => viewRace.after();

  async function viewRace(id) {
    RV = await api("GET", "/api/races/" + id);
    return raceHtml();
  }
  viewRace.after = () => { drawWeekendTrack(); weekendFx({ reveal: true }); };
  function paintRace(veiled = false) { view.innerHTML = raceHtml(veiled); drawWeekendTrack(); }

  // the weekend's circuit, drawn from the same outlines as the season replay
  async function drawWeekendTrack() {
    const box = $("#wk-track"); if (!box || !window.PitReplay) return;
    const all = await PitReplay.loadCircuits();
    if (!document.body.contains(box)) return;
    const id = box.dataset.circuit, c = all[id];
    const opts = Object.entries(all).sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([k, v]) => `<option value="${k}" ${k === id ? "selected" : ""}>${esc(v.name)}</option>`).join("");
    box.innerHTML = `${c ? `<svg class="wk-track-svg" role="img" aria-label="${esc(c.name)} layout"><path class="wkt-edge" d="${c.d}"/><path class="wkt-line" d="${c.d}"/><circle class="wkt-start" r="16"/></svg>` : ""}
      <label class="wk-track-name"><span class="sr-only">Circuit</span><select data-action="race-circuit" aria-label="Circuit">${c ? "" : '<option value="">Choose the circuit</option>'}${opts}</select></label>`;
    const svg = box.querySelector("svg");
    if (svg) {
      const path = svg.querySelector(".wkt-line"), bb = path.getBBox(), pad = 40;
      svg.setAttribute("viewBox", `${bb.x - pad} ${bb.y - pad} ${bb.width + pad * 2} ${bb.height + pad * 2}`);
      const st = path.getPointAtLength(0), dot = svg.querySelector(".wkt-start");
      dot.setAttribute("cx", st.x); dot.setAttribute("cy", st.y);
    }
  }

  function pickOf(pid, cat) { const p = RV.picks.find((x) => x.player_id === pid && x.category === cat); return p ? p.value : ""; }
  function manualOf(pid, cat) { const p = RV.manual.find((x) => x.player_id === pid && x.category === cat); return p ? p.points : 0; }

  function raceHtml(veiled = false) {
    const r = RV.race;
    const order = RV.pick_order.map(playerById).filter(Boolean);
    const allDrivers = r.has_results;
    const isMe = (p) => ME.passcode_required && ME.player_id === p.id;
    const head = `<tr><th></th>${order.map((p, i) => `<th class="player ${isMe(p) ? "mine" : ""}"><span class="dot" style="--c:${p.color}"></span> ${esc(p.name)}${isMe(p) ? ' <span class="you">You</span>' : ""}
        ${i === 0 && order.length > 1 ? '<span class="first">Picks first</span>' : ""}</th>`).join("")}<th>Result</th></tr>`;
    const body = RV.categories.map((c) => {
      let result = "";
      if (c.kind !== "judged" && c.slot) result = RV.results[c.slot] || "";
      const rslot = c.kind !== "judged" && c.slot ? c.slot : "";
      const rs = rslot ? ` data-rslot="${rslot}"` : "";
      const vl = rslot && veiled ? " veil" : "";
      const many = order.length > 2 && c.close_points;
      const top = many ? c.multi_exact : c.exact_points;
      const cells = order.map((p) => {
        const sc = RV.scores[p.id][c.key];
        const cls = sc && sc >= top && c.close_points ? "two" : sc ? "on" : "";
        const ptsTag = `<span class="pts ${cls}${vl}"${rs} title="${pts(sc)} pt${sc === 1 ? "" : "s"}">${pts(sc)}</span>`;
        if (c.kind === "judged") {
          return `<td data-label="${esc(p.name)}" class="${isMe(p) ? "mine" : ""}"><div class="cell-wrap">
            <input class="text-pick" type="text" value="${esc(pickOf(p.id, c.key))}" placeholder="${canPick(p.id) ? (c.key === "crazy" ? "Your bold call" : "Driver or team") : "No pick yet"}"
              data-action="text-pick" data-player="${p.id}" data-cat="${c.key}" ${canPick(p.id) ? "" : "disabled"}>
            <button class="award ${manualOf(p.id, c.key) ? "on" : ""}" data-action="award" data-player="${p.id}" data-cat="${c.key}"
              title="${manualOf(p.id, c.key) ? "Remove the point" : "Award the point"}" aria-pressed="${!!manualOf(p.id, c.key)}">+${pts(c.exact_points)}</button>
          </div></td>`;
        }
        return `<td data-label="${esc(p.name)}" class="${isMe(p) ? "mine" : ""}"><div class="cell-wrap">${driverSelect(`data-action="pick" data-player="${p.id}" data-cat="${c.key}"`, pickOf(p.id, c.key), null, !canPick(p.id), RV.lineup)}${ptsTag}</div></td>`;
      }).join("");
      const label = c.kind === "pwhat"
        ? `<div class="pwhat-cell">PWhat <span class="pitboard" id="pitboard">${r.pwhat ? "P" + r.pwhat : "P?"}</span>
            <button class="icon-btn" data-action="roll" title="Roll the PWhat position" aria-label="Roll the PWhat position">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="16" cy="16" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/></svg></button></div>`
        : esc(c.label);
      const rule = `<small class="cat-rule">${many ? `${pts(c.multi_exact)} exact · ${pts(c.multi_close)} next closest`
        : `${pts(c.exact_points)} pt${c.close_points ? " · " + pts(c.close_points) + " closest" : ""}`}${c.unique_picks && c.kind !== "judged" ? " · pick differently" : ""}</small>`;
      const resInfo = rslot && !EMPTY.has(result) ? infoOf(rslot.replace(/\d+$/, ""), result) : null;
      const resTime = resInfo && resInfo.time && /^(FL|PS|Q|SQ)\d/.test(rslot) ? `<small class="res-time">${esc(resInfo.time)}</small>` : "";
      const resCell = c.kind === "judged" ? `<td class="res" data-label="Result" title="Award the points yourselves">Judged</td>`
        : `<td class="res ${EMPTY.has(result) ? "" : "has"}${vl}" data-label="Result"${rs}>${EMPTY.has(result) ? "—" : `<span class="res-v"><span class="dot" style="--c:${colorOf(result, RV.lineup)}"></span> ${esc(result)}${resTime}</span>`}</td>`;
      return `<tr><td class="cat">${label}${rule}</td>${cells}${resCell}</tr>`;
    }).join("");

    const tally = `<div class="tally" style="--n:${order.length}">
      <div></div>${order.map((p) => `<div><span class="dot" style="--c:${p.color}"></span> ${esc(p.name)}</div>`).join("")}
      <div>This weekend</div>${order.map((p) => `<div class="num">${pts(sum(RV.scores[p.id]))}</div>`).join("")}
      <div>Before</div>${order.map((p) => `<div class="num">${pts(RV.previous[p.id])}</div>`).join("")}
      <div>Championship</div>${order.map((p) => `<div class="num big" style="color:${p.color}">${pts(RV.previous[p.id] + sum(RV.scores[p.id]))}</div>`).join("")}
    </div>`;

    const quali = RV.slots.filter((s) => !/^P\d+$/.test(s)).map((s) => {
      const session = s.replace(/\d+$/, ""), inf = infoOf(session, RV.results[s]);
      const t = inf && inf.time ? `<span class="q-time">${esc(inf.time)}${session === "PS" ? " <small>in the pit lane</small>" : ""}${session === "FL" && inf.status ? " <small>" + esc(inf.status) + "</small>" : ""}</span>` : "";
      return `<label data-rslot="${s}" class="${veiled ? "veil" : ""}"><span>${esc(RV.slot_labels[s] || s)}${t}</span>
        ${driverSelect(`data-action="result" data-slot="${s}"`, RV.results[s], null, false, RV.lineup, true)}</label>`;
    }).join("");
    const grid = RV.slots.filter((s) => /^P\d+$/.test(s)).map((s) => {
      const n = Number(s.slice(1)), drv = RV.results[s], inf = EMPTY.has(drv) ? null : infoOf("P", drv);
      let line = "";
      if (inf) {
        const g = inf.grid, d = g ? g - n : null;
        const move = g === 0 ? `<span class="mv pit" title="Started from the pit lane">Pit lane</span>`
          : g ? `<span class="mv ${d > 0 ? "up" : d < 0 ? "down" : "same"}" title="Started P${g}">${d > 0 ? "▲" + d : d < 0 ? "▼" + (-d) : "="}<small>from P${g}</small></span>` : "";
        const tag = inf.tag ? `<span class="stag ${/^(DNF|DSQ|DNS|NC|EXC|DNQ)$/.test(inf.tag) ? "out" : ""}" title="${esc(inf.status || inf.tag)}">${esc(inf.tag)}</span>` : "";
        const time = inf.time && !inf.tag ? `<span class="slot-time">${esc(inf.time)}</span>` : "";
        line = `<div class="slot-info">${move}${tag}${time}</div>`;
      }
      const note = EMPTY.has(drv) ? "" : `<input class="slot-note" type="text" maxlength="40" value="${esc((inf && inf.note) || "")}" placeholder="+ note, e.g. 5s penalty"
          data-action="note" data-session="P" data-driver="${esc(drv)}" aria-label="Note for ${esc(drv)}">`;
      return `<div class="slot ${r.pwhat === n ? "target" : ""}${veiled ? " veil" : ""}" data-rslot="${s}"><div class="slot-no">${s}${r.pwhat === n ? "<small>PWhat</small>" : ""}</div>
        ${driverSelect(`data-action="result" data-slot="${s}"`, drv, null, false, RV.lineup, true)}${line}${note}</div>`;
    }).join("");
    const fl = RV.results.FL1, ps = RV.results.PS1;
    const fastest = [["FL1", "Fastest lap", fl, "FL"], ["PS1", "Fastest pit stop", ps, "PS"]]
      .filter(([slot, , drv]) => !RV.slots.includes(slot) && !EMPTY.has(drv))
      .map(([, label, drv, sess]) => { const inf = infoOf(sess, drv);
        return `<div><small>${label}</small><b><span class="dot" style="--c:${colorOf(drv, RV.lineup)}"></span> ${esc(drv)}</b>${inf && inf.time ? ` ${esc(inf.time)}${sess === "PS" ? " in the pit lane" : ""}` : ""}</div>`; }).join("");

    return `
      <div class="wk-head">
        <div>
          <div class="wk-title"><h1><span class="flag">${flagEmoji(r.flag)}</span> ${esc(r.title)}</h1><span class="wk-round">Round ${r.round}</span></div>
          <div class="wk-meta">${r.is_sprint ? '<span class="tag sprint">Sprint weekend</span>' : ""}
            ${r.has_results ? '<span class="tag done">Results in</span>' : '<span class="tag live">Predictions open</span>'}
            ${ME.passcode_required && !canEdit()
              ? `<span>You're viewing only.</span> <button class="btn small" data-who="in">Sign in to play</button>`
              : (() => { const u = RV.categories.filter((c) => c.unique_picks && c.kind !== "judged").map((c) => esc(c.label));
                  return u.length ? `<span>Everyone picks differently for ${u.join(" and ")}.</span>` : ""; })()}</div>
          <div class="lineup-strip">
            ${RV.lineup.filter((d) => d.stand_in).map((d) => `<span class="lineup-chip" style="--c:${d.team_color}"><b>${esc(d.name)}</b> in for ${esc(d.replaces)} · ${esc(d.team)}</span>`).join("")}
            <button class="btn ghost small" data-action="lineup-open">Line-up change</button>
          </div>
        </div>
        <div class="wk-track" id="wk-track" data-circuit="${esc(r.circuit || "")}"></div>
        <div class="wk-nav">
          ${RV.prev_id ? `<a class="btn ghost small" href="#/race/${RV.prev_id}" aria-label="Previous race">‹ Previous</a>` : ""}
          ${RV.next_id ? `<a class="btn ghost small" href="#/race/${RV.next_id}" aria-label="Next race">Next ›</a>` : ""}
          <button class="icon-btn" data-action="delete-race" title="Delete this race" aria-label="Delete this race">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>
        </div>
      </div>
      <div class="wk-layout ${order.length > 2 ? "wide" : ""}">
        <section class="panel" style="overflow-x:auto">
          <h2>Predictions</h2>
          <table class="board"><thead>${head}</thead><tbody>${body}</tbody></table>
          ${tally}
        </section>
        <section class="panel">
          <div class="grid-head"><h2 style="margin:0">Results</h2>
            <button class="btn" data-action="fetch-results">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 21V4M5 4h13l-2 4 2 4H5"/></svg>Get results</button></div>
          ${fastest ? `<div class="fastest${veiled ? " veil-box" : ""}">${fastest}</div>` : ""}
          <div class="quali">${quali}</div>
          <div class="start-grid">${grid}</div><div class="grid-tail"></div>
        </section>
      </div>`;
  }
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

  // ------------------------------------------------------------------ weekend effects
  function seenSet(kind) {
    try { const v = localStorage.getItem("pitwall-seen-" + kind); return v ? new Set(JSON.parse(v)) : null; } catch (e) { return null; }
  }
  function markSeen(kind, id) {
    try { const s = seenSet(kind) || new Set(); s.add(id); localStorage.setItem("pitwall-seen-" + kind, JSON.stringify([...s])); } catch (e) { /* private mode */ }
  }
  function isSeen(kind, id) { const s = seenSet(kind); return !!(s && s.has(id)); }
  function seedSeen() {   // first visit on this device: don't replay every past weekend
    try {
      if (localStorage.getItem("pitwall-seen-reveal") === null)
        localStorage.setItem("pitwall-seen-reveal", JSON.stringify(S.races.filter((r) => r.has_results).map((r) => r.id)));
    } catch (e) { /* ignore */ }
  }
  const gridComplete = () => RV.slots.filter((x) => /^P\d+$/.test(x)).every((x) => !EMPTY.has(RV.results[x]));
  /* Lights out once everyone has made the Crazy Prediction, the last call of the weekend.
     Without a Crazy Prediction type, once every driver pick is in. */
  const picksComplete = () => {
    if (RV.race.has_results) return false;
    const crazy = RV.categories.find((c) => c.key === "crazy") || RV.categories.find((c) => c.kind === "judged" && /crazy/i.test(c.label));
    if (crazy) return RV.pick_order.every((pid) => !EMPTY.has(String(pickOf(pid, crazy.key) || "").trim()));
    return RV.categories.filter((c) => c.kind !== "judged").every((c) => RV.pick_order.every((pid) => !EMPTY.has(pickOf(pid, c.key))));
  };
  let fxBusy = false;
  async function weekendFx({ reveal = false } = {}) {
    if (fxBusy || !RV) return;
    fxBusy = true;
    try {
      const id = RV.race.id;
      if (picksComplete() && !isSeen("lights", id)) {
        markSeen("lights", id);
        await PitFX.lightsOut("Lights out. Predictions are in!");
      }
      if (reveal && gridComplete() && !isSeen("reveal", id)) {
        markSeen("reveal", id);
        await revealAndCelebrate();
      }
    } finally { fxBusy = false; }
  }
  async function revealAndCelebrate() {
    paintRace(true);
    const order = RV.slots.filter((x) => !/^P\d+$/.test(x))
      .concat(RV.slots.filter((x) => /^P\d+$/.test(x)).map((x) => Number(x.slice(1))).sort((a, b) => b - a).map((n) => "P" + n));
    await PitFX.revealResults(view, order);
    const pts = RV.pick_order.map((pid) => ({ p: playerById(pid), n: sum(RV.scores[pid]) }));
    const top = Math.max(...pts.map((x) => x.n));
    const leaders = pts.filter((x) => x.n === top);
    if (top > 0 && leaders.length === 1) await PitFX.champagne(leaders[0].p.color, `${esc(leaders[0].p.name)} wins the weekend`);
    const zeros = pts.filter((x) => x.n === 0).map((x) => esc(x.p.name));
    if (zeros.length) await PitFX.rain(`${zeros.join(" and ")}: 0 points this weekend`);
  }

  // ------------------------------------------------------------------ line-up change dialogs
  function modal(id, html) {
    let d = document.getElementById(id);
    if (!d) { d = document.createElement("dialog"); d.id = id; d.className = "lineup-dlg"; document.body.appendChild(d); }
    d.innerHTML = html;
    return d;
  }
  const roundTitle = (n) => (S.races.find((r) => r.round === n) || {}).title || "round " + n;
  function durationField(round, name) {
    return `<fieldset class="dur"><legend>For how long?</legend>
      <label><input type="radio" name="${name}" value="once" checked> This weekend only</label>
      <label><input type="radio" name="${name}" value="on"> From this weekend on</label>
      <label><input type="radio" name="${name}" value="until"> Through round
        <input type="number" class="until" min="${round}" max="${Math.max(round, S.races.length + 10)}" value="${round + 1}" aria-label="Last round"></label>
    </fieldset>`;
  }
  function readDuration(d, name, round) {
    const v = d.querySelector(`input[name="${name}"]:checked`).value;
    return v === "once" ? round : v === "on" ? null : Number(d.querySelector(".until").value) || round;
  }
  function openLineupDialog() {
    const round = RV.race.round;
    const seated = new Set(RV.lineup.map((x) => x.name));
    const d = modal("lineup-dlg", `
      <form method="dialog" class="lineup-form">
        <h2>Line-up change</h2>
        <p class="muted">For when a driver misses ${esc(RV.race.title)} or is replaced. The dropdowns for those weekends update; earlier races stay as they were.</p>
        <label>Team <select name="team">${S.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>
        <label>Out <select name="out"></select></label>
        <label>Stepping in <select name="in">
          ${S.drivers.filter((x) => !seated.has(x.name)).map((x) => `<option value="${esc(x.name)}">${esc(x.name)}${x.team ? " (" + esc(x.team) + ")" : ""}</option>`).join("")}
          <option value="__new">New driver…</option></select></label>
        <div class="newdrv" hidden><input type="text" name="newname" placeholder="Surname, e.g. Hirakawa" aria-label="New driver surname">
          <input type="text" name="newcode" maxlength="3" placeholder="Code" aria-label="Driver code"></div>
        ${durationField(round, "dur")}
        <p class="signin-msg" role="alert"></p>
        <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn" value="ok">Save change</button></div>
      </form>`);
    const f = d.querySelector("form");
    const fillOut = () => {
      const tid = Number(f.team.value);
      f.out.innerHTML = RV.lineup.filter((x) => x.team_id === tid).map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join("");
    };
    fillOut();
    f.team.onchange = fillOut;
    const toggleNew = () => { d.querySelector(".newdrv").hidden = f.in.value !== "__new"; };
    toggleNew(); f.in.onchange = toggleNew;
    f.onsubmit = async (e) => {
      if (e.submitter && e.submitter.value === "cancel") return;
      e.preventDefault();
      const isNew = f.in.value === "__new";
      const body = { team_id: Number(f.team.value), out_driver: f.out.value, from_round: round,
        in_driver: isNew ? f.newname.value.trim() : f.in.value, code: isNew ? f.newcode.value : "",
        to_round: readDuration(d, "dur", round) };
      try {
        await api("POST", "/api/lineup", body);
        d.close(); toast(`${body.in_driver} in for ${body.out_driver}.`);
        await reloadRace();
      } catch (err) { d.querySelector(".signin-msg").textContent = err.message; }
    };
    d.showModal();
  }
  async function offerSuggestions(list) {
    if (!list || !list.length) return;
    const round = RV.race.round;
    const d = modal("suggest-dlg", `
      <form method="dialog">
        <h2>Line-up change spotted</h2>
        <p class="muted">The official results show different drivers than your grid for ${esc(RV.race.title)}:</p>
        <ul class="suggest-list">${list.map((sg, i) => `<li><label><input type="checkbox" name="s" value="${i}" checked>
          <b>${esc(sg.in_driver)}</b> raced for ${esc(sg.team)} instead of ${esc(sg.out_driver)}${sg.new_driver ? " <span class='tag'>new driver</span>" : ""}</label></li>`).join("")}</ul>
        ${durationField(round, "sdur")}
        <div class="actions"><button class="btn ghost" value="cancel">Not now</button><button class="btn" value="ok">Update the line-up</button></div>
      </form>`);
    d.showModal();
    const ok = await new Promise((res) => { d.querySelector("form").onsubmit = (e) => res(e.submitter && e.submitter.value === "ok"); d.oncancel = () => res(false); });
    if (!ok) return;
    const to = readDuration(d, "sdur", round);
    for (const i of [...d.querySelectorAll('input[name="s"]:checked')].map((x) => Number(x.value))) {
      const sg = list[i];
      try { await api("POST", "/api/lineup", { team_id: sg.team_id, out_driver: sg.out_driver, in_driver: sg.in_driver, code: sg.code, from_round: round, to_round: to }); }
      catch (err) { toast(err.message, "err", 6000); }
    }
    toast("Line-up updated."); await reloadRace();
  }

  async function reloadRace() {
    const scrollY = window.scrollY;
    const focusKey = document.activeElement && document.activeElement.dataset ? JSON.stringify(document.activeElement.dataset) : null;
    [RV] = await Promise.all([api("GET", "/api/races/" + RV.race.id), loadState()]);
    paintRace();
    window.scrollTo({ top: scrollY });
    if (focusKey) {
      const d = JSON.parse(focusKey);
      const sel = Object.entries(d).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}="${v}"]`).join("");
      const el = sel && view.querySelector(sel); if (el && el.tagName !== "BUTTON") el.focus();
    }
  }

  // ================================================================== ANALYTICS
  async function viewAnalytics() {
    if (!S.races.length) return `<div class="page-head"><h1>Analytics</h1></div><div class="empty"><h2>Nothing to chart yet</h2><p>Charts fill in after the first race weekend.</p></div>`;
    const stat = (p, k, v) => `<div class="stat" style="--c:${p.color}"><div class="k">${esc(p.name)} · ${k}</div><div class="v">${v}</div></div>`;
    const stats = S.players.map((p) => {
      const rec = S.stats.record[p.id];
      return stat(p, "weekend record", `${rec[0]}–${rec[1]}–${rec[2]}`) +
        stat(p, "picking first", fmt(S.stats.first_pick[p.id]) + " pts") +
        stat(p, "picking second", fmt(S.stats.second_pick[p.id]) + " pts");
    }).join("");
    return `
      <div class="page-head"><div><h1>Analytics</h1><p class="sub">Win–loss–tie by weekend, average points depending on who picks first, and where the points come from.</p></div>
        <span class="spacer"></span><a class="btn ghost" href="/api/export.csv">Download database (CSV)</a></div>
      <div class="stack">
        <div class="statline">${stats}</div>
        <div class="charts">
          <section class="panel span-2"><h2>Championship race</h2><div class="chart-box"><canvas id="c-running"></canvas></div></section>
          <section class="panel span-2"><h2>Points per weekend</h2><div class="chart-box"><canvas id="c-per-race"></canvas></div></section>
          <section class="panel"><h2>Prediction profile</h2><p class="sub" style="margin-top:-8px">Share of available points earned in each category</p><div class="chart-box tall"><canvas id="c-radar"></canvas></div></section>
          <section class="panel"><h2>Category strength</h2><p class="sub" style="margin-top:-8px">Same numbers, easier to compare exactly</p><div class="chart-box tall"><canvas id="c-cats"></canvas></div></section>
        </div>
      </div>`;
  }
  function radarMax(values) {
    const m = Math.max(0, ...values.filter((v) => v !== null && v !== undefined));
    return Math.min(1, Math.max(0.5, Math.ceil(m * 4) / 4));
  }
  function chartDefaults() {
    if (!window.Chart) return false;
    Chart.defaults.color = "#9da0a6";
    Chart.defaults.font.family = "Titillium Web, system-ui, sans-serif";
    Chart.defaults.font.size = 13;
    Chart.defaults.borderColor = "rgba(255,255,255,.07)";
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    return true;
  }
  viewAnalytics.after = () => {
    if (!S.races.length || !chartDefaults()) return;
    const labels = S.stats.per_race.map((r) => r.title);
    charts.push(new Chart($("#c-running"), {
      type: "line",
      data: { labels, datasets: S.players.map((p) => ({ label: p.name, data: S.stats.running[p.id], borderColor: p.color, backgroundColor: p.color, borderWidth: 3, tension: .25, pointRadius: 3 })) },
      options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, scales: { y: { beginAtZero: true } } },
    }));
    charts.push(new Chart($("#c-per-race"), {
      type: "bar",
      data: { labels, datasets: S.players.map((p) => ({ label: p.name, data: S.stats.per_race.map((r) => r.points[p.id]), backgroundColor: p.color, borderRadius: 3 })) },
      options: { maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
    }));
    const cats = S.stats.categories;
    const prof = (p) => cats.map((c) => S.stats.profile[p.id][c.key] ?? 0);
    charts.push(new Chart($("#c-radar"), {
      type: "radar",
      data: { labels: cats.map((c) => c.label), datasets: S.players.map((p) => ({ label: p.name, data: prof(p), borderColor: p.color, backgroundColor: p.color + "33", pointBackgroundColor: p.color, borderWidth: 2.5 })) },
      options: { maintainAspectRatio: false, scales: { r: { min: 0, max: radarMax(S.players.flatMap(prof)), ticks: { display: false, stepSize: .25 }, grid: { color: "rgba(255,255,255,.08)" }, angleLines: { color: "rgba(255,255,255,.08)" }, pointLabels: { color: "#ecebe6", font: { size: 12, weight: 600 } } } },
        plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${Math.round(c.raw * 100)}%` } } } },
    }));
    charts.push(new Chart($("#c-cats"), {
      type: "bar",
      data: { labels: cats.map((c) => c.label), datasets: S.players.map((p) => ({ label: p.name, data: prof(p), backgroundColor: p.color, borderRadius: 3 })) },
      options: { indexAxis: "y", maintainAspectRatio: false, scales: { x: { min: 0, max: 1, ticks: { callback: (v) => Math.round(v * 100) + "%" } } },
        plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${Math.round(c.raw * 100)}%` } } } },
    }));
  };

  // ================================================================== SEASON REPLAY
  let circuitsResolved = false;
  async function viewReplay() {
    if (!circuitsResolved) {
      circuitsResolved = true;
      try { const r = await api("POST", "/api/circuits/resolve"); if (r.updated) await loadState(); } catch (e) { /* offline: use names */ }
    }
    return PitReplay.html(S);
  }
  viewReplay.after = () => PitReplay.mount(view, S, api);

  // ================================================================== PLAYER CARDS
  function playerFacts(p) {
    const st = S.stats, cats = st.categories;
    const prof = cats.map((c) => ({ label: c.label, v: st.profile[p.id][c.key] })).filter((x) => x.v !== null);
    const best = prof.length ? prof.reduce((a, b) => (b.v > a.v ? b : a)) : null;
    const worst = prof.length ? prof.reduce((a, b) => (b.v < a.v ? b : a)) : null;
    const done = st.per_race.filter((r) => r.has_results);
    const bestWk = done.length ? done.reduce((a, b) => (b.points[p.id] > a.points[p.id] ? b : a)) : null;
    const total = S.standings.find((s) => s.player_id === p.id);
    const pos = S.standings.findIndex((s) => s.player_id === p.id) + 1;
    // most-picked driver across positional categories
    return { best, worst, bestWk, total, pos, done: done.length, rec: st.record[p.id] };
  }
  function sparkline(values, color) {
    if (values.length < 2) return "";
    const max = Math.max(...values, 1), w = 300, h = 54;
    const pts = values.map((v, i) => `${(i / (values.length - 1) * w).toFixed(1)},${(h - 4 - v / max * (h - 8)).toFixed(1)}`).join(" ");
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Running points total"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
  }
  async function viewCards() {
    const cards = S.players.map((p) => {
      const f = playerFacts(p);
      return `<article class="card">
        <div class="card-top" style="--c:${p.color}"><div class="card-pos">P${f.pos} in the championship</div><div class="card-name">${esc(p.name)}</div></div>
        <div class="card-body">
          <div class="card-big">
            <div><b>${pts(f.total.total)}</b><span>Points</span></div>
            <div><b>${f.done ? (f.total.race_points / f.done).toFixed(1) : "0.0"}</b><span>Per weekend</span></div>
            <div><b>${f.rec[0]}–${f.rec[1]}–${f.rec[2]}</b><span>W–L–T</span></div>
          </div>
          <dl class="card-rows">
            <div><dt>Best category</dt><dd>${f.best ? `${esc(f.best.label)} (${pct(f.best.v)})` : "—"}</dd></div>
            <div><dt>Weakest category</dt><dd>${f.worst ? `${esc(f.worst.label)} (${pct(f.worst.v)})` : "—"}</dd></div>
            <div><dt>Best weekend</dt><dd>${f.bestWk ? `${esc(f.bestWk.title)} (${pts(f.bestWk.points[p.id])} pts)` : "—"}</dd></div>
            <div><dt>Picking first</dt><dd>${fmt(S.stats.first_pick[p.id])} pts / weekend</dd></div>
            <div><dt>Picking second</dt><dd>${fmt(S.stats.second_pick[p.id])} pts / weekend</dd></div>
            <div><dt>Season predictions</dt><dd>${pts(f.total.season_points)} pts</dd></div>
          </dl>
          ${sparkline(S.stats.running[p.id], p.color)}
          <div class="card-chart"><canvas data-card="${p.id}"></canvas></div>
        </div></article>`;
    }).join("");
    return `<div class="page-head"><div><h1>Player cards</h1><p class="sub">Season stats for each player, updated after every result.</p></div></div><div class="cards">${cards}</div>`;
  }
  viewCards.after = () => {
    if (!chartDefaults()) return;
    const cats = S.stats.categories;
    document.querySelectorAll("canvas[data-card]").forEach((cv) => {
      const p = playerById(cv.dataset.card);
      charts.push(new Chart(cv, {
        type: "radar",
        data: { labels: cats.map((c) => c.label), datasets: [{ data: cats.map((c) => S.stats.profile[p.id][c.key] ?? 0), borderColor: "#17181b", backgroundColor: p.color + "66", borderWidth: 2, pointRadius: 2 }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } },
          scales: { r: { min: 0, max: radarMax(cats.map((c) => S.stats.profile[p.id][c.key])), ticks: { display: false, stepSize: .25 }, grid: { color: "#d5d3cb" }, angleLines: { color: "#d5d3cb" }, pointLabels: { color: "#3b3d42", font: { size: 10, weight: 600 } } } } },
      }));
    });
  };

  // ================================================================== SEASON
  function answerInput(q, attrs, value, locked) {
    const dis = locked ? " disabled" : "";
    if (q.answer_type === "driver") return driverSelect(attrs, value || "", true, locked);
    let opts = null;
    if (q.answer_type === "race") {
      const names = [...S.races.map((r) => r.title)];
      (S.season_calendar || []).forEach((n) => { if (!names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n); });
      opts = names;
    }
    if (q.answer_type === "team") opts = S.teams.map((t) => t.name);
    if (q.answer_type === "player") opts = S.players.map((p) => p.name);
    if (opts) {
      const has = value && !EMPTY.has(value);
      return `<span class="dsel ${has ? "set" : "empty-val"}"><select ${attrs}${dis} aria-label="Answer"><option value="">${has ? "Clear answer" : "Choose…"}</option>
        ${has && !opts.includes(value) ? `<option selected>${esc(value)}</option>` : ""}
        ${opts.map((o) => `<option ${o === value ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></span>`;
    }
    return `<input type="text" class="text-pick" value="${esc(value || "")}" ${attrs}${dis} placeholder="Your answer" aria-label="Answer">`;
  }
  async function viewSeason() {
    const picks = new Map(S.season_picks.map((s) => [s.player_id + ":" + s.position, s.driver]));
    const final = new Map(S.season_final.map((s) => [s.position, s.driver]));
    const per = S.season_position_points;
    const ds = S.driver_standings || [];
    const now = new Map(ds.map((x) => [x.position, x]));
    const rows = Array.from({ length: Math.max(S.grid_size, ds.length) }, (_, i) => i + 1).map((pos) => {
      const cur = now.get(pos);
      return `
      <tr><td class="pos">P${pos}</td>
        <td class="now" data-label="Right now">${cur ? `<span class="dot" style="--c:${teamColor(cur.driver)}"></span><span class="now-name">${esc(cur.driver)}</span><b>${pts(cur.points)}</b>` : '<span class="muted">—</span>'}</td>
        ${S.players.map((p) => {
          const v = picks.get(p.id + ":" + pos) || "";
          const hit = !EMPTY.has(v) && v === final.get(pos);
          return `<td data-label="${esc(p.name)}"><div class="cell-wrap">${driverSelect(`data-action="season-pick" data-player="${p.id}" data-pos="${pos}"`, v, "standings", !canPick(p.id))}<span class="pts ${hit ? "on" : ""}">${hit ? pts(per) : 0}</span></div></td>`;
        }).join("")}
        <td data-label="Final">${driverSelect(`data-action="season-final" data-pos="${pos}"`, final.get(pos) || "", "standings")}</td></tr>`;
    }).join("");
    const ans = new Map(S.season_answers.map((a) => [a.question_id + ":" + a.player_id, a.value]));
    const fin = new Map(S.season_question_final.map((a) => [a.question_id, a.value]));
    const same = (a, b) => a && b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
    const qtypes = { race: "A race on the calendar", driver: "A driver", team: "A team", player: "One of the players", text: "Anything (typed answer)" };
    const questions = S.season_questions.map((q) => `
      <div class="question">
        <div class="q-head"><input type="text" class="q-label" value="${esc(q.label)}" data-action="question-label" data-id="${q.id}" aria-label="Question">
          <label class="q-pts">Worth <input type="number" step="0.25" min="0" value="${q.points}" data-action="question-points" data-id="${q.id}"> pts</label>
          <button class="icon-btn" data-action="question-delete" data-id="${q.id}" aria-label="Delete question">✕</button></div>
        <div class="q-answers">
          ${S.players.map((p) => { const v = ans.get(q.id + ":" + p.id) || ""; const hit = same(v, fin.get(q.id));
            return `<label class="q-ans"><span><span class="dot" style="--c:${p.color}"></span> ${esc(p.name)}</span>
              <span class="cell-wrap">${answerInput(q, `data-action="question-answer" data-id="${q.id}" data-player="${p.id}"`, v, !canPick(p.id))}<span class="pts ${hit ? "on" : ""}">${hit ? pts(q.points) : 0}</span></span></label>`; }).join("")}
          <label class="q-ans final"><span>Actual answer</span>${answerInput(q, `data-action="question-final" data-id="${q.id}"`, fin.get(q.id) || "", false)}</label>
        </div>
      </div>`).join("");
    return `
      <div class="page-head"><div><h1>${S.season} season picks</h1><p class="sub">Made before the season starts and scored at the end.</p></div></div>
      <div class="stack">
        <section class="panel"><h2>Season questions</h2>
          ${questions || '<p class="muted">No questions yet.</p>'}
          <form class="field add-q" id="add-question" autocomplete="off">
            <input type="text" name="label" placeholder="New question, e.g. Who wins the constructors' title?" aria-label="New question" style="flex:1 1 280px">
            <select name="answer_type" aria-label="Kind of answer">${Object.entries(qtypes).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
            <label class="q-pts">Worth <input type="number" name="points" step="0.25" min="0" value="0.5"> pts</label>
            <button class="btn small" type="submit">Add question</button></form>
        </section>
        <section class="panel" style="overflow-x:auto"><div class="grid-head"><h2 style="margin:0">Final drivers' standings</h2>
          <label class="q-pts">Each exact position is worth <input type="number" step="0.25" min="0" value="${per}" data-action="season-per" aria-label="Points per correct position"> pts</label></div>
          <div class="champ-bar">
            <button class="btn small" data-action="update-standings">Update championship points</button>
            <span class="muted">${S.standings_note ? esc(S.standings_note) + "." : "Shows each driver's points so far. Get results updates them too."}</span>
            ${ds.length ? `<span class="spacer"></span><button class="btn ghost small" data-action="final-from-standings" title="For the end of the season">Use as final standings</button>` : ""}
          </div>
          <table class="season-table">
          <thead><tr><th></th><th>Right now</th>${S.players.map((p) => `<th><span class="dot" style="--c:${p.color}"></span> ${esc(p.name)}</th>`).join("")}<th>Final standing</th></tr></thead>
          <tbody>${rows}</tbody></table></section>
      </div>`;
  }

  // ================================================================== PREDICTION TYPES
  function sourceOptions(sel) {
    return Object.entries(S.sources).map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(v.label)}</option>`).join("");
  }
  async function viewRules() {
    const rowsHtml = S.categories.map((c, i) => {
      const what = c.kind === "judged" ? "Judged by the players"
        : c.kind === "pwhat" ? "Race finish at a position rolled each weekend"
        : `${S.sources[c.source].label}${c.position ? ", position " + c.position : ""}`;
      return `<li class="rule ${c.kind}">
        <div class="rule-move">
          <button class="icon-btn" data-action="cat-move" data-id="${c.id}" data-dir="-1" ${i ? "" : "disabled"} aria-label="Move up">▲</button>
          <button class="icon-btn" data-action="cat-move" data-id="${c.id}" data-dir="1" ${i < S.categories.length - 1 ? "" : "disabled"} aria-label="Move down">▼</button></div>
        <div class="rule-main">
          <input type="text" class="rule-label" value="${esc(c.label)}" data-action="cat-edit" data-field="label" data-id="${c.id}" aria-label="Name">
          <div class="rule-what">${esc(what)}${c.kind === "result" ? ` <select data-action="cat-edit" data-field="position" data-id="${c.id}" aria-label="Position">${Array.from({ length: S.grid_size }, (_, n) => `<option ${n + 1 === c.position ? "selected" : ""}>${n + 1}</option>`).join("")}</select>` : ""}</div>
          ${c.kind !== "judged" && c.close_points ? `<div class="rule-multi ${S.players.length > 2 ? "live" : ""}">With 3+ players: exact
            <input type="number" step="0.25" min="0" value="${c.multi_exact ?? 2}" data-action="cat-edit" data-field="multi_exact" data-id="${c.id}" aria-label="Exact pick with 3 or more players">
            next closest <input type="number" step="0.25" min="0" value="${c.multi_close ?? 1}" data-action="cat-edit" data-field="multi_close" data-id="${c.id}" aria-label="Next closest pick with 3 or more players"></div>` : ""}
        </div>
        <label>Exact <input type="number" step="0.25" min="0" value="${c.exact_points}" data-action="cat-edit" data-field="exact_points" data-id="${c.id}"></label>
        ${c.kind === "judged" ? "<span></span>" : `<label>Closest <input type="number" step="0.25" min="0" value="${c.close_points}" data-action="cat-edit" data-field="close_points" data-id="${c.id}"></label>`}
        ${c.kind === "judged" ? "<span></span>" : `<label class="chk"><input type="checkbox" ${c.unique_picks ? "checked" : ""} data-action="cat-edit" data-field="unique_picks" data-id="${c.id}"> Pick differently</label>`}
        <select data-action="cat-edit" data-field="applies" data-id="${c.id}" aria-label="Which weekends"><option value="all" ${c.applies === "all" ? "selected" : ""}>Every weekend</option><option value="sprint" ${c.applies === "sprint" ? "selected" : ""}>Sprint weekends</option></select>
        <button class="icon-btn" data-action="cat-delete" data-id="${c.id}" aria-label="Delete ${esc(c.label)}">✕</button>
      </li>`;
    }).join("");
    return `
      <div class="page-head"><div><h1>Prediction types</h1>
        <p class="sub">Every weekend uses these, and scoring, standings and analytics follow automatically. Exact picks earn the first number. If nobody is exact, the single closest pick earns the second, and a tie for closest earns nothing.</p>
        <p class="sub">With 3 or more players, types with a closest pick score differently: an exact pick earns the "exact" number (2), and the next closest pick earns the "next closest" number (1). If nobody is exact, the closest pick earns it. Ties for closest all score.</p></div></div>
      <div class="stack">
        <section class="panel"><ol class="rules">${rowsHtml}</ol></section>
        <section class="panel"><h2>Add a prediction type</h2>
          <form id="add-cat" class="add-cat" autocomplete="off">
            <fieldset class="kind-pick"><legend>Scored how?</legend>
              <label><input type="radio" name="kind" value="result" checked> From the official results</label>
              <label><input type="radio" name="kind" value="judged"> Judged by the players (like Good Surprise)</label>
              ${S.categories.some((c) => c.kind === "pwhat") ? "" : `<label><input type="radio" name="kind" value="pwhat"> PWhat: random position each weekend</label>`}
            </fieldset>
            <div class="cat-fields">
              <label class="for-result">Result <select name="source">${sourceOptions("race")}</select></label>
              <label class="for-result">Position <select name="position">${Array.from({ length: S.grid_size }, (_, n) => `<option>${n + 1}</option>`).join("")}</select></label>
              <label>Name <input type="text" name="label" placeholder="Leave empty to name it for you"></label>
              <label>Exact <input type="number" name="exact_points" step="0.25" min="0" value="1"></label>
              <label class="not-judged">Closest <input type="number" name="close_points" step="0.25" min="0" value="0.5"></label>
              <label class="chk not-judged"><input type="checkbox" name="unique_picks"> Everyone picks differently</label>
              <label>Weekends <select name="applies"><option value="">Automatic</option><option value="all">Every weekend</option><option value="sprint">Sprint weekends</option></select></label>
            </div>
            <p class="muted small-note">Results-based types are filled in by Get results. Sprint qualifying isn't in the public data, so enter that one yourselves. Pit stop times cover the whole trip through the pit lane.</p>
            <button class="btn" type="submit">Add prediction type</button>
          </form>
        </section>
      </div>`;
  }
  viewRules.after = () => {
    const f = $("#add-cat"); if (!f) return;
    const sync = () => {
      const k = f.querySelector('input[name="kind"]:checked').value;
      f.querySelectorAll(".for-result").forEach((e) => { e.hidden = k !== "result"; });
      f.querySelectorAll(".not-judged").forEach((e) => { e.hidden = k === "judged"; });
    };
    f.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener("change", sync));
    sync();
  };

  // ================================================================== GRID & PLAYERS
  async function viewGrid() {
    const teams = S.teams.map((t) => {
      const ds = S.drivers.filter((d) => d.team_id === t.id);
      return `<div class="team">
        <div class="team-name"><span class="swatch" style="--c:${t.color}"></span>
          <input type="color" value="${esc(t.color)}" data-action="team-color" data-id="${t.id}" aria-label="${esc(t.name)} color">
          <input type="text" value="${esc(t.name)}" data-action="team-name" data-id="${t.id}" aria-label="Team name">
          ${ds.length ? "" : `<button class="icon-btn" data-action="delete-team" data-id="${t.id}" title="Remove this empty team" aria-label="Remove ${esc(t.name)}">✕</button>`}</div>
        <div class="drivers">${ds.map(driverRow).join("") || '<span class="muted">No drivers in this team</span>'}</div></div>`;
    }).join("");
    const loose = S.drivers.filter((d) => !d.team_id);
    return `
      <div class="page-head"><div><h1>Grid &amp; players</h1><p class="sub">Changes here update every dropdown. When a driver misses a weekend or is replaced, open that weekend and use Line-up change, or let Get results spot it for you.</p></div></div>
      <div class="stack">
        <div class="grid-2">
          <section class="panel"><h2>Players</h2>
            <p class="sub" style="margin-top:-8px">Players take turns picking first, in this order.</p>
            <div class="players">${S.players.map((p) => `<div class="player-row">
              <input type="color" value="${esc(p.color)}" data-action="player-color" data-id="${p.id}" aria-label="${esc(p.name)} color">
              <input type="text" value="${esc(p.name)}" data-action="player-name" data-id="${p.id}" aria-label="Player name" style="flex:1">
              ${S.players.length > 1 ? `<button class="icon-btn" data-action="delete-player" data-id="${p.id}" title="Remove player" aria-label="Remove ${esc(p.name)}">✕</button>` : ""}
            </div>`).join("")}</div>
            <button class="btn ghost small" style="margin-top:14px" data-action="add-player">Add player</button>
          </section>
          <section class="panel"><h2>Season &amp; data</h2>
            <div class="field"><label for="season-year" class="muted">Season</label>
              <input type="number" id="season-year" value="${esc(S.season)}" min="1950" max="2100" style="width:110px" data-action="season-year"></div>
            <p class="sub">The season decides which official calendar and results Get Results uses.</p>
            <div class="field" style="margin-top:16px">
              <a class="btn ghost small" href="/api/export.csv">Download database (CSV)</a>
              <a class="btn ghost small" href="/api/backup">Download backup</a></div>
          </section>
        </div>
        <section class="panel">
          <div class="grid-head"><h2 style="margin:0">Line-up changes</h2></div>
          ${S.lineup_changes.length ? `<ul class="changes">${S.lineup_changes.map((ch) => `<li style="--c:${ch.team_color}">
            <span class="ch-when">${ch.to_round === ch.from_round ? esc(roundTitle(ch.from_round)) : ch.to_round ? `Rounds ${ch.from_round}–${ch.to_round}` : `From ${esc(roundTitle(ch.from_round))}`}</span>
            <span class="ch-what"><b>${esc(ch.in_driver)}</b> in for ${esc(ch.out_driver)} · ${esc(ch.team)}</span>
            <label class="ch-until">Through round <input type="number" min="${ch.from_round}" value="${ch.to_round ?? ""}" placeholder="—" data-action="lineup-until" data-id="${ch.id}" title="Leave empty for a permanent change"></label>
            <button class="icon-btn" data-action="lineup-delete" data-id="${ch.id}" aria-label="Remove this change">✕</button></li>`).join("")}</ul>`
            : `<p class="muted">No changes yet. Everyone races in their usual seat.</p>`}
        </section>
        <section class="panel">
          <div class="grid-head"><h2 style="margin:0">Teams and drivers</h2><button class="btn ghost small" data-action="add-team">Add team</button></div>
          ${teams}
          ${loose.length ? `<div class="team"><div class="team-name"><span class="swatch" style="--c:#5d6068"></span><b>Reserves &amp; stand-ins</b></div><div class="drivers">${loose.map(driverRow).join("")}</div></div>` : ""}
          <form class="field" id="add-driver" style="margin-top:18px" autocomplete="off">
            <input type="text" name="name" placeholder="Driver surname" aria-label="New driver name">
            <input type="text" name="code" placeholder="Code" maxlength="3" style="width:80px;text-transform:uppercase" aria-label="Driver code">
            <select name="team_id" aria-label="Team">${S.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}<option value="">Reserve (no seat)</option></select>
            <button class="btn small" type="submit">Add driver</button></form>
        </section>
      </div>`;
  }
  function driverRow(d) {
    return `<div class="drv ${d.sidelined ? "out" : ""}">
      <input type="text" value="${esc(d.name)}" data-action="driver-name" data-id="${d.id}" aria-label="Driver name">
      <input type="text" class="code" value="${esc(d.code || "")}" maxlength="3" placeholder="—" data-action="driver-code" data-id="${d.id}" aria-label="${esc(d.name)} code" title="Three-letter code used by Get Results">
      <select data-action="driver-team" data-id="${d.id}" aria-label="${esc(d.name)} team">${S.teams.map((t) => `<option value="${t.id}" ${t.id === d.team_id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}<option value="" ${d.team_id ? "" : "selected"}>Reserve (no seat)</option></select>
      <button class="icon-btn" data-action="delete-driver" data-id="${d.id}" title="Delete driver" aria-label="Delete ${esc(d.name)}">✕</button>
    </div>`;
  }

  // ================================================================== EVENTS
  async function guarded(fn) {
    try { await fn(); } catch (e) {
      if (e.status === 401) { await loadMe().catch(() => {}); openSignIn(e.message); }
      else toast(e.message, "err", 6000);
      if (RV && location.hash.match(/race|weekend/)) reloadRace().catch(() => {}); else if (e.status) refresh().catch(() => {});
    }
  }

  view.addEventListener("change", (e) => guarded(async () => {
    const el = e.target, a = el.dataset.action, id = el.dataset.id;
    if (!a) return;
    if (!canEdit()) { await refresh(); openSignIn("Sign in to make changes."); return; }
    const v = el.value;
    if (a === "pick") {
      await api("PUT", `/api/races/${RV.race.id}/pick`, { player_id: el.dataset.player, category: el.dataset.cat, value: v });
      flashSaved(); await reloadRace(); weekendFx();
    } else if (a === "text-pick") {
      await api("PUT", `/api/races/${RV.race.id}/pick`, { player_id: el.dataset.player, category: el.dataset.cat, value: v });
      flashSaved();
      const pid = Number(el.dataset.player), mine = RV.picks.find((x) => x.player_id === pid && x.category === el.dataset.cat);
      if (mine) mine.value = v; else RV.picks.push({ player_id: pid, category: el.dataset.cat, value: v });
      weekendFx();
    } else if (a === "note") {
      await api("PUT", `/api/races/${RV.race.id}/note`, { session: el.dataset.session, driver: el.dataset.driver, note: v });
      const box = (RV.info[el.dataset.session] = RV.info[el.dataset.session] || {});
      box[el.dataset.driver] = Object.assign(box[el.dataset.driver] || {}, { note: v.trim() });
      flashSaved();
    } else if (a === "race-circuit") {
      await api("PATCH", `/api/races/${RV.race.id}`, { circuit: v }); flashSaved(); await reloadRace();
    } else if (a === "result") {
      await api("PUT", `/api/races/${RV.race.id}/result`, { slot: el.dataset.slot, value: v });
      flashSaved(); markSeen("reveal", RV.race.id); await reloadRace();
    } else if (a === "season-pick") {
      await api("PUT", "/api/season/pick", { player_id: el.dataset.player, position: el.dataset.pos, value: v }); flashSaved(); await refresh();
    } else if (a === "season-final") {
      await api("PUT", "/api/season/final", { position: el.dataset.pos, value: v }); flashSaved(); await refresh();
    } else if (a === "player-name" || a === "player-color") {
      await api("PUT", "/api/players/" + id, a === "player-name" ? { name: v } : { color: v }); flashSaved(); await refresh();
    } else if (a === "team-name" || a === "team-color") {
      await api("PUT", "/api/teams/" + id, a === "team-name" ? { name: v } : { color: v }); flashSaved(); await refresh();
    } else if (a === "driver-name") {
      await api("PUT", "/api/drivers/" + id, { name: v }); flashSaved(); toast("Renamed. Past picks and results now use the new name."); await refresh();
    } else if (a === "cat-edit") {
      const field = el.dataset.field;
      const val = el.type === "checkbox" ? el.checked : v;
      await api("PUT", "/api/categories/" + id, { [field]: val }); flashSaved(); await refresh();
    } else if (a === "season-per") {
      await api("PUT", "/api/settings", { season_position_points: v }); flashSaved(); await refresh();
    } else if (a === "question-label") {
      await api("PUT", "/api/season/questions/" + id, { label: v }); flashSaved(); await refresh();
    } else if (a === "question-points") {
      await api("PUT", "/api/season/questions/" + id, { points: v }); flashSaved(); await refresh();
    } else if (a === "question-answer") {
      await api("PUT", "/api/season/answer", { question_id: id, player_id: el.dataset.player, value: v }); flashSaved(); await refresh();
    } else if (a === "question-final") {
      await api("PUT", "/api/season/question-answer", { question_id: id, value: v }); flashSaved(); await refresh();
    } else if (a === "lineup-until") {
      await api("PATCH", "/api/lineup/" + id, { to_round: v }); flashSaved(); await refresh();
    } else if (a === "driver-code") {
      await api("PUT", "/api/drivers/" + id, { code: v }); flashSaved(); await refresh();
    } else if (a === "driver-team") {
      await api("PUT", "/api/drivers/" + id, { team_id: v ? Number(v) : null }); flashSaved(); await refresh();
    } else if (a === "season-year") {
      await api("PUT", "/api/settings", { season: v }); schedule = null; flashSaved(); await refresh();
    }
  }));

  view.addEventListener("click", (e) => guarded(async () => {
    const el = e.target.closest("[data-action]");
    if (!el || el.tagName === "SELECT" || el.tagName === "INPUT") return;
    const a = el.dataset.action, id = el.dataset.id;
    if (!canEdit() && a !== "load-schedule") { openSignIn("Sign in to make changes."); return; }
    if (a === "award") {
      const on = !el.classList.contains("on");
      el.classList.toggle("on", on);
      await api("PUT", `/api/races/${RV.race.id}/manual`, { player_id: el.dataset.player, category: el.dataset.cat, points: on ? 1 : 0 });
      flashSaved(); await reloadRace();
    } else if (a === "roll") {
      el.disabled = true;
      const r = await api("POST", `/api/races/${RV.race.id}/roll`);
      await PitFX.rollReel($("#pitboard"), r.pwhat, r.min, r.max);
      toast(`PWhat this weekend: P${r.pwhat}`, "warn");
      await reloadRace(); weekendFx();
    } else if (a === "fetch-results") {
      const filled = Object.entries(RV.results).some(([k, v]) => /^P\d+$/.test(k) && !EMPTY.has(v));
      if (filled && !(await confirmBox("Replace results?", "This weekend already has results. Replace them with the official ones?", "Replace"))) return;
      el.disabled = true; const label = el.innerHTML; el.innerHTML = "Fetching…";
      try {
        const r = await api("POST", `/api/races/${RV.race.id}/fetch-results`);
        await reloadRace();
        markSeen("reveal", RV.race.id);
        await revealAndCelebrate();
        toast(r.message, "ok", 6000);
        await offerSuggestions(r.suggestions);
        if (r.unmatched && r.unmatched.length) toast("Not on your grid yet: " + r.unmatched.join(", ") + ". Add them under Grid & players, then fetch again.", "warn", 9000);
      } finally { el.disabled = false; el.innerHTML = label; }
    } else if (a === "full-calendar") {
      if (!(await confirmBox(`Add the whole ${S.season} calendar?`, "Every official round you haven't added yet goes on the calendar, in order, with no predictions yet.", "Add all rounds"))) return;
      el.disabled = true;
      try { const r = await api("POST", "/api/races/full-calendar"); toast(r.added ? `Added ${r.added} race weekends.` : "Every round is already on the calendar."); await refresh(); }
      finally { el.disabled = false; }
    } else if (a === "update-standings") {
      el.disabled = true; const label = el.textContent; el.textContent = "Updating…";
      try { const r = await api("POST", "/api/standings/update"); toast(r.message); await refresh(); }
      finally { el.disabled = false; el.textContent = label; }
    } else if (a === "final-from-standings") {
      if (!(await confirmBox("Use the current standings as final?", "The Final standing column is filled from the drivers' championship as it is now, and season picks are scored against it. Do this once the last race is done.", "Fill final standings"))) return;
      await api("POST", "/api/season/final-from-standings"); toast("Final standings filled in."); await refresh();
    } else if (a === "cat-move") {
      await api("POST", `/api/categories/${id}/move`, { dir: Number(el.dataset.dir) }); await refresh();
    } else if (a === "cat-delete") {
      const c = S.categories.find((x) => x.id === Number(id));
      if (!(await confirmBox(`Delete ${c.label}?`, "It disappears from every weekend, and any points it scored are removed from the standings.", "Delete type"))) return;
      await api("DELETE", "/api/categories/" + id); toast(`Deleted ${c.label}.`); await refresh();
    } else if (a === "question-delete") {
      if (!(await confirmBox("Delete this question?", "Everyone's answers to it are removed too.", "Delete question"))) return;
      await api("DELETE", "/api/season/questions/" + id); await refresh();
    } else if (a === "lineup-open") {
      openLineupDialog();
    } else if (a === "lineup-delete") {
      const ch = S.lineup_changes.find((x) => x.id === Number(id));
      if (!(await confirmBox("Remove this line-up change?", `${ch.in_driver} goes back to their usual seat and ${ch.out_driver} returns to the ${ch.team} line-up for those weekends.`, "Remove"))) return;
      await api("DELETE", "/api/lineup/" + id); flashSaved(); await refresh();
    } else if (a === "delete-race") {
      if (!(await confirmBox(`Delete ${RV.race.title}?`, "Its predictions and results are removed for good.", "Delete race"))) return;
      await api("DELETE", "/api/races/" + RV.race.id); toast(`Deleted ${RV.race.title}.`); await loadState(); go("#/calendar");
    } else if (a === "load-schedule") {
      el.disabled = true; el.textContent = "Loading…";
      try { schedule = await api("GET", "/api/schedule"); renderSchedule(); el.textContent = "Refresh official calendar";
        const dl = $("#sched-list"); if (dl) dl.innerHTML = schedule.filter((s) => !s.added).map((s) => `<option value="${esc(s.suggested)}">`).join("");
      } finally { el.disabled = false; }
    } else if (a === "add-official") {
      const s = schedule.find((x) => x.round === Number(el.dataset.round));
      const r = await api("POST", "/api/races", { title: s.suggested, flag: s.flag, is_sprint: s.is_sprint, api_round: s.round });
      s.added = true; toast(`${s.suggested} added. Predictions are open.`); await loadState(); go("#/race/" + r.id);
    } else if (a === "sideline") {
      const on = !el.classList.contains("on");
      await api("PUT", "/api/drivers/" + id, { sidelined: on }); flashSaved(); await refresh();
    } else if (a === "delete-driver") {
      const d = S.drivers.find((x) => x.id === Number(id));
      if (!(await confirmBox(`Delete ${d.name}?`, "Past picks keep the name, but the driver leaves every dropdown. To keep them for past races, mark them as sidelined instead.", "Delete driver"))) return;
      await api("DELETE", "/api/drivers/" + id); await refresh();
    } else if (a === "add-player") {
      await api("POST", "/api/players", { name: "New player" }); await refresh();
    } else if (a === "delete-player") {
      const p = playerById(id);
      if (!(await confirmBox(`Remove ${p.name}?`, "All of their predictions are deleted.", "Remove player"))) return;
      await api("DELETE", "/api/players/" + id); await refresh();
    } else if (a === "delete-team") {
      await api("DELETE", "/api/teams/" + id); flashSaved(); await refresh();
    } else if (a === "add-team") {
      await api("POST", "/api/teams", { name: "New team" }); await refresh();
    }
  }));

  view.addEventListener("submit", (e) => guarded(async () => {
    e.preventDefault();
    const f = e.target;
    if (f.id === "add-race") {
      const title = f.title.value.trim();
      const official = (schedule || []).find((s) => s.suggested.toLowerCase() === title.toLowerCase());
      const r = await api("POST", "/api/races", official ? { title, flag: official.flag, is_sprint: official.is_sprint, api_round: official.round } : { title });
      toast(`${r.title} added. Predictions are open.`);
      await loadState(); go("#/race/" + r.id);
    } else if (f.id === "add-cat") {
      const kind = f.querySelector('input[name="kind"]:checked').value;
      const body = { kind, label: f.label.value, exact_points: f.exact_points.value, close_points: kind === "judged" ? 0 : f.close_points.value,
        unique_picks: f.unique_picks.checked, applies: f.applies.value || undefined };
      if (kind === "result") { body.source = f.source.value; body.position = Number(f.position.value); }
      await api("POST", "/api/categories", body);
      toast("Added. It's now on every weekend it applies to."); await refresh();
    } else if (f.id === "add-question") {
      await api("POST", "/api/season/questions", { label: f.label.value, answer_type: f.answer_type.value, points: f.points.value });
      toast("Question added."); await refresh();
    } else if (f.id === "add-driver") {
      await api("POST", "/api/drivers", { name: f.name.value, code: f.code.value, team_id: f.team_id.value ? Number(f.team_id.value) : null });
      toast(`${f.name.value} added to the grid.`); await refresh();
    }
  }));

  // ------------------------------------------------------------------ boot
  (async () => {
    try { await loadState(); seedSeen(); await loadMe(); await route(true); }
    catch (e) { view.innerHTML = `<div class="empty"><h2>Pit Wall can't reach its server</h2><p>Start it with <code>python run.py</code>, then reload this page.</p></div>`; }
  })();
})();
