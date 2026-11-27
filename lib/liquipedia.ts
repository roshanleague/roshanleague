// Current team rosters and positions from Liquipedia (LiquipediaDB API, data CC-BY-SA, liquipedia.net).
// Liquipedia knows about transfers and stand-ins as soon as they are announced; OpenDota only after
// a player's first match for the new team. Without LIQUIPEDIA_API_KEY nothing changes and the site
// runs on OpenDota alone. If Liquipedia stops answering, its data is used for 3 more days, then
// OpenDota takes over again (see the lp_at checks in opendota.ts).
import { q, tx, now, dayStart, dayEnd } from './db';

const BASE = 'https://api.liquipedia.net/api/v3';

async function lp(type: string, params: Record<string, string | number>): Promise<any[]> {
  const key = process.env.LIQUIPEDIA_API_KEY;
  if (!key) throw new Error('LIQUIPEDIA_API_KEY is not set');
  const qs = new URLSearchParams({ wiki: 'dota2', ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const res = await fetch(`${BASE}/${type}?${qs}`, {
    headers: { Authorization: `Apikey ${key}`, 'User-Agent': 'RoshanLeague (https://roshanleague.com)', 'Accept-Encoding': 'gzip' },
    signal: AbortSignal.timeout(30000),
  });
  const j: any = await res.json().catch(() => null);
  if (!res.ok || !j || j.error?.length) throw new Error(`Liquipedia ${type}: HTTP ${res.status} ${JSON.stringify(j?.error ?? '').slice(0, 200)}`);
  return j.result ?? [];
}

async function all(type: string, params: Record<string, string | number>): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const page = await lp(type, { ...params, limit: 1000, offset });
    out.push(...page);
    if (page.length < 1000) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return out;
}

const norm = (page: string) => page.trim().replace(/ /g, '_').toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One short form for a team, so a Liquipedia page ("LEGION_(team)"), a Liquipedia display name
// ("LEGION (team)") and an OpenDota name ("Team LEGION") all come out the same: "legion".
export function teamKey(name: string | null | undefined): string {
  return String(name ?? '')
    .replace(/_/g, ' ')
    .replace(/\s*\(.*?\)\s*$/, '')
    .toLowerCase()
    .replace(/^team\s+/, '')
    .replace(/\s+(team|gaming|esports)$/, '')
    .replace(/[^a-z0-9]+/g, '');
}
const teamName = (page: string) => page.replace(/_/g, ' ').replace(/\s*\(.*\)$/, '').trim();
const isDate = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !/-00/.test(d);

export type LpReport = { squads: number; moved: number };

// Liquipedia player page -> Steam account id, looked up 40 pages per request.
async function accountIds(rawPages: string[]): Promise<Map<string, string>> {
  const pages = [...new Set(rawPages.map((p) => p.trim().replace(/ /g, '_')).filter(Boolean))];
  const players: any[] = [];
  for (let i = 0; i < pages.length; i += 40) {
    await sleep(2000);
    const cond = pages
      .slice(i, i + 40)
      .map((p) => `[[pagename::${p.replace(/[\[\]|]/g, '')}]]`)
      .join(' OR ');
    players.push(...(await lp('player', { conditions: cond, query: 'pagename,extradata', limit: 1000 })));
  }
  const idOf = new Map<string, string>();
  for (const p of players) {
    const id = String(p.extradata?.playerid ?? '').trim();
    if (/^\d+$/.test(id)) idOf.set(norm(p.pagename), id);
  }
  return idOf;
}

// The player pages a tournament lists for one team (p1, p2, ... in opponentplayers; coaches are c1, ...).
function lineupPages(raw: unknown): string[] {
  let o: any = raw;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      return [];
    }
  }
  if (!o || typeof o !== 'object') return [];
  return Object.entries(o)
    .filter(([k, v]) => /^p\d+$/.test(k) && typeof v === 'string' && v.trim() && !/^tbd$/i.test(v.trim()))
    .map(([, v]) => String(v).trim().replace(/ /g, '_'));
}

