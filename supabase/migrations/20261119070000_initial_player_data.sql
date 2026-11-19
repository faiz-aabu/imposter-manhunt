BEGIN;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_user_id uuid UNIQUE
    REFERENCES auth.users (id) ON DELETE SET NULL,
  nickname text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  merged_into_profile_id uuid
    REFERENCES public.profiles (id) ON DELETE RESTRICT,
  anonymized_at timestamptz,
  CONSTRAINT profiles_nickname_valid CHECK (
    nickname IS NULL
    OR (
      anonymized_at IS NULL
      AND nickname = btrim(nickname)
      AND char_length(nickname) BETWEEN 1 AND 20
    )
  ),
  CONSTRAINT profiles_anonymized_identity_cleared CHECK (
    anonymized_at IS NULL
    OR (supabase_user_id IS NULL AND nickname IS NULL)
  ),
  CONSTRAINT profiles_not_merged_into_self CHECK (
    merged_into_profile_id IS NULL OR merged_into_profile_id <> id
  ),
  CONSTRAINT profiles_merged_identity_detached CHECK (
    merged_into_profile_id IS NULL OR supabase_user_id IS NULL
  )
);

CREATE TABLE public.guest_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL
    REFERENCES public.profiles (id) ON DELETE RESTRICT,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  last_used_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT guest_credentials_sha256_hash_length CHECK (
    octet_length(token_hash) = 32
  ),
  CONSTRAINT guest_credentials_expiry_after_creation CHECK (
    expires_at > created_at
  ),
  CONSTRAINT guest_credentials_last_used_after_creation CHECK (
    last_used_at IS NULL OR last_used_at >= created_at
  ),
  CONSTRAINT guest_credentials_revocation_after_creation CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  )
);

COMMENT ON COLUMN public.guest_credentials.token_hash IS
  'SHA-256 digest of a high-entropy guest credential; never store the raw credential.';

CREATE TABLE public.games (
  id uuid PRIMARY KEY,
  game_mode text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT games_mode_valid CHECK (
    game_mode IN ('impostor-classic', 'impostor-word', 'manhunt')
  ),
  CONSTRAINT games_outcome_valid CHECK (
    outcome IN ('win', 'draw', 'cancelled')
  ),
  CONSTRAINT games_end_after_start CHECK (ended_at >= started_at)
);

CREATE TABLE public.game_participants (
  game_id uuid NOT NULL
    REFERENCES public.games (id) ON DELETE RESTRICT,
  profile_id uuid NOT NULL
    REFERENCES public.profiles (id) ON DELETE RESTRICT,
  nickname_at_game_time text,
  role_or_team text NOT NULL,
  result text NOT NULL,
  distance_meters numeric(12, 2),
  play_time_seconds bigint NOT NULL DEFAULT 0,
  hiders_caught integer NOT NULL DEFAULT 0,
  missions_completed integer NOT NULL DEFAULT 0,
  CONSTRAINT game_participants_pkey PRIMARY KEY (game_id, profile_id),
  CONSTRAINT game_participants_nickname_valid CHECK (
    nickname_at_game_time IS NULL
    OR (
      nickname_at_game_time = btrim(nickname_at_game_time)
      AND char_length(nickname_at_game_time) BETWEEN 1 AND 20
    )
  ),
  CONSTRAINT game_participants_role_nonempty CHECK (
    char_length(btrim(role_or_team)) > 0
  ),
  CONSTRAINT game_participants_role_valid CHECK (
    role_or_team IN ('impostor', 'player', 'civilian', 'hunter', 'runner')
  ),
  CONSTRAINT game_participants_result_valid CHECK (
    result IN ('win', 'loss', 'draw', 'cancelled')
  ),
  CONSTRAINT game_participants_distance_nonnegative CHECK (
    distance_meters IS NULL OR distance_meters >= 0
  ),
  CONSTRAINT game_participants_play_time_nonnegative CHECK (
    play_time_seconds >= 0
  ),
  CONSTRAINT game_participants_hiders_caught_nonnegative CHECK (
    hiders_caught >= 0
  ),
  CONSTRAINT game_participants_missions_nonnegative CHECK (
    missions_completed >= 0
  )
);

COMMENT ON COLUMN public.game_participants.distance_meters IS
  'Filtered server-calculated per-game distance in meters; no GPS coordinates are stored.';
COMMENT ON COLUMN public.game_participants.play_time_seconds IS
  'Server-calculated active gameplay time in seconds, excluding countdown time.';

CREATE INDEX guest_credentials_profile_id_idx
  ON public.guest_credentials (profile_id);

CREATE INDEX profiles_merged_into_profile_id_idx
  ON public.profiles (merged_into_profile_id)
  WHERE merged_into_profile_id IS NOT NULL;

