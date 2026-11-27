// Another manager's squad, as anyone may see it. Only squads of tournaments that have started are shown,
// so picks made during an open transfer window stay hidden until the next tournament locks them.
import { q, now } from './db';
import { getEvents, computeStatus, computePoints, getStandings, type Ev, type Mode } from './game';
import type { Role } from '@/season.config';

export type ManagerPlayer = {
  account_id: string;
  name: string;
  team_name: string | null;
  role: Role;
  bench: boolean;
  pts: number; // what the player added to this squad in the tournament
  counted: boolean; // bench: did they come in
  left: boolean; // replaced during the tournament
};

export type ManagerView = {
  name: string;
  event: Ev | null; // the tournament whose squad is shown
  live: boolean;
  events: Ev[]; // tournaments that have started, for switching
  players: ManagerPlayer[];
  evTotal: number;
  rank: { pos: number; of: number } | null;
  seasonTotal: number;
  seasonRank: { pos: number; of: number } | null;
};

const ORDER: Record<string, number> = { core: 0, mid: 1, support: 2 };

export async function getManagerView(userId: number, mode: Mode, eventKey?: string): Promise<ManagerView | null> {
  const user = (await q(`SELECT u.name FROM users u JOIN rosters r ON r.user_id = u.id AND r.mode = $2 WHERE u.id = $1`, [userId, mode]))[0];
  if (!user) return null;
  const t = now();
  const all = await getEvents();
  const status = computeStatus(all, t);
  const started = all.filter((e) => e.multiplier > 0 && e.starts_at != null && e.ends_at != null && e.starts_at <= t);
  const lastDone = started.filter((e) => e.ends_at! < t).sort((a, b) => b.ends_at! - a.ends_at!)[0] ?? null;
  const event = started.find((e) => e.key === eventKey) ?? status.live ?? lastDone;

  const rankIn = async (key?: string) => {
    const rows = await getStandings({ mode, eventKey: key, limit: 5000 });
    const i = rows.findIndex((r) => r.id === userId);
    return i >= 0 ? { pos: i + 1, of: rows.length, total: rows[i].total } : null;
  };
  const season = await rankIn();

  let players: ManagerPlayer[] = [];
  let evTotal = 0;
  let rank: { pos: number; of: number } | null = null;
  if (event) {
    const slots = await q(
      `SELECT s.id, s.account_id, s.bench, s.to_ts, COALESCE(s.role, p.role) AS role, p.name, p.team_name
       FROM roster_slots s JOIN pro_players p ON p.account_id = s.account_id
       WHERE s.user_id = $1 AND s.mode = $2 AND s.from_ts <= $3 AND (s.to_ts IS NULL OR s.to_ts > $4)`,
      [userId, mode, event.ends_at, event.starts_at],
    );
    const points = (await computePoints(mode, [userId])).get(userId);
    players = slots
      .map((s) => {
        const k = `${s.id}|${event.key}`;
        return {
          account_id: s.account_id,
          name: s.name,
          team_name: s.team_name,
          role: s.role,
          bench: !!s.bench,
          pts: points?.slotEvents.get(k) ?? 0,
          counted: points?.slotEvents.has(k) ?? false,
          left: s.to_ts != null && s.to_ts <= event.ends_at!,
        } as ManagerPlayer;
      })
      .sort((a, b) => Number(a.bench) - Number(b.bench) || Number(a.left) - Number(b.left) || ORDER[a.role] - ORDER[b.role] || b.pts - a.pts);
    evTotal = points?.events.get(event.key) ?? 0;
    const r = await rankIn(event.key);
    rank = r ? { pos: r.pos, of: r.of } : null;
  }

  return {
    name: user.name,
    event,
    live: !!event && event.key === status.live?.key,
    events: started.sort((a, b) => a.starts_at! - b.starts_at!),
    players,
    evTotal,
    rank,
    seasonTotal: season?.total ?? 0,
    seasonRank: season ? { pos: season.pos, of: season.of } : null,
  };
}
