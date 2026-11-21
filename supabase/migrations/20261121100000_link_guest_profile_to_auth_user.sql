BEGIN;

CREATE FUNCTION public.link_guest_profile_to_auth_user(
  p_token_hash bytea,
  p_supabase_user_id uuid
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
  v_profile public.profiles%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL
    OR pg_catalog.octet_length(p_token_hash) <> 32
    OR p_supabase_user_id IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid guest profile link request.';
  END IF;

  -- Serialize claims for the same account and prevent duplicate account profiles.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_supabase_user_id::text, 0)
  );

  SELECT credential.profile_id
  INTO v_profile_id
  FROM public.guest_credentials AS credential
  WHERE credential.token_hash = p_token_hash
    AND credential.revoked_at IS NULL
    AND credential.expires_at > pg_catalog.now()
  FOR UPDATE;

  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '28000',
      MESSAGE = 'Guest credential is invalid or expired.';
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM public.profiles AS profile
  WHERE profile.id = v_profile_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_profile.anonymized_at IS NOT NULL
    OR v_profile.merged_into_profile_id IS NOT NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '28000',
      MESSAGE = 'Guest credential is invalid or expired.';
  END IF;

  -- Repeating the same claim is safe; claiming a different account is not.
  IF v_profile.supabase_user_id = p_supabase_user_id THEN
    id := v_profile.id;
    nickname := v_profile.nickname;
    created_at := v_profile.created_at;
    updated_at := v_profile.updated_at;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_profile.supabase_user_id IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM public.profiles AS existing_profile
      WHERE existing_profile.supabase_user_id = p_supabase_user_id
        AND existing_profile.id <> v_profile_id
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '28000',
      MESSAGE = 'Guest profile cannot be linked to this account.';
  END IF;

  UPDATE public.profiles
  SET supabase_user_id = p_supabase_user_id
  WHERE public.profiles.id = v_profile_id
  RETURNING
    public.profiles.id,
    public.profiles.nickname,
    public.profiles.created_at,
    public.profiles.updated_at
  INTO id, nickname, created_at, updated_at;

  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.link_guest_profile_to_auth_user(bytea, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_guest_profile_to_auth_user(bytea, uuid)
  TO service_role;

COMMENT ON FUNCTION public.link_guest_profile_to_auth_user(bytea, uuid) IS
  'Links an existing guest profile only when its high-entropy credential is proven; preserves nickname and all game history and is idempotent for the same auth user.';

NOTIFY pgrst, 'reload schema';

COMMIT;
