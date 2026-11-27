// Database changes after the first version. Each step runs once, in order,
// and the number of the last one done is kept in meta.schema_version.
import type { Q } from './db';

const STEPS: string[] = [
  // 1: casual and grind modes, the bench, coins, Valve roles, main vs qualifier events
  `
  ALTER TABLE events ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'main';
  ALTER TABLE pro_players ADD COLUMN IF NOT EXISTS valve_role INTEGER;
  ALTER TABLE rosters ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'casual';
  ALTER TABLE rosters ADD COLUMN IF NOT EXISTS coins INTEGER;
  ALTER TABLE rosters DROP CONSTRAINT IF EXISTS rosters_pkey;
  ALTER TABLE rosters ADD PRIMARY KEY (user_id, mode);
  ALTER TABLE roster_slots ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'casual';
  ALTER TABLE roster_slots ADD COLUMN IF NOT EXISTS bench BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE roster_slots ADD COLUMN IF NOT EXISTS role TEXT;
  ALTER TABLE roster_slots ADD COLUMN IF NOT EXISTS buy_price INTEGER;
  UPDATE roster_slots s SET role = p.role FROM pro_players p WHERE p.account_id = s.account_id AND s.role IS NULL;
  CREATE INDEX IF NOT EXISTS slots_user_mode ON roster_slots (user_id, mode);
  ALTER TABLE transfers ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'casual';
  ALTER TABLE transfers ADD COLUMN IF NOT EXISTS sell_price INTEGER;
  ALTER TABLE transfers ADD COLUMN IF NOT EXISTS buy_price INTEGER;
  ALTER TABLE transfers ALTER COLUMN out_account DROP NOT NULL;
  CREATE TABLE IF NOT EXISTS grind_income (
    user_id INTEGER NOT NULL,
    event_key TEXT NOT NULL,
    rank INTEGER NOT NULL,
    of_count INTEGER NOT NULL,
    points REAL NOT NULL,
    coins INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (user_id, event_key)
  );
  `,
  // 2: stored leaderboards, refreshed by the sync
  `
  CREATE TABLE IF NOT EXISTS standings (
    mode TEXT NOT NULL,
    scope TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    pts REAL NOT NULL,
    pen REAL NOT NULL,
    total REAL NOT NULL,
    coins INTEGER,
    value INTEGER,
    PRIMARY KEY (mode, scope, user_id)
  );
  CREATE INDEX IF NOT EXISTS standings_board ON standings (mode, scope, total DESC)
  `,
  // 3: fixed season prices. price_src: 'season' (from last season), 'new' (after 3 matches this season),
  // 'team' (for now, from priced teammates), NULL (not priced yet)
  `
  ALTER TABLE pro_players ADD COLUMN IF NOT EXISTS price_src TEXT;
  ALTER TABLE pro_players ALTER COLUMN price SET DEFAULT 50;
  DELETE FROM meta WHERE key IN ('prices_for', 'reprice_pending')
  `,
  // 4: Liquipedia rosters. lp_at: when Liquipedia last set this player's team; lp_pos: position 1-5.
  // Season prices are set again once, so roles come from Liquipedia positions.
  `
  ALTER TABLE pro_players ADD COLUMN IF NOT EXISTS lp_at BIGINT;
  ALTER TABLE pro_players ADD COLUMN IF NOT EXISTS lp_pos INTEGER;
  DELETE FROM meta WHERE key IN ('season_prices', 'price_curve')
  `,
  // 5: rosters read again with player pages looked up per roster; prices again with those roles
  `
  DELETE FROM meta WHERE key IN ('lp_at', 'season_prices', 'price_curve')
  `,
  // 6: tournaments from Liquipedia: dates, invited teams and the match schedule.
  // lp_team: the player's Liquipedia team in the same short form as event_teams.team and lp_matches.team1/2.
  `
  ALTER TABLE events ADD COLUMN IF NOT EXISTS lp_page TEXT;
  ALTER TABLE events ADD COLUMN IF NOT EXISTS lp_start INTEGER;
  ALTER TABLE events ADD COLUMN IF NOT EXISTS lp_end INTEGER;
  ALTER TABLE pro_players ADD COLUMN IF NOT EXISTS lp_team TEXT;
  CREATE TABLE IF NOT EXISTS event_teams (
    event_key TEXT NOT NULL,
    team TEXT NOT NULL,
    name TEXT NOT NULL,
    place TEXT,
    PRIMARY KEY (event_key, team)
  );
  CREATE TABLE IF NOT EXISTS lp_matches (
    id TEXT PRIMARY KEY,
    event_key TEXT NOT NULL,
    ts INTEGER NOT NULL,
    exact BOOLEAN NOT NULL,
    bestof INTEGER,
    section TEXT,
    team1 TEXT,
    team2 TEXT,
    name1 TEXT,
    name2 TEXT,
    score1 INTEGER,
    score2 INTEGER,
    winner INTEGER,
    finished BOOLEAN NOT NULL,
    stream TEXT
  );
  CREATE INDEX IF NOT EXISTS lp_matches_ts ON lp_matches (ts);
  DELETE FROM meta WHERE key = 'lp_at'
  `,
  // 7: tournament lineups from Liquipedia, so a player whose team plays without them (stand-in,
  // left the team) is not shown as playing. event_teams.lineup: how many players Liquipedia lists.
  `
  ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS lineup INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS event_players (
    event_key TEXT NOT NULL,
    account_id TEXT NOT NULL,
    team TEXT NOT NULL,
    PRIMARY KEY (event_key, account_id)
  );
  DELETE FROM meta WHERE key = 'lp_tour_at'
  `,
];

export async function migrate(tx: <T>(fn: (q: Q) => Promise<T>) => Promise<T>, postgres: boolean): Promise<void> {
  await tx(async (q) => {
    // Two servers starting at once must not run the same step twice.
    if (postgres) await q(`SELECT pg_advisory_xact_lock(827364)`);
    const row = (await q(`SELECT value FROM meta WHERE key = 'schema_version'`))[0];
    const done = row ? Number(row.value) : 0;
    for (let i = done; i < STEPS.length; i++) {
      for (const stmt of STEPS[i].split(';').map((x) => x.trim()).filter(Boolean)) await q(stmt);
    }
    if (done < STEPS.length) {
      await q(
        `INSERT INTO meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
        [String(STEPS.length)],
      );
    }
  });
}
