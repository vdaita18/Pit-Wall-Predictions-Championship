# Pit Wall — F1 Predictions Championship

Run your own F1 predictions championship with your friends. Every race weekend, each player predicts pole, the podium, a randomly rolled "PWhat" position and anything else you add. Pit Wall scores it, keeps the standings and shows charts, player cards and a season replay race.

Each group runs its own copy, so your championship, players and rules are yours alone.

---

## Get your own championship online (free, about 15 minutes)

You'll put your copy on [PythonAnywhere](https://www.pythonanywhere.com), a free host for Python websites. Then send the link to your group: anyone with it can make picks and enter results from their phone or laptop, and everyone's screen updates within a few seconds.

1. **Make an account.** Sign up for a free **Beginner** account at pythonanywhere.com. Your username becomes your site address: `yourname.pythonanywhere.com`.

2. **Copy the code.** Open **Consoles → Bash** and run:
   ```
   git clone https://github.com/vdaita18/Pit-Wall-Predictions-Championship.git pitwall
   ```

3. **Create the website.** On the **Web** tab, click **Add a new web app → Next → Manual configuration →** the newest Python version **→ Next**.

4. **Point it at Pit Wall.** Still on the Web tab, click the **WSGI configuration file** link. Delete everything in that file and paste these four lines, with your username in place of `yourname`. Keep the lines flush left with no spaces in front, then click **Save**.
   ```python
   import sys
   sys.path.insert(0, "/home/yourname/pitwall")
   from pitwall.app import create_app
   application = create_app()
   ```

5. **Static files.** Back on the Web tab, under **Static files**, enter URL `/static/` and directory `/home/yourname/pitwall/pitwall/static`.

6. **Go live.** Turn on **Force HTTPS**, click the green **Reload** button at the top, and open `https://yourname.pythonanywhere.com`.

7. **Set it up.** On **Grid & players**, rename the players and add more if you like. On **Calendar**, click **Add the whole season**. Then send the link to your group.

### Get updates

When new features are added here, open **Consoles → Bash** and run:
```
cd ~/pitwall && git pull
```
Then click **Reload** on the Web tab. Your championship data is never touched by an update, because it lives in `data/`, which isn't part of the repository.

### Free-account notes

- Free accounts can only reach an approved list of websites. If **Get results** says it can't reach the results service, type the results in by hand (it takes a minute), ask PythonAnywhere support to allow `api.jolpi.ca`, or upgrade to the $5/month plan. The season calendar is built in, so **Add the whole season** always works.
- Every three months, log in and click **Run until 3 months from today** on the Web tab, or the site pauses. PythonAnywhere emails a reminder first.
- Now and then, download a backup from **Grid & players → Download backup**.

### Optional: require a passcode

By default there's no sign-in. To lock editing, add these two lines at the top of the WSGI file and click **Reload**:
```python
import os
os.environ["PITWALL_PASSCODE"] = "pick-a-passcode"
```
Anyone can still view the site, but making changes needs the passcode, and each player can change only their own picks.

---

## Or run it on your own computer

You need Python 3.9 or newer.

- **Windows:** double-click `start-windows.bat`.
- **Mac:** double-click `start-mac.command`. The first time, right-click it and choose **Open**.
- **Any system, from a terminal:**
  ```
  pip install -r requirements.txt
  python run.py
  ```

Your browser opens at http://localhost:5000. Keep the terminal window open while you play.

---

## What's where

| Page | What you do there |
|---|---|
| **Standings** | The championship battle, who's up next and who picks first, and each player's weekend-by-weekend form. |
| **Calendar** | Add the whole season in one click, or add races one at a time. |
| **This weekend** | The circuit map, picks, the PWhat roll, judged points with the **+** button, and results. Lights out runs once everyone has made their Crazy Prediction. **Get results** fills in the results with a last-to-first reveal, showing places gained or lost from the grid, DNF/DNS/DSQ and laps down, race gaps, and fastest lap and pit stop times. Add a note to any finisher, like a 5-second penalty. |
| **Analytics** | Championship race, points per weekend, a prediction-profile radar, category strength and head-to-head records. |
| **Season replay** | Watch the season as a race: one lap per weekend, on a track you choose. Build your car in the garage: six car shapes, five liveries, accent and helmet colors, number and tag. |
| **Player cards** | A season card for each player. |
| **Season picks** | Predict the final drivers' championship and answer season questions. Shows every driver's championship points so far, and picks score against them, so after the last race they are the final result. **Update championship points** refreshes them, and Get results does it automatically. Reserve drivers who score are listed underneath instead of taking a place. |
| **Prediction types** | Change the scoring, or add and remove prediction types. |
| **Grid & players** | Players, teams, drivers, line-up changes, the season year and backups. |

