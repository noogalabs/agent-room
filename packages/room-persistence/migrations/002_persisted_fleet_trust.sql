CREATE TABLE IF NOT EXISTS agent_room_fleet_trust_keys (
  fleet_id text NOT NULL,
  key_id text NOT NULL,
  public_key_json jsonb NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (fleet_id, key_id)
);

INSERT INTO agent_room_schema_migrations (version, applied_at)
VALUES (2, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
ON CONFLICT (version) DO NOTHING;
