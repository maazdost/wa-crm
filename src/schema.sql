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

CREATE TABLE IF NOT EXISTS chat_flags (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  pinned BOOLEAN NOT NULL DEFAULT FALSE, pinned_at TIMESTAMPTZ,
  favorite BOOLEAN NOT NULL DEFAULT FALSE, archived BOOLEAN NOT NULL DEFAULT FALSE, marked_unread BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, conversation_id)
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_wa_id TEXT;

-- Several WhatsApp Business numbers. Add or remove them from Settings; no redeploy needed.
CREATE TABLE IF NOT EXISTS wa_numbers (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  phone_number_id TEXT UNIQUE NOT NULL,
  display_phone TEXT,
  verified_name TEXT,
  access_token TEXT,            -- encrypted; empty means "use the WA_ACCESS_TOKEN of the server"
  waba_id TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- (one default number per company: see one_default_wa_number_per_company further down)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS wa_number_id INT REFERENCES wa_numbers(id);
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS wa_number_id INT REFERENCES wa_numbers(id);

-- Password reset links (only a hash of the link token is stored)
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- WhatsApp calling: off by default, switched per number from Settings
ALTER TABLE wa_numbers ADD COLUMN IF NOT EXISTS calls_enabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS calls (
  id SERIAL PRIMARY KEY,
  wa_call_id TEXT UNIQUE,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  wa_number_id INT REFERENCES wa_numbers(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  status TEXT NOT NULL DEFAULT 'ringing',
  agent_id INT REFERENCES users(id),
  sdp_offer TEXT,
  sdp_answer TEXT,
  error TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calls_conv ON calls(conversation_id, id DESC);

-- Departments (shown in Settings, used by the bot and by team members), and turn-taking assignment
CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- (the starting departments are added per company further down)
ALTER TABLE users ADD COLUMN IF NOT EXISTS in_rotation BOOLEAN NOT NULL DEFAULT TRUE;
CREATE TABLE IF NOT EXISTS rr_state (team TEXT PRIMARY KEY, last_user_id INT, given INT NOT NULL DEFAULT 0);
ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS buttons JSONB;

-- Lets an admin end a person's sessions (after an email change, password reset or deactivation)
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INT NOT NULL DEFAULT 0;

-- ============================================================================
-- Several companies on one system (sign-up). Every company only sees its own data.
-- Everything that existed before this update belongs to company 1, so the current client keeps working unchanged.
-- Safe to run again and again: nothing is deleted.
-- ============================================================================
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO companies(id, name) VALUES (1, 'Main company') ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('companies','id'), GREATEST((SELECT MAX(id) FROM companies), 1));

-- Stamp each table with its company. Existing rows get company 1; after that the default is removed,
-- so new rows must always say which company they belong to.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','contacts','conversations','templates','settings','quick_replies','labels',
                           'broadcasts','drips','wa_numbers','departments','rr_state'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = t AND column_name = 'company_id') THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN company_id INT NOT NULL DEFAULT 1 REFERENCES companies(id)', t);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN company_id DROP DEFAULT', t);
    END IF;
  END LOOP;
END $$;

-- Names that were unique for the whole system are now unique inside each company
CREATE UNIQUE INDEX IF NOT EXISTS contacts_company_wa ON contacts(company_id, wa_id);
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_wa_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS templates_company_name ON templates(company_id, name);
ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS quick_replies_company_shortcut ON quick_replies(company_id, shortcut);
ALTER TABLE quick_replies DROP CONSTRAINT IF EXISTS quick_replies_shortcut_key;
CREATE UNIQUE INDEX IF NOT EXISTS labels_company_name ON labels(company_id, name);
ALTER TABLE labels DROP CONSTRAINT IF EXISTS labels_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS departments_company_key ON departments(company_id, key);
ALTER TABLE departments DROP CONSTRAINT IF EXISTS departments_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS one_default_wa_number_per_company ON wa_numbers(company_id) WHERE is_default;
DROP INDEX IF EXISTS one_default_wa_number;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_company_key_pk') THEN
    ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey;
    ALTER TABLE settings ADD CONSTRAINT settings_company_key_pk PRIMARY KEY (company_id, key);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rr_state_company_team_pk') THEN
    ALTER TABLE rr_state DROP CONSTRAINT IF EXISTS rr_state_pkey;
    ALTER TABLE rr_state ADD CONSTRAINT rr_state_company_team_pk PRIMARY KEY (company_id, team);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_conv_company ON conversations(company_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);

-- Starting departments for company 1 (only added if missing)
INSERT INTO departments(company_id,key,name) VALUES (1,'general','General'),(1,'sales','Sales'),(1,'recruitment','Recruitment'),(1,'classes','Classes')
  ON CONFLICT (company_id, key) DO NOTHING;
INSERT INTO departments(company_id,key,name) SELECT DISTINCT company_id, team, initcap(team) FROM users WHERE team IS NOT NULL AND team <> ''
  ON CONFLICT (company_id, key) DO NOTHING;
