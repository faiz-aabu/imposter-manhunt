BEGIN;

CREATE FUNCTION public.create_guest_profile(
  p_nickname text,
  p_token_hash bytea
)
RETURNS TABLE (
  id uuid,
  nickname text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_profile_id uuid;
  v_nickname text;
  v_created_at timestamptz;
  v_updated_at timestamptz;
BEGIN
  IF p_nickname IS NULL
    OR p_nickname <> pg_catalog.btrim(p_nickname)
    OR pg_catalog.char_length(p_nickname) NOT BETWEEN 1 AND 20
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid guest profile nickname.';
  END IF;

  IF p_token_hash IS NULL OR pg_catalog.octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid guest credential hash.';
  END IF;

  INSERT INTO public.profiles AS inserted_profile (nickname)
  VALUES (p_nickname)
  RETURNING
    inserted_profile.id,
    inserted_profile.nickname,
    inserted_profile.created_at,
    inserted_profile.updated_at
  INTO
    v_profile_id,
    v_nickname,
    v_created_at,
    v_updated_at;

  INSERT INTO public.guest_credentials (
    profile_id,
    token_hash,
    expires_at
  )
  VALUES (
    v_profile_id,
    p_token_hash,
    v_created_at + INTERVAL '8760 hours'
  );

  id := v_profile_id;
  nickname := v_nickname;
  created_at := v_created_at;
  updated_at := v_updated_at;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_guest_profile(text, bytea)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_guest_profile(text, bytea)
  TO service_role;

COMMENT ON FUNCTION public.create_guest_profile(text, bytea) IS
  'Atomically creates a guest profile and SHA-256 credential hash; executable only by service_role and returns no credential data.';

NOTIFY pgrst, 'reload schema';

COMMIT;
