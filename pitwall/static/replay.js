/* Pit Wall — Season Replay: one lap per round on that weekend's circuit */
(() => {
  "use strict";
  const SVGNS = "http://www.w3.org/2000/svg";
  const LAP_MS = 2600;
  let circuitsCache = null;
  let running = null;   // { stop() } for the replay currently on screen

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const flagEmoji = (cc) => (cc && cc.length === 2) ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "";
  const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const clamp01 = (t) => Math.max(0, Math.min(1, t));
  const GENERIC = "M150 300 C150 180 250 150 350 150 L650 150 C800 150 850 230 850 330 L850 650 C850 780 760 850 640 850 L360 850 C230 850 150 780 150 660 Z";

  async function loadCircuits() {
    if (circuitsCache) return circuitsCache;
    try { circuitsCache = await fetch(window.PIT_STATIC + "vendor/circuits.json").then((r) => r.json()); }
    catch (e) { circuitsCache = {}; }
    return circuitsCache;
  }

  // ------------------------------------------------------------------ avatars
  const STYLES = {
    classic: { label: "Modern" },
    wedge: { label: "Wedge" },
    retro: { label: "Retro" },
  };
  function shade(hex, f) {
    const m = String(hex).replace("#", ""); if (m.length !== 6) return hex;
    return "#" + [0, 2, 4].map((i) => Math.max(0, Math.min(255, Math.round(parseInt(m.substr(i, 2), 16) * f))).toString(16).padStart(2, "0")).join("");
  }
  /* Top-down car pointing right, centred on 0,0, about 44 long. Original shapes, no real liveries. */
  function carMarkup(style, color, number) {
    const dark = shade(color, 0.55), tyre = "#141518";
    const num = number !== null && number !== undefined && number !== "" ? `<text x="4" y="2.6" font-size="7.5" text-anchor="middle" class="car-num">${esc(number)}</text>` : "";
    if (style === "wedge") return `
      <rect x="-20" y="-12" width="9" height="6" rx="1.5" fill="${tyre}"/><rect x="-20" y="6" width="9" height="6" rx="1.5" fill="${tyre}"/>
      <rect x="9" y="-11" width="8" height="5" rx="1.5" fill="${tyre}"/><rect x="9" y="6" width="8" height="5" rx="1.5" fill="${tyre}"/>
      <path d="M-24 -9 L-18 -9 L-18 9 L-24 9 Z" fill="${dark}"/>
      <path d="M-18 -6 L4 -7 L24 -1.5 L24 1.5 L4 7 L-18 6 Z" fill="${color}"/>
      <path d="M20 -10 L23 -10 L23 10 L20 10 Z" fill="${dark}"/>
      <path d="M-6 -3 L4 -3 L6 0 L4 3 L-6 3 Z" fill="${tyre}" opacity=".85"/>${num}`;
    if (style === "retro") return `
      <circle cx="-13" cy="-10" r="5.5" fill="${tyre}"/><circle cx="-13" cy="10" r="5.5" fill="${tyre}"/>
      <circle cx="13" cy="-9" r="4.5" fill="${tyre}"/><circle cx="13" cy="9" r="4.5" fill="${tyre}"/>
      <ellipse cx="0" cy="0" rx="23" ry="6.5" fill="${color}"/>
      <ellipse cx="-4" cy="0" rx="5" ry="3.4" fill="${tyre}" opacity=".85"/>
      <path d="M17 -2 L23 0 L17 2 Z" fill="${dark}"/>${num}`;
    return `
      <rect x="-19" y="-12" width="9" height="6" rx="1.5" fill="${tyre}"/><rect x="-19" y="6" width="9" height="6" rx="1.5" fill="${tyre}"/>
      <rect x="9" y="-11.5" width="8" height="5.5" rx="1.5" fill="${tyre}"/><rect x="9" y="6" width="8" height="5.5" rx="1.5" fill="${tyre}"/>
      <rect x="-24" y="-10" width="5" height="20" rx="1" fill="${dark}"/>
      <path d="M-19 -5 C-8 -7 6 -4 21 -1.6 L21 1.6 C6 4 -8 7 -19 5 Z" fill="${color}"/>
      <rect x="20" y="-11" width="4" height="22" rx="1" fill="${dark}"/>
      <path d="M-5 -2.8 C-2 -4 2 -4 4 0 C2 4 -2 4 -5 2.8 Z" fill="${tyre}" opacity=".85"/>${num}`;
  }
  const tagOf = (p) => (p.tag || p.name.slice(0, 3)).toUpperCase();
  const numberOf = (p, i) => (p.car_number ?? (i + 1));

  // ------------------------------------------------------------------ data
  function buildLaps(S) {
    const done = S.stats.per_race.filter((r) => r.has_results);
    const raceById = new Map(S.races.map((r) => [r.id, r]));
    const cum = Object.fromEntries(S.players.map((p) => [p.id, 0]));
    return done.map((r) => {
      const before = { ...cum };
      S.players.forEach((p) => { cum[p.id] += r.points[p.id] || 0; });
      const race = raceById.get(r.id) || {};
      return { title: r.title, round: r.round, flag: race.flag, before, after: { ...cum }, points: r.points };
    });
  }

  // ------------------------------------------------------------------ view
  function html(S) {
    const laps = buildLaps(S);
    const garage = S.players.map((p, i) => `
      <div class="garage-car" data-player="${p.id}" style="--c:${p.color}">
        <svg class="garage-preview" viewBox="-30 -18 60 36" aria-hidden="true"><g>${carMarkup(p.car_style || "classic", p.color, numberOf(p, i))}</g></svg>
        <div class="garage-name">${esc(p.name)}</div>
        <div class="garage-styles" role="radiogroup" aria-label="${esc(p.name)} car style">
          ${Object.entries(STYLES).map(([k, v]) => `<button class="chip ${((p.car_style || "classic") === k) ? "on" : ""}" role="radio"
            aria-checked="${(p.car_style || "classic") === k}" data-garage="style" data-player="${p.id}" data-value="${k}">${v.label}</button>`).join("")}
        </div>
        <div class="garage-fields">
          <label>Number <input type="number" min="0" max="99" value="${esc(numberOf(p, i))}" data-garage="number" data-player="${p.id}"></label>
          <label>Tag <input type="text" maxlength="3" value="${esc(tagOf(p))}" data-garage="tag" data-player="${p.id}"></label>
        </div>
      </div>`).join("");
    return `
      <div class="page-head"><div><h1>Season replay</h1>
        <p class="sub">${laps.length ? `The whole season as one race: every lap is a race weekend. The gap between the cars is the points gap after each weekend.` : ""}</p></div></div>
      <div class="stack">
        ${laps.length ? `
        <section class="panel replay">
          <div class="replay-hud">
            <div class="replay-round"><span class="replay-flag"></span><span class="replay-title"></span></div>
            <div class="replay-lap"></div>
          </div>
          <div class="replay-body">
            <svg class="replay-track" viewBox="-60 -60 1120 1120" role="img" aria-label="Season replay race">
              <g class="trk"><path class="trk-edge"/><path class="trk-asphalt"/><path class="trk-paint"/><g class="trk-start"></g></g>
              <g class="smoke"></g><g class="cars"></g>
            </svg>
            <ol class="tower" aria-live="polite"></ol>
          </div>
          <div class="replay-finish" hidden><span class="chequer" aria-hidden="true"></span><span class="replay-finish-text"></span></div>
        </section>` : `<div class="empty"><h2>The race starts after the first results</h2><p>Once a weekend has results, it becomes a lap of the replay.</p></div>`}
        <section class="panel"><div class="grid-head"><h2 style="margin:0">Garage</h2>
            <label class="track-pick">Track <select data-garage="track" aria-label="Replay track"></select></label></div>
          <p class="sub" style="margin-top:-6px">Choose your car. It uses your player color from Grid &amp; players.</p>
          <div class="garage">${garage}</div></section>
      </div>`;
  }

  async function mount(root, S, api) {
    if (running) running.stop();
    bindGarage(root, S, api);
    const circuits = await loadCircuits();
    bindTrackPicker(root, S, api, circuits);
    startRace(root, S, circuits);
  }

  function bindTrackPicker(root, S, api, circuits) {
    const sel = root.querySelector('select[data-garage="track"]');
    if (!sel) return;
    sel.innerHTML = Object.entries(circuits).sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([id, c]) => `<option value="${id}" ${id === S.replay_circuit ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    sel.addEventListener("change", async (e) => {
      e.stopPropagation();
      try {
        await api("PUT", "/api/settings", { replay_circuit: sel.value });
        S.replay_circuit = sel.value;
        startRace(root, S, circuits);
      } catch (err) { if (window.PitToast) window.PitToast(err.message, "err"); }
    });
  }

  /* One circuit for the whole replay; each lap is a race weekend. */
  function startRace(root, S, circuits) {
    if (running) running.stop();
    const svg = root.querySelector(".replay-track");
    if (!svg) return;
    const laps = buildLaps(S);
    const players = S.players.map((p, i) => ({ ...p, idx: i }));
    const q = (s) => root.querySelector(s);
    const pathEls = [q(".trk-edge"), q(".trk-asphalt"), q(".trk-paint")];
    const carsG = q(".cars"), smokeG = q(".smoke");
    carsG.innerHTML = ""; smokeG.innerHTML = ""; q(".replay-finish").hidden = true;
    const gapW = players.length > 1 ? Math.min(30, 64 / (players.length - 1)) : 0;   // all cars fit across the track
    const lanes = players.map((_, i) => (i - (players.length - 1) / 2) * gapW);

    // biggest gap of the season sets how far apart the cars can get (max ~22% of a lap)
    let maxGap = 1;
    laps.forEach((l) => { const v = Object.values(l.after); maxGap = Math.max(maxGap, Math.max(...v) - Math.min(...v)); });
    const perPoint = Math.min(0.018, 0.22 / maxGap);

    const carEls = players.map((p) => {
      const g = document.createElementNS(SVGNS, "g");
      g.setAttribute("class", "car");
      g.innerHTML = `<g class="car-body">${carMarkup(p.car_style || "classic", p.color, numberOf(p, p.idx))}</g>
        <g class="car-tag"><rect x="-17" y="-11" width="34" height="18" rx="4"/><text y="2.5" text-anchor="middle">${esc(tagOf(p))}</text></g>`;
      g.querySelector(".car-tag rect").setAttribute("fill", p.color);
      carsG.appendChild(g);
      return g;
    });
    root._recolor = (pl) => {   // garage edits update the running race
      const i = players.findIndex((x) => x.id === pl.id); if (i < 0) return;
      Object.assign(players[i], pl);
      carEls[i].querySelector(".car-body").innerHTML = carMarkup(pl.car_style || "classic", pl.color, numberOf(pl, i));
      carEls[i].querySelector(".car-tag text").textContent = tagOf(pl);
    };

    // the track, drawn once
    const circuit = circuits[S.replay_circuit] || {};
    pathEls.forEach((e) => e.setAttribute("d", circuit.d || GENERIC));
    const pathLen = pathEls[1].getTotalLength();
    const bb = pathEls[1].getBBox(), pad = 90;
    svg.setAttribute("viewBox", `${bb.x - pad} ${bb.y - pad} ${bb.width + pad * 2} ${bb.height + pad * 2}`);
    const a0 = pathEls[1].getPointAtLength(0), b0 = pathEls[1].getPointAtLength(4);
    const ang0 = Math.atan2(b0.y - a0.y, b0.x - a0.x) * 180 / Math.PI;
    q(".trk-start").innerHTML = `<g transform="translate(${a0.x} ${a0.y}) rotate(${ang0})">
      ${Array.from({ length: 12 }, (_, k) => `<rect x="${(k % 2) * 8 - 8}" y="${-39 + Math.floor(k / 2) * 13}" width="8" height="13" fill="${(k % 2 + Math.floor(k / 2)) % 2 ? "#141518" : "#f4f4f0"}"/>`).join("")}</g>`;

    function hud(lap, i) {
      q(".replay-flag").textContent = flagEmoji(lap.flag);
      q(".replay-title").textContent = lap.title;
      q(".replay-lap").textContent = `Lap ${i + 1} of ${laps.length}${circuit.name ? " · " + circuit.name : ""}`;
    }
    function place(frac, lane, el) {
      const L = ((frac % 1) + 1) % 1 * pathLen;
      const a = pathEls[1].getPointAtLength(L), b = pathEls[1].getPointAtLength((L + 3) % pathLen);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const x = a.x - Math.sin(ang) * lane, y = a.y + Math.cos(ang) * lane;
      el.querySelector(".car-body").setAttribute("transform", `translate(${x} ${y}) rotate(${ang * 180 / Math.PI}) scale(1.35)`);
      const side = lane >= 0 ? 1 : -1;   // tags sit on the outside of each car's lane
      el.querySelector(".car-tag").setAttribute("transform", `translate(${x - Math.sin(ang) * 38 * side} ${y + Math.cos(ang) * 38 * side})`);
      return { x, y, ang };
    }
    function tower(scores, prev) {
      const order = players.slice().sort((a, b) => scores[b.id] - scores[a.id]);
      const lead = scores[order[0].id];
      q(".tower").innerHTML = order.map((p, i) => {
        const gain = prev ? scores[p.id] - prev[p.id] : null;
        return `<li style="--c:${p.color}"><span class="tw-pos">P${i + 1}</span><span class="tw-name">${esc(p.name)}</span>
          <span class="tw-pts">${i === 0 ? scores[p.id] + " pts" : (lead - scores[p.id] ? "+" + (lead - scores[p.id]) : "level")}</span>
          ${gain !== null ? `<span class="tw-gain ${gain ? "" : "zero"}">${gain ? "+" + gain : "0"}</span>` : ""}</li>`;
      }).join("");
    }
    function puff(x, y, ang) {
      const c = document.createElementNS(SVGNS, "circle");
      c.setAttribute("cx", x - Math.cos(ang) * 26 + (Math.random() - 0.5) * 6);
      c.setAttribute("cy", y - Math.sin(ang) * 26 + (Math.random() - 0.5) * 6);
      c.setAttribute("r", 5); c.setAttribute("class", "puff");
      smokeG.appendChild(c);
      requestAnimationFrame(() => { c.setAttribute("r", 22 + Math.random() * 10); c.classList.add("go"); });
      setTimeout(() => c.remove(), 1000);
    }
    const offsets = (scores) => {
      const mean = players.reduce((a, p) => a + scores[p.id], 0) / players.length;
      return players.map((p) => (scores[p.id] - mean) * perPoint);
    };
    function finish(last) {
      const order = players.slice().sort((a, b) => last.after[b.id] - last.after[a.id]);
      const tie = order.length > 1 && last.after[order[0].id] === last.after[order[1].id];
      q(".replay-finish-text").textContent = tie ? `Dead level after round ${last.round}` : `${order[0].name} leads after round ${last.round}`;
      q(".replay-finish").hidden = false;
    }

    // reduced motion: cars parked at the line with the latest gap
    if (window.PitFX && window.PitFX.reduced()) {
      const last = laps[laps.length - 1];
      hud(last, laps.length - 1);
      const off = offsets(last.after);
      carEls.forEach((el, i) => place(0.02 + off[i], lanes[i], el));
      tower(last.after, last.before); finish(last);
      return;
    }

    let stopped = false;
    running = { stop() { stopped = true; } };
    const visible = () => document.body.contains(svg);
    const t0 = performance.now();
    let lapIdx = -1, lastPuff = 0;
    const frame = (now) => {
      if (stopped || !visible()) return;
      const t = now - t0;
      const i = Math.min(laps.length - 1, Math.floor(t / LAP_MS));
      const lap = laps[i];
      if (i !== lapIdx) {   // crossing the line: next weekend, and last weekend's points on the tower
        lapIdx = i; hud(lap, i);
        tower(lap.before, i ? laps[i - 1].before : null);
      }
      const within = Math.min(1, (t - i * LAP_MS) / LAP_MS);
      const k = ease(clamp01((within - 0.1) / 0.8));
      const scores = Object.fromEntries(players.map((p) => [p.id, lap.before[p.id] + (lap.after[p.id] - lap.before[p.id]) * k]));
      const off = offsets(scores);
      const puffNow = now - lastPuff > 55;
      players.forEach((p, n) => {
        const pos = place(within + off[n], lanes[n], carEls[n]);
        if (puffNow && lap.points[p.id] === 0 && within > 0.08 && within < 0.92) puff(pos.x, pos.y, pos.ang);
      });
      if (puffNow) lastPuff = now;
      if (within >= 1 && i === laps.length - 1) { tower(lap.after, lap.before); finish(lap); return; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ garage edits
  function bindGarage(root, S, api) {
    const save = async (pid, body) => {
      try {
        await api("PUT", "/api/players/" + pid, body);
        const p = S.players.find((x) => x.id === Number(pid));
        Object.assign(p, body.car_number !== undefined ? { car_number: Number(body.car_number) } : body,
          body.tag ? { tag: body.tag.toUpperCase() } : {});
        const card = root.querySelector(`.garage-car[data-player="${pid}"]`);
        const i = S.players.indexOf(p);
        card.querySelector(".garage-preview g").innerHTML = carMarkup(p.car_style || "classic", p.color, numberOf(p, i));
        card.querySelectorAll('[data-garage="style"]').forEach((b) => {
          const on = b.dataset.value === (p.car_style || "classic"); b.classList.toggle("on", on); b.setAttribute("aria-checked", on);
        });
        if (root._recolor) root._recolor(p);
        if (window.PitToast) window.PitToast("Saved");
      } catch (e) { if (window.PitToast) window.PitToast(e.message, "err"); }
    };
    root.querySelectorAll('[data-garage="style"]').forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation(); save(b.dataset.player, { car_style: b.dataset.value });
    }));
    root.querySelectorAll('input[data-garage]').forEach((inp) => inp.addEventListener("change", (e) => {
      e.stopPropagation();
      save(inp.dataset.player, inp.dataset.garage === "number" ? { car_number: inp.value } : { tag: inp.value });
    }));
  }

  window.PitReplay = { html, mount, carMarkup, stop() { if (running) running.stop(); } };
})();
