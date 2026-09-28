ALTER TABLE player_profiles
    ADD COLUMN avatar VARCHAR(32) NOT NULL DEFAULT '',
    ADD COLUMN rating INTEGER NOT NULL DEFAULT 1000,
    ADD COLUMN games INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN wins INTEGER NOT NULL DEFAULT 0;

CREATE INDEX player_profiles_rating ON player_profiles (rating DESC, games DESC) WHERE games > 0;

-- One finished game. `record` is the full replay: players with roles, proposals and votes,
-- missions (with Excalibur use), Lady of the Lake checks and the table talk.
CREATE TABLE matches (
    id BIGSERIAL PRIMARY KEY,
    room_id VARCHAR(32) NOT NULL,
    player_count SMALLINT NOT NULL,
    good_win BOOLEAN NOT NULL,
    reason TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL,
    record JSONB NOT NULL
);

-- Every seat of a match, AI included; ratings only change for humans.
CREATE TABLE match_players (
    match_id BIGINT NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
    seat SMALLINT NOT NULL,
    user_id VARCHAR(128) NOT NULL,
    role SMALLINT NOT NULL,
    is_ai BOOLEAN NOT NULL,
    won BOOLEAN NOT NULL,
    rating_before INTEGER,
    rating_after INTEGER,
    PRIMARY KEY (match_id, seat)
);

CREATE INDEX match_players_user ON match_players (user_id, match_id DESC);