// Sets team and position of every tracked player who is on a Liquipedia active roster
// (stand-ins excluded). Players on no roster keep their last known team.
export async function refreshRosters(): Promise<LpReport> {
  const squads = await all('squadplayer', { conditions: '[[status::active]] AND [[type::player]]', query: 'pagename,link,id,position,role' });
  // The player pages of everyone on a roster, for their Steam account id.
  const idOf = await accountIds(squads.map((s) => String(s.link || s.id || '')));
  const ours = new Map((await q(`SELECT account_id, team_id, team_name, lp_at FROM pro_players`)).map((r) => [r.account_id as string, r]));

  // One roster entry per player: skip stand-ins and players listed on two active rosters.
  const entries = new Map<string, { team: string; pos: number | null }>();
  const twice = new Set<string>();
  for (const s of squads) {
    if (/stand|loan|sub/i.test(String(s.role ?? ''))) continue;
    const id = idOf.get(norm(s.link || s.id || ''));
    if (!id || !ours.has(id)) continue;
    if (entries.has(id)) twice.add(id);
    const pos = Number(s.position);
    entries.set(id, { team: s.pagename, pos: pos >= 1 && pos <= 5 ? pos : null });
  }
  for (const id of twice) entries.delete(id);

  // Keep OpenDota's team ids where we can, so a team stays one team for the 2-per-team limit:
  // a Liquipedia team takes the OpenDota id most of its players already have.
  const votes = new Map<string, Map<string, number>>();
  for (const [id, e] of entries) {
    const od = ours.get(id)!.team_id;
    if (!od || String(od).startsWith('lp:')) continue;
    const v = votes.get(e.team) ?? votes.set(e.team, new Map()).get(e.team)!;
    v.set(od, (v.get(od) ?? 0) + 1);
  }
  const odKey = new Map<string, string>();
  const usedKeys = new Set<string>();
  for (const [team, v] of [...votes].sort((a, b) => Math.max(...b[1].values()) - Math.max(...a[1].values()))) {
    const best = [...v].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 2 && !usedKeys.has(best[0])) {
      odKey.set(team, best[0]);
      usedKeys.add(best[0]);
    }
  }
  const nameOf = (page: string) => page.replace(/_/g, ' ').replace(/\s*\(.*\)$/, '');

  const t = now();
  const rows: [string, string | null, string | null, number | null, string][] = [];
  let moved = 0;
  for (const [id, e] of entries) {
    const key = odKey.get(e.team) ?? `lp:${e.team}`;
    if (ours.get(id)!.team_id !== key) moved++;
    rows.push([id, key, nameOf(e.team), e.pos, teamKey(e.team)]);
  }
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const vals: any[] = [t];
    const tuples = chunk.map((r, j) => {
      vals.push(...r);
      const n = 1 + j * 5;
      return `($${n + 1}::text, $${n + 2}::text, $${n + 3}::text, $${n + 4}::int, $${n + 5}::text)`;
    });
    await q(
      `UPDATE pro_players p SET team_id = v.tid, team_name = v.tname, lp_pos = v.pos, lp_team = v.lt, lp_at = $1
       FROM (VALUES ${tuples.join(',')}) AS v(id, tid, tname, pos, lt) WHERE p.account_id = v.id`,
      vals,
    );
  }
  return { squads: entries.size, moved };
}


// ---------------------------------------------------------------------------
// Tournaments: dates, league id and invited teams, for every event with an `lp` page in season.config.ts.
// ---------------------------------------------------------------------------

export type TourReport = { dated: string[]; ids: string[]; teams: number; lineups: number };

