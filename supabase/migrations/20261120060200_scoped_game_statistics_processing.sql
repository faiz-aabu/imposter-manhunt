BEGIN;

CREATE FUNCTION public.process_completed_game_statistics_for_games(
  p_game_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_record public.game_statistics_outbox%ROWTYPE;
  v_processed_game_ids uuid[] := ARRAY[]::uuid[];
  v_pending_game_ids uuid[];
BEGIN
  IF p_game_ids IS NULL
     OR pg_catalog.cardinality(p_game_ids) NOT BETWEEN 1 AND 100
     OR pg_catalog.array_position(p_game_ids, NULL) IS NOT NULL
     OR pg_catalog.cardinality(p_game_ids) <> (
       SELECT pg_catalog.count(DISTINCT requested.game_id)
       FROM pg_catalog.unnest(p_game_ids) AS requested(game_id)
     ) THEN
    RAISE EXCEPTION 'Invalid scoped statistics game ID list.'
      USING ERRCODE = '22023';
  END IF;

  FOR v_record IN
    SELECT outbox.*
    FROM public.game_statistics_outbox AS outbox
    WHERE outbox.game_id = ANY (p_game_ids)
      AND outbox.next_attempt_at <= pg_catalog.now()
    ORDER BY outbox.created_at, outbox.game_id
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
      v_processed_game_ids := pg_catalog.array_append(
        v_processed_game_ids,
        v_record.game_id
      );
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

  SELECT COALESCE(
    pg_catalog.array_agg(outbox.game_id ORDER BY outbox.game_id),
    ARRAY[]::uuid[]
  )
  INTO v_pending_game_ids
  FROM public.game_statistics_outbox AS outbox
  WHERE outbox.game_id = ANY (p_game_ids);

  RETURN pg_catalog.jsonb_build_object(
    'processed',
    pg_catalog.cardinality(v_processed_game_ids),
    'pending',
    pg_catalog.cardinality(v_pending_game_ids),
    'processed_game_ids',
    pg_catalog.to_jsonb(v_processed_game_ids),
    'pending_game_ids',
    pg_catalog.to_jsonb(v_pending_game_ids)
  );
END;
$function$;

COMMENT ON FUNCTION public.process_completed_game_statistics_for_games(uuid[]) IS
  'Processes only the explicitly requested service-role statistics outbox game IDs.';

REVOKE ALL ON FUNCTION public.process_completed_game_statistics_for_games(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_completed_game_statistics_for_games(uuid[])
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
