BEGIN;

CREATE TABLE public.game_statistics_outbox (
  game_id uuid PRIMARY KEY,
  game_mode text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  outcome text NOT NULL,
  participants jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT game_statistics_outbox_mode_valid CHECK (
    game_mode IN ('impostor-classic', 'impostor-word', 'manhunt')
  ),
  CONSTRAINT game_statistics_outbox_outcome_valid CHECK (
    outcome IN ('win', 'draw')
  ),
  CONSTRAINT game_statistics_outbox_end_after_start CHECK (
    ended_at >= started_at
  ),
  CONSTRAINT game_statistics_outbox_participants_array CHECK (
    pg_catalog.jsonb_typeof(participants) = 'array'
    AND pg_catalog.jsonb_array_length(participants) > 0
  ),
  CONSTRAINT game_statistics_outbox_attempt_count_nonnegative CHECK (
    attempt_count >= 0
  )
);

CREATE INDEX game_statistics_outbox_next_attempt_idx
  ON public.game_statistics_outbox (next_attempt_at, created_at);

ALTER TABLE public.game_statistics_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_statistics_outbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.game_statistics_outbox
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.game_statistics_outbox TO service_role;

COMMENT ON TABLE public.game_statistics_outbox IS
  'Private durable retry queue for server-authoritative game statistics. Payload access is restricted to service_role.';

CREATE FUNCTION public._validate_completed_game_record(
  p_game_id uuid,
  p_game_mode text,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_outcome text,
  p_participants jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_play_time_seconds bigint;
BEGIN
  IF p_game_id IS NULL
     OR p_game_mode IS NULL
     OR p_game_mode NOT IN (
       'impostor-classic',
       'impostor-word',
       'manhunt'
     )
     OR p_started_at IS NULL
     OR p_ended_at IS NULL
     OR p_ended_at < p_started_at
     OR p_outcome IS NULL
     OR p_outcome NOT IN ('win', 'draw')
     OR p_participants IS NULL
     OR pg_catalog.jsonb_typeof(p_participants) <> 'array'
     OR pg_catalog.jsonb_array_length(p_participants) = 0 THEN
    RAISE EXCEPTION 'Invalid completed-game record.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(p_participants) AS participant(
      profile_id uuid,
      nickname_at_game_time text,
      role_or_team text,
      result text
    )
    WHERE participant.profile_id IS NULL
       OR (
         participant.nickname_at_game_time IS NOT NULL
         AND (
           participant.nickname_at_game_time <>
             pg_catalog.btrim(participant.nickname_at_game_time)
           OR pg_catalog.char_length(participant.nickname_at_game_time)
             NOT BETWEEN 1 AND 20
         )
       )
       OR participant.role_or_team IS NULL
       OR participant.role_or_team NOT IN (
         'impostor',
         'player',
         'civilian',
         'hunter',
         'runner'
       )
       OR participant.result IS NULL
       OR participant.result NOT IN ('win', 'loss', 'draw')
       OR (p_outcome = 'draw' AND participant.result <> 'draw')
       OR (p_outcome = 'win' AND participant.result = 'draw')
  ) THEN
    RAISE EXCEPTION 'Invalid completed-game participant record.'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT participant.profile_id
    FROM pg_catalog.jsonb_to_recordset(p_participants) AS participant(
      profile_id uuid,
      nickname_at_game_time text,
      role_or_team text,
      result text
    )
    GROUP BY participant.profile_id
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate profile in completed-game participants.'
      USING ERRCODE = '22023';
  END IF;

  v_play_time_seconds := pg_catalog.floor(
    pg_catalog.date_part('epoch', p_ended_at - p_started_at)
  )::bigint;
  RETURN v_play_time_seconds;
END;
$function$;

CREATE FUNCTION public._canonical_completed_game_participants(
  p_participants jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'profile_id', participant.profile_id,
        'nickname_at_game_time', participant.nickname_at_game_time,
        'role_or_team', participant.role_or_team,
        'result', participant.result
      )
      ORDER BY participant.profile_id
    ),
    '[]'::jsonb
  )
  FROM pg_catalog.jsonb_to_recordset(p_participants) AS participant(
    profile_id uuid,
    nickname_at_game_time text,
    role_or_team text,
    result text
  );
