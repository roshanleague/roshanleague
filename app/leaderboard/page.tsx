import Link from 'next/link';
import ModeFrame from '@/app/ModeFrame';
import { getUser } from '@/lib/auth';
import { q, now } from '@/lib/db';
import { getEvents, getStandings, standingsUpdatedAt, fmtPts, isMode, type Mode } from '@/lib/game';

export const metadata = { title: 'Leaderboard' };

export default async function Leaderboard({ searchParams }: { searchParams: Promise<{ event?: string; league?: string; mode?: string }> }) {
  const sp = await searchParams;
  const mode: Mode = isMode(sp.mode) ? sp.mode : 'casual';
  const t = now();
  const user = await getUser();
  const events = (await getEvents()).filter((e) => e.multiplier > 0 && e.starts_at != null && e.starts_at <= t);
  const event = events.find((e) => e.key === sp.event);
  const league = sp.league ? (await q(`SELECT id, name, code FROM leagues WHERE code = $1`, [sp.league]))[0] : null;
  const myLeagues = user
    ? await q(`SELECT l.name, l.code FROM leagues l JOIN league_members m ON m.league_id = l.id WHERE m.user_id = $1 ORDER BY l.name`, [user.id])
    : [];
  const rows = await getStandings({ mode, eventKey: event?.key, leagueId: league?.id, limit: 500 });
  const updated = await standingsUpdatedAt();
  const ago = updated ? Math.max(0, Math.round((t - updated) / 60)) : null;
  const href = (o: { mode?: Mode; ev?: string; lg?: string }) => {
    const p = new URLSearchParams();
    const m = o.mode ?? mode;
    if (m !== 'casual') p.set('mode', m);
    if (o.ev) p.set('event', o.ev);
    if (o.lg) p.set('league', o.lg);
    const s = p.toString();
    return `/leaderboard${s ? `?${s}` : ''}`;
  };
  const grind = mode === 'grind';

  return (
    <>
      <section className="hero" style={{ paddingBottom: 0 }}>
        <h1 className="page">{league ? league.name : 'Leaderboard'}</h1>
        <p className="muted">
          {grind ? 'Grind' : 'Casual'}, {event ? `${event.name} only` : 'whole season'}
          {league ? ', this league' : ', everyone'}. Tap a manager to see their squad. Points are added about every 30 minutes
          {ago != null ? `; last update ${ago < 2 ? 'just now' : `${ago} minutes ago`}` : ''}.
        </p>
      </section>

      <ModeFrame mode={mode} />
      <div className="tabs" aria-label="Game mode">
        <Link href={href({ mode: 'casual', ev: sp.event, lg: sp.league })} className={!grind ? 'on' : ''}>
          Casual
        </Link>
        <Link href={href({ mode: 'grind', ev: sp.event, lg: sp.league })} className={grind ? 'on' : ''}>
          Grind
        </Link>
      </div>
      <div className="tabs" aria-label="Tournament">
        <Link href={href({ lg: sp.league })} className={!event ? 'on' : ''}>
          Season
        </Link>
        {events.map((e) => (
          <Link key={e.key} href={href({ ev: e.key, lg: sp.league })} className={event?.key === e.key ? 'on' : ''}>
            {e.name}
          </Link>
        ))}
      </div>
      {myLeagues.length > 0 && (
        <div className="tabs" aria-label="League">
          <Link href={href({ ev: sp.event })} className={!league ? 'on' : ''}>
            Everyone
          </Link>
          {myLeagues.map((l) => (
            <Link key={l.code} href={href({ ev: sp.event, lg: l.code })} className={league?.code === l.code ? 'on' : ''}>
              {l.name}
            </Link>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="muted">No squads here yet.</p>
      ) : (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Manager</th>
                {grind ? <th className="r">Squad and coins</th> : <th className="r">Penalties</th>}
                <th className="r">Points</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className={user?.id === r.id ? 'me' : ''}>
                  <td className="rank">{i + 1}</td>
                  <td>
                    <Link href={`/manager/${r.id}${grind || event ? `?${new URLSearchParams({ ...(grind ? { mode } : {}), ...(event ? { event: event.key } : {}) })}` : ''}`}>
                      {r.name}
                    </Link>
                  </td>
                  {grind ? (
                    <td className="r num muted">{r.value}</td>
                  ) : (
                    <td className="r num muted">{r.pen > 0 ? `−${fmtPts(r.pen)}` : ''}</td>
                  )}
                  <td className="r num">{fmtPts(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
