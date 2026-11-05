"""Official results from the Jolpica F1 API (the Ergast successor)."""
import json
import os
import re
import unicodedata
import urllib.error
import urllib.request

BASE = "https://api.jolpi.ca/ergast/f1/"

COUNTRY_CODES = {
    "australia": "AU", "china": "CN", "japan": "JP", "usa": "US", "united states": "US",
    "canada": "CA", "monaco": "MC", "spain": "ES", "austria": "AT", "uk": "GB",
    "united kingdom": "GB", "belgium": "BE", "hungary": "HU", "netherlands": "NL",
    "italy": "IT", "azerbaijan": "AZ", "bahrain": "BH", "malaysia": "MY", "singapore": "SG",
    "mexico": "MX", "brazil": "BR", "qatar": "QA", "uae": "AE", "saudi arabia": "SA",
}


class F1ApiError(Exception):
    pass


def fetch(path):
    url = BASE + path + ("" if "?" in path else "?limit=100")
    req = urllib.request.Request(url, headers={"User-Agent": "PitWall predictions app"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))["MRData"]
    except urllib.error.HTTPError as e:
        raise F1ApiError("The results service answered with an error (%s). Try again in a minute." % e.code)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise F1ApiError("Couldn't reach the results service. Check your internet connection and try again.")


def races_of(mr):
    return (mr or {}).get("RaceTable", {}).get("Races", [])


def normalize(s):
    s = unicodedata.normalize("NFD", str(s or ""))
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn").lower().strip()


SEASONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seasons")


def schedule(season):
    """The official calendar. Falls back to a calendar bundled in pitwall/seasons/ when offline."""
    try:
        return _schedule_online(season)
    except F1ApiError:
        path = os.path.join(SEASONS_DIR, "%s.json" % season)
        if not os.path.exists(path):
            raise
        with open(path, encoding="utf-8") as f:
            return [dict(r, _hay=normalize(" ".join([r["name"], r["locality"], r["country"]]))) for r in json.load(f)]


def _schedule_online(season):
    out = []
    for r in races_of(fetch("%s.json" % season)):
        loc = r["Circuit"]["Location"]
        sprint = "Sprint" in r
        out.append({
            "round": int(r["round"]), "name": r["raceName"], "date": r.get("date"),
            "locality": loc.get("locality"), "country": loc.get("country"),
            "flag": COUNTRY_CODES.get(normalize(loc.get("country")), ""),
            "circuit_id": r["Circuit"].get("circuitId"),
            "is_sprint": sprint,
            "suggested": (loc.get("locality") or r["raceName"]) + (" Sprint" if sprint else ""),
            "_hay": normalize(" ".join([r["raceName"], r["Circuit"]["circuitName"],
                                        loc.get("locality", ""), loc.get("country", "")])),
        })
    return out


def match_round(sched, title, fallback_index=None):
    """Match a race title like 'Spa-Belgium' or 'Mexico Sprint' to an official round."""
    tokens = [t for t in re.split(r"[^a-z]+", normalize(re.sub("sprint", "", title, flags=re.I))) if len(t) >= 3]
    best, best_score, tie = None, 0, False
    for r in sched:
        words = re.split(r"[^a-z]+", r["_hay"])
        score = sum(1 for t in tokens if t in words)
        if score > best_score:
            best, best_score, tie = r["round"], score, False
        elif score and score == best_score:
            tie = True
    if best_score and not tie:
        return best
    return fallback_index