$function$;

CREATE FUNCTION public._assert_completed_game_matches(
  p_game_id uuid,
  p_game_mode text,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_outcome text,
  p_participants jsonb,
  p_play_time_seconds bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_participant_count bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.games AS game
    WHERE game.id = p_game_id
      AND game.game_mode = p_game_mode
      AND game.started_at = p_started_at
      AND game.ended_at = p_ended_at
      AND game.outcome = p_outcome
  ) THEN
    RAISE EXCEPTION 'Conflicting completed-game retry.'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_participant_count
  FROM public.game_participants AS participant
  WHERE participant.game_id = p_game_id;

  IF v_participant_count <> pg_catalog.jsonb_array_length(p_participants)
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_to_recordset(p_participants) AS expected(
         profile_id uuid,
         nickname_at_game_time text,
         role_or_team text,
         result text
       )
       LEFT JOIN public.game_participants AS recorded
         ON recorded.game_id = p_game_id
        AND recorded.profile_id = expected.profile_id
       WHERE recorded.game_id IS NULL
          OR recorded.nickname_at_game_time
            IS DISTINCT FROM expected.nickname_at_game_time
          OR recorded.role_or_team IS DISTINCT FROM expected.role_or_team
          OR recorded.result IS DISTINCT FROM expected.result
          OR recorded.play_time_seconds IS DISTINCT FROM p_play_time_seconds
     ) THEN
    RAISE EXCEPTION 'Conflicting completed-game participant retry.'
      USING ERRCODE = '22023';
  END IF;
END;
$function$;

