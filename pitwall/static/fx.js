/* Pit Wall — race-weekend effects: PWhat reel, lights out, results reveal, champagne, rain */
(() => {
  "use strict";
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------ sound (tiny, synthesized)
  let ctx = null;
  function audio() {
    try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); return ctx; } catch (e) { return null; }
  }
  function noiseBuffer(a, seconds) {
    const b = a.createBuffer(1, a.sampleRate * seconds, a.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function screech() {
    const a = audio(); if (!a) return;
    const src = a.createBufferSource(); src.buffer = noiseBuffer(a, 0.45);
    const bp = a.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 9;
    bp.frequency.setValueAtTime(3400, a.currentTime); bp.frequency.exponentialRampToValueAtTime(1300, a.currentTime + 0.42);
    const g = a.createGain(); g.gain.setValueAtTime(0.0001, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.09, a.currentTime + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.44);
    src.connect(bp).connect(g).connect(a.destination); src.start();
  }
  function clunk() {
    const a = audio(); if (!a) return;
    const o = a.createOscillator(); o.type = "triangle";
    o.frequency.setValueAtTime(150, a.currentTime); o.frequency.exponentialRampToValueAtTime(55, a.currentTime + 0.16);
    const g = a.createGain(); g.gain.setValueAtTime(0.16, a.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.2);
    o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.22);
  }
  function tick() {
    const a = audio(); if (!a) return;
    const o = a.createOscillator(); o.type = "square"; o.frequency.value = 1900;
    const g = a.createGain(); g.gain.setValueAtTime(0.015, a.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.03);
    o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.035);
  }

  // ------------------------------------------------------------------ PWhat reel
  /* Spins a pit-board reel through positions, slows down and clunks onto the target. */
  async function rollReel(board, target, lo, hi) {
    if (reduced()) { board.textContent = "P" + target; return; }
    const span = hi - lo + 1;
    const loops = 3;
    const seq = [];
    let start = lo + Math.floor(Math.random() * span);
    const steps = loops * span + ((target - start + span) % span);
    for (let i = 0; i <= steps; i++) seq.push(lo + ((start - lo + i) % span));
    board.classList.add("reeling");
    board.innerHTML = `<span class="reel"><span class="reel-strip">${seq.map((n) => `<span>P${n}</span>`).join("")}</span></span>`;
    const strip = board.querySelector(".reel-strip");
    const rowH = board.querySelector(".reel-strip span").getBoundingClientRect().height || 26;
    const total = 1900;
    const t0 = performance.now();
    let lastIdx = -1;
    await new Promise((done) => {
      const frame = (now) => {
        const t = Math.min(1, (now - t0) / total);
        const eased = 1 - Math.pow(1 - t, 4);               // fast start, long slow-down
        const pos = eased * steps;
        const idx = Math.floor(pos);
        if (idx !== lastIdx && t < 0.97) { lastIdx = idx; if (t > 0.35) tick(); }
        strip.style.transform = `translateY(${-pos * rowH}px)`;
        if (t < 1) requestAnimationFrame(frame); else done();
      };
      requestAnimationFrame(frame);
    });
    board.classList.remove("reeling");
    board.textContent = "P" + target;
    board.classList.add("landed");
    clunk(); screech();
    await wait(450);
    board.classList.remove("landed");
  }

  // ------------------------------------------------------------------ overlays
  function overlay(cls) {
    const el = document.createElement("div");
    el.className = "fx-overlay " + cls;
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
    return el;
  }

  /* Five red lights on, one by one, then all out. */
  async function lightsOut(caption) {
    if (reduced()) return;
    const el = overlay("fx-lights");
    el.innerHTML = `<div class="gantry">${Array.from({ length: 5 }, () =>
      `<div class="pod"><i></i><i></i></div>`).join("")}</div><div class="fx-caption"></div>`;
    const pods = el.querySelectorAll(".pod");
    await wait(250);
    for (const p of pods) { p.classList.add("on"); clunk(); await wait(650); }
    await wait(400 + Math.random() * 900);
    pods.forEach((p) => p.classList.remove("on"));
    el.querySelector(".fx-caption").textContent = caption;
    el.classList.add("out");
    await wait(1600);
    el.classList.add("gone");
    await wait(400);
    el.remove();
  }

  /* Particle canvas helper */
  function canvasFx(cls, ms, draw) {
    const el = overlay(cls);
    const cv = document.createElement("canvas");
    el.appendChild(cv);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; };
    resize();
    const g = cv.getContext("2d");
    g.scale(dpr, dpr);
    const t0 = performance.now();
    return new Promise((done) => {
      const frame = (now) => {
        const t = now - t0;
        g.clearRect(0, 0, innerWidth, innerHeight);
        draw(g, t, innerWidth, innerHeight);
        if (t < ms) requestAnimationFrame(frame);
        else { el.classList.add("gone"); setTimeout(() => { el.remove(); done(); }, 400); }
      };
      requestAnimationFrame(frame);
    });
  }

  /* Champagne spray from both bottom corners, in the winner's color plus gold. */
  function champagne(color, caption) {
    if (reduced()) return Promise.resolve();
    const drops = [];
    const add = (x, dir, h) => {
      for (let i = 0; i < 9; i++) {
        const a = (-Math.PI / 2) + dir * (0.25 + Math.random() * 0.55);
        const sp = 9 + Math.random() * 9;
        drops.push({ x, y: h + 10, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: 2 + Math.random() * 3.5,
          c: Math.random() < 0.35 ? color : (Math.random() < 0.5 ? "#f6dc7a" : "#fff6d5"), life: 0 });
      }
    };
    const cap = overlay("fx-caption-only"); cap.innerHTML = `<div class="fx-caption champ">${caption}</div>`;
    setTimeout(() => cap.classList.add("gone"), 2600); setTimeout(() => cap.remove(), 3100);
    return canvasFx("fx-champagne", 2800, (g, t, w, h) => {
      if (t < 1700) { add(0, 1, h); add(w, -1, h); }
      for (const d of drops) {
        d.vy += 0.32; d.vx *= 0.995; d.x += d.vx; d.y += d.vy; d.life++;
        g.globalAlpha = Math.max(0, 1 - d.life / 120);
        g.fillStyle = d.c; g.beginPath(); g.arc(d.x, d.y, d.r, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
      while (drops.length > 1400) drops.shift();
    });
  }

  /* A short rain shower with a dark wash. */
  function rain(caption) {
    if (reduced()) return Promise.resolve();
    const streaks = [];
    const cap = overlay("fx-caption-only"); cap.innerHTML = `<div class="fx-caption rainy">${caption}</div>`;
    setTimeout(() => cap.classList.add("gone"), 2700); setTimeout(() => cap.remove(), 3200);
    return canvasFx("fx-rain", 3000, (g, t, w, h) => {
      const fade = Math.min(1, t / 400, (3000 - t) / 500);
      g.fillStyle = `rgba(20,28,40,${0.35 * fade})`; g.fillRect(0, 0, w, h);
      if (t < 2500) for (let i = 0; i < 14; i++) streaks.push({ x: Math.random() * (w + 200), y: -20, v: 16 + Math.random() * 10, l: 14 + Math.random() * 18 });
      g.strokeStyle = `rgba(190,210,235,${0.55 * fade})`; g.lineWidth = 1.4; g.beginPath();
      for (const s of streaks) { s.y += s.v; s.x -= s.v * 0.25; g.moveTo(s.x, s.y); g.lineTo(s.x + s.l * 0.25, s.y - s.l); }
      g.stroke();
      for (let i = streaks.length - 1; i >= 0; i--) if (streaks[i].y > h + 40) streaks.splice(i, 1);
    });
  }

  // ------------------------------------------------------------------ results reveal
  /* Reveals [data-rslot] elements in the given order: qualifying first, then P22 up to P1. */
  async function revealResults(root, order, onSlot) {
    const els = (slot) => root.querySelectorAll(`[data-rslot="${slot}"]`);
    if (reduced()) { root.querySelectorAll("[data-rslot]").forEach((e) => e.classList.remove("veil")); return; }
    root.querySelectorAll("[data-rslot]").forEach((e) => e.classList.add("veil"));
    await wait(350);
    for (const slot of order) {
      const n = /^P\d+$/.test(slot) ? Number(slot.slice(1)) : 0;
      const gap = !n ? 520 : n > 10 ? 150 : n > 3 ? 300 : 750;
      els(slot).forEach((e) => { e.classList.remove("veil"); e.classList.add("flip-in"); });
      if (onSlot) onSlot(slot);
      if (n && n <= 3) clunk(); else tick();
      await wait(gap);
    }
    root.querySelectorAll(".flip-in").forEach((e) => e.classList.remove("flip-in"));
  }

  window.PitFX = { rollReel, lightsOut, champagne, rain, revealResults, reduced };
})();
