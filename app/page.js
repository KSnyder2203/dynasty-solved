'use client';

import { useState, useEffect, useCallback } from 'react';

// ─── Constants ────────────────────────────────────────────────────────────────

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";

// Amazon-inspired palette
const C = {
  navBg:    '#131921',
  navText:  '#ffffff',
  orange:   '#FF9900',
  orangeHover: '#e88a00',
  blue:     '#007185',
  pageBg:   '#f3f4f5',
  white:    '#ffffff',
  border:   '#ddd',
  textDark: '#0f1111',
  textMid:  '#565959',
  textLight:'#878787',
  red:      '#c40000',
  green:    '#007600',
};

const POS_COLOR = {
  QB: '#0066c0',  // Amazon blue
  RB: '#007600',  // Amazon green
  WR: '#0891b2',  // teal
  TE: '#6b21a8',  // purple
};

const POS_BG = {
  QB: '#e8f0fe',
  RB: '#e8f5e9',
  WR: '#e0f7fa',
  TE: '#f3e8ff',
};

// Tier config — light theme colors
const TIER_CONFIG = {
  'League Winner':        { color: '#6b21a8', bg: '#f3e8ff', border: '#c084fc' },
  Elite:           { color: '#007600', bg: '#e8f5e9', border: '#86efac' },
  Star:            { color: '#0066c0', bg: '#e8f0fe', border: '#93c5fd' },
  Starter:         { color: '#d97706', bg: '#fffbeb', border: '#fcd34d' },
  Streamer:        { color: '#565959', bg: '#f3f4f5', border: '#d1d5db' },
  'Cut Candidate': { color: '#c40000', bg: '#fff0f0', border: '#fca5a5' },
  Unranked:        { color: '#878787', bg: '#f9fafb', border: '#e5e7eb' },
};

function getTier(worp) {
  if (worp >= 2.0) return 'League Winner';
  if (worp >= 1.5) return 'Elite';
  if (worp >= 1.0) return 'Star';
  if (worp >= 0.5) return 'Starter';
  if (worp >= 0.0) return 'Streamer';
  return 'Cut Candidate';
}

// ─── Name normalisation ───────────────────────────────────────────────────────

