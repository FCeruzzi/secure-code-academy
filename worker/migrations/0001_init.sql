-- Schema iniziale: replica i modelli della versione Django (apps/catalog, apps/quizzes,
-- apps/accounts, apps/tournaments). Lo stato live dei tornei (iscritti, risposte,
-- fase corrente) vive nel Durable Object di ogni torneo; qui restano la
-- configurazione e uno specchio dello stato per gli elenchi.
--
-- Le colonne *_html contengono l'HTML già renderizzato al salvataggio: le letture
-- pubbliche non rifanno Markdown ed evidenziazione, così restano sotto il limite
-- di CPU del piano gratuito.

CREATE TABLE courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  is_published INTEGER NOT NULL DEFAULT 0,
  lab_url TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE microcourses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  difficulty INTEGER NOT NULL DEFAULT 1,
  estimated_minutes INTEGER NOT NULL DEFAULT 10,
  is_published INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (course_id, slug)
);
CREATE INDEX microcourses_course ON microcourses(course_id, sort_order, id);

CREATE TABLE slides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  microcourse_id INTEGER NOT NULL REFERENCES microcourses(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  section TEXT NOT NULL DEFAULT 'THEORY',
  body_markdown TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX slides_mc ON slides(microcourse_id, sort_order, id);

CREATE TABLE slide_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  microcourse_id INTEGER NOT NULL REFERENCES microcourses(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  alt_text TEXT NOT NULL DEFAULT '',
  ref_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (microcourse_id, ref_key)
);

-- Solo presentazioni di corso: quelle di microcorso nella versione Django non hanno nessun
-- link pubblico, quindi non sono state portate.
CREATE TABLE presentations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX presentations_course ON presentations(course_id, sort_order, id);

CREATE TABLE resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX resources_course ON resources(course_id, sort_order, id);

CREATE TABLE quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  microcourse_id INTEGER NOT NULL UNIQUE REFERENCES microcourses(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- `data` è il payload JSON per tipo (vedi src/lib/validators.ts); `render` è il
-- JSON con l'HTML pre-renderizzato (testo, spiegazione, righe di codice, file).
CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  qtype TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  explanation TEXT NOT NULL DEFAULT '',
  course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  difficulty INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL DEFAULT '{}',
  render TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX questions_course ON questions(course_id, is_active);
CREATE INDEX questions_qtype ON questions(qtype);

CREATE TABLE quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (quiz_id, question_id)
);
CREATE INDEX quiz_questions_quiz ON quiz_questions(quiz_id, sort_order, id);

-- Amministratori: solo gli username di ADMIN_USERNAMES (wrangler.toml).
CREATE TABLE admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  last_login TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Sessioni del pannello: si salva solo l'hash del token. Scadenza scorrevole di
-- 30 minuti di inattività, come SESSION_COOKIE_AGE nella versione Django.
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX admin_sessions_user ON admin_sessions(user_id);

-- Blocco anti-bruteforce del login, per IP.
CREATE TABLE login_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

CREATE TABLE tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  join_token TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  pool_size INTEGER,
  num_rounds INTEGER NOT NULL DEFAULT 1,
  per_question_seconds INTEGER NOT NULL DEFAULT 60,
  reveal_seconds INTEGER NOT NULL DEFAULT 5,
  points_correct INTEGER NOT NULL DEFAULT 100,
  time_bonus INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  -- Specchio dello stato del Durable Object, aggiornato a ogni transizione.
  status TEXT NOT NULL DEFAULT 'DRAFT',
  participant_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX tournaments_status ON tournaments(status);

CREATE TABLE tournament_courses (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  PRIMARY KEY (tournament_id, course_id)
);

-- Domande congelate nei round (scritte dal Durable Object). Servono a impedire
-- l'eliminazione di una domanda usata in un torneo, come il PROTECT della versione Django.
CREATE TABLE tournament_questions (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  round INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (tournament_id, question_id, round)
);
CREATE INDEX tournament_questions_question ON tournament_questions(question_id);
