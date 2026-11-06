-- Gli amministratori non registrano più un'email: nessuna notifica parte da
-- qui, e un dato personale in meno da custodire.
ALTER TABLE admin_users DROP COLUMN email;