def levenshtein(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


class DriverMatcher:
    """Maps API drivers (code + family name) onto the names on your grid."""

    def __init__(self, drivers):
        self.drivers = [dict(d) for d in drivers]
        self.learned = {}      # driver id -> code
        self.unmatched = []

    def name_for(self, drv):
        if not drv:
            return "----"
        code = (drv.get("code") or "").upper()
        fam = normalize(drv.get("familyName"))
        hit = next((d for d in self.drivers if code and (d["code"] or "").upper() == code), None)
        hit = hit or next((d for d in self.drivers if normalize(d["name"]) == fam), None)
        hit = hit or next((d for d in self.drivers
                           if len(normalize(d["name"])) >= 5 and levenshtein(normalize(d["name"]), fam) <= 1), None)
        if hit:
            if code and not hit["code"]:
                hit["code"] = code
                self.learned[hit["id"]] = code
            return hit["name"]
        label = "%s (%s)" % (drv.get("familyName"), code) if code else drv.get("familyName")
        if label not in self.unmatched:
            self.unmatched.append(label)
        return drv.get("familyName")


def by_position(rows, pos):
    for r in rows:
        if int(r.get("position", 0)) == pos:
            return r["Driver"]
    return None


def get_results(season, rnd, is_sprint):
    """Returns (race name, {'quali': [...], 'race': [...], 'sprint': [...]})"""
    race = races_of(fetch("%s/%s/results.json" % (season, rnd)))
    quali = races_of(fetch("%s/%s/qualifying.json" % (season, rnd)))
    sprint = races_of(fetch("%s/%s/sprint.json" % (season, rnd))) if is_sprint else []
    try:
        pits = races_of(fetch("%s/%s/pitstops.json" % (season, rnd)))
    except F1ApiError:
        pits = []
    name = (race or quali or sprint or [{}])[0].get("raceName")
    rows = race[0]["Results"] if race else []
    return name, {
        "race": rows,
        "quali": quali[0]["QualifyingResults"] if quali else [],
        "sprint": sprint[0]["SprintResults"] if sprint else [],
        "fastest_lap": fastest_lap_order(rows),
        "fastest_pit": fastest_pit_order(rows, pits[0].get("PitStops", []) if pits else []),
    }


def fastest_lap_order(rows):
    """Drivers in fastest-lap order (rank 1 = fastest lap of the race), as result-style rows."""
    ranked = [r for r in rows if (r.get("FastestLap") or {}).get("rank")]
    ranked.sort(key=lambda r: int(r["FastestLap"]["rank"]))
    return [{"position": str(i + 1), "Driver": r["Driver"],
             "time": ((r["FastestLap"].get("Time") or {}).get("time")), "lap": r["FastestLap"].get("lap")}
            for i, r in enumerate(ranked)]


def _seconds(text):
    try:
        parts = str(text).split(":")
        return sum(float(p) * 60 ** (len(parts) - 1 - i) for i, p in enumerate(parts))
    except ValueError:
        return None


def fastest_pit_order(rows, stops):
    """Drivers by their quickest stop. The public data times the whole pit-lane visit, not just the
    stationary time, so this is the quickest pit stop through the pit lane."""
    drivers = {r["Driver"].get("driverId"): r["Driver"] for r in rows}
    best = {}
    for s in stops:
        t = _seconds(s.get("duration"))
        did = s.get("driverId")
        if t is not None and did in drivers and (did not in best or t < best[did]):
            best[did] = t
    order = sorted(best, key=lambda d: best[d])
    return [{"position": str(i + 1), "Driver": drivers[d], "time": "%.3fs" % best[d]} for i, d in enumerate(order)]


# positionText codes for drivers who weren't classified normally
STATUS_TAGS = {"R": "DNF", "D": "DSQ", "W": "DNS", "N": "NC", "E": "EXC", "F": "DNQ"}


def info_of(row, session):
    """Grid slot, a short tag (DNF, DNS, +1 Lap...) and a time for one driver's session."""
    if session in ("FL", "PS"):
        return {"time": row.get("time"), "status": ("Lap %s" % row["lap"]) if row.get("lap") else None}
    if session in ("Q", "SQ"):
        return {"time": row.get("Q3") or row.get("Q2") or row.get("Q1")}
    status = row.get("status") or ""
    tag = STATUS_TAGS.get(row.get("positionText", ""))
    if not tag and status.lower().startswith("did not start"):
        tag = "DNS"
    elif not tag and re.fullmatch(r"\+\d+ Laps?", status):
        tag = status
    elif not tag and status == "Lapped":
        tag = "Lapped"
    grid = row.get("grid")
    return {"grid": int(grid) if str(grid or "").isdigit() else None, "tag": tag,
            "status": status if status and status != "Finished" else None, "time": (row.get("Time") or {}).get("time")}


def driver_standings(season):
    """(round, [{position, points, wins, Driver}]) for the drivers' championship so far."""
    lists = (fetch("%s/driverstandings.json" % season) or {}).get("StandingsTable", {}).get("StandingsLists", [])
    if not lists:
        return None, []
    return int(lists[0].get("round") or 0), lists[0].get("DriverStandings", [])
