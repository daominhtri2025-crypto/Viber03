-- Migration PostgreSQL 0001: schema hoàn chỉnh tương đương trạng thái sau migration SQLite 0000–0011.
-- Lý do tách track: chuyển sang Neon (PostgreSQL) theo kế hoạch phương án B. Không sửa drizzle/*.sql (CLAUDE.md mục 5).
-- Tác động dữ liệu: áp dụng trên cơ sở dữ liệu rỗng. Không có dữ liệu D1 nào được chuyển trong migration này.
-- Khôi phục: DROP SCHEMA public CASCADE; CREATE SCHEMA public; (chỉ trên cơ sở dữ liệu thử nghiệm).
-- Thời điểm lưu theo ISO 8601 UTC dạng text, giữ nguyên quy ước của bản SQLite.

CREATE TABLE learners (
  id text PRIMARY KEY NOT NULL,
  code text NOT NULL UNIQUE,
  created text NOT NULL
);

CREATE TABLE staff (
  email text PRIMARY KEY NOT NULL,
  created text NOT NULL
);

CREATE TABLE lessons (
  lesson integer PRIMARY KEY NOT NULL,
  title text NOT NULL,
  group_no integer NOT NULL,
  body text NOT NULL,
  quiz text NOT NULL,
  next_step text,
  created text NOT NULL,
  updated text NOT NULL,
  hidden integer NOT NULL DEFAULT 0,
  CONSTRAINT lessons_lesson_min CHECK (lesson >= 0),
  CONSTRAINT lessons_group_range CHECK (group_no BETWEEN 1 AND 5),
  CONSTRAINT lessons_hidden_bool CHECK (hidden IN (0, 1))
);

CREATE TABLE lesson_versions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lesson integer NOT NULL REFERENCES lessons(lesson),
  title text NOT NULL,
  group_no integer NOT NULL,
  body text NOT NULL,
  quiz text NOT NULL,
  next_step text,
  hidden integer NOT NULL,
  saved_by text NOT NULL,
  saved_at text NOT NULL
);
CREATE INDEX lesson_versions_lesson_idx ON lesson_versions (lesson, saved_at);

CREATE TABLE videos (
  lesson integer PRIMARY KEY NOT NULL,
  key text NOT NULL,
  mime text NOT NULL,
  duration integer NOT NULL,
  updated text NOT NULL,
  kind text NOT NULL DEFAULT 'file',
  url text
);

CREATE TABLE progress (
  learner text NOT NULL REFERENCES learners(id),
  lesson integer NOT NULL,
  read integer NOT NULL DEFAULT 0,
  done integer NOT NULL DEFAULT 0,
  score integer NOT NULL DEFAULT 0,
  updated text NOT NULL,
  completed_at text,
  PRIMARY KEY (learner, lesson)
);
CREATE INDEX progress_lesson_idx ON progress (lesson);
CREATE INDEX progress_completed_at_idx ON progress (completed_at);

CREATE TABLE assessments (
  id text PRIMARY KEY NOT NULL,
  learner text NOT NULL REFERENCES learners(id),
  phase text NOT NULL,
  scores text NOT NULL,
  assessor text NOT NULL,
  created text NOT NULL,
  client_id text
);
CREATE UNIQUE INDEX assessments_learner_client_unique ON assessments (learner, client_id);

CREATE TABLE quiz_attempts (
  id text PRIMARY KEY NOT NULL,
  learner text NOT NULL REFERENCES learners(id),
  lesson integer NOT NULL,
  choice integer NOT NULL,
  correct integer NOT NULL,
  client_id text NOT NULL,
  created text NOT NULL,
  CONSTRAINT quiz_attempts_lesson_min CHECK (lesson >= 0),
  CONSTRAINT quiz_attempts_choice_min CHECK (choice >= 0),
  CONSTRAINT quiz_attempts_correct_bool CHECK (correct IN (0, 1))
);
CREATE UNIQUE INDEX quiz_attempts_learner_client_unique ON quiz_attempts (learner, client_id);
CREATE INDEX quiz_attempts_lesson_created_idx ON quiz_attempts (lesson, created);
CREATE INDEX quiz_attempts_learner_lesson_idx ON quiz_attempts (learner, lesson);

CREATE TABLE accounts (
  id text PRIMARY KEY NOT NULL,
  email text NOT NULL UNIQUE,
  full_name text,
  password_hash text NOT NULL,
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_change integer NOT NULL DEFAULT 0 CHECK (must_change IN (0, 1)),
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until text,
  created text NOT NULL,
  updated text NOT NULL
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY NOT NULL,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'volunteer')),
  expires_at text NOT NULL,
  created text NOT NULL
);
CREATE INDEX sessions_account_idx ON sessions (account_id);

CREATE TABLE password_reset_tokens (
  id text PRIMARY KEY NOT NULL,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created text NOT NULL,
  expires_at text NOT NULL,
  used_at text
);
CREATE INDEX password_reset_tokens_account_idx ON password_reset_tokens (account_id, created);

CREATE TABLE request_limits (
  key text PRIMARY KEY NOT NULL,
  window_start text NOT NULL,
  count integer NOT NULL CHECK (count >= 0)
);

CREATE TABLE news (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  summary text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 500),
  content text NOT NULL DEFAULT '' CHECK (char_length(content) <= 5000),
  source_url text CHECK (source_url IS NULL OR (source_url LIKE 'https://%' AND char_length(source_url) <= 500)),
  hidden integer NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  published_at text NOT NULL,
  created_by text,
  created text NOT NULL,
  updated text NOT NULL
);
CREATE INDEX news_visible_published_idx ON news (hidden, published_at);
