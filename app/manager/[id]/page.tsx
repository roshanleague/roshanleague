// Another manager's squad and what each player earned them. Linked from the leaderboard.
import Link from 'next/link';
import ModeFrame from '@/app/ModeFrame';
import { getUser } from '@/lib/auth';
import { fmtPts, isMode, type Mode } from '@/lib/game';
import { getManagerView, type ManagerPlayer } from '@/lib/manager';

export const metadata = { title: 'Manager' };

const ROLE: Record<string, string> = { core: 'Core', mid: 'Mid', support: 'Support' };

function Player({ p }: { p: ManagerPlayer }) {
  return (
    <li className={`pl ${p.role}${p.bench ? ' bench' : ''}`}>
      <div className="line">
        <span className="pinfo">
          <span className="nm">{p.name}</span>
          <span className="small muted">
            {p.bench ? `Bench ${ROLE[p.role].toLowerCase()}` : ROLE[p.role]} · {p.team_name ?? 'No team'}
          </span>
          {(p.left || (p.bench && !p.counted)) && (
            <span className="row" style={{ gap: 6, marginTop: 3 }}>
              {p.left && <span className="pill dim">Replaced</span>}
              {p.bench && !p.counted && <span className="pill dim">Not counted</span>}
            </span>
          )}
        </span>
        <span className="pts">
          <b className="num">{fmtPts(p.pts)}</b>
        </span>
      </div>
    </li>
  );
}

export default async function ManagerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mode?: string; event?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const mode: Mode = isMode(sp.mode) ? sp.mode : 'casual';
  const uid = /^\d+$/.test(id) ? Number(id) : NaN;
  const [me, v] = await Promise.all([getUser(), Number.isFinite(uid) ? getManagerView(uid, mode, sp.event) : null]);
  const back = `/leaderboard${mode !== 'casual' ? `?mode=${mode}` : ''}`;

  if (!v) {
    return (
      <section className="hero">
        <h1 className="page">No squad here</h1>
        <p className="muted">This manager has no {mode === 'grind' ? 'Grind' : 'Casual'} squad.</p>
        <Link href={back} className="btn plain">
          Back to the leaderboard
        </Link>
      </section>
    );
  }

  const href = (o: { mode?: Mode; ev?: string }) => {
    const p = new URLSearchParams();
    const m = o.mode ?? mode;
    if (m !== 'casual') p.set('mode', m);
    if (o.ev) p.set('event', o.ev);
    const s = p.toString();
    return `/manager/${uid}${s ? `?${s}` : ''}`;
  };
  const starters = v.players.filter((p) => !p.bench);
  const bench = v.players.filter((p) => p.bench);

  return (
    <>
      <section className="hero" style={{ paddingBottom: 0 }}>
        <h1 className="page">{v.name}</h1>
        <p className="muted">
          {me?.id === uid ? 'This is how others see your squad. ' : ''}
          Squads show once a tournament starts, so picks for the next one stay hidden until then.
        </p>
      </section>

      <ModeFrame mode={mode} />
      <div className="tabs" aria-label="Game mode">
        <Link href={href({ mode: 'casual', ev: sp.event })} className={mode === 'casual' ? 'on' : ''}>
          Casual
        </Link>
        <Link href={href({ mode: 'grind', ev: sp.event })} className={mode === 'grind' ? 'on' : ''}>
          Grind
        </Link>
      </div>
      {v.events.length > 1 && (
        <div className="tabs" aria-label="Tournament">
          {v.events.map((e) => (
            <Link key={e.key} href={href({ ev: e.key })} className={v.event?.key === e.key ? 'on' : ''}>
              {e.name}
            </Link>
          ))}
        </div>
      )}

      <div className="dash">
        <div className="headline">
          {v.live && <span className="tag live">Live</span>} <b>{v.event ? v.event.name : 'No tournament yet'}</b>
        </div>
        <div className="stats">
          {v.event && (
            <div>
              <span className="k">{v.live ? 'This tournament' : v.event.name}</span>
              <b className="num">{fmtPts(v.evTotal)}</b>
              <span className="small muted">{v.rank ? `#${v.rank.pos} of ${v.rank.of}` : ''}</span>
            </div>
          )}
          <div>
            <span className="k">Season</span>
            <b className="num">{fmtPts(v.seasonTotal)}</b>
            <span className="small muted">{v.seasonRank ? `#${v.seasonRank.pos} of ${v.seasonRank.of}` : ''}</span>
          </div>
        </div>
      </div>

      {!v.event ? (
        <p className="muted">The squad shows here once the first tournament of the season starts.</p>
      ) : v.players.length === 0 ? (
        <p className="muted">This manager had no squad at {v.event.name}.</p>
      ) : (
        <>
          <h2 className="sub">
            Squad<span className="muted small"> · points in {v.live ? 'this tournament' : v.event.name}</span>
          </h2>
          <ul className="pls">
            {starters.map((p) => (
              <Player key={`${p.account_id}-${p.left}`} p={p} />
            ))}
          </ul>
          {bench.length > 0 && (
            <>
              <h3 className="sub">Bench</h3>
              <ul className="pls">
                {bench.map((p) => (
                  <Player key={`${p.account_id}-${p.left}`} p={p} />
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <p style={{ marginTop: 24 }}>
        <Link href={back} className="btn plain sm">
          Back to the leaderboard
        </Link>
      </p>
    </>
  );
}