CREATE INDEX games_mode_ended_at_idx
  ON public.games (game_mode, ended_at DESC);

CREATE INDEX game_participants_profile_game_idx
  ON public.game_participants (profile_id, game_id);

CREATE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER profiles_set_updated_at
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE FUNCTION public.anonymize_deleted_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_profile_id uuid;
BEGIN
  UPDATE public.profiles
  SET supabase_user_id = NULL,
      nickname = NULL,
      anonymized_at = COALESCE(anonymized_at, pg_catalog.now())
  WHERE supabase_user_id = OLD.id
  RETURNING id INTO v_profile_id;

  IF v_profile_id IS NOT NULL THEN
    UPDATE public.guest_credentials
    SET revoked_at = COALESCE(revoked_at, pg_catalog.now())
    WHERE profile_id = v_profile_id;

    UPDATE public.game_participants
    SET nickname_at_game_time = NULL
    WHERE profile_id = v_profile_id;
  END IF;

  RETURN OLD;
END;
$function$;

CREATE TRIGGER auth_user_anonymize_player_profile
BEFORE DELETE ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.anonymize_deleted_auth_user();

REVOKE ALL ON FUNCTION public.set_updated_at()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.anonymize_deleted_auth_user()
  FROM PUBLIC, anon, authenticated;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.guest_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guest_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE public.games ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.games FORCE ROW LEVEL SECURITY;
ALTER TABLE public.game_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_participants FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.profiles,
  public.guest_credentials,
  public.games,
  public.game_participants
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.profiles,
  public.games,
  public.game_participants
TO authenticated;

GRANT ALL ON TABLE
  public.profiles,
  public.guest_credentials,
  public.games,
  public.game_participants
TO service_role;

CREATE POLICY profiles_select_own
ON public.profiles
FOR SELECT
TO authenticated
USING (
  supabase_user_id = (SELECT auth.uid())
  AND anonymized_at IS NULL
  AND merged_into_profile_id IS NULL
);

CREATE POLICY game_participants_select_own
ON public.game_participants
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.profiles AS profile
    WHERE profile.id = game_participants.profile_id
      AND profile.supabase_user_id = (SELECT auth.uid())
      AND profile.anonymized_at IS NULL
      AND profile.merged_into_profile_id IS NULL
  )
);

CREATE POLICY games_select_as_participant
ON public.games
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.game_participants AS participant
    JOIN public.profiles AS profile
      ON profile.id = participant.profile_id
    WHERE participant.game_id = games.id
      AND profile.supabase_user_id = (SELECT auth.uid())
      AND profile.anonymized_at IS NULL
      AND profile.merged_into_profile_id IS NULL
  )
);

CREATE VIEW public.player_statistics
WITH (security_invoker = true)
AS
SELECT
  profile.id AS profile_id,
  COALESCE(
    SUM(participant.distance_meters) FILTER (
      WHERE game.outcome <> 'cancelled'
        AND participant.result <> 'cancelled'
    ),
    0::numeric
  )
    AS lifetime_distance_meters,
  COUNT(participant.game_id) FILTER (
    WHERE game.outcome <> 'cancelled'
      AND participant.result IN ('win', 'loss', 'draw')
  ) AS games_played,
  COUNT(participant.game_id) FILTER (
    WHERE game.outcome <> 'cancelled'
      AND participant.result = 'win'
  ) AS games_won,
  COALESCE(
    SUM(participant.play_time_seconds) FILTER (
      WHERE game.outcome <> 'cancelled'
        AND participant.result <> 'cancelled'
    ),
    0
  )::bigint
    AS total_active_play_time_seconds,
  COALESCE(
    SUM(participant.hiders_caught) FILTER (
      WHERE game.outcome <> 'cancelled'
        AND participant.result <> 'cancelled'
    ),
    0
  )::bigint
    AS hiders_caught,
  COALESCE(
    SUM(participant.missions_completed) FILTER (
      WHERE game.outcome <> 'cancelled'
        AND participant.result <> 'cancelled'
    ),
    0
  )::bigint
    AS missions_completed
FROM public.profiles AS profile
LEFT JOIN public.game_participants AS participant
  ON participant.profile_id = profile.id
LEFT JOIN public.games AS game
  ON game.id = participant.game_id
WHERE profile.supabase_user_id = (SELECT auth.uid())
  AND profile.anonymized_at IS NULL
  AND profile.merged_into_profile_id IS NULL
GROUP BY profile.id;

COMMENT ON VIEW public.player_statistics IS
  'Read-only totals derived from game participants; cancelled games are excluded from all lifetime statistics.';

REVOKE ALL ON TABLE public.player_statistics FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.player_statistics TO authenticated;
GRANT SELECT ON TABLE public.player_statistics TO service_role;

COMMIT;
