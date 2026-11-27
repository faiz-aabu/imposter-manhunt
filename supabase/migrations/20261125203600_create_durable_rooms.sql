CREATE TABLE public.rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code text NOT NULL,
  game_mode text NOT NULL,
  settings jsonb NOT NULL,
  max_players smallint NOT NULL,
  host_player_id uuid,
  game_status text NOT NULL DEFAULT 'waiting',
  lifecycle_status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT rooms_code_normalized
    CHECK (room_code = upper(btrim(room_code)) AND room_code ~ '^[A-Z]{4}$'),
  CONSTRAINT rooms_game_mode_valid
    CHECK (game_mode IN ('impostor-classic', 'impostor-word', 'manhunt')),
  CONSTRAINT rooms_settings_valid
    CHECK (
      jsonb_typeof(settings) = 'object'
      AND settings ? 'gameMode'
      AND settings ? 'maxPlayers'
      AND settings ? 'isPrivate'
      AND settings ->> 'gameMode' = game_mode
      AND jsonb_typeof(settings -> 'maxPlayers') = 'number'
      AND settings ->> 'maxPlayers' = max_players::text
      AND jsonb_typeof(settings -> 'isPrivate') = 'boolean'
      AND (
        settings - ARRAY[
          'gameMode',
          'maxPlayers',
          'isPrivate',
          'classicImpostor',
          'wordImpostor',
          'manhunt'
        ]::text[]
      ) = '{}'::jsonb
    ),
  CONSTRAINT rooms_mode_settings_match
    CHECK (
      (NOT (settings ? 'classicImpostor') OR game_mode = 'impostor-classic')
      AND (NOT (settings ? 'wordImpostor') OR game_mode = 'impostor-word')
      AND (NOT (settings ? 'manhunt') OR game_mode = 'manhunt')
    ),
  CONSTRAINT rooms_classic_settings_shape
    CHECK (
      NOT (settings ? 'classicImpostor')
      OR (
        jsonb_typeof(settings -> 'classicImpostor') = 'object'
        AND (settings -> 'classicImpostor') ?& ARRAY[
          'impostorCount',
          'discussionDurationSeconds',
          'votingDurationSeconds'
        ]::text[]
        AND jsonb_typeof(settings -> 'classicImpostor' -> 'impostorCount') = 'number'
        AND jsonb_typeof(settings -> 'classicImpostor' -> 'discussionDurationSeconds') = 'number'
        AND jsonb_typeof(settings -> 'classicImpostor' -> 'votingDurationSeconds') = 'number'
        AND (
          (settings -> 'classicImpostor') - ARRAY[
            'impostorCount',
            'discussionDurationSeconds',
            'votingDurationSeconds'
          ]::text[]
        ) = '{}'::jsonb
      )
    ),
  CONSTRAINT rooms_word_settings_shape
    CHECK (
      NOT (settings ? 'wordImpostor')
      OR (
        jsonb_typeof(settings -> 'wordImpostor') = 'object'
        AND (settings -> 'wordImpostor') ?& ARRAY[
          'category',
          'impostorCount',
          'discussionDurationSeconds',
          'votingDurationSeconds'
        ]::text[]
        AND jsonb_typeof(settings -> 'wordImpostor' -> 'category') = 'string'
        AND jsonb_typeof(settings -> 'wordImpostor' -> 'impostorCount') = 'number'
        AND jsonb_typeof(settings -> 'wordImpostor' -> 'discussionDurationSeconds') = 'number'
        AND jsonb_typeof(settings -> 'wordImpostor' -> 'votingDurationSeconds') = 'number'
        AND (
          (settings -> 'wordImpostor') - ARRAY[
            'category',
            'impostorCount',
            'discussionDurationSeconds',
            'votingDurationSeconds'
          ]::text[]
        ) = '{}'::jsonb
      )
    ),
  CONSTRAINT rooms_manhunt_settings_shape
    CHECK (
      NOT (settings ? 'manhunt')
      OR (
        jsonb_typeof(settings -> 'manhunt') = 'object'
        AND (settings -> 'manhunt') ? 'hunterCount'
        AND jsonb_typeof(settings -> 'manhunt' -> 'hunterCount') = 'number'
        AND (
          NOT (settings -> 'manhunt' ? 'gameDurationSeconds')
          OR jsonb_typeof(settings -> 'manhunt' -> 'gameDurationSeconds') = 'number'
        )
        AND (
          (settings -> 'manhunt') - ARRAY[
            'hunterCount',
            'gameDurationSeconds'
          ]::text[]
        ) = '{}'::jsonb
      )
    ),
  CONSTRAINT rooms_max_players_valid CHECK (max_players BETWEEN 2 AND 12),
  CONSTRAINT rooms_game_status_valid
    CHECK (game_status IN ('waiting', 'starting', 'in_progress', 'finished')),
  CONSTRAINT rooms_lifecycle_status_valid
    CHECK (lifecycle_status IN ('active', 'expired', 'closed')),
  CONSTRAINT rooms_active_requires_host
    CHECK (lifecycle_status <> 'active' OR host_player_id IS NOT NULL),
  CONSTRAINT rooms_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT rooms_version_positive CHECK (version > 0),
  CONSTRAINT rooms_id_host_unique UNIQUE (id, host_player_id)
);

