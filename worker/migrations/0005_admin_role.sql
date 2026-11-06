-- Ruolo degli account del pannello: "admin" (gli username di ADMIN_USERNAMES)
-- oppure "consultant", che lavora solo sui contenuti (vedi consultantMay).
ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
