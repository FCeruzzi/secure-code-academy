-- Credenziali monouso, registro delle azioni del pannello, pulizia dei link.

-- Scadenza della password temporanea (ms epoch): dopo, il primo accesso è
-- rifiutato finché un altro admin non ne genera una nuova.
ALTER TABLE admin_users ADD COLUMN temp_expires_at INTEGER;

-- Registro delle azioni sugli account: chi ha fatto cosa, su chi, quando.
CREATE TABLE admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT ''
);
CREATE INDEX admin_audit_at ON admin_audit(at);

-- Link salvati prima che l'import li validasse: via tutto ciò che non è
-- http(s) (per esempio `javascript:`), come rifiuterebbero oggi form e import.
UPDATE courses SET lab_url = ''
  WHERE lab_url != '' AND lower(trim(lab_url)) NOT LIKE 'http://%' AND lower(trim(lab_url)) NOT LIKE 'https://%';
DELETE FROM presentations WHERE lower(trim(url)) NOT LIKE 'https://%';
DELETE FROM resources WHERE lower(trim(url)) NOT LIKE 'http://%' AND lower(trim(url)) NOT LIKE 'https://%';
DELETE FROM slide_images WHERE lower(trim(url)) NOT LIKE 'https://%';
