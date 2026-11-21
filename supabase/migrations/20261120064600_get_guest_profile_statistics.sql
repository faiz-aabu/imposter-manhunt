BEGIN;

CREATE FUNCTION public.get_guest_profile_statistics(
  p_profile_id uuid,
  p_token_hash bytea
)
RETURNS TABLE (
  games_played bigint,
  games_won bigint,
  games_lost bigint,
  total_active_play_time_seconds bigint
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_profile_id IS NULL
     OR p_token_hash IS NULL
     OR pg_catalog.octet_length(p_token_hash) <> 32
     OR NOT EXISTS (
       SELECT 1
       FROM public.guest_credentials AS credential
       JOIN public.profiles AS profile
         ON profile.id = credential.profile_id
       WHERE credential.profile_id = p_profile_id
         AND credential.token_hash = p_token_hash
         AND credential.revoked_at IS NULL
         AND credential.expires_at > pg_catalog.now()
         AND profile.supabase_user_id IS NULL
         AND profile.anonymized_at IS NULL
         AND profile.merged_into_profile_id IS NULL
     ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    pg_catalog.count(participant.game_id) FILTER (
      WHERE game.outcome <> 'cancelled'
        AND participant.result IN ('win', 'loss', 'draw')
    ) AS games_played,
    pg_catalog.count(participant.game_id) FILTER (
      WHERE game.outcome <> 'cancelled'
        AND participant.result = 'win'
    ) AS games_won,
    pg_catalog.count(participant.game_id) FILTER (
      WHERE game.outcome <> 'cancelled'
        AND participant.result = 'loss'
    ) AS games_lost,
    COALESCE(
      pg_catalog.sum(participant.play_time_seconds) FILTER (
        WHERE game.outcome <> 'cancelled'
          AND participant.result <> 'cancelled'
      ),
      0
    )::bigint AS total_active_play_time_seconds
  FROM public.profiles AS profile
  LEFT JOIN public.game_participants AS participant
    ON participant.profile_id = profile.id
  LEFT JOIN public.games AS game
    ON game.id = participant.game_id
  WHERE profile.id = p_profile_id
    AND profile.supabase_user_id IS NULL
    AND profile.anonymized_at IS NULL
    AND profile.merged_into_profile_id IS NULL;
END;
$function$;

COMMENT ON FUNCTION public.get_guest_profile_statistics(uuid, bytea) IS
  'Returns aggregate statistics only for an active guest profile and matching unexpired credential hash.';

REVOKE ALL ON FUNCTION public.get_guest_profile_statistics(uuid, bytea)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_guest_profile_statistics(uuid, bytea)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
