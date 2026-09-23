CREATE TABLE player_profiles (
    user_id VARCHAR(128) PRIMARY KEY,
    nickname VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
