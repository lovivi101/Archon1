-- Friend requests waiting for an answer; a request in both directions becomes a friendship instead.
CREATE TABLE friend_requests (
    requester_id VARCHAR(128) NOT NULL REFERENCES player_profiles (user_id) ON DELETE CASCADE,
    target_id VARCHAR(128) NOT NULL REFERENCES player_profiles (user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (requester_id, target_id),
    CHECK (requester_id <> target_id)
);

CREATE INDEX friend_requests_target ON friend_requests (target_id);

-- One row per friendship, stored with user_a < user_b.
CREATE TABLE friendships (
    user_a VARCHAR(128) NOT NULL REFERENCES player_profiles (user_id) ON DELETE CASCADE,
    user_b VARCHAR(128) NOT NULL REFERENCES player_profiles (user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
);

CREATE INDEX friendships_user_b ON friendships (user_b);

CREATE TABLE direct_messages (
    id BIGSERIAL PRIMARY KEY,
    sender_id VARCHAR(128) NOT NULL REFERENCES player_profiles (user_id) ON DELETE CASCADE,
    target_id VARCHAR(128) NOT NULL REFERENCES player_profiles (user_id) ON DELETE CASCADE,
    body VARCHAR(200) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX direct_messages_pair ON direct_messages (LEAST(sender_id, target_id), GREATEST(sender_id, target_id), id DESC);