export async function refreshTournaments(): Promise<TourReport> {
  const evs = await q(`SELECT key, lp_page, league_id, starts_at, ends_at, lp_start, lp_end FROM events WHERE lp_page IS NOT NULL ORDER BY sort`);
  const report: TourReport = { dated: [], ids: [], teams: 0, lineups: 0 };
  if (!evs.length) return report;
  const byPage = new Map(evs.map((e) => [norm(e.lp_page), e]));
  const cond = (field: string, list: any[]) => list.map((e) => `[[${field}::${String(e.lp_page).replace(/[\[\]|]/g, '')}]]`).join(' OR ');

  const tours = await lp('tournament', { conditions: cond('pagename', evs), query: 'pagename,startdate,enddate,extradata', limit: 100 });
  for (const r of tours) {
    const e = byPage.get(norm(r.pagename));
    if (!e) continue;
    const start = isDate(r.startdate) ? dayStart(r.startdate) : null;
    const end = isDate(r.enddate) ? dayEnd(r.enddate) : null;
    const lid = /^\d+$/.test(String(r.extradata?.leagueid ?? '')) ? Number(r.extradata.leagueid) : null;
    await q(`UPDATE events SET lp_start = $2, lp_end = $3, league_id = COALESCE(league_id, $4) WHERE key = $1`, [
      e.key,
      start != null && end != null ? start : null,
      start != null && end != null ? end : null,
      lid,
    ]);
    if (start != null && end != null) report.dated.push(e.key);
    if (lid != null && e.league_id == null) report.ids.push(`${e.key}=${lid}`);
  }

  // Invited and qualified teams of tournaments that are not long over. Liquipedia lists them as
  // placements; a placement ("13-16") appears once the team is out. With each team, its lineup for
  // the tournament (stand-ins included), read for tournaments that are on or start within two weeks.
  const t = now();
  const open = evs.filter((e) => (e.lp_end ?? e.ends_at) == null || (e.lp_end ?? e.ends_at) > t - 3 * 86400);
  if (!open.length) return report;
  await sleep(2000);
  const rows = await lp('placement', { conditions: cond('parent', open), query: 'parent,opponentname,placement,opponentplayers', limit: 1000 });
  const soon = new Set(open.filter((e) => (e.lp_start ?? e.starts_at) != null && (e.lp_start ?? e.starts_at) <= t + 14 * 86400).map((e) => e.key));
  const per = new Map<string, Map<string, [string, string | null, string[]]>>();
  for (const r of rows) {
    const e = byPage.get(norm(r.parent));
    const name = String(r.opponentname ?? '').trim();
    if (!e || !name || /^tbd$/i.test(name)) continue;
    const m = per.get(e.key) ?? per.set(e.key, new Map()).get(e.key)!;
    m.set(teamKey(name), [teamName(name), String(r.placement ?? '').trim() || null, soon.has(e.key) ? lineupPages(r.opponentplayers) : []]);
  }
  const allPages = [...per.values()].flatMap((m) => [...m.values()].flatMap((v) => v[2]));
  const idOf = allPages.length ? await accountIds(allPages) : new Map<string, string>();
  await tx(async (query) => {
    for (const [key, teams] of per) {
      await query(`DELETE FROM event_teams WHERE event_key = $1`, [key]);
      await query(`DELETE FROM event_players WHERE event_key = $1`, [key]);
      for (const [team, [name, place, pages]] of teams) {
        await query(`INSERT INTO event_teams (event_key, team, name, place, lineup) VALUES ($1, $2, $3, $4, $5)`, [key, team, name, place, pages.length]);
        report.teams++;
        for (const page of pages) {
          const id = idOf.get(norm(page));
          if (!id) continue;
          await query(`INSERT INTO event_players (event_key, account_id, team) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [key, id, team]);
          report.lineups++;
        }
      }
    }
  });
  return report;
}

// ---------------------------------------------------------------------------
// Match schedule of tournaments that are on now or start within two weeks.
// ---------------------------------------------------------------------------

function streamUrl(s: any): string | null {
  if (!s || typeof s !== 'object') return null;
  const tw = s.twitch_en_1 || s.twitch;
  if (tw) return `https://www.twitch.tv/${encodeURIComponent(tw)}`;
  const kick = s.kick_en_1 || s.kick;
  if (kick) return `https://kick.com/${encodeURIComponent(kick)}`;
  return null;
}

export async function refreshMatches(events: { key: string; lp_page: string | null }[]): Promise<number> {
  const evs = events.filter((e) => e.lp_page);
  if (!evs.length) return 0;
  const byPage = new Map(evs.map((e) => [norm(e.lp_page!), e.key]));
  const rows = await all('match', {
    conditions: evs.map((e) => `[[parent::${e.lp_page!.replace(/[\[\]|]/g, '')}]]`).join(' OR '),
    query: 'match2id,parent,date,dateexact,finished,bestof,section,winner,match2opponents,stream',
    order: 'date ASC',
  });
  const per = new Map<string, any[][]>();
  for (const r of rows) {
    const key = byPage.get(norm(r.parent ?? ''));
    const ts = Date.parse(String(r.date ?? '').replace(' ', 'T') + 'Z');
    // Matches without a real date yet come as year 0000.
    if (!key || !r.match2id || !Number.isFinite(ts) || ts < Date.UTC(2020, 0, 1)) continue;
    const o = Array.isArray(r.match2opponents) ? r.match2opponents : [];
    const side = (i: number) => {
      const name = String(o[i]?.name ?? '').trim();
      const known = name && !/^tbd$/i.test(name);
      const score = Number(o[i]?.score);
      return { key: known ? teamKey(name) : null, name: known ? teamName(name) : null, score: Number.isFinite(score) && score >= 0 ? score : null };
    };
    const a = side(0);
    const b = side(1);
    const w = Number(r.winner);
    const list = per.get(key) ?? per.set(key, []).get(key)!;
    list.push([
      String(r.match2id), key, Math.floor(ts / 1000), Number(r.dateexact) === 1, Number(r.bestof) || null, String(r.section ?? '') || null,
      a.key, b.key, a.name, b.name, a.score, b.score, w === 1 || w === 2 ? w : null, Number(r.finished) === 1, streamUrl(r.stream),
    ]);
  }
  let n = 0;
  await tx(async (query) => {
    for (const [key, list] of per) {
      await query(`DELETE FROM lp_matches WHERE event_key = $1`, [key]);
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        const vals: any[] = [];
        const tuples = chunk.map((r, j) => {
          vals.push(...r);
          const k = j * 15;
          return `(${Array.from({ length: 15 }, (_, x) => `$${k + x + 1}`).join(',')})`;
        });
        await query(
          `INSERT INTO lp_matches (id, event_key, ts, exact, bestof, section, team1, team2, name1, name2, score1, score2, winner, finished, stream)
           VALUES ${tuples.join(',')} ON CONFLICT (id) DO NOTHING`,
          vals,
        );
      }
      n += list.length;
    }
  });
  return n;
}
