-- user_integrations already supports provider='google_calendar'.
-- Ensure the unique index exists for upsert conflict resolution.

CREATE UNIQUE INDEX IF NOT EXISTS user_integrations_user_provider
  ON user_integrations(user_id, provider);
