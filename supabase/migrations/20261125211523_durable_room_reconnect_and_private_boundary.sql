ALTER TABLE public.rooms
  ALTER COLUMN expires_at DROP NOT NULL,
  ADD CONSTRAINT rooms_id_game_mode_unique UNIQUE (id, game_mode);

COMMENT ON COLUMN public.rooms.expires_at IS
  'NULL means automatic timed expiry is not configured.';

ALTER TABLE public.room_players
  ADD COLUMN reconnect_deadline_at timestamptz,
  ADD COLUMN disconnect_generation bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT room_players_disconnect_generation_nonnegative
    CHECK (disconnect_generation >= 0),
  ADD CONSTRAINT room_players_reconnect_deadline_consistent
    CHECK (
      reconnect_deadline_at IS NULL
      OR (
        membership_status = 'active'
        AND connection_status = 'disconnected'
      )
    ),
  ADD CONSTRAINT room_players_disconnected_deadline_required
    CHECK (
      membership_status <> 'active'
      OR connection_status <> 'disconnected'
      OR reconnect_deadline_at IS NOT NULL
    ) NOT VALID;

CREATE INDEX room_players_due_reconnect_idx
  ON public.room_players (reconnect_deadline_at, room_id, player_id)
  WHERE membership_status = 'active'
    AND connection_status = 'disconnected'
    AND reconnect_deadline_at IS NOT NULL;

CREATE TABLE public.room_private_manhunt_boundaries (
  room_id uuid PRIMARY KEY,
  room_game_mode text NOT NULL DEFAULT 'manhunt',
  center_latitude numeric NOT NULL,
  center_longitude numeric NOT NULL,
  radius_meters numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_private_manhunt_boundaries_mode_valid
    CHECK (room_game_mode = 'manhunt'),
  CONSTRAINT room_private_manhunt_boundaries_latitude_valid
    CHECK (center_latitude BETWEEN -90 AND 90),
  CONSTRAINT room_private_manhunt_boundaries_longitude_valid
    CHECK (center_longitude BETWEEN -180 AND 180),
  CONSTRAINT room_private_manhunt_boundaries_radius_valid
    CHECK (radius_meters BETWEEN 100 AND 1000),
  CONSTRAINT room_private_manhunt_boundaries_room_mode_fkey
    FOREIGN KEY (room_id, room_game_mode)
    REFERENCES public.rooms (id, game_mode)
    ON DELETE CASCADE
);

ALTER TABLE public.room_private_manhunt_boundaries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.room_private_manhunt_boundaries
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.room_private_manhunt_boundaries
  TO service_role;