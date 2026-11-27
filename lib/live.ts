// What a manager wants to see about their own squad while a tournament runs or between tournaments:
// their players' points and where they come from, their teams' next matches, who is not at the tournament.
import { q, now } from './db';
import { getEvents, computeStatus, computePoints, getSquad, getStandings, type Ev, type Mode, type SquadPlayer } from './game';
import { teamKey } from './liquipedia';

export type MatchLine = {
  id: string;
  ts: number;
  exact: boolean;
  bestof: number | null;
  section: string | null;
  name1: string | null;
  name2: string | null;
  score1: number | null;
  score2: number | null;
  winner: number | null;
  finished: boolean;
  live: boolean;
  stream: string | null;
  mine: { name: string; role: string; side: 1 | 2 }[];
};

export type PlayerMatch = { id: string; ts: number; opp: string | null; won: boolean | null; pts: number };
export type Source = { key: string; label: string; pts: number };
// benched: the team is there, but plays without this player (a stand-in, or they left the team).
export type TeamState = 'playing' | 'out' | 'won' | 'absent' | 'benched' | 'invited' | 'unknown';

export type DashPlayer = SquadPlayer & {
  lp_team: string | null;
  state: TeamState;
  place: string | null;
  evPts: number; // what the player added to the squad in the shown tournament
  rawPts: number; // the player's own points in that tournament since joining the squad
  counted: boolean; // bench: did they come in
  matches: PlayerMatch[];
  sources: Source[];
  nextTs: number | null;
  nextLive: boolean;
};

export type Dashboard = {
  scored: Ev | null; // tournament whose points are shown: the live one, else the last finished one
  upcoming: Ev | null; // the live tournament, else the next one
  live: boolean;
  day: [number, number] | null;
  evTotal: number;
  seasonTotal: number;
  rank: { pos: number; of: number } | null;
  seasonRank: { pos: number; of: number } | null;
  players: DashPlayer[];
  next: MatchLine[];
  teamsKnown: boolean; // Liquipedia has listed the teams of `upcoming`
  scheduleKnown: boolean;
};

export const SOURCE_LABEL: Record<string, string> = {
  kills: 'Kills',
  deaths: 'Deaths',
  assists: 'Assists',
  last_hits: 'Last hits',
  gold_per_min: 'GPM',
  xp_per_min: 'XPM',
  stuns: 'Stuns',
  hero_healing: 'Healing',
  towers_killed: 'Towers',
  roshans_killed: 'Roshans',
  firstblood_claimed: 'First blood',
  obs_placed: 'Wards',
  camps_stacked: 'Stacks',
  rune_pickups: 'Runes',
  teamfight_participation: 'Teamfights',
};

const keyOf = (p: { lp_team?: string | null; team_name: string | null }) => p.lp_team || teamKey(p.team_name) || null;

