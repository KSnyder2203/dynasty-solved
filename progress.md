# Fantasy Portfolio — Progress Log

## What We've Built

### Core App
- Next.js 16 app (single client component, `app/page.js`) running at `http://localhost:3000`
- No extra packages — pure React, SVG, and Sleeper's public API
- Amazon-inspired light theme: white cards, dark navy nav (`#131921`), orange accent (`#FF9900`)

### Authentication & League Loading
- Login with Sleeper username → fetches user_id → loads leagues
- Auto-detects the current NFL season (tries current year first, falls back to prior year)
- Supports single league or All Leagues combined view

### My Roster Tab
- Shows every QB/RB/WR/TE on your dynasty roster(s)
- Displays: Name, Position, Team, Tier badge, WORP, PPG, Total Points
- Filter by position (ALL / QB / RB / WR / TE)
- Filter by tier (Thanos → Cut Candidate)
- Sort by WORP, PPG, Total Points, or Name
- League tag chips on each player when viewing multiple leagues

### League Standings Tab *(single league only)*
- Ranks every team in the league by **Starting Lineup WORP** (not total roster WORP)
- Reads `roster_positions` directly from Sleeper to determine starting slots (QB, RB, WR, TE, FLEX, SUPER_FLEX, REC_FLEX)
- Optimal lineup algorithm: fills positional slots by WORP, FLEX/SUPER_FLEX by PPG
- Lineup format strip at top showing exact starting requirements pulled from league settings
- Click any team to expand their full roster
  - Split into **Starting Lineup** and **Bench** sections
  - Grouped by position: QB → RB → WR → TE, sorted by WORP within each group
- Medal icons (🥇🥈🥉) and colored borders for top 3 teams
- "You" badge highlights your own team

### Top 200 Rankings Tab
- **Table view**: Top 200 players ranked by WORP in the selected league's scoring system
  - Rank number, name, position, team, tier badge, WORP, PPG, Total Points
  - Players on your roster highlighted green
  - All filters and sort options apply
- **Chart view** (toggle button): SVG scatter plot
  - X-axis = position rank by WORP (QB1, RB1, WR1, TE1 all start at 1)
  - Y-axis = WORP score
  - Smooth cubic bezier trend lines, one per position
  - Per-position toggle buttons to show/hide positions
  - Hover tooltips with player name, team, pos rank, tier, WORP, PPG
  - Players on your roster shown with a red ring
  - Axes rescale dynamically when positions are toggled

### Live WORP Computation Engine
- **No static data** — WORP is computed fresh from Sleeper's API for each league
- Fetches all 18 weeks of NFL stats in parallel, applies the league's exact scoring settings (half PPR vs full PPR, custom TD values, etc.)
- **Replacement level detection**: uses `MAX(Kneedle curve elbow, roster-structure anchor)`
  - Roster anchor: `(starters × numTeams)` per position, accounting for FLEX/SFLEX splits
  - Prevents QB replacement level from being set too high (which was compressing the Allen vs Tua gap)
- **QB-specific normalization**: QBs are scaled within their own pool (QB1 = ceiling), then set to 85% of the global ceiling — preserves the within-QB gap while keeping cross-position comparison valid
- **Global normalization**: best player at 17 games = 2.5 WORP
- Minimum 8 games played to qualify
- **Year selector** (2020–2025) in the nav bar, defaults to 2025 (most recent completed season)
- Results cached per `leagueId_year` — switching years after first load is instant

### WORP Tiers
| Tier | WORP | Color |
|---|---|---|
| Thanos | ≥ 2.0 | Purple |
| Elite | ≥ 1.5 | Green |
| Star | ≥ 1.0 | Blue |
| Starter | ≥ 0.5 | Amber |
| Streamer | ≥ 0.0 | Grey |
| Cut Candidate | < 0.0 | Red |

### Position Colors
| Position | Tables | Chart |
|---|---|---|
| QB | Blue | Blue |
| RB | Green | Green |
| WR | Teal | Amazon Yellow (#FF9900) |
| TE | Purple | Purple |

---

## Known Issues / Things to Revisit
- WORP computation takes ~10–15 seconds on first load (18 parallel API calls) — could add a progress bar
- `worp_2024.json` still sits in `/public` but is no longer used — can be deleted
- All Leagues view hides the League Standings tab (by design), but there's no explanation shown to the user
- Superflex QB value could be further tuned — the 85% ceiling is a heuristic, not derived from data
- Players who changed teams mid-season may show wrong current team (Sleeper's player database reflects current team, not the team they played for in the stat year)

---

## Next Steps (Potential)

### High Priority
- [ ] **Trade analyzer** — compare two groups of players by WORP, PPG, age, and tier; output a winner
- [ ] **Age overlay** — show player age on roster and standings views; flag aging curves (RBs over 28, etc.)
- [ ] **Draft grade tool** — score a dynasty rookie draft class by picking players and comparing their projected WORP

### Medium Priority
- [ ] **Historical WORP trends** — sparkline chart per player showing WORP across multiple seasons (already have 2020–2025 data available)
- [ ] **Waiver wire recommendations** — show the best available (unrostered) players in the league by WORP
- [ ] **Roster needs analysis** — identify positional weaknesses on your team vs. league average
- [ ] **Progress bar** during WORP computation instead of just a text message

### Polish
- [ ] Delete unused `public/worp_2024.json`
- [ ] Show a message in the League Standings tab explaining it's hidden in All Leagues mode
- [ ] Mobile responsiveness — the grid tables don't collapse well on small screens
- [ ] Export to CSV or shareable link