function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/['''.,]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Cache ────────────────────────────────────────────────────────────────────

let nflPlayersCache = null;
let worpMapCache = null;
const worpComputedCache = {}; // key: `${leagueId}_${year}` → { worpMap, worpList }
const dynastyValuesCache = {}; // key: `${numQbs}_${ppr}_${numTeams}` → { map, list }
let dynastyMapCurrent = new Map(); // active sleeperId → fc entry
let dynastyListCurrent = [];       // active full sorted list (players + picks)

// ─── FantasyCalc dynasty values ───────────────────────────────────────────────

async function fetchDynastyValues(league) {
  const slots    = parseSlots(league.roster_positions || []);
  const numQbs   = slots.SUPER_FLEX > 0 ? 2 : 1;
  const ppr      = league.scoring_settings?.rec ?? 1;
  const numTeams = league.total_rosters || 12;
  const cacheKey = `${numQbs}_${ppr}_${numTeams}`;

  if (dynastyValuesCache[cacheKey]) return dynastyValuesCache[cacheKey];

  const url  = `https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=${numQbs}&ppr=${ppr}&numTeams=${numTeams}`;
  const data = await fetch(url).then(r => r.json());

  const map    = new Map();
  const list   = [];
  const result = { map, list, pickAvgMap: {} };

  // Build a pick value lookup: "2027_1" → average FC value for that year+round
  const pickValueMap = {}; // key: `${season}_${round}` → [values]
  for (const item of data) {
    const p = item.player || {};
    const pos = p.position || '';
    if (pos === 'PICK' || pos === 'PI') {
      const nameMatch = (p.name || '').match(/(\d{4}).*?(\d+)\./);
      if (nameMatch) {
        const key = `${nameMatch[1]}_${nameMatch[2]}`;
        if (!pickValueMap[key]) pickValueMap[key] = [];
        pickValueMap[key].push(item.value);
      }
    }
  }
  // Average each bucket
  const pickAvgMap = {};
  for (const [key, vals] of Object.entries(pickValueMap)) {
    pickAvgMap[key] = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
  }

  for (const item of data) {
    const p   = item.player || {};
    const pos = p.position || 'UNK';
    const isPick = pos === 'PICK' || pos === 'PI';
    const entry = {
      name:        p.name || '—',
      pos,
      team:        p.maybeTeam || null,
      age:         p.maybeAge  || null,
      sleeper_id:  p.sleeperId || null,
      fc_value:    item.value,
      fc_rank:     item.overallRank,
      fc_pos_rank: item.positionRank,
      fc_trend:    item.trend30Day ?? 0,
      fc_tier:     item.maybeTier  ?? null,
      is_pick:     isPick,
    };
    list.push(entry);
    if (p.sleeperId) map.set(p.sleeperId, entry);
  }

  // Attach the pick avg map for use when enriching roster picks
  result.pickAvgMap = pickAvgMap;

  list.sort((a, b) => b.fc_value - a.fc_value);

  dynastyValuesCache[cacheKey] = result;
  return result;
}

// ─── Live WORP computation ────────────────────────────────────────────────────

// Apply league scoring settings to a single week's raw stats
function computeFantasyPoints(stats, scoring) {
  let pts = 0;
  for (const [key, val] of Object.entries(stats || {})) {
    const mult = scoring[key];
    if (mult && typeof val === 'number') pts += val * mult;
  }
  return pts;
}

// Smooth an array with a rolling window
function rollingAvg(arr, w = 3) {
  return arr.map((_, i) => {
    const s = Math.max(0, i - Math.floor(w / 2));
    const e = Math.min(arr.length, s + w);
    const sl = arr.slice(s, e);
    return sl.reduce((a, v) => a + v, 0) / sl.length;
  });
}

// Kneedle elbow detection on a sorted-descending PPG array.
// Returns the index where the curve "flattens out" — this is the replacement player.
function findReplacementIdx(sortedPpgs) {
  const n = sortedPpgs.length;
  if (n < 4) return n - 1;
  const smooth = rollingAvg(sortedPpgs, 5);
  const min = smooth[n - 1], max = smooth[0], range = max - min || 1;
  let maxDist = -1, idx = Math.floor(n / 3);
  smooth.forEach((v, i) => {
    const x = i / (n - 1);
    const y = (v - min) / range;
    // Distance from the diagonal line connecting (0,1)→(1,0)
    const dist = Math.abs(x + y - 1) / Math.SQRT2;
    if (dist > maxDist) { maxDist = dist; idx = i; }
  });
  // Replacement = a few spots past the elbow (the last reliable starter)
  return Math.min(idx + 2, n - 1);
}

// Given a league's roster_positions and team count, compute how many players
// at each position are "starters" across the whole league — this anchors
// replacement level to actual league structure instead of curve-guessing.
function rosterBasedReplRanks(rosterPositions, numTeams) {
  const slots = parseSlots(rosterPositions);
  // FLEX splits: historical averages across dynasty leagues
  const flexRb = 0.40, flexWr = 0.40, flexTe = 0.20;
  const recFlexWr = 0.65, recFlexTe = 0.35;
  // SUPER_FLEX is usually filled by QB in dynasty — add full weight to QB
  return {
    QB: Math.round((slots.QB + slots.SUPER_FLEX) * numTeams),
    RB: Math.round((slots.RB + slots.FLEX * flexRb) * numTeams),
    WR: Math.round((slots.WR + slots.FLEX * flexWr + slots.REC_FLEX * recFlexWr) * numTeams),
    TE: Math.round((slots.TE + slots.FLEX * flexTe + slots.REC_FLEX * recFlexTe) * numTeams),
  };
}

// Compute WORP for a specific league + year using live Sleeper stats.
// Returns { worpMap: {normalizedName → entry}, worpList: sorted top-200 array }
async function computeLeagueWORP(league, year, playersMap, onProgress) {
  const cacheKey = `${league.league_id}_${year}`;
  if (worpComputedCache[cacheKey]) return worpComputedCache[cacheKey];

  const scoring  = league.scoring_settings || {};
  const numTeams = league.total_rosters || 12;
  const numWeeks = year >= 2021 ? 18 : 17;

  // Replacement ranks from roster structure — more accurate than curve-only
  const rosterReplRanks = rosterBasedReplRanks(league.roster_positions || [], numTeams);

  // Fetch all weeks in parallel
  onProgress(`Fetching ${year} season stats (${numWeeks} weeks)…`);
  const weeklyData = await Promise.all(
    Array.from({ length: numWeeks }, (_, i) =>
      fetch(`https://api.sleeper.app/v1/stats/nfl/regular/${year}/${i + 1}`)
        .then(r => r.json()).catch(() => ({}))
    )
  );

  // Aggregate per player: sum fantasy points and count games played
  onProgress('Aggregating player stats…');
  const agg = {};
  for (const weekStats of weeklyData) {
    for (const [pid, stats] of Object.entries(weekStats || {})) {
      const pts    = computeFantasyPoints(stats, scoring);
      const played = (stats.gp ?? 0) >= 1;
      if (!played) continue;
      if (!agg[pid]) agg[pid] = { pts: 0, gp: 0 };
      agg[pid].pts += pts;
      agg[pid].gp  += 1;
    }
  }

  // Build per-position lists (min 1 game — injured players included, durability handled by gp/17 in formula)
  onProgress('Computing replacement levels…');
  const byPos = { QB: [], RB: [], WR: [], TE: [] };
  for (const [pid, { pts, gp }] of Object.entries(agg)) {
    if (gp < 1) continue;
    const sp = playersMap[pid];
    if (!sp) continue;
    const pos = sp.position;
    if (!byPos[pos]) continue;
    byPos[pos].push({
      player_id: pid,
      name: `${sp.first_name} ${sp.last_name}`,
      pos,
      team: sp.team || 'FA',
      ppg: pts / gp,
      gp,
      total_pts: Math.round(pts),
    });
  }

  // For each position, find replacement level using BOTH roster structure
  // (primary) and curve elbow (secondary) — take the deeper of the two
  // so we never set replacement too high.
  // Replacement level is derived from players with 8+ games (stable sample)
  // but WORP is computed for everyone including injured players.
  const allPlayers = [];
  for (const [pos, players] of Object.entries(byPos)) {
    players.sort((a, b) => b.ppg - a.ppg);
    const healthyPpgs = players.filter(p => p.gp >= 8).map(p => p.ppg);
    const ppgs = healthyPpgs.length >= 4 ? healthyPpgs : players.map(p => p.ppg);

    const curveIdx  = findReplacementIdx(ppgs);
    const rosterIdx = Math.min(rosterReplRanks[pos] ?? curveIdx, players.length - 1);
    // Use whichever goes deeper — ensures Allen vs Tua gap is preserved
    const replIdx   = Math.max(curveIdx, rosterIdx);

    // Average 3 players around the replacement index for stability
    const window  = ppgs.slice(Math.max(0, replIdx - 1), replIdx + 2);
    const replPpg = window.reduce((s, v) => s + v, 0) / window.length;

    players.forEach((p, i) => {
      allPlayers.push({ ...p, repl_ppg: replPpg, ppg_vs_repl: p.ppg - replPpg, pos_rank: i + 1 });
    });
  }

  // Per-position normalization for QBs — QBs are scaled within the QB pool
  // so that the QB1 vs QB2 gap is properly reflected (the global normalization
  // compressed it because top RBs/WRs had larger raw ppg_vs_repl numbers).
  // All other positions use global normalization for cross-position comparison.
  const nonQbMax = Math.max(
    ...allPlayers.filter(p => p.pos !== 'QB').map(p => p.ppg_vs_repl), 0.01
  );
  const qbMax = Math.max(
    ...allPlayers.filter(p => p.pos === 'QB').map(p => p.ppg_vs_repl), 0.01
  );
  // QBs are normalized to their own peak, then scaled to 85% of the global
  // ceiling — elite QBs stay just below elite skill players by design
  const qbScale = (nonQbMax * 0.85) / qbMax;

  allPlayers.forEach(p => {
    const pvr      = p.pos === 'QB' ? p.ppg_vs_repl * qbScale : p.ppg_vs_repl;
    const rawWorp  = pvr / nonQbMax * 2.5 * (p.gp / 17);
    p.worp         = Math.round(rawWorp * 1000) / 1000;
    p.tier_label   = getTier(p.worp);
  });

  const worpMap = {};
  allPlayers.forEach(p => { worpMap[normalizeName(p.name)] = p; });

  const worpList = [...allPlayers]
    .sort((a, b) => b.worp - a.worp)
    .slice(0, 200)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  const result = { worpMap, worpList };
  worpComputedCache[cacheKey] = result;
  return result;
}

// ─── Lineup helpers ───────────────────────────────────────────────────────────

// Parse Sleeper roster_positions into slot counts
function parseSlots(rosterPositions = []) {
  const slots = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, SUPER_FLEX: 0, REC_FLEX: 0 };
  for (const pos of rosterPositions) {
    if (pos in slots) slots[pos]++;
  }
  return slots;
}

// Given a team's players (sorted by worp desc) and slot counts,
// greedily assign the best players to starting spots.
// Returns { starters: [...players], startingWorp: number }
function optimalLineup(players, slots) {
  const ranked = players.filter(p => p.worp !== null).sort((a, b) => b.worp - a.worp);
  const pool = { QB: [], RB: [], WR: [], TE: [] };
  for (const p of ranked) { if (pool[p.pos]) pool[p.pos].push(p); }

  const starters = [];
  const used = new Set();

  const pick = (candidates, n) => {
    let picked = 0;
    for (const p of candidates) {
      if (picked >= n) break;
      if (!used.has(p.player_id)) { starters.push(p); used.add(p.player_id); picked++; }
    }
  };

  // Fill positional slots first
  pick(pool.QB, slots.QB);
  pick(pool.RB, slots.RB);
  pick(pool.WR, slots.WR);
  pick(pool.TE, slots.TE);

  // Flex pools sorted by PPG (not WORP) per user preference
  const byPpg = (a, b) => (b.ppg ?? -99) - (a.ppg ?? -99);
  const flexPool    = () => [...pool.RB, ...pool.WR, ...pool.TE].filter(p => !used.has(p.player_id)).sort(byPpg);
  const recFlexPool = () => [...pool.WR, ...pool.TE].filter(p => !used.has(p.player_id)).sort(byPpg);
  const superPool   = () => [...pool.QB, ...pool.RB, ...pool.WR, ...pool.TE].filter(p => !used.has(p.player_id)).sort(byPpg);

  pick(recFlexPool(), slots.REC_FLEX);
  pick(flexPool(),    slots.FLEX);
  pick(superPool(),   slots.SUPER_FLEX);

  const startingWorp = starters.reduce((s, p) => s + p.worp, 0);
  return { starters, startingWorp };
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Home() {
  const [screen, setScreen] = useState('login');
  const [usernameInput, setUsernameInput] = useState('');
  const [userData, setUserData] = useState(null);
  const [leagues, setLeagues] = useState([]);

  const [rosterPlayers, setRosterPlayers] = useState([]);
  const [leagueStandings, setLeagueStandings] = useState([]);
  const [selectedLeagueIds, setSelectedLeagueIds] = useState([]);
  const [activeLeague, setActiveLeague] = useState(null);  // league used for WORP computation
  const [worpList, setWorpList] = useState([]);
  const [dynastyList, setDynastyList] = useState([]);
  const [worpYear, setWorpYear] = useState(2025);           // year currently computed; 2025 = most recent completed season
  const [tab, setTab] = useState('roster');

  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [error, setError] = useState('');
  const [posFilter, setPosFilter] = useState('ALL');
  const [tierFilter, setTierFilter] = useState('ALL');
  const [sortBy, setSortBy] = useState('worp');

  // ── LOGIN ──────────────────────────────────────────────────────────────────
  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    setLoadingMsg('Looking up Sleeper account…');
    try {
      const uRes = await fetch(`https://api.sleeper.app/v1/user/${usernameInput.trim()}`);
      if (!uRes.ok) throw new Error('User not found. Check your Sleeper username.');
      const user = await uRes.json();
      if (!user?.user_id) throw new Error('User not found.');

      setLoadingMsg('Loading your leagues…');
      // Try current year first — Sleeper creates new leagues well before the season.
      // Fall back to prior year if current year returns nothing.
      const currentYear = new Date().getFullYear();
      let leagueData = null;
      let nflYear = currentYear;
      const r1 = await fetch(`https://api.sleeper.app/v1/user/${user.user_id}/leagues/nfl/${currentYear}`);
      const d1 = await r1.json();
      if (d1 && d1.length > 0) {
        leagueData = d1;
      } else {
        nflYear = currentYear - 1;
        const r2 = await fetch(`https://api.sleeper.app/v1/user/${user.user_id}/leagues/nfl/${nflYear}`);
        leagueData = await r2.json();
      }

      setUserData(user);
      setLeagues(leagueData || []);
      setScreen('dashboard');
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  };

  // ── Core enrichment helper (uses current worpMapCache) ────────────────────
  const enrichPlayers = useCallback((playerIds) => {
    const result = [];
    for (const pid of playerIds) {
      const sp = nflPlayersCache?.[pid];
      if (!sp) continue;
      const pos = sp.position;
      if (!['QB','RB','WR','TE'].includes(pos)) continue;
      const fullName = `${sp.first_name} ${sp.last_name}`;
      const w  = worpMapCache?.[normalizeName(fullName)];
      const fc = dynastyMapCurrent.get(pid);
      result.push({
        player_id: pid,
        name: fullName,
        pos,
        team: sp.team || 'FA',
        worp: w?.worp ?? null,
        tier_label: w ? getTier(w.worp) : 'Unranked',
        ppg: w?.ppg ?? null,
        ppg_vs_repl: w?.ppg_vs_repl ?? null,
        repl_ppg: w?.repl_ppg ?? null,
        pos_rank: w?.pos_rank ?? null,
        gp: w?.gp ?? null,
        total_pts: w?.total_pts ?? null,
        fc_value:    fc?.fc_value    ?? null,
        fc_rank:     fc?.fc_rank     ?? null,
        fc_pos_rank: fc?.fc_pos_rank ?? null,
        fc_trend:    fc?.fc_trend    ?? null,
        fc_age:      fc?.fc_age      ?? null,
      });
    }
    return result.sort((a, b) => (b.worp ?? -99) - (a.worp ?? -99));
  }, []);

  // ── Build standings for a league given current worpMapCache ───────────────
  const buildStandings = useCallback((lid, rosters, users, leagueName, leagueObj, dynMap) => {
    const userMap = {};
    users.forEach(u => { userMap[u.user_id] = u; });
    const slots = parseSlots(leagueObj?.roster_positions || []);
    const totalStartingSlots = slots.QB + slots.RB + slots.WR + slots.TE + slots.FLEX + slots.SUPER_FLEX + slots.REC_FLEX;
    const teams = rosters.map(roster => {
      const u = userMap[roster.owner_id] || {};
      const players = enrichPlayers(roster.players || []);
      const ranked = players.filter(p => p.worp !== null);
      const { starters, startingWorp } = optimalLineup(players, slots);
      // Total FC value: sum all players via dynasty map
      const totalFcValue = (roster.players || []).reduce((sum, pid) => {
        const fc = (dynMap || dynastyMapCurrent).get(pid);
        return sum + (fc?.fc_value ?? 0);
      }, 0);
      return {
        roster_id: roster.roster_id,
        owner_id: roster.owner_id,
        display_name: u.display_name || u.username || `Team ${roster.roster_id}`,
        team_name: u.metadata?.team_name || null,
        is_me: roster.owner_id === userData?.user_id,
        players,
        starters,
        startingWorp,
        totalFcValue,
        slots,
        totalStartingSlots,
        eliteCount: starters.filter(p => ['League Winner','Elite'].includes(p.tier_label)).length,
        cutCount:   ranked.filter(p => p.tier_label === 'Cut Candidate').length,
        playerCount: players.length,
      };
    }).sort((a, b) => b.startingWorp - a.startingWorp).map((t, i) => ({ ...t, rank: i + 1 }));
    return { league_id: lid, league_name: leagueName, teams };
  }, [enrichPlayers, userData]);

  // ── LOAD PORTFOLIO ─────────────────────────────────────────────────────────
  const loadPortfolio = useCallback(async (leagueIds, yearOverride) => {
    setError('');
    setLoading(true);
    setRosterPlayers([]);
    setLeagueStandings([]);

    try {
      // 1. Ensure player database is loaded
      if (!nflPlayersCache) {
        setLoadingMsg('Downloading NFL player database (one-time, ~5MB)…');
        const pRes = await fetch('https://api.sleeper.app/v1/players/nfl');
        nflPlayersCache = await pRes.json();
      }

      // 2. Fetch rosters + FantasyCalc dynasty values concurrently
      setLoadingMsg('Loading roster data & dynasty values…');
      const primaryLeagueObj = leagues.find(l => l.league_id === leagueIds[0]);
      const [leagueDataArr, dynastyMap] = await Promise.all([
        Promise.all(leagueIds.map(async lid => {
          const leagueObj = leagues.find(l => l.league_id === lid);
          const [rostersRes, usersRes, picksRes] = await Promise.all([
            fetch(`https://api.sleeper.app/v1/league/${lid}/rosters`),
            fetch(`https://api.sleeper.app/v1/league/${lid}/users`),
            fetch(`https://api.sleeper.app/v1/league/${lid}/traded_picks`),
          ]);
          return {
            lid,
            leagueObj,
            leagueName: leagueObj?.name || lid,
            rosters: await rostersRes.json(),
            users: await usersRes.json(),
            tradedPicks: await picksRes.json().catch(() => []),
          };
        })),
        fetchDynastyValues(primaryLeagueObj).catch(() => ({ map: new Map(), list: [] })),
      ]);

      // 3. Determine the primary league (first selected) for WORP scoring
      const primaryLeague = leagueDataArr[0]?.leagueObj;
      const targetYear = yearOverride ?? worpYear ?? parseInt(primaryLeague?.season || 2025);

      // 4. Compute WORP for the primary league's scoring settings + target year
      const { worpMap, worpList: computedList } = await computeLeagueWORP(
        primaryLeague, targetYear, nflPlayersCache, setLoadingMsg
      );
      worpMapCache = worpMap;
      dynastyMapCurrent  = dynastyMap.map;
      dynastyListCurrent = dynastyMap.list;
      setDynastyList(dynastyMap.list);
      setWorpList(computedList.map(p => ({ ...p, ...(dynastyMap.map.get(p.player_id) || {}) })));
      setActiveLeague(primaryLeague);
      setWorpYear(targetYear);

      // 5. Collect my player IDs + picks across all leagues
      const myPlayerIds = new Set();
      const playerLeagueMap = {};
      const myPicksArr = [];   // { name, season, round, leagueName, fc entry or null }
      const standingsData = [];

      for (const { lid, leagueObj, leagueName, rosters, users, tradedPicks } of leagueDataArr) {
        const myRoster = rosters.find(r => r.owner_id === userData.user_id);
        if (myRoster) {
          (myRoster.players || []).forEach(pid => {
            myPlayerIds.add(pid);
            if (!playerLeagueMap[pid]) playerLeagueMap[pid] = [];
            playerLeagueMap[pid].push(leagueName);
          });

          // Build complete pick holdings:
          // traded_picks only shows picks that changed hands — un-traded own picks
          // are NOT in that list. We must construct them from league structure.
          const currentYear = new Date().getFullYear();
          const myRosterId  = myRoster.roster_id;
          const allPicks    = tradedPicks || [];

          // Determine how many rounds this league uses (scan traded picks, default 5)
          const roundsInLeague = allPicks.length > 0
            ? Math.max(...allPicks.map(pk => pk.round), 5)
            : 5;
          const futureSeasons = [currentYear + 1, currentYear + 2]; // 2027, 2028

          // Picks traded AWAY from my roster (original mine, now someone else's)
          const tradedAway = new Set(
            allPicks
              .filter(pk => pk.roster_id === myRosterId && pk.owner_id !== myRosterId
                         && parseInt(pk.season) > currentYear)
              .map(pk => `${pk.season}_${pk.round}`)
          );

          // Picks received from other teams (now mine but originally theirs)
          const received = allPicks.filter(pk =>
            pk.owner_id === myRosterId &&
            pk.roster_id !== myRosterId &&
            parseInt(pk.season) > currentYear
          );

          const seenPicks = new Set();

          const addPick = (season, round, label) => {
            const dedupeKey = `${season}_${round}_${label}`;
            if (seenPicks.has(dedupeKey)) return;
            seenPicks.add(dedupeKey);
            const roundLabel = round === 1 ? '1st' : round === 2 ? '2nd' : round === 3 ? '3rd' : `${round}th`;
            const name = `${season} ${roundLabel}${label !== 'own' ? ` (Tm ${label})` : ''}`;
            const fcKey = `${season}_${round}`;
            myPicksArr.push({
              pick_id: `${lid}_${dedupeKey}`,
              name,
              season: String(season),
              round,
              leagueName,
              is_pick:  true,
              pos:      'PICK',
              fc_value: dynastyMap.pickAvgMap?.[fcKey] ?? null,
              fc_rank:  null, fc_pos_rank: null, fc_trend: null,
            });
          };

          // 1. Own picks not traded away
          for (const season of futureSeasons) {
            for (let round = 1; round <= roundsInLeague; round++) {
              if (!tradedAway.has(`${season}_${round}`)) {
                addPick(season, round, 'own');
              }
            }
          }

          // 2. Picks received via trades
          received.forEach(pk => addPick(pk.season, pk.round, pk.roster_id));
        }
        standingsData.push(buildStandings(lid, rosters, users, leagueName, leagueObj, dynastyMap.map));
      }

      // 6. Enrich my roster players
      const myEnriched = enrichPlayers([...myPlayerIds]).map(p => ({
        ...p, leagues: playerLeagueMap[p.player_id] || [],
      }));

      setRosterPlayers([...myEnriched, ...myPicksArr]);
      setLeagueStandings(standingsData);
      setScreen('portfolio');
    } catch (err) {
      setError(err.message || 'Failed to load portfolio.');
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  }, [userData, leagues, enrichPlayers, buildStandings]);

  // ── Re-compute WORP for a different year (roster data stays cached) ────────
  const handleYearChange = (newYear) => {
    if (!selectedLeagueIds.length) return;
    setWorpYear(newYear);
    loadPortfolio(selectedLeagueIds, newYear);
  };

  const handleLeagueSelect = (leagueId) => {
    const ids = leagueId === 'ALL' ? leagues.map(l => l.league_id) : [leagueId];
    setSelectedLeagueIds(ids);
    loadPortfolio(ids);
  };

  // ── Derived data ───────────────────────────────────────────────────────────
  const rankedPlayers = rosterPlayers.filter(p => p.worp !== null && !p.is_pick);
  const myPicks    = rosterPlayers.filter(p => p.is_pick);
  // Rookies = on roster, no WORP (didn't play last season), not a pick
  const myRookies  = rosterPlayers.filter(p => p.worp === null && !p.is_pick).map(p => {
    const sp = nflPlayersCache?.[p.player_id] || {};
    const fc = dynastyMapCurrent.get(p.player_id);
    return {
      ...p,
      years_exp:  sp.years_exp   ?? null,
      college:    sp.college     ?? null,
      age:        sp.age         ?? null,
      depth_order: sp.depth_chart_order ?? null,
      depth_pos:   sp.depth_chart_position ?? null,
      fc_value:   fc?.fc_value   ?? p.fc_value ?? null,
      fc_trend:   fc?.fc_trend   ?? p.fc_trend ?? null,
      fc_rank:    fc?.fc_rank    ?? p.fc_rank  ?? null,
    };
  }).sort((a, b) => (b.fc_value ?? -1) - (a.fc_value ?? -1));

  // My roster — filtered (picks handled separately)
  const filtered = [...rosterPlayers].filter(p => {
    if (p.is_pick) return false;
    if (posFilter !== 'ALL' && p.pos !== posFilter) return false;
    if (tierFilter === 'Rookies') return p.worp === null; // rookies = no WORP
    if (tierFilter !== 'ALL' && p.tier_label !== tierFilter) return false;
    return true;
  }).sort((a, b) => {
    if (sortBy === 'worp') return (b.worp ?? -99) - (a.worp ?? -99);
    if (sortBy === 'ppg')       return (b.ppg       ?? -99) - (a.ppg       ?? -99);
    if (sortBy === 'total_pts') return (b.total_pts ?? -99) - (a.total_pts ?? -99);
    if (sortBy === 'fc_value')  return (b.fc_value  ?? -99) - (a.fc_value  ?? -99);
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    return 0;
  });

  // Top 200 leaderboard — filtered + sorted
  const rosterNameSet = new Set(rosterPlayers.map(p => p.name));
  const filteredTop200 = worpList.filter(p => {
    if (posFilter !== 'ALL' && p.pos !== posFilter) return false;
    if (tierFilter !== 'ALL' && p.tier_label !== tierFilter) return false;
    return true;
  }).sort((a, b) => {
    if (sortBy === 'worp') return b.worp - a.worp;
    if (sortBy === 'ppg')       return b.ppg       - a.ppg;
    if (sortBy === 'total_pts') return (b.total_pts ?? -99) - (a.total_pts ?? -99);
    if (sortBy === 'fc_value')  return (b.fc_value  ?? -99) - (a.fc_value  ?? -99);
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    return 0;
  });

  // Compute optimal starting lineup for WORP stats (use primary league's slots)
  const rosterSlots   = parseSlots(activeLeague?.roster_positions || []);
  const { starters: myStarters } = optimalLineup(rankedPlayers, rosterSlots);
  const starterIds    = new Set(myStarters.map(p => p.player_id));

  // Stats reflect starters only
  const totalWorp   = myStarters.reduce((s, p) => s + p.worp, 0);
  const byPos = ['QB','RB','WR','TE'].map(pos => ({
    pos,
    worp:  myStarters.filter(p => p.pos === pos).reduce((s, p) => s + p.worp, 0),
    count: myStarters.filter(p => p.pos === pos).length,
  }));

  // Tier breakdown still uses full roster so you see your whole asset picture
  const tierPlayers = rankedPlayers;

  const nflYear = leagues[0]?.season || new Date().getFullYear();

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', backgroundColor: C.pageBg, fontFamily: FONT, color: C.textDark }}>

      {/* ── NAV BAR ──────────────────────────────────────────────────────── */}
      <header style={{
        backgroundColor: C.navBg,
        padding: '0 12px',
        display: 'flex',
        alignItems: 'center',
        minHeight: 54,
        gap: 12,
        position: 'sticky',
        top: 0,
        zIndex: 100,
        flexWrap: 'wrap',
      }}>
        {/* Logo */}
        <div
          onClick={() => screen !== 'login' && setScreen('dashboard')}
          style={{ cursor: screen !== 'login' ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <span style={{ fontSize: 22 }}>🏈</span>
          <span style={{ color: C.white, fontWeight: 700, fontSize: 18, letterSpacing: -0.5 }}>
Dynasty<span style={{ color: C.orange }}>Solved</span>
          </span>
        </div>

        {/* Breadcrumb — hidden on mobile */}
        {screen !== 'login' && (
          <div className="hide-mobile" style={{ color: '#ccc', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#aaa' }}>/</span>
            <span>{userData?.display_name || userData?.username}</span>
            {screen === 'portfolio' && (
              <>
                <span style={{ color: '#aaa' }}>/</span>
                <span style={{ color: C.orange }}>Solved</span>
              </>
            )}
          </div>
        )}

        {/* Year selector — shown in portfolio */}
        {screen === 'portfolio' && !loading && worpYear && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 12 }}>
            <span style={{ color: '#6b7280', fontSize: 12 }}>WORP season:</span>
            <select
              value={worpYear}
              onChange={e => handleYearChange(Number(e.target.value))}
              style={{
                padding: '3px 8px',
                backgroundColor: '#1f2937',
                border: '1px solid #374151',
                borderRadius: 4,
                color: C.orange,
                fontFamily: FONT,
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {[2020,2021,2022,2023,2024,2025].map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          {screen === 'portfolio' && (
            <button onClick={() => setScreen('dashboard')} style={navBtn}>
              ← My Leagues
            </button>
          )}
          {screen !== 'login' && (
            <button onClick={() => {
              setScreen('login');
              setUserData(null);
              setLeagues([]);
              setRosterPlayers([]);
              setUsernameInput('');
            }} style={navBtn}>
              Sign Out
            </button>
          )}
        </div>
      </header>

      {/* ── SECONDARY NAV (portfolio only) ───────────────────────────────── */}
      {screen === 'portfolio' && !loading && (
        <div style={{
          backgroundColor: C.white,
          borderBottom: `1px solid ${C.border}`,
          padding: '0 8px',
          minHeight: 44,
        }}>
        <div className="nav-tabs" style={{ display: 'flex', alignItems: 'center' }}>
          {/* Main tabs */}
          {[['roster','My Roster'], ...(selectedLeagueIds.length === 1 ? [['standings','League Power Rankings']] : []), ['worptable','WORP Rankings'], ['top200','WORP Chart'], ['fc','Trade Values']].map(([t, label]) => (
            <button key={t}
              onClick={() => { setTab(t); setPosFilter('ALL'); setTierFilter('ALL'); setSortBy('worp'); }}
              style={{
                padding: '12px 18px', background: 'none', border: 'none',
                borderBottom: tab === t ? `3px solid ${C.orange}` : '3px solid transparent',
                color: tab === t ? C.textDark : C.textMid,
                fontFamily: FONT, fontSize: 14, fontWeight: tab === t ? 700 : 400, cursor: 'pointer', marginRight: 4,
              }}
            >{label}</button>
          ))}

          {/* Filters — shown on roster and worptable tabs */}
          {(tab === 'roster' || tab === 'worptable') && (<>
            <div style={{ width: 1, height: 20, background: C.border, margin: '0 12px' }} />
            {['ALL','QB','RB','WR','TE'].map(pos => (
              <button key={pos} onClick={() => setPosFilter(pos)} style={{
                padding: '10px 12px', background: 'none', border: 'none',
                borderBottom: posFilter === pos ? `3px solid ${C.blue}` : '3px solid transparent',
                color: posFilter === pos ? C.blue : C.textMid,
                fontFamily: FONT, fontSize: 13, fontWeight: posFilter === pos ? 700 : 400, cursor: 'pointer',
              }}>{pos === 'ALL' ? 'All' : pos}</button>
            ))}
            <div style={{ width: 1, height: 20, background: C.border, margin: '0 12px' }} />
            <select value={tierFilter} onChange={e => setTierFilter(e.target.value)}
              style={{ padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 4, fontFamily: FONT, fontSize: 13, color: C.textDark, background: C.white, cursor: 'pointer' }}>
              <option value="ALL">All Tiers</option>
              {Object.keys(TIER_CONFIG).filter(t => t !== 'Unranked').map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
              <option value="Rookies">Rookies</option>
            </select>
            <select value={sortBy} onChange={e => setSortBy(e.target.value)}
              style={{ padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 4, fontFamily: FONT, fontSize: 13, color: C.textDark, background: C.white, cursor: 'pointer', marginLeft: 8 }}>
              <option value="worp">Sort: WORP</option>
              <option value="fc_value">Sort: FC Value</option>
              <option value="ppg">Sort: PPG</option>
              <option value="total_pts">Sort: Total Points</option>
              <option value="name">Sort: Name</option>
            </select>
          </>)}

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
            {tab === 'roster' && (
              <span style={{ color: C.textMid, fontSize: 13 }}>
                {filtered.length} of {rosterPlayers.filter(p => !p.is_pick).length} players
              </span>
            )}
            {(tab === 'worptable' || tab === 'top200') && (
              <span style={{ color: C.textMid, fontSize: 13 }}>{filteredTop200.length} players</span>
            )}
          </div>
        </div>{/* nav-tabs */}
        </div>
      )}

      <main style={{ maxWidth: 1100, margin: '0 auto', padding: '16px 12px' }}>

        {/* ── LOGIN ──────────────────────────────────────────────────────── */}
        {screen === 'login' && (
          <div style={{ maxWidth: 420, margin: '60px auto 0' }}>
            <div style={{
              backgroundColor: C.white,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: '32px 28px',
            }}>
              <div style={{ textAlign: 'center', marginBottom: 24 }}>
                <div style={{ fontSize: 40, marginBottom: 10 }}>🏈</div>
                <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6, color: C.textDark }}>
                  Sign in to DynastySolved
                </h1>
                <p style={{ color: C.textMid, fontSize: 14 }}>
                  Dynasty WORP analysis powered by Sleeper
                </p>
              </div>

              <form onSubmit={handleLogin}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 5, color: C.textDark }}>
                  Sleeper Username
                </label>
                <input
                  value={usernameInput}
                  onChange={e => setUsernameInput(e.target.value)}
                  placeholder="your_username"
                  required
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: `1px solid #888`,
                    borderRadius: 4,
                    fontFamily: FONT,
                    fontSize: 15,
                    outline: 'none',
                    boxSizing: 'border-box',
                    marginBottom: 14,
                    color: C.textDark,
                  }}
                />
                {error && (
                  <p style={{ color: C.red, fontSize: 13, marginBottom: 10, padding: '8px 12px', backgroundColor: '#fff0f0', borderRadius: 4, border: '1px solid #fca5a5' }}>
                    {error}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    width: '100%',
                    padding: '10px',
                    backgroundColor: loading ? '#e0a800' : C.orange,
                    color: C.textDark,
                    border: '1px solid #a66600',
                    borderRadius: 20,
                    fontFamily: FONT,
                    fontWeight: 700,
                    fontSize: 15,
                    cursor: loading ? 'wait' : 'pointer',
                  }}
                >
                  {loading ? loadingMsg : 'Load My Dynasty'}
                </button>
              </form>

              <p style={{ marginTop: 20, color: C.textLight, fontSize: 12, textAlign: 'center' }}>
                Uses the Sleeper public API — no password required
              </p>
            </div>

            {/* Tier legend */}
            <div style={{
              backgroundColor: C.white,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: '18px 20px',
              marginTop: 16,
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: C.textDark }}>WORP Tier Guide</div>
              {[
                ['League Winner',        '≥ 2.0', 'Generational — snap and it\'s done'],
                ['Elite',         '≥ 1.5', 'Franchise cornerstone'],
                ['Star',          '≥ 1.0', 'Reliable weekly starter'],
                ['Starter',       '≥ 0.5', 'Solid lineup piece'],
                ['Streamer',      '≥ 0.0', 'Depth / matchup play'],
                ['Cut Candidate', '< 0.0', 'Below replacement level'],
              ].map(([tier, range, desc]) => (
                <div key={tier} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <TierBadge label={tier} />
                  <span style={{ fontSize: 12, color: C.textMid }}>{range} — {desc}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── DASHBOARD ──────────────────────────────────────────────────── */}
        {screen === 'dashboard' && (
          <div style={{ maxWidth: 680, margin: '0 auto' }}>
            <div style={{
              backgroundColor: C.white,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              overflow: 'hidden',
            }}>
              <div style={{ padding: '16px 20px', borderBottom: `1px solid ${C.border}`, backgroundColor: '#f8f8f8' }}>
                <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Your {nflYear} Leagues</h2>
                <p style={{ color: C.textMid, fontSize: 13, marginTop: 3, marginBottom: 0 }}>
                  {leagues.length} league{leagues.length !== 1 ? 's' : ''} found
                </p>
              </div>

              {error && (
                <div style={{ padding: '12px 20px', color: C.red, backgroundColor: '#fff0f0', fontSize: 14 }}>{error}</div>
              )}

              {loading ? (
                <div style={{ padding: 32, textAlign: 'center', color: C.textMid }}>{loadingMsg}</div>
              ) : (
                <div>
                  <LeagueRow
                    name="All Leagues"
                    sub={`${leagues.length} leagues combined`}
                    isAll
                    onClick={() => handleLeagueSelect('ALL')}
                  />
                  {leagues.map(league => (
                    <LeagueRow
                      key={league.league_id}
                      name={league.name}
                      sub={`${league.total_rosters} teams`}
                      onClick={() => handleLeagueSelect(league.league_id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── PORTFOLIO ──────────────────────────────────────────────────── */}
        {screen === 'portfolio' && (
          <div>
            {loading ? (
              <div style={{ textAlign: 'center', padding: '80px 20px' }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
                <p style={{ color: C.textMid, fontSize: 15 }}>{loadingMsg}</p>
              </div>
            ) : (
              <>
                {/* ── Stats bar + Tier breakdown — My Roster only ───── */}
                {tab === 'roster' && (<>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                  gap: 10,
                  marginBottom: 12,
                }}>
                  <StatCard label="Starting WORP" value={totalWorp.toFixed(2)} accent={C.blue} sub={`${myStarters.length} starters`} />
                  <StatCard label="Players" value={rosterPlayers.filter(p => !p.is_pick).length} accent={C.textMid} />
                  {byPos.map(({ pos, worp, count }) => (
                    <StatCard key={pos} label={`${pos} WORP`} value={worp.toFixed(2)} sub={`${count} players`} accent={POS_COLOR[pos]} />
                  ))}
                  {myPicks.length > 0 && <PicksStatCard picks={myPicks} />}
                </div>

                {/* ── Tier breakdown bar ────────────────────────────── */}
                <div style={{
                  backgroundColor: C.white,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  padding: '14px 20px',
                  marginBottom: 20,
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.textMid, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
                    Roster Tier Breakdown
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'stretch' }}>
                    {[
                      ...Object.entries(TIER_CONFIG).filter(([t]) => t !== 'Unranked').map(([tier, cfg]) => ({ tier, cfg, count: tierPlayers.filter(p => p.tier_label === tier).length })),
                      { tier: 'Rookies', cfg: { color: '#b45309', bg: '#fffbeb', border: '#fcd34d' }, count: myRookies.length },
                    ].map(({ tier, cfg, count }) => {
                      const total = tier === 'Rookies' ? rosterPlayers.filter(p => !p.is_pick).length : tierPlayers.length;
                      const pct = total > 0 ? count / total : 0;
                      const isActive = tierFilter === tier;
                      return (
                        <div key={tier} style={{ flex: '1 1 80px', minWidth: 70 }}>
                          <div
                            onClick={() => setTierFilter(isActive ? 'ALL' : tier)}
                            style={{
                              backgroundColor: cfg.bg,
                              border: `2px solid ${isActive ? cfg.color : cfg.border}`,
                              borderRadius: 6,
                              padding: '10px 12px',
                              textAlign: 'center',
                              cursor: 'pointer',
                              boxShadow: isActive ? `0 0 0 3px ${cfg.color}33` : 'none',
                              transition: 'box-shadow 0.15s, border-color 0.15s',
                            }}
                          >
                            <div style={{ fontSize: 24, fontWeight: 700, color: cfg.color, lineHeight: 1 }}>{count}</div>
                            <div style={{ fontSize: 11, fontWeight: 600, color: cfg.color, marginTop: 4 }}>{tier}</div>
                            {count > 0 && (
                              <div style={{ fontSize: 10, color: C.textLight, marginTop: 2 }}>
                                {Math.round(pct * 100)}%
                              </div>
                            )}
                          </div>
                          <div style={{ height: 4, backgroundColor: '#e5e7eb', borderRadius: 2, marginTop: 4 }}>
                            <div style={{ height: 4, width: `${pct * 100}%`, backgroundColor: cfg.color, borderRadius: 2, transition: 'width 0.3s' }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                </>)}

                {error && (
                  <div style={{ color: C.red, marginBottom: 12, padding: '10px 14px', background: '#fff0f0', borderRadius: 4, fontSize: 14 }}>{error}</div>
                )}

                {/* ── STANDINGS TAB ─────────────────────────────────── */}
                {tab === 'standings' && (
                  <LeagueStandingsView standings={leagueStandings} myUserId={userData?.user_id} />
                )}

                {/* ── MY ROSTER TAB ─────────────────────────────────── */}
                {tab === 'roster' && (<>
                  <div className="table-scroll">
                  <TableHeader />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 600 }}>
                    {filtered.map(player => (
                      <PlayerRow key={player.player_id} player={player} onRoster={true} />
                    ))}
                    {filtered.length === 0 && <EmptyState />}
                  </div>
                  </div>

                  {/* Picks section */}
                  {myPicks.length > 0 && (
                    <div style={{ marginTop: 20 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.textMid, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, paddingBottom: 6, borderBottom: `2px dashed ${C.border}` }}>
                        Rookie Draft Picks ({myPicks.length})
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
                        {myPicks.sort((a, b) => (b.fc_value ?? 0) - (a.fc_value ?? 0)).map(pk => (
                          <div key={pk.pick_id} style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '10px 14px',
                            backgroundColor: C.white,
                            border: `1px solid ${C.border}`,
                            borderLeft: `3px solid ${C.orange}`,
                            borderRadius: 6,
                          }}>
                            <div>
                              <div style={{ fontWeight: 700, fontSize: 14, color: C.textDark }}>{pk.name}</div>
                              <div style={{ fontSize: 11, color: C.textLight }}>{pk.leagueName}</div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              {pk.fc_value ? (
                                <>
                                  <div style={{ fontWeight: 700, fontSize: 15, color: '#c45500' }}>{pk.fc_value.toLocaleString()}</div>
                                  {pk.fc_trend != null && pk.fc_trend !== 0 && (
                                    <div style={{ fontSize: 10, color: pk.fc_trend > 0 ? C.green : C.red }}>
                                      {pk.fc_trend > 0 ? '▲' : '▼'} {Math.abs(Math.round(pk.fc_trend))}
                                    </div>
                                  )}
                                </>
                              ) : (
                                <div style={{ fontSize: 13, color: C.textLight }}>No value</div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>)}

                {/* ── WORP RANKINGS TABLE ───────────────────────────── */}
                {tab === 'worptable' && (<>
                  <div style={{ backgroundColor: '#fffbf0', border: `1px solid #fde68a`, borderRadius: 6, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#92400e', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <span style={{ marginTop: 1 }}>🏆</span>
                    <span><strong>WORP</strong> (Win Over Replacement Player) is how many additional wins a player generates you over a replacement level player. Players <strong>highlighted in green</strong> are on your roster.</span>
                  </div>
                  <div className="table-scroll">
                  <TableHeader showRank />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 640 }}>
                    {filteredTop200.map(player => (
                      <LeaderboardRow key={player.name + player.pos} player={player} onRoster={rosterNameSet.has(player.name)} />
                    ))}
                    {filteredTop200.length === 0 && <EmptyState />}
                  </div>
                  </div>
                </>)}

                {/* ── WORP CHART ────────────────────────────────────── */}
                {tab === 'top200' && (<>
                  <div style={{ backgroundColor: '#fffbf0', border: `1px solid #fde68a`, borderRadius: 6, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#92400e', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <span style={{ marginTop: 1 }}>📊</span>
                    <span><strong>WORP</strong> (Win Over Replacement Player) is how many additional wins a player generates you over a replacement level player.</span>
                  </div>
                  <WORPChart players={filteredTop200} rosterNameSet={rosterNameSet} />
                </>)}

                {/* ── FC VALUE TAB ──────────────────────────────────── */}
                {tab === 'fc' && (
                  <FCValueTab
                    dynastyList={dynastyList}
                    rosterPlayers={rosterPlayers}
                    rosterNameSet={rosterNameSet}
                    activeLeague={activeLeague}
                  />
                )}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{
      backgroundColor: C.white,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: '14px 16px',
      borderTop: `3px solid ${accent}`,
    }}>
      <div style={{ color: C.textMid, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ color: C.textDark, fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ color: C.textLight, fontSize: 11, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function PicksStatCard({ picks }) {
  const rounds = [1, 2, 3, 4, 5];
  const labels = ['1st', '2nd', '3rd', '4th', '5th'];
  const counts = rounds.map(r => picks.filter(p => p.round === r).length);
  const maxCount = Math.max(...counts, 1);

  return (
    <div style={{
      backgroundColor: C.white,
      border: `1px solid ${C.border}`,
      borderTop: `3px solid ${C.orange}`,
      borderRadius: 8,
      padding: '14px 16px',
    }}>
      <div style={{ color: C.textMid, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Rookie Picks</div>
      <div style={{ color: C.textDark, fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{picks.length}</div>
      <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 8, display: 'flex', gap: 5, alignItems: 'flex-end' }}>
        {rounds.map((r, i) => {
          const count = counts[i];
          if (count === 0) return null;
          const barH = Math.max(4, Math.round((count / maxCount) * 18));
          return (
            <div key={r} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: C.textMid }}>{count}</div>
              <div style={{
                width: 14, height: barH,
                backgroundColor: C.orange,
                borderRadius: '2px 2px 0 0',
                opacity: 1 - i * 0.15,
              }} />
              <div style={{ fontSize: 9, color: C.textLight }}>{labels[i]}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TierBadge({ label }) {
  const t = TIER_CONFIG[label] || TIER_CONFIG.Unranked;
  return (
    <span style={{
      backgroundColor: t.bg,
      color: t.color,
      border: `1px solid ${t.border}`,
      borderRadius: 12,
      padding: '2px 10px',
      fontSize: 12,
      fontWeight: 600,
      whiteSpace: 'nowrap',
      display: 'inline-block',
    }}>
      {label}
    </span>
  );
}

function PlayerRow({ player }) {
  const { name, pos, team, worp, tier_label, ppg, total_pts, fc_value, fc_trend, leagues, pos_rank } = player;
  const posColor = POS_COLOR[pos] || C.textMid;
  const posBg    = POS_BG[pos]   || '#f9fafb';
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: '2fr 70px 60px 130px 70px 60px 70px 80px',

        gap: 10,
        alignItems: 'center',
        padding: '12px 16px',
        backgroundColor: hovered ? '#f0f8ff' : C.white,
        border: `1px solid ${hovered ? '#c8e6f9' : C.border}`,
        borderRadius: 6,
        fontSize: 14,
        transition: 'background 0.1s, border-color 0.1s',
        cursor: 'default',
      }}
    >
      {/* Name */}
      <div>
        <div style={{ fontWeight: 700, color: C.textDark, marginBottom: 3 }}>{name}</div>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {(leagues || []).map(l => (
            <span key={l} style={{
              fontSize: 11,
              color: C.blue,
              backgroundColor: '#e8f4f8',
              borderRadius: 3,
              padding: '1px 6px',
            }}>{l}</span>
          ))}
        </div>
      </div>

      {/* Pos */}
      <div style={{ textAlign: 'center' }}>
        <span style={{
          backgroundColor: posBg,
          color: posColor,
          fontWeight: 700,
          fontSize: 12,
          padding: '3px 8px',
          borderRadius: 4,
          display: 'inline-block',
        }}>
          {pos}
        </span>
        {pos_rank && (
          <div style={{ fontSize: 11, color: C.textLight, marginTop: 2 }}>#{pos_rank}</div>
        )}
      </div>

      {/* Team */}
      <div style={{ color: C.textMid, textAlign: 'center', fontSize: 13 }}>{team}</div>

      {/* Tier */}
      <div><TierBadge label={tier_label} /></div>

      {/* WORP */}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 11, color: C.textLight, marginBottom: 1 }}>WORP</div>
        <div style={{
          fontWeight: 700,
          fontSize: 16,
          color: worp !== null ? (TIER_CONFIG[tier_label]?.color || C.textMid) : C.textLight,
        }}>
          {worp !== null ? worp.toFixed(2) : '—'}
        </div>
      </div>

      {/* PPG */}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 11, color: C.textLight, marginBottom: 1 }}>PPG</div>
        <div style={{ fontWeight: 700, fontSize: 16, color: C.textDark }}>
          {ppg !== null ? ppg.toFixed(1) : '—'}
        </div>
      </div>

      {/* Total Points */}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 11, color: C.textLight, marginBottom: 1 }}>Pts</div>
        <div style={{ fontWeight: 700, fontSize: 15, color: total_pts != null ? C.textDark : C.textLight }}>
          {total_pts != null ? total_pts : '—'}
        </div>
      </div>

      {/* FantasyCalc Dynasty Value */}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 11, color: C.textLight, marginBottom: 1 }}>FC Value</div>
        <div style={{ fontWeight: 700, fontSize: 15, color: fc_value != null ? '#c45500' : C.textLight }}>
          {fc_value != null ? fc_value.toLocaleString() : '—'}
        </div>
        {fc_trend != null && fc_trend !== 0 && (
          <div style={{ fontSize: 10, color: fc_trend > 0 ? C.green : C.red }}>
            {fc_trend > 0 ? '▲' : '▼'} {Math.abs(Math.round(fc_trend))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Rookies Tab ──────────────────────────────────────────────────────────────

function RookiesTab({ rookies }) {
  const [posFilter, setPosFilter] = useState('ALL');

  const filtered = rookies.filter(p => posFilter === 'ALL' || p.pos === posFilter);
  const byPos = ['QB','RB','WR','TE'].map(pos => ({
    pos,
    count: rookies.filter(p => p.pos === pos).length,
  }));

  if (!rookies.length) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px', color: C.textMid }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🎓</div>
        <p style={{ fontWeight: 600 }}>No unranked players on your roster.</p>
        <p style={{ fontSize: 13, marginTop: 6 }}>All your players have WORP data from last season.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Explainer */}
      <div style={{
        backgroundColor: '#fffbf0', border: `1px solid #fde68a`,
        borderRadius: 6, padding: '10px 14px', marginBottom: 16,
        fontSize: 13, color: '#92400e', display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span>🎓</span>
        <span>These players have <strong>no WORP score</strong> because they didn't play enough last season — rookies, IR holdouts, or newly added prospects. Sorted by FantasyCalc dynasty value.</span>
      </div>

      {/* Pos filter */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        {['ALL','QB','RB','WR','TE'].map(pos => {
          const cnt = pos === 'ALL' ? rookies.length : byPos.find(p => p.pos === pos)?.count;
          return (
            <button key={pos} onClick={() => setPosFilter(pos)} style={{
              padding: '5px 14px', border: 'none',
              borderBottom: posFilter === pos ? `3px solid ${C.orange}` : '3px solid transparent',
              background: 'none', fontFamily: FONT, fontSize: 13,
              color: posFilter === pos ? C.textDark : C.textMid,
              fontWeight: posFilter === pos ? 700 : 400, cursor: 'pointer',
            }}>
              {pos === 'ALL' ? 'All' : pos} {cnt > 0 ? `(${cnt})` : ''}
            </button>
          );
        })}
      </div>

      {/* Grid of rookie cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
        {filtered.map(p => (
          <RookieCard key={p.player_id} player={p} />
        ))}
      </div>
    </div>
  );
}

function RookieCard({ player }) {
  const { name, pos, team, age, college, depth_order, depth_pos, fc_value, fc_trend, fc_rank, years_exp, leagues } = player;
  const posColor = POS_COLOR[pos] || C.textMid;
  const posBg    = POS_BG[pos]   || '#f9fafb';

  return (
    <div style={{
      backgroundColor: C.white,
      border: `1px solid ${C.border}`,
      borderTop: `3px solid ${posColor}`,
      borderRadius: 8,
      padding: '14px 16px',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, color: C.textDark, marginBottom: 3 }}>{name}</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ backgroundColor: posBg, color: posColor, fontWeight: 700, fontSize: 11, padding: '2px 7px', borderRadius: 4 }}>{pos}</span>
            {team && <span style={{ fontSize: 12, color: C.textMid }}>{team}</span>}
            {age && <span style={{ fontSize: 12, color: C.textLight }}>Age {age}</span>}
          </div>
        </div>
        {fc_value != null && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: C.textLight, marginBottom: 1 }}>FC Value</div>
            <div style={{ fontWeight: 700, fontSize: 18, color: '#c45500' }}>{fc_value.toLocaleString()}</div>
            {fc_trend != null && fc_trend !== 0 && (
              <div style={{ fontSize: 10, color: fc_trend > 0 ? C.green : C.red }}>
                {fc_trend > 0 ? '▲' : '▼'} {Math.abs(Math.round(fc_trend))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Details */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {college && (
          <div style={{ fontSize: 12, color: C.textMid, display: 'flex', gap: 6 }}>
            <span style={{ color: C.textLight, width: 64 }}>College</span>
            <span>{college}</span>
          </div>
        )}
        {fc_rank != null && (
          <div style={{ fontSize: 12, color: C.textMid, display: 'flex', gap: 6 }}>
            <span style={{ color: C.textLight, width: 64 }}>FC Rank</span>
            <span>#{fc_rank} overall</span>
          </div>
        )}
        {depth_order != null && (
          <div style={{ fontSize: 12, color: C.textMid, display: 'flex', gap: 6 }}>
            <span style={{ color: C.textLight, width: 64 }}>Depth</span>
            <span>{depth_pos || pos}{depth_order}</span>
          </div>
        )}
        {years_exp === 0 && (
          <div style={{ marginTop: 4 }}>
            <span style={{
              fontSize: 10, fontWeight: 700, backgroundColor: '#fef3c7',
              color: '#92400e', border: '1px solid #fcd34d',
              borderRadius: 10, padding: '2px 8px',
            }}>TRUE ROOKIE</span>
          </div>
        )}
      </div>

      {/* League tags */}
      {(leagues || []).length > 0 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
          {leagues.map(l => (
            <span key={l} style={{ fontSize: 10, color: C.blue, backgroundColor: '#e8f4f8', borderRadius: 3, padding: '1px 6px' }}>{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── League Standings ─────────────────────────────────────────────────────────

function LeagueStandingsView({ standings, myUserId }) {
  const [expandedTeam, setExpandedTeam] = useState(null);
  const [standingsSort, setStandingsSort] = useState('worp'); // 'worp' | 'fc'

  if (!standings.length) return <EmptyState />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {standings.map(({ league_id, league_name, teams }) => (
        <div key={league_id}>
          {/* League header */}
          {standings.length > 1 && (
            <div style={{ fontSize: 15, fontWeight: 700, color: C.textDark, marginBottom: 10, paddingBottom: 6, borderBottom: `2px solid ${C.orange}`, display: 'inline-block' }}>
              {league_name}
            </div>
          )}

          {/* Lineup format pill */}
          {teams[0] && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: C.textMid, fontWeight: 600 }}>Starting lineup:</span>
              {Object.entries(teams[0].slots).filter(([,v]) => v > 0).map(([slot, count]) => (
                <span key={slot} style={{
                  fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                  backgroundColor: slot === 'SUPER_FLEX' ? '#fef3c7' : slot === 'FLEX' || slot === 'REC_FLEX' ? '#f3f4f5' : POS_BG[slot] || '#f3f4f5',
                  color: slot === 'SUPER_FLEX' ? '#92400e' : slot === 'FLEX' || slot === 'REC_FLEX' ? C.textMid : POS_COLOR[slot] || C.textMid,
                  border: `1px solid ${slot === 'SUPER_FLEX' ? '#fcd34d' : C.border}`,
                }}>
                  {count > 1 ? `${count}× ` : ''}{slot.replace('_', ' ')}
                </span>
              ))}
              <span style={{ fontSize: 11, color: C.textLight }}>({teams[0].totalStartingSlots} starters)</span>
            </div>
          )}

          {/* Sort toggle */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: C.textMid, fontWeight: 600 }}>Rank by:</span>
            {[['worp','Starting WORP'],['fc','FC Roster Value']].map(([v,label]) => (
              <button key={v} onClick={() => setStandingsSort(v)} style={{
                padding: '4px 12px', border: `1px solid ${standingsSort === v ? C.orange : C.border}`,
                borderRadius: 4, backgroundColor: standingsSort === v ? C.orange + '22' : C.white,
                color: standingsSort === v ? '#92400e' : C.textMid,
                fontFamily: FONT, fontSize: 12, fontWeight: standingsSort === v ? 700 : 400, cursor: 'pointer',
              }}>{label}</button>
            ))}
          </div>

          {/* Column headers — scrollable on mobile */}
          <div className="table-scroll">
          <div style={{
            display: 'grid',
            gridTemplateColumns: '36px 1fr 100px 90px 1fr 80px', minWidth: 580,
            gap: 10, padding: '6px 16px',
            fontSize: 11, fontWeight: 700, color: C.textMid, textTransform: 'uppercase', letterSpacing: 0.5,
          }}>
            <div style={{ textAlign: 'center' }}>#</div>
            <div>Manager</div>
            <div style={{ textAlign: 'right' }}>Starting WORP</div>
            <div style={{ textAlign: 'right' }}>FC Value</div>
            <div>Tier Breakdown</div>
            <div style={{ textAlign: 'right' }}>Roster</div>
            <div style={{ textAlign: 'right' }}></div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[...teams].sort((a, b) => standingsSort === 'fc'
              ? (b.totalFcValue || 0) - (a.totalFcValue || 0)
              : b.startingWorp - a.startingWorp
            ).map((team, sortIdx) => {
              const displayRank = sortIdx + 1;
              const key = `${league_id}-${team.roster_id}`;
              const expanded = expandedTeam === key;
              const isMe = team.is_me;
              return (
                <div key={key}>
                  {/* Team row */}
                  <div
                    onClick={() => setExpandedTeam(expanded ? null : key)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '36px 1fr 100px 90px 1fr 80px', minWidth: 580,
                      gap: 10, alignItems: 'center',
                      padding: '13px 16px',
                      backgroundColor: isMe ? '#fffbf0' : C.white,
                      border: `1px solid ${isMe ? C.orange + '88' : C.border}`,
                      borderLeft: `4px solid ${isMe ? C.orange : team.rank === 1 ? '#FFD700' : team.rank === 2 ? '#C0C0C0' : team.rank === 3 ? '#CD7F32' : C.border}`,
                      borderRadius: 6,
                      cursor: 'pointer',
                      transition: 'background 0.1s',
                    }}
                  >
                    {/* Rank */}
                    <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 15,
                      color: displayRank === 1 ? '#b45309' : displayRank <= 3 ? C.textMid : C.textLight }}>
                      {displayRank === 1 ? '🥇' : displayRank === 2 ? '🥈' : displayRank === 3 ? '🥉' : displayRank}
                    </div>

                    {/* Manager */}
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontWeight: 700, fontSize: 14, color: C.textDark }}>{team.display_name}</span>
                        {isMe && <span style={{ fontSize: 10, backgroundColor: C.orange + '33', color: '#92400e', border: `1px solid ${C.orange}88`, borderRadius: 10, padding: '1px 7px', fontWeight: 600 }}>You</span>}
                      </div>
                      {team.team_name && <div style={{ fontSize: 11, color: C.textLight }}>{team.team_name}</div>}
                    </div>

                    {/* Starting WORP */}
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 700, fontSize: 16, color: team.startingWorp >= 8 ? C.green : team.startingWorp >= 4 ? C.blue : C.textDark }}>
                        {team.startingWorp.toFixed(2)}
                      </div>
                    </div>

                    {/* FC Roster Value */}
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 700, fontSize: 16, color: team.totalFcValue > 0 ? '#c45500' : C.textLight }}>
                        {team.totalFcValue > 0 ? (team.totalFcValue / 1000).toFixed(1) + 'k' : '—'}
                      </div>
                    </div>

                    {/* Tier breakdown strip */}
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                      {Object.entries(TIER_CONFIG).filter(([t]) => t !== 'Unranked').map(([tier, cfg]) => {
                        const count = team.players.filter(p => p.worp !== null && p.tier_label === tier).length;
                        if (count === 0) return null;
                        return (
                          <span key={tier} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 3,
                            backgroundColor: cfg.bg, color: cfg.color,
                            border: `1px solid ${cfg.border}`,
                            borderRadius: 10, padding: '1px 7px', fontSize: 11, fontWeight: 700,
                          }}>
                            {count} <span style={{ fontWeight: 400, fontSize: 10 }}>{tier === 'Cut Candidate' ? 'Cut' : tier}</span>
                          </span>
                        );
                      })}
                    </div>

                    {/* Roster size */}
                    <div style={{ textAlign: 'right', color: C.textMid, fontSize: 13 }}>
                      {team.playerCount}
                    </div>

                    {/* Expand chevron */}
                    <div style={{ textAlign: 'right', color: C.textLight, fontSize: 16, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>›</div>
                  </div>

                  {/* Expanded roster */}
                  {expanded && (() => {
                    const POS_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3 };
                    const byPos = (a, b) => (POS_ORDER[a.pos] ?? 9) - (POS_ORDER[b.pos] ?? 9) || (b.worp ?? -99) - (a.worp ?? -99);
                    const starterIds = new Set(team.starters.map(p => p.player_id));
                    const bench = team.players.filter(p => !starterIds.has(p.player_id)).sort(byPos);
                    const renderPlayer = (p, isStarter) => (
                      <div key={p.player_id} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '7px 10px',
                        backgroundColor: isStarter ? C.white : '#f9fafb',
                        border: `1px solid ${isStarter ? C.border : '#e5e7eb'}`,
                        borderLeft: `3px solid ${isStarter ? (POS_COLOR[p.pos] || C.border) : '#d1d5db'}`,
                        borderRadius: 4,
                        fontSize: 13,
                        opacity: isStarter ? 1 : 0.75,
                      }}>
                        <div>
                          <div style={{ fontWeight: isStarter ? 600 : 400, color: isStarter ? C.textDark : C.textMid }}>{p.name}</div>
                          <div style={{ fontSize: 11, color: C.textLight }}>{p.pos} · {p.team}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontWeight: 700, fontSize: 14, color: p.worp !== null ? TIER_CONFIG[p.tier_label]?.color : C.textLight }}>
                            {p.worp !== null ? p.worp.toFixed(2) : '—'}
                          </div>
                          {p.worp !== null && <TierBadge label={p.tier_label} />}
                        </div>
                      </div>
                    );
                    return (
                      <div style={{
                        backgroundColor: '#fafafa', border: `1px solid ${C.border}`,
                        borderTop: 'none', borderRadius: '0 0 6px 6px', padding: '14px 16px', marginTop: -4,
                      }}>
                        {/* Starting lineup section */}
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.textMid, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
                          ▶ Starting Lineup — {team.startingWorp.toFixed(2)} WORP
                        </div>
                        {['QB','RB','WR','TE'].map(pos => {
                          const group = [...team.starters].filter(p => p.pos === pos).sort((a,b) => (b.worp??-99)-(a.worp??-99));
                          if (!group.length) return null;
                          return (
                            <div key={pos} style={{ marginBottom: 10 }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: POS_COLOR[pos], textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ backgroundColor: POS_BG[pos], color: POS_COLOR[pos], padding: '1px 8px', borderRadius: 4 }}>{pos}</span>
                              </div>
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 5 }}>
                                {group.map(p => renderPlayer(p, true))}
                              </div>
                            </div>
                          );
                        })}

                        {/* Bench section */}
                        {bench.length > 0 && (<>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.textLight, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, borderTop: `1px dashed ${C.border}`, paddingTop: 12, marginTop: 4 }}>
                            Bench ({bench.length})
                          </div>
                          {['QB','RB','WR','TE'].map(pos => {
                            const group = bench.filter(p => p.pos === pos).sort((a,b) => (b.worp??-99)-(a.worp??-99));
                            if (!group.length) return null;
                            return (
                              <div key={pos} style={{ marginBottom: 10 }}>
                                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, marginBottom: 5 }}>
                                  <span style={{ backgroundColor: POS_BG[pos], color: POS_COLOR[pos], padding: '1px 8px', borderRadius: 4 }}>{pos}</span>
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 5 }}>
                                  {group.map(p => renderPlayer(p, false))}
                                </div>
                              </div>
                            );
                          })}
                        </>)}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
          </div>{/* table-scroll */}
        </div>
      ))}
    </div>
  );
}

// ─── FC Value Tab ─────────────────────────────────────────────────────────────

const FC_POS_ORDER = ['QB','RB','WR','TE'];
const SKILL_POS = new Set(['QB','RB','WR','TE']);

function FCValueTab({ dynastyList, rosterPlayers, rosterNameSet, activeLeague }) {
  const [fcView,    setFcView]    = useState('table');
  const [fcPosFilter, setFcPosFilter] = useState('ALL');
  const [showPicks, setShowPicks] = useState(true);

  if (!dynastyList.length) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px', color: C.textMid }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
        <p>Load a league to see FantasyCalc trade values.</p>
      </div>
    );
  }

  // Build roster lookup by name for highlighting; also index my picks
  const rosterByName = new Map();
  const myPickNames  = new Set();
  rosterPlayers.forEach(p => {
    if (p.is_pick) myPickNames.add(p.name);
    else rosterByName.set(p.name, p);
  });

  // Combine skill players + picks into one sorted list
  const skillPlayers = dynastyList.filter(p => SKILL_POS.has(p.pos));
  const fcPicks      = dynastyList.filter(p => p.is_pick);

  // Merged + filtered list (picks included when showPicks=true and posFilter=ALL)
  const combined = [
    ...skillPlayers.filter(p => fcPosFilter === 'ALL' || p.pos === fcPosFilter),
    ...(showPicks && fcPosFilter === 'ALL' ? fcPicks : []),
  ].sort((a, b) => b.fc_value - a.fc_value);

  // Re-rank within the combined list (picks get a rank too)
  combined.forEach((p, i) => { p._rank = i + 1; });

  const filteredSkill = combined; // alias used below

  // My roster entries with FC values
  const myRosterFc = rosterPlayers
    .filter(p => p.fc_value != null)
    .sort((a, b) => b.fc_value - a.fc_value);

  const totalRosterValue = myRosterFc.reduce((s, p) => s + p.fc_value, 0);
  const top25owned  = myRosterFc.filter(p => p.fc_rank  <= 25).length;
  const top50owned  = myRosterFc.filter(p => p.fc_rank  <= 50).length;
  const top100owned = myRosterFc.filter(p => p.fc_rank <= 100).length;

  // Movers — biggest 30-day changes among skill players
  const sorted30 = [...skillPlayers].filter(p => p.fc_trend != null).sort((a, b) => b.fc_trend - a.fc_trend);
  const risers   = sorted30.slice(0, 5);
  const fallers  = [...sorted30].reverse().slice(0, 5);

  // WORP vs Value chart data — only players with both worp and fc_value
  const chartPlayers = rosterPlayers
    .filter(p => p.worp != null && p.fc_value != null && SKILL_POS.has(p.pos));
  const allSkillWithWorp = filteredSkill.map(p => {
    const rp   = rosterByName.get(p.name);
    const worp = rp?.worp ?? worpMapCache?.[normalizeName(p.name)]?.worp ?? null;
    return { ...p, worp };
  }).filter(p => p.worp != null);

  return (
    <div>
      {/* ── Stats bar ─────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px,1fr))', gap: 10, marginBottom: 20 }}>
        <StatCard label="Roster FC Value" value={totalRosterValue.toLocaleString()} accent={C.orange} />
        <StatCard label="Top 25 Assets"   value={top25owned}  accent="#6b21a8" />
        <StatCard label="Top 50 Assets"   value={top50owned}  accent={C.blue}  />
        <StatCard label="Top 100 Assets"  value={top100owned} accent={C.green} />
      </div>

      {/* ── Movers strip ──────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
        {/* Risers */}
        <div style={{ backgroundColor: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.green, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
            📈 30-Day Risers
          </div>
          {risers.map(p => (
            <MoverRow key={p.name} player={p} owned={rosterByName.has(p.name)} direction="up" />
          ))}
        </div>
        {/* Fallers */}
        <div style={{ backgroundColor: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.red, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
            📉 30-Day Fallers
          </div>
          {fallers.map(p => (
            <MoverRow key={p.name} player={p} owned={rosterByName.has(p.name)} direction="down" />
          ))}
        </div>
      </div>

      {/* ── View toggle + pos filter ───────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
          {[['table','≡ Rankings'],['chart','◎ Value vs WORP']].map(([v,label]) => (
            <button key={v} onClick={() => setFcView(v)} style={{
              padding: '6px 14px', border: 'none', fontFamily: FONT, fontSize: 13, cursor: 'pointer',
              backgroundColor: fcView === v ? C.orange : C.white,
              color: fcView === v ? '#000' : C.textMid,
              fontWeight: fcView === v ? 700 : 400,
            }}>{label}</button>
          ))}
        </div>

        {fcView === 'table' && (<>
          <div style={{ width: 1, height: 20, background: C.border }} />
          {['ALL','QB','RB','WR','TE'].map(pos => (
            <button key={pos} onClick={() => setFcPosFilter(pos)} style={{
              padding: '5px 11px', background: 'none', border: 'none',
              borderBottom: fcPosFilter === pos ? `3px solid ${C.blue}` : '3px solid transparent',
              color: fcPosFilter === pos ? C.blue : C.textMid,
              fontFamily: FONT, fontSize: 13, fontWeight: fcPosFilter === pos ? 700 : 400, cursor: 'pointer',
            }}>{pos === 'ALL' ? 'All' : pos}</button>
          ))}
          <div style={{ width: 1, height: 20, background: C.border }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.textMid, cursor: 'pointer' }}>
            <input type="checkbox" checked={showPicks} onChange={e => setShowPicks(e.target.checked)} />
            Show Picks
          </label>
        </>)}

        <span style={{ marginLeft: 'auto', color: C.textMid, fontSize: 13 }}>
          {fcView === 'table' ? `${combined.length} items` : `${allSkillWithWorp.length} players with WORP`}
        </span>
      </div>

      {/* ── TABLE VIEW ─────────────────────────────────────── */}
      {fcView === 'table' && (<>
        <div className="table-scroll">
        <div style={{
          display: 'grid', gridTemplateColumns: '44px 2fr 70px 60px 80px 80px 70px 70px',
          minWidth: 640,
          gap: 10, padding: '6px 16px',
          fontSize: 11, fontWeight: 700, color: C.textMid, textTransform: 'uppercase', letterSpacing: 0.5,
        }}>
          <div style={{ textAlign: 'center' }}>#</div>
          <div>Player / Pick</div>
          <div style={{ textAlign: 'center' }}>Pos</div>
          <div style={{ textAlign: 'center' }}>Age</div>
          <div style={{ textAlign: 'right' }}>FC Value</div>
          <div style={{ textAlign: 'right' }}>30d Trend</div>
          <div style={{ textAlign: 'right' }}>WORP</div>
          <div style={{ textAlign: 'right' }}>Pos Rank</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 640 }}>
          {combined.map(p => {
            const owned = p.is_pick ? myPickNames.has(p.name) : rosterByName.has(p.name);
            const worp  = p.is_pick ? null : (rosterByName.get(p.name)?.worp ?? worpMapCache?.[normalizeName(p.name)]?.worp ?? null);
            return (
              <FCPlayerRow key={(p.name || '') + (p.pos || '') + (p._rank || '')} player={p} globalRank={p._rank} owned={owned} worp={worp} />
            );
          })}
          {combined.length === 0 && <EmptyState />}
        </div>
        </div>{/* table-scroll */}
      </>)}

      {/* ── CHART VIEW: Value vs WORP ──────────────────────── */}
      {fcView === 'chart' && (
        <FCValueWORPChart players={allSkillWithWorp} rosterByName={rosterByName} />
      )}
    </div>
  );
}

function MoverRow({ player, owned, direction }) {
  const posColor = POS_COLOR[player.pos] || C.textMid;
  const trendColor = direction === 'up' ? C.green : C.red;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', borderBottom: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, backgroundColor: POS_BG[player.pos] || '#f9fafb', color: posColor, padding: '1px 6px', borderRadius: 3 }}>{player.pos}</span>
        <span style={{ fontSize: 13, fontWeight: owned ? 700 : 400, color: owned ? C.blue : C.textDark }}>{player.name}</span>
        {owned && <span style={{ fontSize: 10, color: C.blue }}>★</span>}
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: trendColor }}>
          {direction === 'up' ? '▲' : '▼'} {Math.abs(Math.round(player.fc_trend))}
        </div>
        <div style={{ fontSize: 10, color: C.textLight }}>{player.fc_value.toLocaleString()}</div>
      </div>
    </div>
  );
}

function FCPlayerRow({ player, globalRank, owned, worp }) {
  const [hovered, setHovered] = useState(false);
  const posColor = POS_COLOR[player.pos] || C.textMid;
  const posBg    = POS_BG[player.pos]   || '#f9fafb';
  const trendColor = player.fc_trend > 0 ? C.green : player.fc_trend < 0 ? C.red : C.textLight;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'grid', gridTemplateColumns: '44px 2fr 70px 60px 80px 80px 70px 70px',
        gap: 10, alignItems: 'center', padding: '10px 16px',
        backgroundColor: owned ? (hovered ? '#d1fae5' : '#f0fdf4') : (hovered ? '#f0f8ff' : C.white),
        border: `1px solid ${owned ? '#86efac' : (hovered ? '#c8e6f9' : C.border)}`,
        borderRadius: 6, fontSize: 13, transition: 'background 0.1s',
      }}
    >
      {/* Rank */}
      <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 13,
        color: globalRank <= 10 ? C.orange : globalRank <= 25 ? '#6b21a8' : C.textLight }}>
        {globalRank ?? '—'}
      </div>

      {/* Name */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: owned ? 700 : 400, color: C.textDark }}>{player.name}</span>
          {owned && <span style={{ fontSize: 10, backgroundColor: '#dcfce7', color: '#15803d', border: '1px solid #86efac', borderRadius: 10, padding: '1px 6px', fontWeight: 600 }}>Owned</span>}
        </div>
        {player.team && <div style={{ fontSize: 11, color: C.textLight }}>{player.team}</div>}
      </div>

      {/* Pos */}
      <div style={{ textAlign: 'center' }}>
        {!player.is_pick && (
          <span style={{ backgroundColor: posBg, color: posColor, fontWeight: 700, fontSize: 11, padding: '2px 7px', borderRadius: 4 }}>{player.pos}</span>
        )}
      </div>

      {/* Age */}
      <div style={{ textAlign: 'center', color: player.age <= 23 ? C.green : player.age >= 29 ? C.red : C.textMid, fontWeight: 600, fontSize: 13 }}>
        {player.age ?? '—'}
      </div>

      {/* FC Value */}
      <div style={{ textAlign: 'right', fontWeight: 700, fontSize: 15, color: '#c45500' }}>
        {player.fc_value.toLocaleString()}
      </div>

      {/* 30d Trend */}
      <div style={{ textAlign: 'right', fontWeight: 600, fontSize: 13, color: trendColor }}>
        {player.fc_trend !== 0 ? `${player.fc_trend > 0 ? '+' : ''}${Math.round(player.fc_trend)}` : <span style={{ color: C.textLight }}>—</span>}
      </div>

      {/* WORP */}
      <div style={{ textAlign: 'right', fontWeight: 700, fontSize: 13,
        color: worp != null ? (TIER_CONFIG[getTier(worp)]?.color || C.textMid) : C.textLight }}>
        {worp != null ? worp.toFixed(2) : '—'}
      </div>

      {/* Pos rank */}
      <div style={{ textAlign: 'right', color: C.textLight, fontSize: 12 }}>
        {player.fc_pos_rank ? `${player.pos}${player.fc_pos_rank}` : '—'}
      </div>
    </div>
  );
}

function FCValueWORPChart({ players, rosterByName }) {
  const [tooltip, setTooltip] = useState(null);
  const [activePosSet, setActivePosSet] = useState(new Set(['QB','RB','WR','TE']));
  const [rosterOnly, setRosterOnly] = useState(false);

  const togglePos = pos => setActivePosSet(prev => {
    const next = new Set(prev);
    if (next.has(pos) && next.size === 1) return prev;
    next.has(pos) ? next.delete(pos) : next.add(pos);
    return next;
  });

  const visible = players.filter(p => activePosSet.has(p.pos));
  if (!visible.length) return <EmptyState />;

  const W = 860, H = 500;
  const PAD = { top: 40, right: 40, bottom: 60, left: 80 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top  - PAD.bottom;

  const maxWorp = Math.max(...visible.map(p => p.worp), 0.1);
  const minWorp = Math.min(...visible.map(p => p.worp), 0);
  const maxVal  = Math.max(...visible.map(p => p.fc_value), 1);
  const worpPad = (maxWorp - minWorp) * 0.06 || 0.1;
  const valPad  = maxVal * 0.05;

  const xScale = w => PAD.left + ((w - (minWorp - worpPad)) / ((maxWorp + worpPad) - (minWorp - worpPad))) * innerW;
  const yScale = v => PAD.top  + (1 - (v / (maxVal + valPad))) * innerH;

  // Quadrant midpoints for labels
  const midX   = xScale((maxWorp + minWorp) / 2);
  const midY   = yScale(maxVal / 2);

  // Y-axis ticks
  const yStep = maxVal > 8000 ? 2000 : maxVal > 4000 ? 1000 : 500;
  const yTicks = [];
  for (let v = 0; v <= maxVal + valPad; v += yStep) yTicks.push(v);

  // X-axis ticks
  const xTicks = [];
  for (let v = Math.ceil(minWorp / 0.5) * 0.5; v <= maxWorp + 0.1; v = Math.round((v + 0.5) * 10) / 10) xTicks.push(v);

  const plotted = visible.map(p => ({
    ...p,
    cx: xScale(p.worp),
    cy: yScale(p.fc_value),
    owned: rosterByName.has(p.name),
  }));

  return (
    <div style={{ backgroundColor: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '16px 8px 8px' }}>
      {/* Position toggles */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {['QB','RB','WR','TE'].map(pos => {
          const active = activePosSet.has(pos);
          const color  = CHART_POS_COLOR[pos];
          return (
            <button key={pos} onClick={() => togglePos(pos)} style={{
              display: 'flex', alignItems: 'center', gap: 7, padding: '5px 14px',
              backgroundColor: active ? color + '18' : '#f3f4f5',
              border: `2px solid ${active ? color : '#d1d5db'}`,
              borderRadius: 20, cursor: 'pointer', fontFamily: FONT, fontSize: 13,
              fontWeight: 700, color: active ? color : '#9ca3af',
              opacity: active ? 1 : 0.5, transition: 'all 0.15s',
            }}>
              <svg width={24} height={10}><line x1={0} y1={5} x2={24} y2={5} stroke={active ? color : '#d1d5db'} strokeWidth={2.5}/><circle cx={12} cy={5} r={4} fill={active ? color : '#d1d5db'}/></svg>
              {pos}
            </button>
          );
        })}
        <div style={{ width: 1, height: 20, background: C.border, margin: '0 4px' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.blue }}>
          <svg width={16} height={16}><circle cx={8} cy={8} r={6} fill="none" stroke={C.blue} strokeWidth={2}/><circle cx={8} cy={8} r={3} fill={C.blue}/></svg>
          <span style={{ fontWeight: 600 }}>On Your Roster</span>
        </div>
        <div style={{ width: 1, height: 20, background: C.border, margin: '0 4px' }} />
        <button onClick={() => setRosterOnly(r => !r)} style={{
          padding: '4px 12px', border: `1px solid ${rosterOnly ? C.blue : C.border}`,
          borderRadius: 4, backgroundColor: rosterOnly ? '#e8f0fe' : C.white,
          color: rosterOnly ? C.blue : C.textMid, fontFamily: FONT, fontSize: 12,
          fontWeight: rosterOnly ? 700 : 400, cursor: 'pointer',
        }}>
          {rosterOnly ? '★ Highlight Mine' : '☆ Highlight Mine'}
        </button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <svg width={W} height={H} style={{ display: 'block', maxWidth: '100%' }}>
          {/* Quadrant shading */}
          <rect x={PAD.left} y={PAD.top} width={midX - PAD.left} height={midY - PAD.top} fill="#f0fdf4" opacity={0.5} />
          <rect x={midX} y={PAD.top} width={W - PAD.right - midX} height={midY - PAD.top} fill="#fffbf0" opacity={0.6} />
          <rect x={PAD.left} y={midY} width={midX - PAD.left} height={H - PAD.bottom - midY} fill="#f9fafb" opacity={0.5} />
          <rect x={midX} y={midY} width={W - PAD.right - midX} height={H - PAD.bottom - midY} fill="#fff0f0" opacity={0.5} />

          {/* Quadrant labels */}
          {[
            [PAD.left + 8, PAD.top + 16, 'VALUE UPSIDE',      '#007600'],
            [midX + 8,     PAD.top + 16, 'BLUE CHIP',         '#b45309'],
            [PAD.left + 8, midY + 16,    'DEPTH',             '#565959'],
            [midX + 8,     midY + 16,    'PRODUCTION UPSIDE', '#c40000'],
          ].map(([x, y, label, color]) => (
            <text key={label} x={x} y={y} fontSize={10} fontWeight={700} fill={color} opacity={0.6} letterSpacing={1}>{label}</text>
          ))}

          {/* Grid lines */}
          {yTicks.map(v => (
            <g key={v}>
              <line x1={PAD.left} y1={yScale(v)} x2={W - PAD.right} y2={yScale(v)} stroke="#e5e7eb" strokeWidth={1} />
              <text x={PAD.left - 8} y={yScale(v) + 4} textAnchor="end" fontSize={11} fill={C.textLight}>{(v/1000).toFixed(0)}k</text>
            </g>
          ))}
          {xTicks.map(v => (
            <g key={v}>
              <line x1={xScale(v)} y1={PAD.top} x2={xScale(v)} y2={H - PAD.bottom} stroke="#e5e7eb" strokeWidth={1} />
              <text x={xScale(v)} y={H - PAD.bottom + 16} textAnchor="middle" fontSize={11} fill={C.textLight}>{v.toFixed(1)}</text>
            </g>
          ))}

          {/* Crosshair at midpoints */}
          <line x1={midX} y1={PAD.top} x2={midX} y2={H - PAD.bottom} stroke="#d1d5db" strokeWidth={1} strokeDasharray="4,3" />
          <line x1={PAD.left} y1={midY} x2={W - PAD.right} y2={midY} stroke="#d1d5db" strokeWidth={1} strokeDasharray="4,3" />

          {/* Axes */}
          <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} stroke="#d1d5db" strokeWidth={1.5} />
          <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} stroke="#d1d5db" strokeWidth={1.5} />

          {/* Axis labels */}
          <text x={W / 2} y={H - 6} textAnchor="middle" fontSize={12} fill={C.textMid} fontWeight={600}>WORP (2025 Production)</text>
          <text x={14} y={PAD.top + innerH / 2} textAnchor="middle" fontSize={12} fill={C.textMid} fontWeight={600} transform={`rotate(-90, 14, ${PAD.top + innerH / 2})`}>FC Dynasty Value</text>

          {/* Dots — non-owned players drawn first (behind), owned on top */}
          {[...plotted.filter(p => !p.owned), ...plotted.filter(p => p.owned)].map((p, i) => {
            const dimmed = rosterOnly && !p.owned;
            return (
              <g key={i} onMouseEnter={() => setTooltip(p)} onMouseLeave={() => setTooltip(null)} style={{ cursor: 'pointer' }}>
                {p.owned ? (
                  <>
                    <circle cx={p.cx} cy={p.cy} r={9} fill="none" stroke={C.blue} strokeWidth={2} />
                    <circle cx={p.cx} cy={p.cy} r={5} fill={CHART_POS_COLOR[p.pos]} />
                  </>
                ) : (
                  <circle cx={p.cx} cy={p.cy} r={4} fill={CHART_POS_COLOR[p.pos]} fillOpacity={dimmed ? 0.1 : 0.55} />
                )}
              </g>
            );
          })}

          {/* Tooltip */}
          {tooltip && (() => {
            const boxW = 180, boxH = 88;
            const bx = Math.min(tooltip.cx + 12, W - PAD.right - boxW - 4);
            const by = Math.max(tooltip.cy - boxH / 2, PAD.top);
            const tier = tooltip.worp != null ? TIER_CONFIG[getTier(tooltip.worp)] : TIER_CONFIG.Unranked;
            return (
              <g style={{ pointerEvents: 'none' }}>
                <rect x={bx} y={by} width={boxW} height={boxH} rx={6} fill={C.white} stroke={C.border} strokeWidth={1} style={{ filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.12))' }} />
                <rect x={bx} y={by} width={4} height={boxH} rx={2} fill={CHART_POS_COLOR[tooltip.pos]} />
                <text x={bx+12} y={by+18} fontSize={13} fontWeight={700} fill={C.textDark}>{tooltip.name}</text>
                <text x={bx+12} y={by+32} fontSize={11} fill={C.textMid}>{tooltip.pos} · {tooltip.team || 'FA'} · Age {tooltip.age || '?'}</text>
                <text x={bx+12} y={by+50} fontSize={12} fontWeight={700} fill="#c45500">FC: {tooltip.fc_value.toLocaleString()}</text>
                <text x={bx+12} y={by+66} fontSize={12} fill={C.textMid}>
                  <tspan fontWeight={700} fill={tier?.color}>{tooltip.worp?.toFixed(2)}</tspan>
                  <tspan> WORP</tspan>
                </text>
                <text x={bx+12} y={by+82} fontSize={10} fill={tooltip.fc_trend > 0 ? C.green : C.red}>
                  {tooltip.fc_trend > 0 ? '▲' : '▼'} {Math.abs(Math.round(tooltip.fc_trend))} 30d
                </text>
                {tooltip.owned && <text x={bx+boxW-10} y={by+18} textAnchor="end" fontSize={10} fontWeight={700} fill={C.blue}>Owned</text>}
              </g>
            );
          })()}
        </svg>
      </div>
    </div>
  );
}

// ─── WORP Chart ───────────────────────────────────────────────────────────────

const CHART_POS_COLOR = {
  QB: '#0066c0',
  RB: '#007600',
  WR: '#FF9900',
  TE: '#6b21a8',
};

function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const cpx = (prev.x + curr.x) / 2;
    d += ` C ${cpx} ${prev.y}, ${cpx} ${curr.y}, ${curr.x} ${curr.y}`;
  }
  return d;
}

function WORPChart({ players, rosterNameSet }) {
  const [tooltip, setTooltip] = useState(null);
  const [activePosSet, setActivePosSet] = useState(new Set(['QB','RB','WR','TE']));
  const [rosterOnly, setRosterOnly] = useState(false);

  const togglePos = (pos) => {
    setActivePosSet(prev => {
      const next = new Set(prev);
      // Don't allow deselecting the last active position
      if (next.has(pos) && next.size === 1) return prev;
      next.has(pos) ? next.delete(pos) : next.add(pos);
      return next;
    });
  };

  // Filter by active positions + optional roster-only toggle
  const visiblePlayers = players.filter(p =>
    activePosSet.has(p.pos) && (!rosterOnly || rosterNameSet.has(p.name))
  );

  const W = 860, H = 460;
  const PAD = { top: 30, right: 30, bottom: 60, left: 64 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  if (!players.length) return <EmptyState />;

  const positions = ['QB', 'RB', 'WR', 'TE'];

  // Assign WORP-based position rank across ALL players (not just visible)
  const worpPosRankMap = {};
  positions.forEach(pos => {
    [...players]
      .filter(p => p.pos === pos)
      .sort((a, b) => b.worp - a.worp)
      .forEach((p, i) => { worpPosRankMap[p.name + pos] = i + 1; });
  });

  // Axis ranges — x is worp position rank (use visible players only)
  const maxPosRank = visiblePlayers.length
    ? Math.max(...visiblePlayers.map(p => worpPosRankMap[p.name + p.pos] || 1))
    : 1;
  const minWorp = Math.min(...visiblePlayers.map(p => p.worp));
  const maxWorp = Math.max(...visiblePlayers.map(p => p.worp));
  const worpPad = (maxWorp - minWorp) * 0.08 || 0.2;
  const yMin = Math.floor((minWorp - worpPad) * 10) / 10;
  const yMax = Math.ceil((maxWorp + worpPad) * 10) / 10;

  const xScale = r => PAD.left + ((r - 1) / Math.max(maxPosRank - 1, 1)) * innerW;
  const yScale = w => PAD.top + (1 - (w - yMin) / (yMax - yMin)) * innerH;

  // Enrich visible players with chart coords using worp position rank on x-axis
  const plotted = visiblePlayers.map((p) => {
    const worpRank = worpPosRankMap[p.name + p.pos] || 1;
    return {
      ...p,
      worpRank,
      cx: xScale(worpRank),
      cy: yScale(p.worp),
      onRoster: rosterNameSet.has(p.name),
    };
  });

  // Trend lines per position — sorted by worp rank so curve flows left→right
  const trendLines = positions.map(pos => {
    const pts = plotted
      .filter(p => p.pos === pos)
      .sort((a, b) => a.worpRank - b.worpRank)
      .map(p => ({ x: p.cx, y: p.cy }));
    return { pos, pts, path: smoothPath(pts) };
  });

  // Y-axis grid lines
  const yTicks = [];
  const step = (yMax - yMin) > 3 ? 0.5 : 0.25;
  for (let v = Math.ceil(yMin / step) * step; v <= yMax + 0.001; v = Math.round((v + step) * 100) / 100) {
    yTicks.push(v);
  }

  // X-axis ticks
  const xTicks = [];
  const xStep = maxPosRank <= 20 ? 5 : maxPosRank <= 50 ? 10 : 25;
  for (let r = 1; r <= maxPosRank; r += xStep) xTicks.push(r);
  if (xTicks[xTicks.length - 1] !== maxPosRank) xTicks.push(maxPosRank);

  return (
    <div style={{ backgroundColor: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: '16px 8px 8px' }}>
      {/* Position toggle buttons + legend */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {positions.map(pos => {
          const active = activePosSet.has(pos);
          const color = CHART_POS_COLOR[pos];
          return (
            <button
              key={pos}
              onClick={() => togglePos(pos)}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '5px 14px',
                backgroundColor: active ? color + '18' : '#f3f4f5',
                border: `2px solid ${active ? color : '#d1d5db'}`,
                borderRadius: 20,
                cursor: 'pointer',
                fontFamily: FONT,
                fontSize: 13,
                fontWeight: 700,
                color: active ? color : '#9ca3af',
                transition: 'all 0.15s',
                opacity: active ? 1 : 0.5,
              }}
            >
              <svg width={24} height={10} style={{ flexShrink: 0 }}>
                <line x1={0} y1={5} x2={24} y2={5} stroke={active ? color : '#d1d5db'} strokeWidth={2.5} />
                <circle cx={12} cy={5} r={4} fill={active ? color : '#d1d5db'} />
              </svg>
              {pos}
            </button>
          );
        })}
        <div style={{ width: 1, height: 20, background: C.border, margin: '0 4px' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#dc2626' }}>
          <svg width={16} height={16}>
            <circle cx={8} cy={8} r={6} fill="none" stroke="#dc2626" strokeWidth={2} />
            <circle cx={8} cy={8} r={3} fill="#dc2626" />
          </svg>
          <span style={{ fontWeight: 600 }}>On Your Roster</span>
        </div>
        <div style={{ width: 1, height: 20, background: C.border, margin: '0 4px' }} />
        <button onClick={() => setRosterOnly(r => !r)} style={{
          padding: '4px 12px', border: `1px solid ${rosterOnly ? C.blue : C.border}`,
          borderRadius: 4, backgroundColor: rosterOnly ? '#e8f0fe' : C.white,
          color: rosterOnly ? C.blue : C.textMid, fontFamily: FONT, fontSize: 12,
          fontWeight: rosterOnly ? 700 : 400, cursor: 'pointer',
        }}>
          {rosterOnly ? '★ Highlight Mine' : '☆ Highlight Mine'}
        </button>
      </div>

      {/* SVG chart */}
      <div style={{ overflowX: 'auto' }}>
        <svg width={W} height={H} style={{ display: 'block', maxWidth: '100%' }}>

          {/* Grid lines */}
          {yTicks.map(v => (
            <g key={v}>
              <line
                x1={PAD.left} y1={yScale(v)} x2={W - PAD.right} y2={yScale(v)}
                stroke="#e5e7eb" strokeWidth={1}
              />
              <text x={PAD.left - 8} y={yScale(v) + 4} textAnchor="end" fontSize={11} fill={C.textLight}>
                {v.toFixed(2)}
              </text>
            </g>
          ))}

          {/* WORP = 0 baseline */}
          {yMin < 0 && yMax > 0 && (
            <line
              x1={PAD.left} y1={yScale(0)} x2={W - PAD.right} y2={yScale(0)}
              stroke="#9ca3af" strokeWidth={1.5} strokeDasharray="5,4"
            />
          )}

          {/* Axes */}
          <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} stroke="#d1d5db" strokeWidth={1.5} />
          <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} stroke="#d1d5db" strokeWidth={1.5} />

          {/* X-axis ticks */}
          {xTicks.map(r => (
            <g key={r}>
              <line x1={xScale(r)} y1={H - PAD.bottom} x2={xScale(r)} y2={H - PAD.bottom + 5} stroke="#d1d5db" />
              <text x={xScale(r)} y={H - PAD.bottom + 16} textAnchor="middle" fontSize={11} fill={C.textLight}>
                {r}
              </text>
            </g>
          ))}

          {/* Axis labels */}
          <text x={W / 2} y={H - 6} textAnchor="middle" fontSize={12} fill={C.textMid} fontWeight={600}>
            Position Rank
          </text>
          <text
            x={14} y={PAD.top + innerH / 2}
            textAnchor="middle" fontSize={12} fill={C.textMid} fontWeight={600}
            transform={`rotate(-90, 14, ${PAD.top + innerH / 2})`}
          >
            WORP
          </text>

          {/* Trend lines (drawn below dots) */}
          {trendLines.map(({ pos, path }) => path && (
            <path
              key={pos}
              d={path}
              stroke={CHART_POS_COLOR[pos]}
              strokeWidth={2.5}
              fill="none"
              strokeOpacity={0.55}
            />
          ))}

          {/* Player dots */}
          {plotted.map((p, i) => (
            <g key={i}
              onMouseEnter={e => setTooltip({ player: p, x: p.cx, y: p.cy })}
              onMouseLeave={() => setTooltip(null)}
              style={{ cursor: 'pointer' }}
            >
              {p.onRoster ? (
                // On-roster: ring + filled dot
                <>
                  <circle cx={p.cx} cy={p.cy} r={8} fill="none" stroke="#dc2626" strokeWidth={2} />
                  <circle cx={p.cx} cy={p.cy} r={4.5} fill={CHART_POS_COLOR[p.pos]} />
                </>
              ) : (
                <circle cx={p.cx} cy={p.cy} r={4.5}
                  fill={CHART_POS_COLOR[p.pos]}
                  fillOpacity={0.8}
                />
              )}
            </g>
          ))}

          {/* Tooltip */}
          {tooltip && (() => {
            const { player: p, x, y } = tooltip;
            const boxW = 172, boxH = 80;
            const bx = Math.min(x + 12, W - PAD.right - boxW - 4);
            const by = Math.max(y - boxH / 2, PAD.top);
            const tier = TIER_CONFIG[p.tier_label] || TIER_CONFIG.Unranked;
            return (
              <g style={{ pointerEvents: 'none' }}>
                <rect x={bx} y={by} width={boxW} height={boxH} rx={6}
                  fill={C.white} stroke={C.border} strokeWidth={1}
                  style={{ filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.12))' }}
                />
                {/* Pos color bar */}
                <rect x={bx} y={by} width={4} height={boxH} rx={2} fill={CHART_POS_COLOR[p.pos]} />
                <text x={bx + 12} y={by + 18} fontSize={13} fontWeight={700} fill={C.textDark}>{p.name}</text>
                <text x={bx + 12} y={by + 33} fontSize={11} fill={C.textMid}>
                  {p.pos} · {p.team || 'FA'} · {p.pos}#{p.worpRank} by WORP
                </text>
                {/* Tier pill drawn as rect+text */}
                <rect x={bx + 12} y={by + 40} width={86} height={16} rx={8}
                  fill={tier.bg} stroke={tier.border} strokeWidth={1} />
                <text x={bx + 55} y={by + 52} textAnchor="middle" fontSize={10} fontWeight={600} fill={tier.color}>
                  {p.tier_label}
                </text>
                <text x={bx + 12} y={by + 70} fontSize={12} fill={C.textDark}>
                  <tspan fontWeight={700} fill={CHART_POS_COLOR[p.pos]}>{p.worp.toFixed(2)}</tspan>
                  <tspan fill={C.textMid}> WORP</tspan>
                  <tspan fill={C.textMid}>  ·  </tspan>
                  <tspan fontWeight={600}>{p.ppg != null ? p.ppg.toFixed(1) : '—'}</tspan>
                  <tspan fill={C.textMid}> PPG</tspan>
                </text>
                {p.onRoster && (
                  <text x={bx + boxW - 10} y={by + 18} textAnchor="end" fontSize={10} fontWeight={700} fill="#dc2626">
                    ✓ Yours
                  </text>
                )}
              </g>
            );
          })()}
        </svg>
      </div>
    </div>
  );
}

function TableHeader({ showRank }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: showRank ? '44px 2fr 70px 60px 130px 70px 60px 70px 80px' : '2fr 70px 60px 130px 70px 60px 70px 80px',
      gap: 10,
      padding: '8px 16px',
      fontSize: 12,
      fontWeight: 700,
      color: C.textMid,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    }}>
      {showRank && <div style={{ textAlign: 'center' }}>#</div>}
      <div>Player</div>
      <div style={{ textAlign: 'center' }}>Pos</div>
      <div style={{ textAlign: 'center' }}>Team</div>
      <div>Tier</div>
      <div style={{ textAlign: 'right' }}>WORP</div>
      <div style={{ textAlign: 'right' }}>PPG</div>
      <div style={{ textAlign: 'right' }}>Pts</div>
      <div style={{ textAlign: 'right' }}>FC Value</div>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{
      backgroundColor: C.white,
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: '40px 20px',
      textAlign: 'center',
      color: C.textMid,
    }}>
      No players match these filters.
    </div>
  );
}

function LeaderboardRow({ player, onRoster }) {
  const { name, pos, team, worp, tier_label, ppg, total_pts, fc_value, fc_trend, rank, pos_rank } = player;
  const posColor = POS_COLOR[pos] || C.textMid;
  const posBg    = POS_BG[pos]   || '#f9fafb';
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: '44px 2fr 70px 60px 130px 70px 60px 70px 80px',
        gap: 10,
        alignItems: 'center',
        padding: '11px 16px',
        backgroundColor: onRoster
          ? (hovered ? '#d1fae5' : '#f0fdf4')
          : (hovered ? '#f0f8ff' : C.white),
        border: `1px solid ${onRoster ? '#86efac' : (hovered ? '#c8e6f9' : C.border)}`,
        borderRadius: 6,
        fontSize: 14,
        transition: 'background 0.1s, border-color 0.1s',
      }}
    >
      {/* Rank */}
      <div style={{ textAlign: 'center', fontWeight: 700, color: rank <= 10 ? C.orange : C.textLight, fontSize: 13 }}>
        {rank}
      </div>

      {/* Name */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 700, color: C.textDark }}>{name}</span>
          {onRoster && (
            <span style={{
              fontSize: 10,
              backgroundColor: '#dcfce7',
              color: '#15803d',
              border: '1px solid #86efac',
              borderRadius: 10,
              padding: '1px 7px',
              fontWeight: 600,
            }}>On Roster</span>
          )}
        </div>
        {pos_rank && (
          <div style={{ fontSize: 11, color: C.textLight, marginTop: 1 }}>{pos}#{pos_rank} overall</div>
        )}
      </div>

      {/* Pos */}
      <div style={{ textAlign: 'center' }}>
        <span style={{
          backgroundColor: posBg,
          color: posColor,
          fontWeight: 700,
          fontSize: 12,
          padding: '3px 8px',
          borderRadius: 4,
          display: 'inline-block',
        }}>{pos}</span>
      </div>

      {/* Team */}
      <div style={{ color: C.textMid, textAlign: 'center', fontSize: 13 }}>{team || 'FA'}</div>

      {/* Tier */}
      <div><TierBadge label={tier_label} /></div>

      {/* WORP */}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 11, color: C.textLight, marginBottom: 1 }}>WORP</div>
        <div style={{ fontWeight: 700, fontSize: 16, color: TIER_CONFIG[tier_label]?.color || C.textMid }}>
          {worp.toFixed(2)}
        </div>
      </div>

      {/* PPG */}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 11, color: C.textLight, marginBottom: 1 }}>PPG</div>
        <div style={{ fontWeight: 700, fontSize: 16, color: C.textDark }}>
          {ppg != null ? ppg.toFixed(1) : '—'}
        </div>
      </div>

      {/* Total Points */}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 11, color: C.textLight, marginBottom: 1 }}>Pts</div>
        <div style={{ fontWeight: 700, fontSize: 15, color: total_pts != null ? C.textDark : C.textLight }}>
          {total_pts != null ? total_pts : '—'}
        </div>
      </div>

      {/* FantasyCalc Dynasty Value */}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 11, color: C.textLight, marginBottom: 1 }}>FC Value</div>
        <div style={{ fontWeight: 700, fontSize: 15, color: fc_value != null ? '#c45500' : C.textLight }}>
          {fc_value != null ? fc_value.toLocaleString() : '—'}
        </div>
        {fc_trend != null && fc_trend !== 0 && (
          <div style={{ fontSize: 10, color: fc_trend > 0 ? C.green : C.red }}>
            {fc_trend > 0 ? '▲' : '▼'} {Math.abs(Math.round(fc_trend))}
          </div>
        )}
      </div>
    </div>
  );
}

function LeagueRow({ name, sub, isAll, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        padding: '14px 20px',
        background: hovered ? '#f0f8ff' : 'transparent',
        border: 'none',
        borderBottom: `1px solid ${C.border}`,
        fontFamily: FONT,
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 0.1s',
      }}
    >
      <div>
        <div style={{
          fontWeight: isAll ? 700 : 400,
          fontSize: 15,
          color: isAll ? C.blue : C.textDark,
          marginBottom: 2,
        }}>
          {isAll ? '⊕ ' : ''}{name}
        </div>
        <div style={{ fontSize: 12, color: C.textMid }}>{sub}</div>
      </div>
      <span style={{ color: C.textLight, fontSize: 18 }}>›</span>
    </button>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const navBtn = {
  padding: '6px 14px',
  backgroundColor: 'transparent',
  border: `1px solid #888`,
  borderRadius: 4,
  color: C.white,
  fontFamily: FONT,
  fontSize: 13,
  cursor: 'pointer',
};
