"""Prediction types, scoring rules and season statistics.

Prediction types live in the database (table `categories`), so players can add their own.
Each type is one of:
  result  - filled from race results: a source (race finish, qualifying, sprint, fastest lap, ...)
            and a position (P1, P3, ...). Exact pick scores exact_points; if nobody is exact,
            the single closest pick scores close_points (ties score nothing).
  pwhat   - like `result` on the race finish, but the position is rolled each weekend.
  judged  - a discussion pick (Good Surprise, Big Flop, ...); players award it with +1.
"""

GRID_SIZE = 22
EMPTY = ("", None, "----")

# result source -> (slot prefix, label used in the UI, label for position 1)
SOURCES = {
    "race": ("P", "Race finish", "Race winner"),
    "quali": ("Q", "Qualifying", "Pole position"),
    "sprint": ("S", "Sprint finish", "Sprint winner"),
    "sprint_quali": ("SQ", "Sprint qualifying", "Sprint pole"),
    "fastest_lap": ("FL", "Fastest lap", "Fastest lap"),
    "fastest_pit": ("PS", "Fastest pit stop", "Fastest pit stop"),
}
SPRINT_SOURCES = {"sprint", "sprint_quali"}

# The rules a brand-new season starts with
DEFAULT_CATEGORIES = [
    # key, label, kind, source, position, exact, close, unique, applies
    ("good_surprise", "Good Surprise", "judged", None, None, 1, 0, 0, "all"),
    ("big_flop", "Big Flop", "judged", None, None, 1, 0, 0, "all"),
    ("sprint_pole", "Sprint Pole Position", "result", "sprint_quali", 1, 1, 0, 0, "sprint"),
    ("sprint_p1", "Sprint P1", "result", "sprint", 1, 1, 0, 0, "sprint"),
    ("pole", "Pole Position", "result", "quali", 1, 1, 0, 0, "all"),
    ("p3", "P3", "result", "race", 3, 1, 0, 0, "all"),
    ("p2", "P2", "result", "race", 2, 1, 0, 0, "all"),
    ("p1", "P1", "result", "race", 1, 1, 0, 0, "all"),
    ("fastest_lap", "Fastest Lap", "result", "fastest_lap", 1, 1, 0.5, 0, "all"),
    ("fastest_pit", "Fastest Pit Stop", "result", "fastest_pit", 1, 1, 0.5, 1, "all"),
    ("pwhat", "PWhat", "pwhat", "race", None, 1, 0.5, 1, "all"),
    ("crazy", "1 Crazy Prediction", "judged", None, None, 1, 0, 0, "all"),
]
# Rules the original spreadsheet used, kept for seasons already in progress
LEGACY_CATEGORIES = [
    ("good_surprise", "Good Surprise", "judged", None, None, 1, 0, 1, "all"),
    ("big_flop", "Big Flop", "judged", None, None, 1, 0, 1, "all"),
    ("sprint_pole", "Sprint Pole Position", "result", "sprint_quali", 1, 1, 0, 1, "sprint"),
    ("sprint_p1", "Sprint P1", "result", "sprint", 1, 1, 0, 1, "sprint"),
    ("pole", "Pole Position", "result", "quali", 1, 1, 0, 1, "all"),
    ("p3", "P3", "result", "race", 3, 1, 0, 1, "all"),
    ("p2", "P2", "result", "race", 2, 1, 0, 1, "all"),
    ("p1", "P1", "result", "race", 1, 1, 0, 1, "all"),
    ("pwhat", "PWhat", "pwhat", "race", None, 2, 1, 1, "all"),
    ("crazy", "1 Crazy Prediction", "judged", None, None, 1, 0, 1, "all"),
]


def slot_of(cat, race):
    """The results slot a type is scored against, e.g. 'P3', 'Q1', 'FL1'."""
    if cat["kind"] == "judged":
        return None
    prefix = SOURCES[cat["source"]][0]
    pos = race["pwhat"] if cat["kind"] == "pwhat" else cat["position"]
    return "%s%d" % (prefix, pos) if pos else None


def slot_label(slot):
    for src, (prefix, name, first) in sorted(SOURCES.items(), key=lambda kv: -len(kv[1][0])):
        if slot.startswith(prefix) and slot[len(prefix):].isdigit():
            n = int(slot[len(prefix):])
            if src == "race":
                return "P%d" % n
            return first if n == 1 else "%s P%d" % (name, n)
    return slot


def categories_for(race, cats):
    return [c for c in cats if c["applies"] == "all" or (c["applies"] == "sprint" and race["is_sprint"])]


