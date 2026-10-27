CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin','manager','agent')),
  team TEXT NOT NULL DEFAULT 'general',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_online BOOLEAN NOT NULL DEFAULT FALSE,
  max_active_chats INT NOT NULL DEFAULT 150,
  last_assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  wa_id TEXT UNIQUE NOT NULL,
  name TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  contact_id INT UNIQUE NOT NULL REFERENCES contacts(id),
  assigned_to INT REFERENCES users(id),
  team TEXT,
  intent TEXT,
  status TEXT NOT NULL DEFAULT 'bot' CHECK (status IN ('bot','open','closed')),
  bot_step TEXT NOT NULL DEFAULT 'new',
  last_customer_message_at TIMESTAMPTZ,
  window_expires_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_agent_reply_at TIMESTAMPTZ,
  unread_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_assigned ON conversations(assigned_to, status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES conversations(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer','bot','agent')),
  sender_id INT REFERENCES users(id),
  wa_message_id TEXT UNIQUE,
  type TEXT NOT NULL DEFAULT 'text',
  body TEXT,
  media_id TEXT,
  template_name TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS templates (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'utility',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notes (
  id SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES conversations(id),
  user_id INT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_name TEXT;
CREATE TABLE IF NOT EXISTS media (
  wa_media_id TEXT PRIMARY KEY, mime TEXT, size INT, data BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), token TEXT UNIQUE NOT NULL,
  platform TEXT NOT NULL DEFAULT 'android', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS quick_replies (
  id SERIAL PRIMARY KEY, shortcut TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS labels (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, color TEXT NOT NULL DEFAULT '#0e5a4a');
CREATE TABLE IF NOT EXISTS conversation_labels (
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  label_id INT NOT NULL REFERENCES labels(id) ON DELETE CASCADE, PRIMARY KEY (conversation_id, label_id)
);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_away_at TIMESTAMPTZ;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS opted_out BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS list_name TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS opt_in_source TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'local';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS meta_id TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS rejected_reason TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS var_count INT NOT NULL DEFAULT 0;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS footer TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS buttons JSONB;
UPDATE templates SET var_count=1 WHERE name='followup_interest' AND var_count=0;

CREATE TABLE IF NOT EXISTS broadcasts (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, template_name TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sending','done','cancelled')),
  segment JSONB, var_map JSONB, scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  created_by INT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id BIGSERIAL PRIMARY KEY, broadcast_id INT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  contact_id INT NOT NULL REFERENCES contacts(id), wa_id TEXT NOT NULL, params JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued', wa_message_id TEXT, error TEXT, sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_br_b ON broadcast_recipients(broadcast_id, status);
CREATE INDEX IF NOT EXISTS idx_br_msg ON broadcast_recipients(wa_message_id);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS profile_name TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_personal BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS drips (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, stop_on_reply BOOLEAN NOT NULL DEFAULT TRUE,
  steps JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drip_enrollments (
  id BIGSERIAL PRIMARY KEY, drip_id INT NOT NULL REFERENCES drips(id) ON DELETE CASCADE, contact_id INT NOT NULL REFERENCES contacts(id),
  step INT NOT NULL DEFAULT 0, next_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (drip_id, contact_id)
);
