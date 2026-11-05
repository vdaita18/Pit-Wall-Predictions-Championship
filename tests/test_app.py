"""Run with: python -m unittest discover tests"""
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pitwall import f1api  # noqa: E402
from pitwall.app import create_app  # noqa: E402


class PitWallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.c = create_app(os.path.join(self.tmp.name, "t.db")).test_client()
        s = self.c.get("/api/state").get_json()
        self.A, self.V = [p["id"] for p in s["players"]]

    def tearDown(self):
        self.tmp.cleanup()

    def race(self, title="Austin US"):
        return self.c.post("/api/races", json={"title": title}).get_json()["id"]

    def pick(self, rid, pid, cat, value):
        return self.c.put("/api/races/%d/pick" % rid, json={"player_id": pid, "category": cat, "value": value})

    def test_title_parsing_and_sprint(self):
        rid = self.race("Shanghai Sprint 🇨🇳")
        r = self.c.get("/api/races/%d" % rid).get_json()["race"]
        self.assertEqual((r["title"], r["flag"], r["is_sprint"]), ("Shanghai Sprint", "CN", 1))

    def test_duplicate_pick_rejected(self):
        rid = self.race()
        # PWhat and fastest pit stop need different picks; everything else can be shared
        self.assertEqual(self.pick(rid, self.A, "p1", "Norris").status_code, 200)
        self.assertEqual(self.pick(rid, self.V, "p1", "Norris").status_code, 200)
        self.assertEqual(self.pick(rid, self.A, "pwhat", "Gasly").status_code, 200)
        self.assertEqual(self.pick(rid, self.V, "pwhat", "Gasly").status_code, 409)
        self.assertEqual(self.pick(rid, self.A, "fastest_pit", "Norris").status_code, 200)
        self.assertEqual(self.pick(rid, self.V, "fastest_pit", "Norris").status_code, 409)

    def test_empty_picks_score_zero(self):
        rid = self.race()
        sc = self.c.get("/api/races/%d" % rid).get_json()["scores"]
        self.assertEqual(sum(sc[str(self.A)].values()), 0)

    def test_pwhat_rules(self):
        rid = self.race()
        self.c.patch("/api/races/%d" % rid, json={"pwhat": 10})
        order = ["Antonelli", "Leclerc", "Verstappen", "Hamilton", "Norris", "Hadjar", "Piastri",
                 "Russell", "Lawson", "Gasly", "Hulkenberg", "Lindblad"]
        for i, d in enumerate(order):
            self.c.put("/api/races/%d/result" % rid, json={"slot": "P%d" % (i + 1), "value": d})
        self.pick(rid, self.A, "pwhat", "Lawson")      # P9, one away
        self.pick(rid, self.V, "pwhat", "Lindblad")    # P12, two away
        sc = self.c.get("/api/races/%d" % rid).get_json()["scores"]
        self.assertEqual((sc[str(self.A)]["pwhat"], sc[str(self.V)]["pwhat"]), (0.5, 0))
        self.pick(rid, self.V, "pwhat", "Gasly")       # exact
        sc = self.c.get("/api/races/%d" % rid).get_json()["scores"]
        self.assertEqual((sc[str(self.A)]["pwhat"], sc[str(self.V)]["pwhat"]), (0, 1))
        self.pick(rid, self.V, "pwhat", "Hulkenberg")  # P11, also one away: tie
        sc = self.c.get("/api/races/%d" % rid).get_json()["scores"]
        self.assertEqual((sc[str(self.A)]["pwhat"], sc[str(self.V)]["pwhat"]), (0, 0))

    def test_fetch_results_matches_spellings(self):
        s = self.c.get("/api/state").get_json()
        rus = next(d for d in s["drivers"] if d["name"] == "Russell")
        self.c.put("/api/drivers/%d" % rus["id"], json={"name": "Russel", "code": ""})
        rid = self.race()
        res = [{"position": "1", "Driver": {"code": "RUS", "familyName": "Russell"}},
               {"position": "2", "Driver": {"code": "HUL", "familyName": "Hülkenberg"}}]
        with mock.patch.object(f1api, "schedule", return_value=[{"round": 18, "_hay": "austin usa"}]), \
             mock.patch.object(f1api, "get_results", return_value=("US GP", {"race": res, "quali": res, "sprint": []})):
            out = self.c.post("/api/races/%d/fetch-results" % rid).get_json()
        self.assertEqual(out["unmatched"], [])
        results = self.c.get("/api/races/%d" % rid).get_json()["results"]
        self.assertEqual((results["P1"], results["P2"], results["Q1"]), ("Russel", "Hulkenberg", "Russel"))

    def test_rename_driver_updates_history(self):
        rid = self.race()
        self.pick(rid, self.A, "p1", "Perez")
        s = self.c.get("/api/state").get_json()
        per = next(d for d in s["drivers"] if d["name"] == "Perez")
        self.c.put("/api/drivers/%d" % per["id"], json={"name": "Pérez"})
        picks = self.c.get("/api/races/%d" % rid).get_json()["picks"]
        self.assertEqual(picks[0]["value"], "Pérez")

    def test_pole_alone_is_not_results_in(self):
        rid = self.race()
        self.c.put("/api/races/%d/result" % rid, json={"slot": "pole", "value": "Hamilton"})
        r = next(x for x in self.c.get("/api/state").get_json()["races"] if x["id"] == rid)
        self.assertFalse(r["has_results"])
        self.c.put("/api/races/%d/result" % rid, json={"slot": "P1", "value": "Hamilton"})
        r = next(x for x in self.c.get("/api/state").get_json()["races"] if x["id"] == rid)
        self.assertTrue(r["has_results"])

    def test_open_mode_tracks_which_device_changed(self):
        rid = self.race()
        self.c.put("/api/races/%d/pick" % rid, json={"player_id": self.V, "category": "p1", "value": "Norris"},
                   headers={"X-Pitwall-Device": "laptop-1"})
        rev = self.c.get("/api/rev").get_json()
        self.assertEqual((rev["device"], rev["what"]), ("laptop-1", "made a pick for Austin"))

    def test_avatar_and_circuit(self):
        self.assertEqual(self.c.put("/api/players/%d" % self.A, json={"tag": "a"}).status_code, 400)
        self.c.put("/api/players/%d" % self.A, json={"car_style": "retro", "car_number": 44, "tag": "aud"})
        p = next(x for x in self.c.get("/api/state").get_json()["players"] if x["id"] == self.A)
        self.assertEqual((p["car_style"], p["car_number"], p["tag"]), ("retro", 44, "AUD"))
        rid = self.race("Spa-Belgium BE")
        r = next(x for x in self.c.get("/api/state").get_json()["races"] if x["id"] == rid)
        self.assertEqual(r["circuit"], "be-1925")

    def _ids(self):
        st = self.c.get("/api/state").get_json()
        return {t["name"]: t["id"] for t in st["teams"]}

    def test_lineup_change_applies_only_to_its_rounds(self):
        teams = self._ids()
        r1, r2, r3 = self.race("Melbourne AU"), self.race("Shanghai CN"), self.race("Suzuka JP")
        ok = self.c.post("/api/lineup", json={"team_id": teams["Red Bull"], "out_driver": "Hadjar",
                                              "in_driver": "Lawson", "from_round": 2, "to_round": 2})
        self.assertEqual(ok.status_code, 200)
        ok = self.c.post("/api/lineup", json={"team_id": teams["Racing Bulls"], "out_driver": "Lawson",
                                              "in_driver": "Tsunoda", "code": "tsu", "from_round": 2, "to_round": 2})
        self.assertEqual(ok.status_code, 200)
        names = lambda rid: [(d["name"], d["team"]) for d in self.c.get("/api/races/%d" % rid).get_json()["lineup"]]
        self.assertIn(("Hadjar", "Red Bull"), names(r1))
        self.assertIn(("Lawson", "Red Bull"), names(r2))
        self.assertIn(("Tsunoda", "Racing Bulls"), names(r2))
        self.assertNotIn("Hadjar", [n for n, _ in names(r2)])
        self.assertIn(("Hadjar", "Red Bull"), names(r3))
        self.assertEqual(len(names(r2)), 22)
        tsu = next(d for d in self.c.get("/api/state").get_json()["drivers"] if d["name"] == "Tsunoda")
        self.assertEqual((tsu["team_id"], tsu["code"]), (None, "TSU"))

    def test_wrong_seat_rejected(self):
        teams = self._ids()
        self.race()
        r = self.c.post("/api/lineup", json={"team_id": teams["Haas"], "out_driver": "Norris",
                                             "in_driver": "Hirakawa", "from_round": 1})
        self.assertEqual(r.status_code, 400)

    def test_get_results_spots_replacements(self):
        rid = self.race("Mexico MX")
        def row(pos, code, fam, team):
            return {"position": str(pos), "Driver": {"code": code, "familyName": fam}, "Constructor": {"name": team}}
        res = [row(1, "VER", "Verstappen", "Red Bull"), row(2, "LAW", "Lawson", "Red Bull"),
               row(3, "TSU", "Tsunoda", "RB F1 Team"), row(4, "LIN", "Lindblad", "RB F1 Team"),
               row(5, "HIR", "Hirakawa", "Haas F1 Team"), row(6, "BEA", "Bearman", "Haas F1 Team"),
               row(7, "HUL", "Hülkenberg", "Kick Sauber"), row(8, "BOR", "Bortoleto", "Audi")]
        with mock.patch.object(f1api, "schedule", return_value=[{"round": 19, "_hay": "mexico"}]), \
             mock.patch.object(f1api, "get_results", return_value=("Mexico GP", {"race": res, "quali": res, "sprint": []})):
            out = self.c.post("/api/races/%d/fetch-results" % rid).get_json()
        got = sorted((s["team"], s["out_driver"], s["in_driver"], s["new_driver"]) for s in out["suggestions"])
        self.assertEqual(got, [("Haas", "Ocon", "Hirakawa", True), ("Racing Bulls", "Lawson", "Tsunoda", True),
                               ("Red Bull", "Hadjar", "Lawson", False)])
        self.assertEqual(out["unmatched"], [])

    def test_fastest_lap_closest_and_custom_type(self):
        rid = self.race()
        for i, d in enumerate(["Norris", "Piastri", "Russell", "Leclerc"]):
            self.c.put("/api/races/%d/result" % rid, json={"slot": "FL%d" % (i + 1), "value": d})
        self.pick(rid, self.A, "fastest_lap", "Piastri")   # 2nd fastest
        self.pick(rid, self.V, "fastest_lap", "Leclerc")   # 4th fastest
        sc = self.c.get("/api/races/%d" % rid).get_json()["scores"]
        self.assertEqual((sc[str(self.A)]["fastest_lap"], sc[str(self.V)]["fastest_lap"]), (0.5, 0))
        # a player-made type: qualifying P2, 1 exact / 0.25 closest
        r = self.c.post("/api/categories", json={"kind": "result", "source": "quali", "position": 2,
                                                 "exact_points": 1, "close_points": 0.25})
        self.assertEqual(r.status_code, 200)
        key = r.get_json()["key"]
        d = self.c.get("/api/races/%d" % rid).get_json()
        self.assertIn(key, [c["key"] for c in d["categories"]])
        self.assertIn("Q2", d["slots"])
        self.c.put("/api/races/%d/result" % rid, json={"slot": "Q2", "value": "Hamilton"})
        self.pick(rid, self.A, key, "Hamilton")
        self.assertEqual(self.c.get("/api/races/%d" % rid).get_json()["scores"][str(self.A)][key], 1)
        st = self.c.get("/api/state").get_json()
        self.assertIn(key, [c["key"] for c in st["stats"]["categories"]])
        # a judged type
        r = self.c.post("/api/categories", json={"kind": "judged", "label": "Driver of the day", "exact_points": 0.5})
        jkey = r.get_json()["key"]
        self.c.put("/api/races/%d/manual" % rid, json={"player_id": self.V, "category": jkey, "points": 1})
        self.assertEqual(self.c.get("/api/races/%d" % rid).get_json()["scores"][str(self.V)][jkey], 0.5)

    def test_three_players(self):
        self.c.post("/api/players", json={"name": "Sam"})
        ps = self.c.get("/api/state").get_json()["players"]
        self.assertEqual(len(ps), 3)
        rid = self.race()
        self.c.put("/api/races/%d/result" % rid, json={"slot": "P1", "value": "Norris"})
        for p in ps:
            self.pick(rid, p["id"], "p1", "Norris")
        sc = self.c.get("/api/races/%d" % rid).get_json()["scores"]
        self.assertEqual([sc[str(p["id"])]["p1"] for p in ps], [1, 1, 1])

    def test_three_players_closest_rule(self):
        for n in ("Sam", "Kit"):
            self.c.post("/api/players", json={"name": n})
        a, b, c, d = [p["id"] for p in self.c.get("/api/state").get_json()["players"]]
        rid = self.race()
        for i, drv in enumerate(["Norris", "Piastri", "Russell", "Leclerc", "Hamilton"]):
            self.c.put("/api/races/%d/result" % rid, json={"slot": "FL%d" % (i + 1), "value": drv})
        score = lambda: [self.c.get("/api/races/%d" % rid).get_json()["scores"][str(p)]["fastest_lap"] for p in (a, b, c, d)]
        # exact gets 2, the next closest gets 1
        for p, drv in ((a, "Norris"), (b, "Piastri"), (c, "Leclerc"), (d, "Hamilton")):
            self.pick(rid, p, "fastest_lap", drv)
        self.assertEqual(score(), [2, 1, 0, 0])
        # two tied for next closest both get 1
        self.pick(rid, c, "fastest_lap", "Piastri")
        self.assertEqual(score(), [2, 1, 1, 0])
        # nobody exact: the closest gets 1, and a tie for closest gives both 1
        self.pick(rid, a, "fastest_lap", "Russell")
        self.assertEqual(score(), [0, 1, 1, 0])
        self.pick(rid, b, "fastest_lap", "Hamilton")
        self.assertEqual(score(), [0, 0, 1, 0])
        # the 3+ player points can be changed per prediction type
        cat = next(x for x in self.c.get("/api/state").get_json()["categories"] if x["key"] == "fastest_lap")
        self.c.put("/api/categories/%d" % cat["id"], json={"multi_close": 1.5})
        self.assertEqual(score(), [0, 0, 1.5, 0])

    def test_pwhat_rolls_up_to_the_last_car(self):
        rid = self.race()
        seen = {self.c.post("/api/races/%d/roll" % rid).get_json()["pwhat"] for _ in range(400)}
        self.assertEqual((min(seen), max(seen)), (4, 22))
        # a 20-car season rolls 4 to 20 and shows 20 result slots
        for d in self.c.get("/api/state").get_json()["drivers"]:
            if d["name"] in ("Perez", "Bottas"):
                self.c.put("/api/drivers/%d" % d["id"], json={"team_id": None})
        self.assertEqual(self.c.post("/api/races/%d/roll" % rid).get_json()["max"], 20)
        slots = self.c.get("/api/races/%d" % rid).get_json()["slots"]
        self.assertEqual(slots[-1], "P20")

    def test_result_details_notes_and_championship(self):
        rid = self.race("Mexico MX")
        def row(pos, code, fam, grid, text=None, status="Finished", t=None, fl=None):
            r = {"position": str(pos), "positionText": text or str(pos), "grid": str(grid), "status": status,
                 "Driver": {"code": code, "familyName": fam, "driverId": fam.lower()}, "Constructor": {"name": "X"}}
            if t: r["Time"] = {"time": t}
            if fl: r["FastestLap"] = {"rank": fl[0], "lap": "50", "Time": {"time": fl[1]}}
            return r
        res = [row(1, "NOR", "Norris", 3, t="1:40:12.1", fl=("2", "1:20.5")), row(2, "PIA", "Piastri", 1, t="+3.2", fl=("1", "1:20.1")),
               row(3, "VER", "Verstappen", 0, status="+1 Lap"), row(4, "RUS", "Russell", 2, text="R", status="Retired")]
        data = {"race": res, "quali": [], "sprint": [], "fastest_lap": f1api.fastest_lap_order(res),
                "fastest_pit": [{"position": "1", "Driver": res[0]["Driver"], "time": "21.402s"}]}
        with mock.patch.object(f1api, "schedule", return_value=[{"round": 19, "_hay": "mexico"}]), \
             mock.patch.object(f1api, "get_results", return_value=("Mexico GP", data)), \
             mock.patch.object(f1api, "fetch", side_effect=f1api.F1ApiError("offline")):
            self.c.post("/api/races/%d/fetch-results" % rid)
        d = self.c.get("/api/races/%d" % rid).get_json()
        self.assertEqual((d["info"]["P"]["Norris"]["grid"], d["info"]["P"]["Verstappen"]["tag"], d["info"]["P"]["Russell"]["tag"]),
                         (3, "+1 Lap", "DNF"))
        self.assertEqual((d["results"]["FL1"], d["info"]["FL"]["Piastri"]["time"], d["info"]["PS"]["Norris"]["time"]),
                         ("Piastri", "1:20.1", "21.402s"))
        # a penalty note survives fetching the results again
        self.c.put("/api/races/%d/note" % rid, json={"session": "P", "driver": "Norris", "note": "+5s penalty"})
        with mock.patch.object(f1api, "schedule", return_value=[{"round": 19, "_hay": "mexico"}]), \
             mock.patch.object(f1api, "get_results", return_value=("Mexico GP", data)), \
             mock.patch.object(f1api, "fetch", side_effect=f1api.F1ApiError("offline")):
            self.c.post("/api/races/%d/fetch-results" % rid)
        self.assertEqual(self.c.get("/api/races/%d" % rid).get_json()["info"]["P"]["Norris"]["note"], "+5s penalty")
        # with the results service offline, championship points are worked out from the results (the DNF scores nothing)
        st = self.c.get("/api/state").get_json()
        pts = {x["driver"]: x["points"] for x in st["driver_standings"]}
        self.assertEqual((pts["Norris"], pts["Piastri"], pts["Verstappen"], pts["Russell"]), (25, 18, 15, 0))
        self.assertIn("Worked out from your results", st["standings_note"])
        # official standings win when the service answers
        official = (19, [{"position": "1", "points": "331", "wins": "7", "Driver": {"code": "NOR", "familyName": "Norris"}}])
        with mock.patch.object(f1api, "driver_standings", return_value=official):
            out = self.c.post("/api/standings/update").get_json()
        self.assertEqual(out["message"], "Official standings after Mexico.")
        st = self.c.get("/api/state").get_json()["driver_standings"]
        self.assertEqual((st[0]["driver"], st[0]["points"]), ("Norris", 331))
        self.c.post("/api/season/final-from-standings")
        self.assertEqual(self.c.get("/api/state").get_json()["season_final"], [{"position": 1, "driver": "Norris"}])

    def test_car_options(self):
        r = self.c.put("/api/players/%d" % self.A, json={"car_style": "rocket", "car_livery": "sash",
                                                         "car_accent": "#ffffff", "car_helmet": "#112233"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.c.put("/api/players/%d" % self.A, json={"car_accent": "red"}).status_code, 400)
        p = next(x for x in self.c.get("/api/state").get_json()["players"] if x["id"] == self.A)
        self.assertEqual((p["car_style"], p["car_livery"], p["car_accent"], p["car_helmet"]), ("rocket", "sash", "#ffffff", "#112233"))

    def test_full_calendar_works_offline(self):
        with mock.patch.object(f1api, "fetch", side_effect=f1api.F1ApiError("offline")):
            out = self.c.post("/api/races/full-calendar").get_json()
        self.assertEqual(out["added"], 23)
        rs = self.c.get("/api/state").get_json()["races"]
        self.assertEqual((rs[15]["title"], rs[15]["circuit"], rs[1]["is_sprint"]), ("Bahrain", "my-1999", 1))

    def test_season_points(self):
        self.c.put("/api/season/pick", json={"player_id": self.A, "position": 1, "value": "Norris"})
        self.c.put("/api/season/final", json={"position": 1, "value": "Norris"})
        st = self.c.get("/api/state").get_json()["standings"]
        self.assertEqual(next(s for s in st if s["player_id"] == self.A)["total"], 0.5)
        q = self.c.get("/api/state").get_json()["season_questions"][0]
        self.c.put("/api/season/answer", json={"question_id": q["id"], "player_id": self.A, "value": "Abu Dhabi"})
        self.c.put("/api/season/answer", json={"question_id": q["id"], "player_id": self.V, "value": "Qatar"})
        self.c.put("/api/season/question-answer", json={"question_id": q["id"], "value": "abu dhabi"})
        st = {s["player_id"]: s["total"] for s in self.c.get("/api/state").get_json()["standings"]}
        self.assertEqual((st[self.A], st[self.V]), (1.0, 0))


class LegacyUpgradeTest(unittest.TestCase):
    def test_season_in_progress_keeps_its_rules(self):
        import sqlite3
        tmp = tempfile.TemporaryDirectory()
        path = os.path.join(tmp.name, "old.db")
        create_app(path)
        c = sqlite3.connect(path)   # make it look like a database from the first version
        for t in ("categories", "season_questions"):
            c.execute("DELETE FROM %s" % t)
        c.execute("DELETE FROM settings WHERE key='season_position_points'")
        c.execute("INSERT INTO races(title, pos) VALUES ('Melbourne', 0)")
        c.execute("INSERT INTO picks VALUES (1, 1, 'pwhat', 'Gasly')")
        c.execute("INSERT INTO results VALUES (1, 'pole', 'Norris')")
        c.commit(); c.close()
        cl = create_app(path).test_client()
        st = cl.get("/api/state").get_json()
        pw = next(x for x in st["categories"] if x["key"] == "pwhat")
        self.assertEqual((pw["exact_points"], pw["close_points"], st["season_position_points"]), (2, 1, 2))
        self.assertNotIn("fastest_lap", [x["key"] for x in st["categories"]])
        self.assertEqual(cl.get("/api/races/1").get_json()["results"].get("Q1"), "Norris")
        tmp.cleanup()


class SharedPlayTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        with mock.patch.dict(os.environ, {"PITWALL_PASSCODE": "boxbox"}):
            self.app = create_app(os.path.join(self.tmp.name, "t.db"))
        self.a = self.app.test_client()
        self.v = self.app.test_client()
        s = self.a.get("/api/state").get_json()
        self.A, self.V = [p["id"] for p in s["players"]]

    def tearDown(self):
        self.tmp.cleanup()

    def test_viewers_can_read_but_not_write(self):
        self.assertEqual(self.a.get("/api/state").status_code, 200)
        self.assertEqual(self.a.post("/api/races", json={"title": "Mexico"}).status_code, 401)
        self.assertEqual(self.a.get("/api/backup").status_code, 401)

    def test_wrong_passcode(self):
        r = self.a.post("/api/login", json={"passcode": "nope", "player_id": self.A})
        self.assertEqual(r.status_code, 403)

    def test_each_player_edits_only_their_own_picks_and_sees_changes(self):
        self.a.post("/api/login", json={"passcode": "boxbox", "player_id": self.A})
        self.v.post("/api/login", json={"passcode": "boxbox", "player_id": self.V})
        rid = self.a.post("/api/races", json={"title": "Mexico MX"}).get_json()["id"]
        rev = self.v.get("/api/rev").get_json()
        self.assertEqual((rev["by"], rev["what"]), ("Player 1", "added a race"))
        ok = self.a.put("/api/races/%d/pick" % rid, json={"player_id": self.A, "category": "p1", "value": "Norris"})
        self.assertEqual(ok.status_code, 200)
        self.assertTrue(ok.headers.get("X-Pitwall-Rev"))
        bad = self.a.put("/api/races/%d/pick" % rid, json={"player_id": self.V, "category": "p1", "value": "Piastri"})
        self.assertEqual(bad.status_code, 403)
        rev = self.v.get("/api/rev").get_json()
        self.assertEqual(rev["what"], "made a pick for Mexico")
        picks = self.v.get("/api/races/%d" % rid).get_json()["picks"]
        self.assertEqual([(p["player_id"], p["value"]) for p in picks], [(self.A, "Norris")])
        # results can be entered by either player
        r = self.v.put("/api/races/%d/result" % rid, json={"slot": "P1", "value": "Norris"})
        self.assertEqual(r.status_code, 200)


if __name__ == "__main__":
    unittest.main()