CREATE TABLE public.room_players (
  player_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms (id) ON DELETE CASCADE,
  nickname text NOT NULL,
  connection_status text NOT NULL DEFAULT 'connected',
  membership_status text NOT NULL DEFAULT 'active',
  reconnect_token_hash bytea,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CONSTRAINT room_players_room_player_unique UNIQUE (room_id, player_id),
  CONSTRAINT room_players_nickname_valid
    CHECK (
      nickname = btrim(nickname)
      AND char_length(nickname) BETWEEN 1 AND 20
    ),
  CONSTRAINT room_players_connection_status_valid
    CHECK (connection_status IN ('connected', 'disconnected', 'reconnecting')),
  CONSTRAINT room_players_membership_status_valid
    CHECK (membership_status IN ('active', 'removed')),
  CONSTRAINT room_players_reconnect_hash_valid
    CHECK (
      (
        membership_status = 'active'
        AND reconnect_token_hash IS NOT NULL
        AND octet_length(reconnect_token_hash) = 32
        AND removed_at IS NULL
      )
      OR (
        membership_status = 'removed'
        AND reconnect_token_hash IS NULL
        AND removed_at IS NOT NULL
      )
    ),
  CONSTRAINT room_players_last_activity_valid
    CHECK (last_activity_at >= joined_at),
  CONSTRAINT room_players_removed_after_join
    CHECK (removed_at IS NULL OR removed_at >= joined_at)
);

ALTER TABLE public.rooms
  ADD CONSTRAINT rooms_host_is_room_player
  FOREIGN KEY (id, host_player_id)
  REFERENCES public.room_players (room_id, player_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX rooms_active_room_code_key
  ON public.rooms (room_code)
  WHERE lifecycle_status = 'active';

CREATE INDEX rooms_active_expiry_idx
  ON public.rooms (expires_at)
  WHERE lifecycle_status = 'active';

CREATE INDEX room_players_active_room_joined_idx
  ON public.room_players (room_id, joined_at)
  WHERE membership_status = 'active';

CREATE FUNCTION public.enforce_active_room_host_membership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  target_room_id uuid;
  room_lifecycle text;
  current_host_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'rooms' THEN
    IF TG_OP = 'DELETE' THEN
      target_room_id := OLD.id;
    ELSE
      target_room_id := NEW.id;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      target_room_id := OLD.room_id;
    ELSE
      target_room_id := NEW.room_id;
    END IF;
  END IF;

  SELECT r.lifecycle_status, r.host_player_id
    INTO room_lifecycle, current_host_id
    FROM public.rooms AS r
    WHERE r.id = target_room_id;

  IF NOT FOUND OR room_lifecycle <> 'active' THEN
    RETURN NULL;
  END IF;

  IF current_host_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.room_players AS rp
      WHERE rp.room_id = target_room_id
        AND rp.player_id = current_host_id
        AND rp.membership_status = 'active'
  ) THEN
    RAISE EXCEPTION 'An active room must have an active member as host'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER rooms_active_host_membership_check
  AFTER INSERT OR UPDATE ON public.rooms
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_active_room_host_membership();

CREATE CONSTRAINT TRIGGER room_players_active_host_membership_check
  AFTER INSERT OR UPDATE OR DELETE ON public.room_players
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_active_room_host_membership();

COMMENT ON TABLE public.rooms IS
  'Durable room metadata only. Validate complete settings with the API roomSettingsSchema before writes; project Manhunt settings without boundary coordinates; serialize room operations in transactions.';
COMMENT ON COLUMN public.rooms.max_players IS
  'For joins, lock this room row FOR UPDATE, count active room_players, compare against this capacity, and insert in the same transaction.';
COMMENT ON COLUMN public.rooms.version IS
  'Increment on each room or membership mutation; require the expected version for optimistic concurrency checks.';
COMMENT ON COLUMN public.rooms.host_player_id IS
  'Host must remain an active member. Transfer host and remove a player in one transaction; the deferred FK and trigger validate the committed state.';
COMMENT ON COLUMN public.room_players.reconnect_token_hash IS
  'Store only the SHA-256 hash of the reconnect token; clear it when membership is removed.';

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_players ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rooms, public.room_players
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rooms, public.room_players
  TO service_role;

REVOKE ALL ON FUNCTION public.enforce_active_room_host_membership()
  FROM PUBLIC, anon, authenticated;
