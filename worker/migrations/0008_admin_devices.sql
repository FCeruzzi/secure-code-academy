-- Dispositivi riconosciuti del pannello: dopo un accesso riuscito il browser conserva
-- un codice casuale, qui solo come hash. Da quel browser il login non risente del
-- blocco dell'account né della sospensione globale (ha un suo limite di tentativi):
-- chi conosce un username non può tenerne fuori il titolare. Il codice da solo non
-- apre il pannello, serve sempre la password.
CREATE TABLE admin_devices (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX admin_devices_user ON admin_devices(user_id);