CREATE FUNCTION public.record_completed_game(
  p_game_id uuid,
  p_game_mode text,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_outcome text,
  p_participants jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_rows_inserted integer;
  v_play_time_seconds bigint;
  v_participant record;
BEGIN
  v_play_time_seconds := public._validate_completed_game_record(
    p_game_id,
    p_game_mode,
    p_started_at,
    p_ended_at,
    p_outcome,
    p_participants
  );

  INSERT INTO public.games (
    id,
    game_mode,
    started_at,
    ended_at,
    outcome
  )
  VALUES (
    p_game_id,
    p_game_mode,
    p_started_at,
    p_ended_at,
    p_outcome
  )
  ON CONFLICT (id) DO NOTHING;

  GET DIAGNOSTICS v_rows_inserted = ROW_COUNT;
  IF v_rows_inserted = 0 THEN
    PERFORM public._assert_completed_game_matches(
      p_game_id,
      p_game_mode,
      p_started_at,
      p_ended_at,
      p_outcome,
      p_participants,
      v_play_time_seconds
    );
    RETURN true;
  END IF;

  FOR v_participant IN
    SELECT
      participant.profile_id,
      participant.nickname_at_game_time,
      participant.role_or_team,
      participant.result
    FROM pg_catalog.jsonb_to_recordset(p_participants) AS participant(
      profile_id uuid,
      nickname_at_game_time text,
      role_or_team text,
      result text
    )
  LOOP
    INSERT INTO public.game_participants (
      game_id,
      profile_id,
      nickname_at_game_time,
      role_or_team,
      result,
      play_time_seconds
    )
    VALUES (
      p_game_id,
      v_participant.profile_id,
      v_participant.nickname_at_game_time,
      v_participant.role_or_team,
      v_participant.result,
      v_play_time_seconds
    );
  END LOOP;

  RETURN true;
END;
$function$;

CREATE FUNCTION public.enqueue_completed_game_statistics(
  p_game_id uuid,
  p_game_mode text,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_outcome text,
  p_participants jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_rows_inserted integer;
  v_existing public.game_statistics_outbox%ROWTYPE;
  v_canonical_participants jsonb;
  v_play_time_seconds bigint;
BEGIN
  v_play_time_seconds := public._validate_completed_game_record(
    p_game_id,
    p_game_mode,
    p_started_at,
    p_ended_at,
    p_outcome,
    p_participants
  );
  v_canonical_participants :=
    public._canonical_completed_game_participants(p_participants);

  IF EXISTS (
    SELECT 1 FROM public.games AS game WHERE game.id = p_game_id
  ) THEN
    PERFORM public.record_completed_game(
      p_game_id,
      p_game_mode,
      p_started_at,
      p_ended_at,
      p_outcome,
      v_canonical_participants
    );
    RETURN true;
  END IF;

  INSERT INTO public.game_statistics_outbox (
    game_id,
    game_mode,
    started_at,
    ended_at,
    outcome,
    participants
  )
  VALUES (
    p_game_id,
    p_game_mode,
    p_started_at,
    p_ended_at,
    p_outcome,
    v_canonical_participants
  )
  ON CONFLICT (game_id) DO NOTHING;

  GET DIAGNOSTICS v_rows_inserted = ROW_COUNT;
  IF v_rows_inserted = 0 THEN
    SELECT *
    INTO v_existing
    FROM public.game_statistics_outbox AS outbox
    WHERE outbox.game_id = p_game_id
    FOR UPDATE;

    IF FOUND THEN
      IF v_existing.game_mode IS DISTINCT FROM p_game_mode
         OR v_existing.started_at IS DISTINCT FROM p_started_at
         OR v_existing.ended_at IS DISTINCT FROM p_ended_at
         OR v_existing.outcome IS DISTINCT FROM p_outcome
         OR v_existing.participants IS DISTINCT FROM
           v_canonical_participants THEN
        RAISE EXCEPTION 'Conflicting queued completed-game retry.'
          USING ERRCODE = '22023';
      END IF;
    ELSE
      PERFORM public.record_completed_game(
        p_game_id,
        p_game_mode,
        p_started_at,
        p_ended_at,
        p_outcome,
        v_canonical_participants
      );
    END IF;
  END IF;

  RETURN true;
END;
$function$;

CREATE FUNCTION public.process_completed_game_statistics(
  p_batch_size integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_record public.game_statistics_outbox%ROWTYPE;
  v_processed integer := 0;
  v_pending bigint;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid statistics outbox batch size.'
      USING ERRCODE = '22023';
  END IF;

  FOR v_record IN
    SELECT *
    FROM public.game_statistics_outbox AS outbox
    WHERE outbox.next_attempt_at <= pg_catalog.now()
    ORDER BY outbox.created_at, outbox.game_id
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      PERFORM public.record_completed_game(
        v_record.game_id,
        v_record.game_mode,
        v_record.started_at,
        v_record.ended_at,
        v_record.outcome,
        v_record.participants
      );
      DELETE FROM public.game_statistics_outbox
      WHERE game_id = v_record.game_id;
      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.game_statistics_outbox
      SET attempt_count = attempt_count + 1,
          next_attempt_at = pg_catalog.now() + pg_catalog.make_interval(
            secs => LEAST(
              60,
              pg_catalog.power(2, LEAST(attempt_count + 1, 6))::integer
            )
          )
      WHERE game_id = v_record.game_id;
    END;
  END LOOP;

  SELECT pg_catalog.count(*)
  INTO v_pending
  FROM public.game_statistics_outbox;

  RETURN pg_catalog.jsonb_build_object(
    'processed',
    v_processed,
    'pending',
    v_pending
  );
END;
$function$;

COMMENT ON FUNCTION public.record_completed_game(
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  jsonb
) IS
  'Atomically records server-authoritative game statistics; identical retries succeed and conflicting retries fail.';

COMMENT ON FUNCTION public.enqueue_completed_game_statistics(
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  jsonb
) IS
  'Durably queues a validated game result for service_role processing; identical retries succeed and conflicts fail.';

REVOKE ALL ON FUNCTION public._validate_completed_game_record(
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._canonical_completed_game_participants(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._assert_completed_game_matches(
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  jsonb,
  bigint
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_completed_game(
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_completed_game_statistics(
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_completed_game_statistics(integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public._validate_completed_game_record(
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public._canonical_completed_game_participants(jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public._assert_completed_game_matches(
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  jsonb,
  bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_completed_game(
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_completed_game_statistics(
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_completed_game_statistics(integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