## Make it your own

**Prediction types** lists every prediction made each weekend. Change any type's points, rename, reorder or delete it, or add your own:

- **From the official results:** a race finish, qualifying, sprint, sprint qualifying, fastest lap or fastest pit stop position. Get results fills these in automatically.
- **Judged by the players:** discussion picks like Good Surprise or Big Flop. Players award the points with the **+** button.
- **PWhat:** a race position rolled fresh each weekend.

Each type has points for an exact pick, points for the closest pick when nobody is exact (a tie for closest scores nothing), whether players must all pick different drivers, and whether it runs every weekend or only on sprint weekends.

With three or more players, types that score a closest pick work differently: an exact pick scores 2, and the next closest pick scores 1. If nobody is exact, the closest pick scores 1. Players tied for closest all score. Both numbers can be changed for each type.

**Season picks** has the final-standings prediction, with points per correct position, plus season questions. "Which race will the world champion be crowned at?" is included, and you can add your own, answered with a race, driver, team, player or anything typed.

**Players:** add as many as you like. First pick rotates through everyone in order.

**Line-up changes:** when a driver is injured or replaced, open that weekend and click **Line-up change**. Each weekend's dropdowns show exactly who raced it, and earlier weekends stay untouched. **Get results** also spots changes in the official entry list and offers to add them.

## Default rules

- Pole, P1, P2, P3, Sprint Pole and Sprint P1: 1 point for the exact driver.
- PWhat, fastest lap and fastest pit stop: 1 point for exact, 0.5 for the single closest pick. With 3+ players: 2 for exact, 1 for the next closest.
- PWhat rolls a position from P4 to the last car on that weekend's grid (P22 with 22 cars, P20 with 20).
- Final drivers' championship: 0.5 per correct position. The champion question: 0.5.
- Only PWhat and fastest pit stop need everyone to pick a different driver.
- Good Surprise, Big Flop and the Crazy Prediction are judged by the players.

Change any of it on **Prediction types** and **Season picks**.

## Start a new season

Set the year on **Grid & players**, then click **Calendar → Add the whole season**. To wipe everything and start over, delete `data/pitwall.db` (on PythonAnywhere: `rm ~/pitwall/data/pitwall.db`, then **Reload**). A fresh one is created with the default rules.

## Your data

Everything lives in one file, `data/pitwall.db`. Back it up from **Grid & players → Download backup**, or export every prediction as a CSV. To move a championship to another copy, upload a backup over `data/pitwall.db` and reload.

Results come from the free [Jolpica F1 API](https://github.com/jolpica/jolpica-f1) and usually appear a little while after each session. Sprint pole and time penalties aren't published there, so enter those yourself. Pit stop times cover the whole trip through the pit lane. When the results service can't be reached, championship points are worked out from the results entered in Pit Wall, so they're only complete if every race and sprint finishing order is in.

## Where the code is

| File | What it does |
|---|---|
| `run.py` / `wsgi.py` | Start the app on your computer / on a web host |
| `pitwall/app.py` | The server: every page's data, saving, line-ups, Get results, sharing |
| `pitwall/scoring.py` | Scoring rules, PWhat, standings and analytics |
| `pitwall/f1api.py` | Talks to the results service and matches driver names |
| `pitwall/db.py` | The database layout and the starting 2026 grid |
| `pitwall/circuits.py` | Which circuit outline goes with which race |
| `pitwall/seasons/` | Built-in season calendars, used when the results service can't be reached |
| `pitwall/templates/index.html` | The page shell and navigation |
| `pitwall/static/app.js` | Every screen and button in the browser |
| `pitwall/static/fx.js` | PWhat reel, lights out, results reveal, champagne and rain |
| `pitwall/static/replay.js` | Season replay and the garage |
| `pitwall/static/style.css` | All the styling |
| `tests/test_app.py` | Automatic checks: `python -m unittest discover tests` |

## Credits

Results from [Jolpica F1](https://github.com/jolpica/jolpica-f1). Circuit outlines from [bacinger/f1-circuits](https://github.com/bacinger/f1-circuits) (MIT). Charts by [Chart.js](https://www.chartjs.org) (MIT). Fonts: Barlow Condensed and Titillium Web (SIL Open Font License). Their licenses are in `pitwall/static/vendor` and `pitwall/static/fonts`.

Pit Wall is a fan project and isn't affiliated with Formula 1.