export async function getDashboard(userId: number, mode: Mode): Promise<Dashboard | null> {
  const squad = await getSquad(userId, mode);
  if (!squad) return null;
  const t = now();
  const events = await getEvents();
  const status = computeStatus(events, t);
  const season = events.filter((e) => e.multiplier > 0 && e.starts_at != null && e.ends_at != null);
  const lastDone = season.filter((e) => e.ends_at! < t).sort((a, b) => b.ends_at! - a.ends_at!)[0] ?? null;
  const scored = status.live ?? lastDone;
  const upcoming = status.live ?? status.next;

  const ids = squad.players.map((p) => p.account_id);
  const inIds = (from: number) => ids.map((_, i) => `$${from + i}`).join(',');
  const extra = new Map(
    (await q(`SELECT account_id, lp_team FROM pro_players WHERE account_id IN (${inIds(1)})`, ids)).map((r) => [r.account_id as string, r.lp_team as string | null]),
  );
  const slots = new Map(
    (await q(`SELECT id, from_ts FROM roster_slots WHERE user_id = $1 AND mode = $2 AND to_ts IS NULL`, [userId, mode])).map((r) => [r.id as number, r.from_ts as number]),
  );
  const points = (await computePoints(mode, [userId])).get(userId);

  // Each player's matches in the shown tournament, since they joined the squad.
  const pm = scored
    ? await q(
        `SELECT pm.account_id, pm.points::float8 AS pts, pm.breakdown, m.match_id, m.start_time, m.radiant_name, m.dire_name, m.radiant_win
         FROM player_match_points pm JOIN matches m ON m.match_id = pm.match_id
         WHERE m.event_key = $1 AND pm.account_id IN (${inIds(2)}) ORDER BY m.start_time DESC`,
        [scored.key, ...ids],
      )
    : [];

  // Teams at the upcoming tournament with their lineups, and its schedule.
  const teams = upcoming ? await q(`SELECT team, name, place, lineup FROM event_teams WHERE event_key = $1`, [upcoming.key]) : [];
  const lineup = new Map(
    upcoming
      ? (await q(`SELECT account_id, team FROM event_players WHERE event_key = $1 AND account_id IN (${inIds(2)})`, [upcoming.key, ...ids])).map(
          (r) => [r.account_id as string, r.team as string],
        )
      : [],
  );
  // While a tournament is on: which games each team has played so far, to see who sits out.
  const teamGames = new Map<string, number[]>();
  if (status.live) {
    for (const r of await q(`SELECT start_time, radiant_name, dire_name FROM matches WHERE event_key = $1`, [status.live.key])) {
      for (const k of new Set([teamKey(r.radiant_name), teamKey(r.dire_name)])) if (k) teamGames.set(k, [...(teamGames.get(k) ?? []), r.start_time]);
    }
  }
  const teamMap = new Map(teams.map((r) => [r.team as string, r]));
  const sched = upcoming
    ? await q(`SELECT * FROM lp_matches WHERE event_key = $1 AND finished = FALSE AND ts >= $2 ORDER BY ts, id`, [upcoming.key, t - 5 * 3600])
    : [];

  const players: DashPlayer[] = squad.players.map((p) => {
    // The tournament lineup knows best which team a player is with right now.
    const tk = lineup.get(p.account_id) || extra.get(p.account_id) || teamKey(p.team_name) || null;
    const from = slots.get(p.slot_id) ?? 0;
    const mine = pm.filter((r) => r.account_id === p.account_id && r.start_time >= from);
    const sums = new Map<string, number>();
    for (const r of mine) {
      let b: Record<string, { points: number }> = {};
      try {
        b = JSON.parse(r.breakdown ?? '{}');
      } catch {}
      for (const [k, v] of Object.entries(b)) sums.set(k, (sums.get(k) ?? 0) + (Number(v?.points) || 0));
    }
    const sources = [...sums]
      .filter(([, v]) => Math.abs(v) >= 0.05)
      .map(([k, v]) => ({ key: k, label: SOURCE_LABEL[k] ?? k, pts: v }))
      .sort((a, b) => b.pts - a.pts);
    // The five biggest sources, plus whatever costs points (deaths).
    const shownSources = [...sources.filter((x) => x.pts > 0).slice(0, 5), ...sources.filter((x) => x.pts < 0)];
    const matches = mine.map((r) => {
      const rk = teamKey(r.radiant_name);
      const dk = teamKey(r.dire_name);
      const radiant = tk && rk === tk ? true : tk && dk === tk ? false : null;
      return {
        id: r.match_id,
        ts: r.start_time,
        opp: radiant === true ? r.dire_name : radiant === false ? r.radiant_name : null,
        won: radiant == null || r.radiant_win == null ? null : radiant === r.radiant_win,
        pts: r.pts,
      };
    });
    const entry = tk ? teamMap.get(tk) : undefined;
    // Sitting out: Liquipedia lists the team's lineup without this player, or the team has played
    // two or more games at this tournament since the player last played (or without them at all).
    const notListed = !!entry && entry.lineup > 0 && !lineup.has(p.account_id);
    const lastOwn = Math.max(0, ...pm.filter((r) => r.account_id === p.account_id).map((r) => r.start_time as number));
    const gamesWithout = tk ? (teamGames.get(tk) ?? []).filter((ts) => ts > lastOwn).length : 0;
    const sitsOut = notListed || gamesWithout >= 2;
    let state: TeamState = 'unknown';
    if (upcoming && teams.length) {
      if (!entry) state = 'absent';
      else if (entry.place === '1' && status.live) state = 'won';
      else if (entry.place && status.live) state = 'out';
      else if (sitsOut) state = 'benched';
      else if (!status.live) state = 'invited';
      else state = 'playing';
    }
    const nextMatch = tk ? sched.find((m) => m.team1 === tk || m.team2 === tk) : undefined;
    const counted = scored ? points?.slotEvents.has(`${p.slot_id}|${scored.key}`) ?? false : false;
    return {
      ...p,
      lp_team: tk,
      state,
      place: entry?.place ?? null,
      evPts: scored ? points?.slotEvents.get(`${p.slot_id}|${scored.key}`) ?? 0 : 0,
      rawPts: mine.reduce((a, r) => a + r.pts, 0),
      counted,
      matches,
      sources: shownSources,
      nextTs: nextMatch ? nextMatch.ts : null,
      nextLive: !!nextMatch && nextMatch.ts <= t,
    } as DashPlayer;
  });

  const keys = new Map<string, DashPlayer[]>();
  for (const p of players) if (p.lp_team) keys.set(p.lp_team as string, [...(keys.get(p.lp_team as string) ?? []), p]);
  const next: MatchLine[] = sched
    .filter((m) => keys.has(m.team1) || keys.has(m.team2))
    .slice(0, 8)
    .map((m) => ({
      id: m.id,
      ts: m.ts,
      exact: m.exact,
      bestof: m.bestof,
      section: m.section,
      name1: m.name1,
      name2: m.name2,
      score1: m.score1,
      score2: m.score2,
      winner: m.winner,
      finished: m.finished,
      live: m.ts <= t,
      stream: m.stream,
      mine: [
        ...(keys.get(m.team1) ?? []).map((p) => ({ name: p.name, role: p.role, side: 1 as const })),
        ...(keys.get(m.team2) ?? []).map((p) => ({ name: p.name, role: p.role, side: 2 as const })),
      ],
    }));

  const rankIn = async (eventKey?: string) => {
    const rows = await getStandings({ mode, eventKey, limit: 5000 });
    const i = rows.findIndex((r) => r.id === userId);
    return i >= 0 ? { pos: i + 1, of: rows.length } : null;
  };
  let day: [number, number] | null = null;
  if (status.live) {
    const len = Math.round((status.live.ends_at! - 30 * 3600 + 1 - status.live.starts_at!) / 86400) + 1;
    day = [Math.min(len, Math.floor((t - status.live.starts_at!) / 86400) + 1), len];
  }
  const pen =
    mode === 'casual'
      ? (await q(`SELECT COALESCE(SUM(penalty), 0)::float8 AS p FROM transfers WHERE user_id = $1 AND mode = 'casual'`, [userId]))[0].p
      : 0;

  return {
    scored,
    upcoming,
    live: !!status.live,
    day,
    evTotal: scored ? points?.events.get(scored.key) ?? 0 : 0,
    seasonTotal: (points?.total ?? 0) - pen,
    rank: scored ? await rankIn(scored.key) : null,
    seasonRank: await rankIn(),
    players,
    next,
    teamsKnown: teams.length > 0,
    scheduleKnown: sched.length > 0,
  };
}
