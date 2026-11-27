CREATE TABLE public.room_runtime_fencing (
  singleton_id smallint PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0)
);

INSERT INTO public.room_runtime_fencing (singleton_id, epoch)
VALUES (1, 0);

ALTER TABLE public.room_runtime_fencing ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.room_runtime_fencing
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON TABLE public.room_runtime_fencing
  TO service_role;

COMMENT ON TABLE public.room_runtime_fencing IS
  'Single monotonically increasing fencing epoch for the exclusive durable-room runtime owner.';
