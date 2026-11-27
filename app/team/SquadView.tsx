// The squad as a manager follows it: points, next matches, where the points come from.
// The player list for transfers lives behind the Transfers button (TeamBuilder).
import Link from 'next/link';
import LocalTime from '@/app/LocalTime';
import { fmtDate, fmtPts, type Mode } from '@/lib/game';
import type { Dashboard, DashPlayer, MatchLine } from '@/lib/live';

const ROLE: Record<string, string> = { core: 'Core', mid: 'Mid', support: 'Support' };

function StatePill({ p, d }: { p: DashPlayer; d: Dashboard }) {
  const ev = d.upcoming?.name ?? '';
  switch (p.state) {
    case 'playing':
      return <span className="pill ok">Playing</span>;
    case 'won':
      return <span className="pill gold">Won {ev}</span>;
    case 'out':
      return <span className="pill dim">Out{p.place ? `, ${p.place.replace('-', '–')}` : ''}</span>;
    case 'absent':
      return <span className="pill bad">Not at {ev}</span>;
    case 'benched':
      return <span className="pill bad">Not playing</span>;
    case 'invited':
      return <span className="pill ok">At {ev}</span>;
    default:
      return null;
  }
}

function Player({ p, d, mode }: { p: DashPlayer; d: Dashboard; mode: Mode }) {
  const last = p.matches[0];
  const shown = p.bench ? p.rawPts : p.evPts;
  const maxSrc = Math.max(1, ...p.sources.map((s) => Math.abs(s.pts)));
  return (
    <li className={`pl ${p.role}${p.bench ? ' bench' : ''}`}>
      <details>
        <summary>
          <span className="pinfo">
            <span className="nm">{p.name}</span>
            <span className="small muted">
              {p.bench ? `Bench ${ROLE[p.role].toLowerCase()}` : ROLE[p.role]} · {p.team_name ?? 'No team'}
            </span>
            <span className="row" style={{ gap: 6, marginTop: 3 }}>
              <StatePill p={p} d={d} />
              {p.bench && d.scored && p.matches.length > 0 && (
                <span className={`pill ${p.counted ? 'ok' : 'dim'}`}>{p.counted ? 'Came in' : 'Not counted'}</span>
              )}
              {p.inactive && <span className="pill bad">Not playing, free to replace</span>}
            </span>
          </span>
          <span className="pts">
            <b className="num">{d.scored ? fmtPts(shown) : '–'}</b>
            <span className="small muted">
              {p.matches.length ? `${p.matches.length} ${p.matches.length === 1 ? 'game' : 'games'}` : d.live ? 'no games yet' : ''}
            </span>
          </span>
        </summary>
        <div className="more">
          <p className="small muted" style={{ margin: 0 }}>
            {last ? (
              <>
                Last game {fmtPts(last.pts)} pts{last.opp ? ` vs ${last.opp}` : ''}. Average {fmtPts(p.rawPts / p.matches.length)} a game.{' '}
              </>
            ) : null}
            {p.nextLive ? (
              <b>Playing now. </b>
            ) : p.nextTs ? (
              <>
                Next game <LocalTime ts={p.nextTs} rel />.
              </>
            ) : null}{' '}
            {mode === 'grind' ? `Bought for ${p.buy_price ?? p.price}.` : `Price ${p.price}.`}
          </p>
          {p.sources.length > 0 && (
            <>
              <h4>Where the points come from</h4>
              <ul className="src">
                {p.sources.map((s) => (
                  <li key={s.key}>
                    <span>{s.label}</span>
                    <span className="bar">
                      <i className={s.pts < 0 ? 'neg' : ''} style={{ width: `${(Math.abs(s.pts) / maxSrc) * 100}%` }} />
                    </span>
                    <span className="num r">{s.pts > 0 ? '+' : ''}{fmtPts(s.pts)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {p.matches.length > 0 && (
            <>
              <h4>Games in {d.scored?.name}</h4>
              <ul className="games">
                {p.matches.map((m) => (
                  <li key={m.id}>
                    <span className="small muted">
                      <LocalTime ts={m.ts} />
                    </span>
                    <span>
                      {m.won != null && <b className={m.won ? 'w' : 'l'}>{m.won ? 'W' : 'L'}</b>} {m.opp ? `vs ${m.opp}` : ''}
                    </span>
                    <span className="num r">{fmtPts(m.pts)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {!p.matches.length && !p.sources.length && <p className="small muted">No games for your squad yet.</p>}
        </div>
      </details>
    </li>
  );
}

function Match({ m }: { m: MatchLine }) {
  const team = (side: 1 | 2) => {
    const name = side === 1 ? m.name1 : m.name2;
    const ours = m.mine.filter((x) => x.side === side);
    return (
      <span className={`tm${ours.length ? ' ours' : ''}`}>
        <span>{name ?? 'TBD'}</span>
        {ours.length > 0 && <span className="small">{ours.map((x) => x.name).join(', ')}</span>}
      </span>
    );
  };
  return (
    <li className={m.live ? 'live' : ''}>
      <span className="when small">
        {m.live ? <span className="tag live">Live</span> : <LocalTime ts={m.ts} exact={m.exact} rel />}
        <span className="muted">
          {m.bestof ? `Bo${m.bestof}` : ''}
          {m.section ? ` · ${m.section}` : ''}
        </span>
      </span>
      <span className="vs">
        {team(1)}
        <span className="muted small">{m.live && m.score1 != null ? `${m.score1}:${m.score2}` : 'vs'}</span>
        {team(2)}
      </span>
      {m.stream ? (
        <a className="btn plain sm" href={m.stream} target="_blank" rel="noopener noreferrer">
          Watch
        </a>
      ) : (
        <span />
      )}
    </li>
  );
}

export default function SquadView({
  d,
  mode,
  editHref,
  editLabel,
  editNote,
  coins,
}: {
  d: Dashboard;
  mode: Mode;
  editHref: string | null;
  editLabel: string;
  editNote: string;
  coins: number | null;
}) {
  const starters = d.players.filter((p) => !p.bench);
  const bench = d.players.filter((p) => p.bench);
  const absent = d.players.filter((p) => p.state === 'absent' && !p.bench);
  const benched = d.players.filter((p) => p.state === 'benched' && !p.bench);

  return (
    <>
      <div className="dash">
        <div className="headline">
          {d.live ? (
            <>
              <span className="tag live">Live</span> <b>{d.upcoming?.name}</b>
              {d.day && <span className="muted"> · day {d.day[0]} of {d.day[1]}</span>}
            </>
          ) : d.upcoming ? (
            <>
              <b>{d.upcoming.name}</b>
              <span className="muted"> starts {d.upcoming.starts_at ? fmtDate(d.upcoming.starts_at) : 'on a date to be announced'}</span>
            </>
          ) : (
            <b>The season is over</b>
          )}
        </div>
        <div className="stats">
          {d.scored && (
            <div>
              <span className="k">{d.live ? 'This tournament' : d.scored.name}</span>
              <b className="num">{fmtPts(d.evTotal)}</b>
              <span className="small muted">{d.rank ? `#${d.rank.pos} of ${d.rank.of}` : ''}</span>
            </div>
          )}
          <div>
            <span className="k">Season</span>
            <b className="num">{fmtPts(d.seasonTotal)}</b>
            <span className="small muted">{d.seasonRank ? `#${d.seasonRank.pos} of ${d.seasonRank.of}` : ''}</span>
          </div>
          {mode === 'grind' && coins != null && (
            <div>
              <span className="k">Coins</span>
              <b className="num">{coins}</b>
              <span className="small muted">in hand</span>
            </div>
          )}
        </div>
        <div className="row actions">
          <span className="small muted">{editNote}</span>
          {editHref && (
            <Link href={editHref} className="btn sm">
              {editLabel}
            </Link>
          )}
        </div>
      </div>

      {absent.length > 0 && !d.live && (
        <p className="note bad">
          {absent.map((p) => p.name).join(', ')} {absent.length === 1 ? 'is' : 'are'} not at {d.upcoming?.name}: their team is not on the list of
          teams. A bench player of the same role scores instead, if you have one.
        </p>
      )}

      {benched.length > 0 && (
        <p className="note bad">
          {benched.map((p) => p.name).join(', ')} {benched.length === 1 ? 'is' : 'are'} not in {benched.length === 1 ? 'their' : 'the'} team&apos;s lineup at{' '}
          {d.upcoming?.name}: the team plays with someone else. Games they do not play score 0. A bench player of the same role comes in
          only if the starter plays no game at the tournament.
        </p>
      )}

      {d.upcoming && (
        <>
          <h2 className="sub">Next games</h2>
          {d.next.length ? (
            <ul className="sched">
              {d.next.slice(0, 4).map((m) => (
                <Match key={m.id} m={m} />
              ))}
              {d.next.length > 4 && (
                <li className="morem">
                  <details>
                    <summary className="small">{d.next.length - 4} more</summary>
                    <ul className="sched inner">
                      {d.next.slice(4).map((m) => (
                        <Match key={m.id} m={m} />
                      ))}
                    </ul>
                  </details>
                </li>
              )}
            </ul>
          ) : (
            <p className="small muted">
              {d.scheduleKnown
                ? `None of your players' teams has a game scheduled right now.`
                : `The schedule of ${d.upcoming.name} is not out yet.`}
            </p>
          )}
        </>
      )}

      <h2 className="sub">
        Your squad{d.scored ? <span className="muted small"> · points in {d.live ? 'this tournament' : d.scored.name}</span> : null}
      </h2>
      <ul className="pls">
        {starters.map((p) => (
          <Player key={p.account_id} p={p} d={d} mode={mode} />
        ))}
      </ul>
      {bench.length > 0 && (
        <>
          <h3 className="sub">Bench</h3>
          <p className="small muted" style={{ marginTop: -4 }}>
            A bench player scores only when a starter of the same role is not at the tournament.
          </p>
          <ul className="pls">
            {bench.map((p) => (
              <Player key={p.account_id} p={p} d={d} mode={mode} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}
