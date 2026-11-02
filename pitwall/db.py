"""SQLite storage for the predictions championship."""
import os
import sqlite3
from datetime import datetime

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, pos INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, pos INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS drivers (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT DEFAULT '',
    team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    sidelined INTEGER DEFAULT 0, pos INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS races (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, flag TEXT DEFAULT '',
    is_sprint INTEGER DEFAULT 0, pwhat INTEGER, api_round INTEGER,
    pos INTEGER NOT NULL, created_at TEXT);
CREATE TABLE IF NOT EXISTS picks (
    race_id INTEGER REFERENCES races(id) ON DELETE CASCADE,
    player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
    category TEXT, value TEXT, PRIMARY KEY (race_id, player_id, category));
CREATE TABLE IF NOT EXISTS manual (
    race_id INTEGER REFERENCES races(id) ON DELETE CASCADE,
    player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
    category TEXT, points INTEGER DEFAULT 0, PRIMARY KEY (race_id, player_id, category));
CREATE TABLE IF NOT EXISTS results (
    race_id INTEGER REFERENCES races(id) ON DELETE CASCADE,
    slot TEXT, driver TEXT, PRIMARY KEY (race_id, slot));
CREATE TABLE IF NOT EXISTS season_picks (
    player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
    position INTEGER, driver TEXT, PRIMARY KEY (player_id, position));
CREATE TABLE IF NOT EXISTS season_final (position INTEGER PRIMARY KEY, driver TEXT);
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, label TEXT NOT NULL,
    kind TEXT NOT NULL,              -- result | pwhat | judged
    source TEXT, position INTEGER,   -- for result types: which result, which place
    exact_points REAL NOT NULL DEFAULT 1, close_points REAL NOT NULL DEFAULT 0,
    unique_picks INTEGER NOT NULL DEFAULT 0, applies TEXT NOT NULL DEFAULT 'all', pos INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS season_questions (
    id INTEGER PRIMARY KEY, label TEXT NOT NULL, answer_type TEXT NOT NULL DEFAULT 'text',
    points REAL NOT NULL DEFAULT 0.5, pos INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS season_answers (
    question_id INTEGER REFERENCES season_questions(id) ON DELETE CASCADE,
    player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
    value TEXT, PRIMARY KEY (question_id, player_id));
CREATE TABLE IF NOT EXISTS season_question_final (
    question_id INTEGER PRIMARY KEY REFERENCES season_questions(id) ON DELETE CASCADE, value TEXT);
CREATE TABLE IF NOT EXISTS lineup_changes (
    id INTEGER PRIMARY KEY, team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    out_driver TEXT NOT NULL, in_driver TEXT NOT NULL, from_round INTEGER NOT NULL, to_round INTEGER);
"""

# 2026 grid, in the order teams appear on the Grid Set-up sheet
TEAMS = [
    ("Red Bull", "#3671C6", [("Verstappen", "VER"), ("Hadjar", "HAD")]),
    ("McLaren", "#FF8000", [("Piastri", "PIA"), ("Norris", "NOR")]),
    ("Ferrari", "#E8002D", [("Leclerc", "LEC"), ("Hamilton", "HAM")]),
    ("Mercedes", "#27F4D2", [("Russell", "RUS"), ("Antonelli", "ANT")]),
    ("Williams", "#64C4FF", [("Albon", "ALB"), ("Sainz", "SAI")]),
    ("Racing Bulls", "#6692FF", [("Lawson", "LAW"), ("Lindblad", "LIN")]),
    ("Haas", "#B6BABD", [("Ocon", "OCO"), ("Bearman", "BEA")]),
    ("Alpine", "#FF87BC", [("Gasly", "GAS"), ("Colapinto", "COL")]),
    ("Audi", "#C0C0C0", [("Hulkenberg", "HUL"), ("Bortoleto", "BOR")]),
    ("Cadillac", "#D4AF37", [("Perez", "PER"), ("Bottas", "BOT")]),
    ("Aston Martin", "#229971", [("Stroll", "STR"), ("Alonso", "ALO")]),
]
PLAYERS = [("Player 1", "#7FCBA4"), ("Player 2", "#E06A6A")]
PLAYER_COLORS = ["#7FCBA4", "#E06A6A", "#6FA8F5", "#F2C230", "#B48CF2", "#F29A4A", "#4FD1C5", "#F27BB5"]


def connect(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


MIGRATIONS = [  # (table, column, definition) added to databases made by earlier versions
    ("players", "car_style", "TEXT DEFAULT 'classic'"),
    ("players", "car_number", "INTEGER"),
    ("players", "tag", "TEXT"),
    ("races", "circuit", "TEXT"),
]


def init(path):
    con = connect(path)
    con.executescript(SCHEMA)
    for table, column, definition in MIGRATIONS:
        have = {r["name"] for r in con.execute("PRAGMA table_info(%s)" % table)}
        if column not in have:
            con.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, definition))
    if not con.execute("SELECT 1 FROM players LIMIT 1").fetchone():
        for i, (name, color) in enumerate(PLAYERS):
            con.execute("INSERT INTO players(name, color, pos) VALUES (?,?,?)", (name, color, i))
        pos = 0
        for t, (team, color, drivers) in enumerate(TEAMS):
            cur = con.execute("INSERT INTO teams(name, color, pos) VALUES (?,?,?)", (team, color, t))
            for name, code in drivers:
                con.execute("INSERT INTO drivers(name, code, team_id, pos) VALUES (?,?,?,?)",
                            (name, code, cur.lastrowid, pos))
                pos += 1
        con.execute("INSERT OR REPLACE INTO settings VALUES ('season', ?)", (str(datetime.now().year),))

    # results slots were renamed when prediction types became customizable
    for old, new in (("pole", "Q1"), ("sprint_p1", "S1"), ("sprint_pole", "SQ1")):
        con.execute("UPDATE OR IGNORE results SET slot=? WHERE slot=?", (new, old))
        con.execute("DELETE FROM results WHERE slot=?", (old,))

    if not con.execute("SELECT 1 FROM categories LIMIT 1").fetchone():
        from .scoring import DEFAULT_CATEGORIES, LEGACY_CATEGORIES
        in_progress = con.execute("SELECT 1 FROM picks LIMIT 1").fetchone() is not None
        # a season already under way keeps the rules it started with, so standings don't move
        for i, c in enumerate(LEGACY_CATEGORIES if in_progress else DEFAULT_CATEGORIES):
            con.execute("""INSERT INTO categories(key, label, kind, source, position, exact_points, close_points,
                           unique_picks, applies, pos) VALUES (?,?,?,?,?,?,?,?,?,?)""", c + (i,))
        con.execute("INSERT OR IGNORE INTO settings VALUES ('season_position_points', ?)", ("2" if in_progress else "0.5",))
        con.execute("INSERT INTO season_questions(label, answer_type, points, pos) VALUES (?,?,?,0)",
                    ("Which race will the world champion be crowned at?", "race", 0.5))
    con.commit()
    con.close()


def setting(con, key, default=None):
    row = con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default
