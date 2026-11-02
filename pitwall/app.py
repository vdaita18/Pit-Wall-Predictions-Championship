"""Pit Wall — F1 predictions championship web app."""
import csv
import json
import hmac
import io
import os
import random
import re
import secrets
import time
from datetime import datetime, timedelta

from flask import Flask, g, jsonify, render_template, request, send_file, session, Response

from . import circuits, db, f1api
from .scoring import (GRID_SIZE, EMPTY, SOURCES, SPRINT_SOURCES, build_stats, categories_for, result_slots,
                      score_race, season_points, slot_label, slot_of)

HERE = os.path.dirname(os.path.abspath(__file__))
FLAG_RE = re.compile("[\U0001F1E6-\U0001F1FF]{2}")


def _secret_key(db_path):
    """A random signing key for sign-in cookies, created once and kept with the data."""
    path = os.path.join(os.path.dirname(os.path.abspath(db_path)), "secret.key")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
    with open(path) as f:
        return f.read().strip()


def create_app(db_path=None):
    app = Flask(__name__, template_folder=os.path.join(HERE, "templates"),
                static_folder=os.path.join(HERE, "static"))
    app.config["DB_PATH"] = db_path or os.environ.get(
        "PITWALL_DB", os.path.join(os.path.dirname(HERE), "data", "pitwall.db"))
    db.init(app.config["DB_PATH"])
    schedule_cache = {}

    # Shared play: set PITWALL_PASSCODE and everyone who knows it can sign in as a player.
    # Without it (playing on one computer) anyone can edit anything.
    PASSCODE = os.environ.get("PITWALL_PASSCODE", "").strip()
    app.config.update(
        SECRET_KEY=os.environ.get("PITWALL_SECRET") or _secret_key(app.config["DB_PATH"]),
        SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(days=200),
    )
    failed_logins = {}   # ip -> [timestamps]
    OPEN_WRITES = {"login", "logout", "resolve_circuits"}   # no sign-in needed, not announced to the other player
    CHANGE_WORDS = {
        "edit_player": "updated the players", "add_category": "added a prediction type",
        "edit_category": "changed a prediction type", "move_category": "reordered the prediction types",
        "add_question": "added a season question", "edit_question": "changed a season question",
        "season_answer": "answered a season question", "season_question_answer": "set a season answer",
        "add_full_calendar": "added the season calendar", "add_lineup_change": "changed the line-up",
        "edit_lineup_change": "changed the line-up", "resolve_circuits": "matched the circuits",
        "set_pick": "made a pick", "set_manual": "awarded points", "set_result": "updated the results",
        "fetch_results": "fetched the official results", "roll": "rolled the PWhat position",
        "add_race": "added a race", "delete_race": "deleted a race", "edit_race": "edited a race",
        "season_pick": "made a season pick", "season_final": "updated the final standings",
    }

    # ------------------------------------------------------------------ helpers
    def con():
        if "con" not in g:
            g.con = db.connect(app.config["DB_PATH"])
        return g.con

    @app.teardown_appcontext
    def close(_exc):
        c = g.pop("con", None)
        if c is not None:
            c.close()

    def rows(sql, args=()):
        return [dict(r) for r in con().execute(sql, args).fetchall()]

    def fail(msg, code=400):
        return jsonify({"error": msg}), code

    def players():
        return rows("SELECT * FROM players ORDER BY pos, id")

    def drivers():
        return rows("""SELECT d.*, t.name AS team, t.color AS team_color FROM drivers d
                       LEFT JOIN teams t ON t.id = d.team_id ORDER BY d.pos, d.id""")

    def races():
        rs = rows("SELECT * FROM races ORDER BY pos, id")
        filled = {r["race_id"] for r in rows(
            "SELECT DISTINCT race_id FROM results WHERE driver NOT IN ('', '----') AND slot GLOB 'P[0-9]*'")}
        for i, r in enumerate(rs):
            r["round"] = i + 1
            r["has_results"] = r["id"] in filled
            r["circuit"] = r.get("circuit") or circuits.guess(r["title"])
        return rs

    def race_data(race_id):
        picks = {(r["player_id"], r["category"]): r["value"]
                 for r in rows("SELECT * FROM picks WHERE race_id=?", (race_id,))}
        manual = {(r["player_id"], r["category"]): r["points"]
                  for r in rows("SELECT * FROM manual WHERE race_id=?", (race_id,))}
        results = {r["slot"]: r["driver"] for r in rows("SELECT * FROM results WHERE race_id=?", (race_id,))}
        return picks, manual, results

    def cats():
        return rows("SELECT * FROM categories ORDER BY pos, id")

    def season_data():
        sp = {(r["player_id"], r["position"]): r["driver"] for r in rows("SELECT * FROM season_picks")}
        sf = {r["position"]: r["driver"] for r in rows("SELECT * FROM season_final")}
        return sp, sf

    def season_totals(ps):
        sp, sf = season_data()
        qs = rows("SELECT * FROM season_questions ORDER BY pos, id")
        answers = {(r["question_id"], r["player_id"]): r["value"] for r in rows("SELECT * FROM season_answers")}
        finals = {r["question_id"]: r["value"] for r in rows("SELECT * FROM season_question_final")}
        per = float(db.setting(con(), "season_position_points", "0.5"))
        return season_points(ps, sp, sf, per, qs, answers, finals)

    def all_scores(ps, rs, cs=None):
        cs = cs if cs is not None else cats()
        out = {}
        for r in rs:
            picks, manual, results = race_data(r["id"])
            out[r["id"]] = score_race(r, ps, cs, picks, manual, results)
        return out

    def parse_title(raw):
        raw = str(raw or "").strip()
        flag = ""
        m = FLAG_RE.search(raw)
        if m:
            flag = "".join(chr(ord(ch) - 0x1F1E6 + 65) for ch in m.group(0))
            raw = FLAG_RE.sub("", raw).strip()
        m = re.search(r"\s+([A-Z]{2})$", raw)
        if m:
            flag = flag or m.group(1)
            raw = raw[:m.start()].strip()
        return raw, flag

    def season():
        return db.setting(con(), "season", str(datetime.now().year))

    def get_schedule():
        yr = season()
        hit = schedule_cache.get(yr)
        if hit and time.time() - hit[0] < 6 * 3600:
            return hit[1]
        sched = f1api.schedule(yr)
        schedule_cache[yr] = (time.time(), sched)
        con().execute("INSERT OR REPLACE INTO settings VALUES ('season_calendar', ?)",
                      (json.dumps([x["suggested"] for x in sched if x.get("suggested")]),))
        con().commit()
        return sched

    def first_picker(ps, round_no):
        return ps[(round_no - 1) % len(ps)]["id"] if ps else None

    # ------------------------------------------------------------------ line-ups
    def lineup_changes():
        return rows("""SELECT l.*, t.name AS team, t.color AS team_color FROM lineup_changes l
                       LEFT JOIN teams t ON t.id = l.team_id ORDER BY l.from_round, l.id""")

    def lineup_for(round_no):
        """The grid for one round: every team seat, with stand-ins and replacements applied."""
        seats = [dict(d, seat_team_id=d["team_id"], stand_in=False, replaces=None)
                 for d in drivers() if d["team_id"] and not d["sidelined"]]
        by_name = {d["name"]: d for d in drivers()}
        for ch in sorted(lineup_changes(), key=lambda c: c["id"]):
            if ch["from_round"] <= round_no <= (ch["to_round"] or 10 ** 6):
                seat = next((x for x in seats if x["seat_team_id"] == ch["team_id"] and x["name"] == ch["out_driver"]), None)
                if seat:
                    who = by_name.get(ch["in_driver"], {})
                    seat.update(name=ch["in_driver"], code=who.get("code", ""), id=who.get("id"),
                                stand_in=True, replaces=ch["out_driver"])
        teams = {t["id"]: t for t in rows("SELECT * FROM teams")}
        for x in seats:   # stand-ins drive in the colors of the seat they fill
            t = teams.get(x["seat_team_id"], {})
            x["team"], x["team_color"], x["team_id"] = t.get("name"), t.get("color"), x["seat_team_id"]
        return seats

    STOP = {"f1", "team", "formula", "one", "scuderia", "aramco", "cognizant", "bwt", "moneygram", "visa", "cash", "app", ""}

    def team_key(name):
        """'RB F1 Team', 'Racing Bulls' and 'VCARB' all become the same key; so do 'Kick Sauber' and 'Audi'."""
        words = set(re.split(r"[^a-z0-9]+", f1api.normalize(name))) - STOP
        if {"red", "bull"} <= words:
            return "redbull"
        if words & {"racing", "bulls", "vcarb", "rb", "alphatauri", "tauri", "toro", "rosso"}:
            return "racingbulls"
        if words & {"audi", "sauber", "kick", "stake", "alfa"}:
            return "audi"
        return " ".join(sorted(words))

    def team_for_constructor(name, teams):
        k = team_key(name)
        return next((t for t in teams if team_key(t["name"]) == k), None)

    def suggest_lineup_changes(race_rows, matcher, round_no):
        """Compare who each team actually ran with this round's line-up and suggest the differences."""
        teams = rows("SELECT * FROM teams")
        lineup = lineup_for(round_no)
        theirs = {}
        for r in race_rows:
            t = team_for_constructor((r.get("Constructor") or {}).get("name", ""), teams)
            if t:
                theirs.setdefault(t["id"], []).append((matcher.name_for(r["Driver"]), r["Driver"]))
        known = {d["name"] for d in drivers()}
        out = []
        for t in teams:
            ours = [x["name"] for x in lineup if x["seat_team_id"] == t["id"]]
            got = theirs.get(t["id"], [])
            ins = [(n, d) for n, d in got if n not in ours]
            outs = [n for n in ours if n not in [g[0] for g in got]]
            if len(ins) == 1 and len(outs) == 1:
                n, d = ins[0]
                out.append({"team_id": t["id"], "team": t["name"], "out_driver": outs[0], "in_driver": n,
                            "code": (d.get("code") or "").upper(), "new_driver": n not in known, "from_round": round_no})
        return out

    # ------------------------------------------------------------------ sign-in & live sync
    def signed_in():
        return not PASSCODE or bool(session.get("unlocked"))

    def me():
        pid = session.get("player_id")
        if pid and not con().execute("SELECT 1 FROM players WHERE id=?", (pid,)).fetchone():
            session.pop("player_id", None)
            pid = None
        return pid

    def may_edit_player(pid):
        """With a passcode, players can only change their own predictions."""
        return not PASSCODE or me() == int(pid)

    @app.before_request
    def guard_writes():
        if request.method == "GET" or not request.path.startswith("/api/"):
            return None
        if request.endpoint in OPEN_WRITES:
            return None
        if not signed_in():
            return fail("Sign in with the championship passcode to make changes.", 401)
        if PASSCODE and not me():
            return fail("Choose which player you are before making changes.", 401)
        return None

    @app.after_request
    def bump_revision(resp):
        if (request.method != "GET" and request.path.startswith("/api/") and resp.status_code < 400
                and request.endpoint not in OPEN_WRITES | {"whoami_set"}):
            c = con()
            rev = int(db.setting(c, "rev", "0")) + 1
            who = c.execute("SELECT name FROM players WHERE id=?", (session.get("player_id"),)).fetchone()
            what = CHANGE_WORDS.get(request.endpoint, "made changes")
            rid = (request.view_args or {}).get("rid")
            race = c.execute("SELECT title FROM races WHERE id=?", (rid,)).fetchone() if rid else None
            if race:
                what += " for " + race["title"]
            for k, v in (("rev", str(rev)), ("rev_by", who["name"] if who else ""),
                         ("rev_by_id", str(session.get("player_id") or "")), ("rev_what", what),
                         ("rev_device", request.headers.get("X-Pitwall-Device", "")[:64])):
                c.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (k, v))
            c.commit()
            resp.headers["X-Pitwall-Rev"] = str(rev)
        return resp

    @app.route("/api/me")
    def whoami():
        return jsonify({"passcode_required": bool(PASSCODE), "signed_in": signed_in(), "player_id": me(),
                        "rev": int(db.setting(con(), "rev", "0"))})

    @app.route("/api/login", methods=["POST"])
    def login():
        b = request.get_json(force=True)
        ip = request.headers.get("X-Real-IP") or request.remote_addr or "?"
        now = time.time()
        recent = [t for t in failed_logins.get(ip, []) if now - t < 600]
        if len(recent) >= 8:
            return fail("Too many wrong passcodes. Wait ten minutes and try again.", 429)
        if PASSCODE and not hmac.compare_digest(str(b.get("passcode", "")).strip(), PASSCODE):
            failed_logins[ip] = recent + [now]
            return fail("That passcode isn't right. Check it with whoever set up the site.", 403)
        pid = b.get("player_id")
        if not pid or not con().execute("SELECT 1 FROM players WHERE id=?", (pid,)).fetchone():
            return fail("Choose which player you are.")
        session.permanent = True
        session["unlocked"] = True
        session["player_id"] = int(pid)
        return jsonify({"ok": True})

    @app.route("/api/logout", methods=["POST"])
    def logout():
        session.clear()
        return jsonify({"ok": True})

    @app.route("/api/rev")
    def revision():
        c = con()
        return jsonify({"rev": int(db.setting(c, "rev", "0")), "by": db.setting(c, "rev_by", ""),
                        "by_id": db.setting(c, "rev_by_id", ""), "what": db.setting(c, "rev_what", ""),
                        "device": db.setting(c, "rev_device", "")})

    # ------------------------------------------------------------------ pages
    @app.route("/")
    def index():
        return render_template("index.html")

    # ------------------------------------------------------------------ state
    @app.route("/api/state")
    def state():
        ps, rs = players(), races()
        scores = all_scores(ps, rs)
        cs = cats()
        stats = build_stats(ps, rs, scores, cs)
        sp, sf = season_data()
        spts = season_totals(ps)
        for r in rs:
            r["first_picker"] = first_picker(ps, r["round"])
            r["points"] = {pid: sum(v.values()) for pid, v in scores[r["id"]].items()}
        standings = sorted(
            [{"player_id": p["id"], "name": p["name"], "color": p["color"],
              "race_points": stats["totals"][p["id"]], "season_points": spts[p["id"]],
              "total": round(stats["totals"][p["id"]] + spts[p["id"]], 2)} for p in ps],
            key=lambda s: -s["total"])
        return jsonify({
            "season": season(), "players": ps, "drivers": drivers(),
            "teams": rows("SELECT * FROM teams ORDER BY pos, id"), "races": rs,
            "stats": stats, "standings": standings,
            "season_picks": [{"player_id": k[0], "position": k[1], "driver": v} for k, v in sp.items()],
            "season_final": [{"position": k, "driver": v} for k, v in sf.items()],
            "grid_size": GRID_SIZE, "lineup_changes": lineup_changes(), "categories": cs,
            "sources": {k: {"label": v[1], "first": v[2], "sprint": k in SPRINT_SOURCES} for k, v in SOURCES.items()},
            "season_questions": rows("SELECT * FROM season_questions ORDER BY pos, id"),
            "season_answers": rows("SELECT * FROM season_answers"),
            "season_question_final": rows("SELECT * FROM season_question_final"),
            "season_position_points": float(db.setting(con(), "season_position_points", "0.5")),
            "season_calendar": json.loads(db.setting(con(), "season_calendar", "[]") or "[]"),
            "replay_circuit": db.setting(con(), "replay_circuit", "") or (rs[0]["circuit"] if rs else "") or "it-1922",
        })

    # ------------------------------------------------------------------ races
    @app.route("/api/races", methods=["POST"])
    def add_race():
        body = request.get_json(force=True)
        title, flag = parse_title(body.get("title"))
        if not title:
            return fail("Type the race name first, for example “Mexico” or “Miami Sprint”.")
        if con().execute("SELECT 1 FROM races WHERE lower(title)=lower(?)", (title,)).fetchone():
            return fail("%s is already on the calendar." % title, 409)
        flag = (body.get("flag") or flag or "").upper()[:2]
        sprint = bool(body.get("is_sprint")) or bool(re.search(r"\bsprint\b", title, re.I))
        pos = con().execute("SELECT COALESCE(MAX(pos), -1) + 1 FROM races").fetchone()[0]
        cur = con().execute(
            "INSERT INTO races(title, flag, is_sprint, api_round, circuit, pos, created_at) VALUES (?,?,?,?,?,?,?)",
            (title, flag, int(sprint), body.get("api_round"),
             circuits.BY_API_ID.get(body.get("circuit_id") or "") or circuits.guess(title), pos, datetime.now().isoformat()))
        con().commit()
        return jsonify({"id": cur.lastrowid, "title": title})

    @app.route("/api/races/<int:rid>", methods=["DELETE"])
    def delete_race(rid):
        con().execute("DELETE FROM races WHERE id=?", (rid,))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/races/<int:rid>", methods=["PATCH"])
    def edit_race(rid):
        body = request.get_json(force=True)
        if "title" in body:
            title, flag = parse_title(body["title"])
            if not title:
                return fail("A race needs a name.")
            con().execute("UPDATE races SET title=?, is_sprint=? WHERE id=?",
                          (title, int(bool(re.search(r"\bsprint\b", title, re.I))), rid))
            if flag:
                con().execute("UPDATE races SET flag=? WHERE id=?", (flag, rid))
        if body.get("circuit"):
            con().execute("UPDATE races SET circuit=? WHERE id=?", (str(body["circuit"])[:20], rid))
        if "pwhat" in body:
            v = body["pwhat"]
            con().execute("UPDATE races SET pwhat=? WHERE id=?",
                          (int(v) if v not in (None, "") else None, rid))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/races/<int:rid>")
    def race_detail(rid):
        ps, rs = players(), races()
        race = next((r for r in rs if r["id"] == rid), None)
        if not race:
            return fail("That race isn't on the calendar any more.", 404)
        picks, manual, results = race_data(rid)
        cs = cats()
        scores = score_race(race, ps, cs, picks, manual, results)
        prev = {p["id"]: 0 for p in ps}
        all_sc = all_scores(ps, [r for r in rs if r["round"] < race["round"]], cs)
        for sc in all_sc.values():
            for pid, v in sc.items():
                prev[pid] = round(prev[pid] + sum(v.values()), 2)
        here = [dict(c, slot=slot_of(c, race)) for c in categories_for(race, cs)]
        slots = result_slots(race, cs)
        idx = (race["round"] - 1) % len(ps) if ps else 0
        order = [p["id"] for p in ps[idx:] + ps[:idx]]
        return jsonify({
            "race": race, "categories": here, "slots": slots,
            "slot_labels": {sl: slot_label(sl) for sl in slots},
            "picks": [{"player_id": k[0], "category": k[1], "value": v} for k, v in picks.items()],
            "manual": [{"player_id": k[0], "category": k[1], "points": v} for k, v in manual.items()],
            "results": results, "scores": scores, "previous": prev, "pick_order": order,
            "lineup": lineup_for(race["round"]),
            "prev_id": next((r["id"] for r in rs if r["round"] == race["round"] - 1), None),
            "next_id": next((r["id"] for r in rs if r["round"] == race["round"] + 1), None),
        })

    @app.route("/api/races/<int:rid>/pick", methods=["PUT"])
    def set_pick(rid):
        b = request.get_json(force=True)
        cat, pid, value = b.get("category"), int(b.get("player_id")), (b.get("value") or "").strip()
        c = next((x for x in cats() if x["key"] == cat), None)
        if not c:
            return fail("That prediction type doesn't exist any more.")
        if not may_edit_player(pid):
            return fail("You can only change your own predictions.", 403)
        ps = players()
        if c["unique_picks"] and c["kind"] != "judged" and value not in EMPTY:
            taken = con().execute("""SELECT p.name FROM picks k JOIN players p ON p.id = k.player_id
                                     WHERE k.race_id=? AND k.category=? AND k.player_id<>? AND k.value=?""",
                                  (rid, cat, pid, value)).fetchone()
            if taken:
                return fail("%s already picked %s for %s, and everyone has to pick differently there."
                            % (taken["name"], value, c["label"]), 409)
        con().execute("INSERT OR REPLACE INTO picks VALUES (?,?,?,?)", (rid, pid, cat, value))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/races/<int:rid>/manual", methods=["PUT"])
    def set_manual(rid):
        b = request.get_json(force=True)
        con().execute("INSERT OR REPLACE INTO manual VALUES (?,?,?,?)",
                      (rid, int(b["player_id"]), b["category"], 1 if b.get("points") else 0))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/races/<int:rid>/result", methods=["PUT"])
    def set_result(rid):
        b = request.get_json(force=True)
        con().execute("INSERT OR REPLACE INTO results VALUES (?,?,?)", (rid, b["slot"], b.get("value") or "----"))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/races/<int:rid>/roll", methods=["POST"])
    def roll(rid):
        race = next((r for r in races() if r["id"] == rid), None)
        hi = max(len(lineup_for(race["round"] if race else 1)) - 1, 4)
        value = random.randint(4, hi)
        con().execute("UPDATE races SET pwhat=? WHERE id=?", (value, rid))
        con().commit()
        return jsonify({"pwhat": value, "min": 4, "max": hi})

    @app.route("/api/races/<int:rid>/fetch-results", methods=["POST"])
    def fetch_results(rid):
        race = next((r for r in races() if r["id"] == rid), None)
        if not race:
            return fail("That race isn't on the calendar any more.", 404)
        yr = season()
        try:
            rnd = race["api_round"] or f1api.match_round(get_schedule(), race["title"], race["round"])
            if not rnd:
                return fail("Couldn't match %s to the %s calendar." % (race["title"], yr))
            name, data = f1api.get_results(yr, rnd, bool(race["is_sprint"]))
        except f1api.F1ApiError as e:
            return fail(str(e), 502)
        if not any(data.values()):
            return fail("No results are out yet for round %s. They usually appear a little while after "
                        "the session ends." % rnd, 404)

        matcher = f1api.DriverMatcher(drivers())
        filled, writes = [], {}
        words = {"race": "finishing order", "quali": "qualifying", "sprint": "sprint",
                 "fastest_lap": "fastest laps", "fastest_pit": "pit stops"}
        for src, word in words.items():
            got = data.get(src) or []
            if not got:
                continue
            prefix = SOURCES[src][0]
            con().execute("DELETE FROM results WHERE race_id=? AND slot GLOB ?", (rid, prefix + "[0-9]*"))
            for i in range(1, GRID_SIZE + 1):
                d = f1api.by_position(got, i)
                if d:
                    writes["%s%d" % (prefix, i)] = matcher.name_for(d)
            filled.append(word)
        for slot, value in writes.items():
            con().execute("INSERT OR REPLACE INTO results VALUES (?,?,?)", (rid, slot, value))
        suggestions = suggest_lineup_changes(data["race"], matcher, race["round"]) if data["race"] else []
        matcher.unmatched = [u for u in matcher.unmatched
                             if not any(u.startswith(s["in_driver"]) for s in suggestions)]
        for did, code in matcher.learned.items():
            con().execute("UPDATE drivers SET code=? WHERE id=?", (code, did))
        con().execute("UPDATE races SET api_round=? WHERE id=?", (rnd, rid))
        official = next((s for s in schedule_cache.get(yr, (0, []))[1] if s["round"] == rnd), None)
        if official and circuits.BY_API_ID.get(official.get("circuit_id")):
            con().execute("UPDATE races SET circuit=? WHERE id=?", (circuits.BY_API_ID[official["circuit_id"]], rid))
        con().commit()
        msg = "Filled the %s from the %s." % (", ".join(filled), name or "round %s" % rnd)
        if race["is_sprint"]:
            msg += " Sprint pole isn't published, so set that one yourself."
        return jsonify({"message": msg, "unmatched": matcher.unmatched, "suggestions": suggestions})

    # ------------------------------------------------------------------ line-up changes
    @app.route("/api/lineup", methods=["POST"])
    def add_lineup_change():
        b = request.get_json(force=True)
        try:
            team_id, frm = int(b["team_id"]), int(b["from_round"])
            to = int(b["to_round"]) if b.get("to_round") not in (None, "") else None
        except (KeyError, TypeError, ValueError):
            return fail("Choose the team, both drivers and the weekend the change starts.")
        out_d, in_d = str(b.get("out_driver", "")).strip(), str(b.get("in_driver", "")).strip()
        if not out_d or not in_d or out_d == in_d:
            return fail("Choose who's out and who's stepping in.")
        if to is not None and to < frm:
            return fail("The change can't end before it starts.")
        seat = next((x for x in lineup_for(frm) if x["seat_team_id"] == team_id and x["name"] == out_d), None)
        if not seat:
            return fail("%s isn't in that seat in round %d." % (out_d, frm))
        if in_d not in {d["name"] for d in drivers()}:   # a brand-new name becomes a reserve driver
            pos = con().execute("SELECT COALESCE(MAX(pos), -1) + 1 FROM drivers").fetchone()[0]
            con().execute("INSERT INTO drivers(name, code, team_id, pos) VALUES (?,?,NULL,?)",
                          (in_d, re.sub(r"[^A-Za-z]", "", str(b.get("code", ""))).upper()[:3], pos))
        con().execute("INSERT INTO lineup_changes(team_id, out_driver, in_driver, from_round, to_round) VALUES (?,?,?,?,?)",
                      (team_id, out_d, in_d, frm, to))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/lineup/<int:lid>", methods=["PATCH", "DELETE"])
    def edit_lineup_change(lid):
        if request.method == "DELETE":
            con().execute("DELETE FROM lineup_changes WHERE id=?", (lid,))
        else:
            b = request.get_json(force=True)
            to = b.get("to_round")
            con().execute("UPDATE lineup_changes SET to_round=? WHERE id=?", (int(to) if to not in (None, "") else None, lid))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/schedule")
    def official_schedule():
        try:
            sched = get_schedule()
        except f1api.F1ApiError as e:
            return fail(str(e), 502)
        taken = {r["api_round"] for r in races() if r["api_round"]}
        return jsonify([{k: v for k, v in r.items() if not k.startswith("_")} | {"added": r["round"] in taken}
                        for r in sched])

    # ------------------------------------------------------------------ people & grid
    @app.route("/api/players", methods=["POST"])
    def add_player():
        pos = con().execute("SELECT COALESCE(MAX(pos), -1) + 1 FROM players").fetchone()[0]
        color = db.PLAYER_COLORS[pos % len(db.PLAYER_COLORS)]
        con().execute("INSERT INTO players(name, color, pos) VALUES (?,?,?)",
                      ((request.get_json(force=True).get("name") or "Player %d" % (pos + 1)).strip(), color, pos))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/players/<int:pid>", methods=["PUT", "DELETE"])
    def edit_player(pid):
        if request.method == "DELETE":
            if con().execute("SELECT COUNT(*) FROM players").fetchone()[0] <= 1:
                return fail("The championship needs at least one player.")
            con().execute("DELETE FROM players WHERE id=?", (pid,))
        else:
            b = request.get_json(force=True)
            for field in ("name", "color"):
                if b.get(field):
                    con().execute("UPDATE players SET %s=? WHERE id=?" % field, (b[field].strip(), pid))
            if b.get("car_style") in ("classic", "wedge", "retro"):
                con().execute("UPDATE players SET car_style=? WHERE id=?", (b["car_style"], pid))
            if "car_number" in b:
                try:
                    n = max(0, min(99, int(b["car_number"])))
                except (TypeError, ValueError):
                    return fail("The car number has to be between 0 and 99.")
                con().execute("UPDATE players SET car_number=? WHERE id=?", (n, pid))
            if "tag" in b:
                tag = re.sub(r"[^A-Za-z]", "", str(b["tag"])).upper()[:3]
                if len(tag) < 2:
                    return fail("The tag needs two or three letters, like VEN.")
                con().execute("UPDATE players SET tag=? WHERE id=?", (tag, pid))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/circuits/resolve", methods=["POST"])
    def resolve_circuits():
        """Match each race to its official circuit using the season calendar, when it can be reached."""
        try:
            sched = {s["round"]: s for s in get_schedule()}
        except f1api.F1ApiError:
            return jsonify({"updated": 0, "offline": True})
        n = 0
        for r in rows("SELECT id, api_round, circuit FROM races"):
            official = sched.get(r["api_round"]) if r["api_round"] else None
            cid = official and circuits.BY_API_ID.get(official.get("circuit_id"))
            if cid and cid != r["circuit"]:
                con().execute("UPDATE races SET circuit=? WHERE id=?", (cid, r["id"]))
                n += 1
        con().commit()
        return jsonify({"updated": n})

    @app.route("/api/teams", methods=["POST"])
    def add_team():
        pos = con().execute("SELECT COALESCE(MAX(pos), -1) + 1 FROM teams").fetchone()[0]
        con().execute("INSERT INTO teams(name, color, pos) VALUES (?,?,?)",
                      (request.get_json(force=True).get("name") or "New team", "#888888", pos))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/teams/<int:tid>", methods=["PUT", "DELETE"])
    def edit_team(tid):
        if request.method == "DELETE":
            con().execute("DELETE FROM teams WHERE id=?", (tid,))
        else:
            b = request.get_json(force=True)
            for field in ("name", "color"):
                if b.get(field):
                    con().execute("UPDATE teams SET %s=? WHERE id=?" % field, (b[field].strip(), tid))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/drivers", methods=["POST"])
    def add_driver():
        b = request.get_json(force=True)
        name = (b.get("name") or "").strip()
        if not name:
            return fail("Type the driver's name first.")
        pos = con().execute("SELECT COALESCE(MAX(pos), -1) + 1 FROM drivers").fetchone()[0]
        con().execute("INSERT INTO drivers(name, code, team_id, pos) VALUES (?,?,?,?)",
                      (name, (b.get("code") or "").upper()[:3], b.get("team_id"), pos))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/drivers/<int:did>", methods=["PUT", "DELETE"])
    def edit_driver(did):
        if request.method == "DELETE":
            con().execute("DELETE FROM drivers WHERE id=?", (did,))
            con().commit()
            return jsonify({"ok": True})
        b = request.get_json(force=True)
        old = con().execute("SELECT name FROM drivers WHERE id=?", (did,)).fetchone()
        if "name" in b and b["name"].strip() and old and b["name"].strip() != old["name"]:
            new = b["name"].strip()
            con().execute("UPDATE drivers SET name=? WHERE id=?", (new, did))
            # keep past picks and results pointing at the same driver
            for table, col in (("picks", "value"), ("results", "driver"),
                               ("lineup_changes", "out_driver"), ("lineup_changes", "in_driver"),
                               ("season_answers", "value"), ("season_question_final", "value"),
                               ("season_picks", "driver"), ("season_final", "driver")):
                con().execute("UPDATE %s SET %s=? WHERE %s=?" % (table, col, col), (new, old["name"]))
        if "code" in b:
            con().execute("UPDATE drivers SET code=? WHERE id=?", ((b["code"] or "").upper()[:3], did))
        if "team_id" in b:
            con().execute("UPDATE drivers SET team_id=? WHERE id=?", (b["team_id"] or None, did))
        if "sidelined" in b:
            con().execute("UPDATE drivers SET sidelined=? WHERE id=?", (1 if b["sidelined"] else 0, did))
        con().commit()
        return jsonify({"ok": True})

    # ------------------------------------------------------------------ season
    @app.route("/api/season/pick", methods=["PUT"])
    def season_pick():
        b = request.get_json(force=True)
        if not may_edit_player(b["player_id"]):
            return fail("You can only change your own season predictions.", 403)
        con().execute("INSERT OR REPLACE INTO season_picks VALUES (?,?,?)",
                      (int(b["player_id"]), int(b["position"]), b.get("value") or "----"))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/season/final", methods=["PUT"])
    def season_final():
        b = request.get_json(force=True)
        con().execute("INSERT OR REPLACE INTO season_final VALUES (?,?)",
                      (int(b["position"]), b.get("value") or "----"))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/settings", methods=["PUT"])
    def settings():
        b = request.get_json(force=True)
        if "replay_circuit" in b and re.fullmatch(r"[a-z]{2}-\d{4}", str(b["replay_circuit"])):
            con().execute("INSERT OR REPLACE INTO settings VALUES ('replay_circuit', ?)", (b["replay_circuit"],))
            con().commit()
        if "season_position_points" in b:
            try:
                v = max(0.0, float(b["season_position_points"]))
            except (TypeError, ValueError):
                return fail("Points per correct position has to be a number, like 0.5.")
            con().execute("INSERT OR REPLACE INTO settings VALUES ('season_position_points', ?)", (str(v),))
            con().commit()
        if "season" in b and re.fullmatch(r"\d{4}", str(b["season"])):
            con().execute("INSERT OR REPLACE INTO settings VALUES ('season', ?)", (str(b["season"]),))
            con().commit()
        return jsonify({"ok": True})

    # ------------------------------------------------------------------ prediction types
    def number(v, what, default=0.0):
        if v in (None, ""):
            return default
        try:
            n = float(v)
        except (TypeError, ValueError):
            raise ValueError("%s has to be a number, like 1 or 0.5." % what)
        if n < 0 or n > 100:
            raise ValueError("%s has to be between 0 and 100." % what)
        return n

    def category_fields(b, current=None):
        cur = current or {}
        kind = b.get("kind", cur.get("kind"))
        if kind not in ("result", "pwhat", "judged"):
            raise ValueError("Choose whether this is scored from results or judged by the players.")
        source = b.get("source", cur.get("source")) if kind == "result" else ("race" if kind == "pwhat" else None)
        if kind == "result" and source not in SOURCES:
            raise ValueError("Choose which result this prediction is scored against.")
        position = None
        if kind == "result":
            try:
                position = int(b.get("position", cur.get("position")) or 1)
            except (TypeError, ValueError):
                raise ValueError("The position has to be a whole number, like 3 for P3.")
            if not 1 <= position <= GRID_SIZE:
                raise ValueError("The position has to be between 1 and %d." % GRID_SIZE)
        label = str(b.get("label", cur.get("label")) or "").strip()[:40]
        if not label:
            label = SOURCES[source][2] if kind == "result" and position == 1 else (
                "P%d" % position if source == "race" else "%s P%d" % (SOURCES[source][1], position)) if kind == "result" else ""
        if not label:
            raise ValueError("Give the prediction type a name.")
        applies = b.get("applies", cur.get("applies")) or ("sprint" if source in SPRINT_SOURCES else "all")
        if applies not in ("all", "sprint"):
            applies = "all"
        exact = number(b.get("exact_points", cur.get("exact_points", 1)), "Points for an exact pick", 1)
        close = 0 if kind == "judged" else number(b.get("close_points", cur.get("close_points", 0)), "Points for the closest pick")
        unique = 1 if b.get("unique_picks", cur.get("unique_picks", 0)) in (True, 1, "1", "true", "on") else 0
        return dict(label=label, kind=kind, source=source, position=position, exact_points=exact,
                    close_points=close, unique_picks=unique, applies=applies)

    @app.route("/api/categories", methods=["POST"])
    def add_category():
        b = request.get_json(force=True)
        try:
            f = category_fields(b)
        except ValueError as e:
            return fail(str(e))
        if f["kind"] == "pwhat" and con().execute("SELECT 1 FROM categories WHERE kind='pwhat'").fetchone():
            return fail("There's already a PWhat type. Its position is rolled once each weekend.")
        if con().execute("SELECT 1 FROM categories WHERE lower(label)=lower(?)", (f["label"],)).fetchone():
            return fail("There's already a prediction type called %s." % f["label"], 409)
        base = re.sub(r"[^a-z0-9]+", "_", f["label"].lower()).strip("_") or "type"
        key, n = base, 2
        while con().execute("SELECT 1 FROM categories WHERE key=?", (key,)).fetchone():
            key, n = "%s_%d" % (base, n), n + 1
        pos = con().execute("SELECT COALESCE(MAX(pos), -1) + 1 FROM categories").fetchone()[0]
        con().execute("""INSERT INTO categories(key, label, kind, source, position, exact_points, close_points,
                         unique_picks, applies, pos) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                      (key, f["label"], f["kind"], f["source"], f["position"], f["exact_points"], f["close_points"],
                       f["unique_picks"], f["applies"], pos))
        con().commit()
        return jsonify({"ok": True, "key": key})

    @app.route("/api/categories/<int:cid>", methods=["PUT", "DELETE"])
    def edit_category(cid):
        cur = con().execute("SELECT * FROM categories WHERE id=?", (cid,)).fetchone()
        if not cur:
            return fail("That prediction type doesn't exist any more.", 404)
        if request.method == "DELETE":
            for t in ("picks", "manual"):
                con().execute("DELETE FROM %s WHERE category=?" % t, (cur["key"],))
            con().execute("DELETE FROM categories WHERE id=?", (cid,))
        else:
            try:
                f = category_fields(request.get_json(force=True), dict(cur))
            except ValueError as e:
                return fail(str(e))
            con().execute("""UPDATE categories SET label=?, kind=?, source=?, position=?, exact_points=?,
                             close_points=?, unique_picks=?, applies=? WHERE id=?""",
                          (f["label"], f["kind"], f["source"], f["position"], f["exact_points"], f["close_points"],
                           f["unique_picks"], f["applies"], cid))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/categories/<int:cid>/move", methods=["POST"])
    def move_category(cid):
        order = [r["id"] for r in cats()]
        if cid not in order:
            return fail("That prediction type doesn't exist any more.", 404)
        i = order.index(cid)
        j = i + (1 if request.get_json(force=True).get("dir", 1) > 0 else -1)
        if 0 <= j < len(order):
            order[i], order[j] = order[j], order[i]
            for n, x in enumerate(order):
                con().execute("UPDATE categories SET pos=? WHERE id=?", (n, x))
            con().commit()
        return jsonify({"ok": True})

    # ------------------------------------------------------------------ season questions
    QUESTION_TYPES = ("race", "driver", "team", "player", "text")

    @app.route("/api/season/questions", methods=["POST"])
    def add_question():
        b = request.get_json(force=True)
        label = str(b.get("label") or "").strip()[:120]
        if not label:
            return fail("Type the question first.")
        kind = b.get("answer_type") if b.get("answer_type") in QUESTION_TYPES else "text"
        try:
            pts = number(b.get("points"), "Points", 0.5)
        except ValueError as e:
            return fail(str(e))
        pos = con().execute("SELECT COALESCE(MAX(pos), -1) + 1 FROM season_questions").fetchone()[0]
        con().execute("INSERT INTO season_questions(label, answer_type, points, pos) VALUES (?,?,?,?)", (label, kind, pts, pos))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/season/questions/<int:qid>", methods=["PUT", "DELETE"])
    def edit_question(qid):
        if request.method == "DELETE":
            con().execute("DELETE FROM season_questions WHERE id=?", (qid,))
        else:
            b = request.get_json(force=True)
            if b.get("label"):
                con().execute("UPDATE season_questions SET label=? WHERE id=?", (str(b["label"]).strip()[:120], qid))
            if "points" in b:
                try:
                    con().execute("UPDATE season_questions SET points=? WHERE id=?", (number(b["points"], "Points", 0.5), qid))
                except ValueError as e:
                    return fail(str(e))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/season/answer", methods=["PUT"])
    def season_answer():
        b = request.get_json(force=True)
        if not may_edit_player(b["player_id"]):
            return fail("You can only answer for yourself.", 403)
        con().execute("INSERT OR REPLACE INTO season_answers VALUES (?,?,?)",
                      (int(b["question_id"]), int(b["player_id"]), str(b.get("value") or "").strip()[:120]))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/season/question-answer", methods=["PUT"])
    def season_question_answer():
        b = request.get_json(force=True)
        con().execute("INSERT OR REPLACE INTO season_question_final VALUES (?,?)",
                      (int(b["question_id"]), str(b.get("value") or "").strip()[:120]))
        con().commit()
        return jsonify({"ok": True})

    @app.route("/api/races/full-calendar", methods=["POST"])
    def add_full_calendar():
        try:
            sched = get_schedule()
        except f1api.F1ApiError as e:
            return fail(str(e), 502)
        have = {r["api_round"] for r in races() if r["api_round"]}
        titles = {r["title"].lower() for r in races()}
        added = 0
        for s_ in sched:
            if s_["round"] in have or s_["suggested"].lower() in titles:
                continue
            pos = con().execute("SELECT COALESCE(MAX(pos), -1) + 1 FROM races").fetchone()[0]
            con().execute("""INSERT INTO races(title, flag, is_sprint, api_round, circuit, pos, created_at)
                             VALUES (?,?,?,?,?,?,?)""",
                          (s_["suggested"], s_["flag"], int(s_["is_sprint"]), s_["round"],
                           circuits.BY_API_ID.get(s_.get("circuit_id") or "") or circuits.guess(s_["suggested"]),
                           pos, datetime.now().isoformat()))
            added += 1
        con().commit()
        return jsonify({"added": added})

    # ------------------------------------------------------------------ export
    @app.route("/api/export.csv")
    def export_csv():
        ps, rs = players(), races()
        cs = cats()
        scores = all_scores(ps, rs, cs)
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["Player Name", "Race", "Prediction", "Points", "Round"])
        for r in rs:
            for p in ps:
                for c in categories_for(r, cs):
                    w.writerow([p["name"], r["title"], c["label"], scores[r["id"]][p["id"]][c["key"]], r["round"]])
        return Response(buf.getvalue(), mimetype="text/csv",
                        headers={"Content-Disposition": "attachment; filename=predictions-database.csv"})

    @app.route("/api/backup")
    def backup():
        if not signed_in():
            return fail("Sign in to download a backup.", 401)
        return send_file(app.config["DB_PATH"], as_attachment=True, download_name="pitwall-backup.db")

    return app