def result_slots(race, cats):
    """Race finish P1-P22, plus every other result a prediction type needs this weekend."""
    extra = []
    for c in categories_for(race, cats):
        if c["kind"] == "result" and c["source"] != "race":
            s = slot_of(c, race)
            if s and s not in extra:
                extra.append(s)
    return extra + ["P%d" % i for i in range(1, GRID_SIZE + 1)]


def _rank(driver, results, prefix):
    if driver in EMPTY:
        return None
    for i in range(1, GRID_SIZE + 1):
        if results.get("%s%d" % (prefix, i)) == driver:
            return i
    return None


def score_race(race, players, cats, picks, manual, results):
    """Points per player per prediction type.

    picks[(player_id, key)] -> value, manual[(player_id, key)] -> 0/1, results[slot] -> driver
    """
    scores = {p["id"]: {} for p in players}
    for c in categories_for(race, cats):
        key = c["key"]
        for p in players:
            scores[p["id"]][key] = 0
        if c["kind"] == "judged":
            for p in players:
                if manual.get((p["id"], key)):
                    scores[p["id"]][key] = c["exact_points"]
            continue
        slot = slot_of(c, race)
        target = results.get(slot) if slot else None
        if target in EMPTY:
            continue
        prefix = SOURCES[c["source"]][0]
        pos = int(slot[len(prefix):])
        exact = [p["id"] for p in players if picks.get((p["id"], key)) == target]
        for pid in exact:
            scores[pid][key] = c["exact_points"]
        if exact or not c["close_points"]:
            continue
        dist = {}
        for p in players:
            r = _rank(picks.get((p["id"], key)), results, prefix)
            if r is not None:
                dist[p["id"]] = abs(r - pos)
        if dist:
            best = min(dist.values())
            winners = [pid for pid, d in dist.items() if d == best]
            if len(winners) == 1:
                scores[winners[0]][key] = c["close_points"]
    return scores


def same(a, b):
    return str(a or "").strip().lower() == str(b or "").strip().lower() and str(a or "").strip() not in EMPTY


def season_points(players, season_picks, season_final, per_position, questions, answers, finals):
    out = {p["id"]: 0 for p in players}
    for (pid, pos), drv in season_picks.items():
        if pid in out and drv not in EMPTY and season_final.get(pos) == drv:
            out[pid] += per_position
    for q in questions:
        final = finals.get(q["id"])
        if final in EMPTY:
            continue
        for p in players:
            if same(answers.get((q["id"], p["id"])), final):
                out[p["id"]] += q["points"]
    return {k: round(v, 2) for k, v in out.items()}


def build_stats(players, races, race_scores, cats):
    """Everything the dashboard, analytics and player cards need, computed once."""
    ids = [p["id"] for p in players]
    n = len(players)
    per_race, running, totals = [], {pid: [] for pid in ids}, {pid: 0 for pid in ids}
    profile = {pid: {c["key"]: [0, 0] for c in cats} for pid in ids}   # points, attempts
    record = {pid: [0, 0, 0] for pid in ids}
    first = {pid: [0, 0] for pid in ids}
    second = {pid: [0, 0] for pid in ids}

    for idx, race in enumerate(races):
        sc = race_scores[race["id"]]
        pts = {pid: round(sum(sc[pid].values()), 2) for pid in ids}
        per_race.append({"id": race["id"], "title": race["title"], "round": idx + 1,
                         "is_sprint": bool(race["is_sprint"]), "points": pts, "has_results": race["has_results"]})
        for pid in ids:
            totals[pid] = round(totals[pid] + pts[pid], 2)
            running[pid].append(totals[pid])
            if race["has_results"]:
                for key, v in sc[pid].items():
                    if key in profile[pid]:
                        profile[pid][key][0] += v
                        profile[pid][key][1] += 1
        if race["has_results"] and n:
            first_pid = ids[idx % n]
            for pid in ids:
                others = [pts[o] for o in ids if o != pid]
                if others:
                    best_other = max(others)
                    record[pid][0 if pts[pid] > best_other else 1 if pts[pid] < best_other else 2] += 1
                bucket = first if pid == first_pid else second
                bucket[pid][0] += pts[pid]
                bucket[pid][1] += 1

    maxpts = {c["key"]: c["exact_points"] or 1 for c in cats}
    prof_pct = {pid: {k: (round(got / (att * maxpts[k]), 3) if att else None)
                      for k, (got, att) in profile[pid].items()} for pid in ids}
    return {
        "per_race": per_race, "running": running, "totals": totals, "profile": prof_pct, "record": record,
        "first_pick": {pid: (first[pid][0] / first[pid][1] if first[pid][1] else None) for pid in ids},
        "second_pick": {pid: (second[pid][0] / second[pid][1] if second[pid][1] else None) for pid in ids},
        "categories": [{"key": c["key"], "label": c["label"], "max": c["exact_points"]} for c in cats],
    }
