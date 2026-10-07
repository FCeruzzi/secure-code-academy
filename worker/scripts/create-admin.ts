// Genera admin.sql con gli account amministratore: l'equivalente di
// `manage.py create_admin` della versione Django.
//
//   ADMIN_USERNAMES=alice,bruno ADMIN_PASSWORD='la-password-temporanea' npx tsx scripts/create-admin.ts [admin.sql]
//   npx wrangler d1 execute sca --remote --file admin.sql
//
// Crea gli username di ADMIN_USERNAMES (variabile d'ambiente, altrimenti
// wrangler.toml) con la password temporanea comune; al primo accesso ognuno
// deve sceglierne una propria e registrare l'email. Rilanciarlo non tocca chi ha già completato il primo
// accesso.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, TEMP_PASSWORD_MS } from "../src/lib/auth";

const HERE = dirname(fileURLToPath(import.meta.url));
const toml = readFileSync(join(HERE, "../wrangler.toml"), "utf-8");
const usernames = (process.env.ADMIN_USERNAMES || toml.match(/^ADMIN_USERNAMES\s*=\s*"([^"]*)"/m)?.[1] || "")
  .split(",")
  .map((u) => u.trim().toLowerCase())
  .filter(Boolean);
const iterations = parseInt(toml.match(/^PBKDF2_ITERATIONS\s*=\s*"(\d+)"/m)?.[1] ?? "100000", 10);

const password = process.env.ADMIN_PASSWORD;
if (!password) {
  console.error("Imposta la variabile d'ambiente ADMIN_PASSWORD con la password temporanea.");
  process.exit(1);
}
if (!usernames.length) {
  console.error("Imposta ADMIN_USERNAMES (username separati da virgola).");
  process.exit(1);
}

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const lines = ["-- Generato da worker/scripts/create-admin.ts: contiene hash di password, non committarlo."];
// La password vale per il primo accesso entro TEMP_PASSWORD_MS (24 ore), come
// quelle generate dal pannello.
const expires = Date.now() + TEMP_PASSWORD_MS;
for (const username of usernames) {
  const hash = await hashPassword(password, iterations);
  lines.push(
    `INSERT INTO admin_users (username, password_hash, must_change_password, is_active, temp_expires_at) VALUES (${q(username)}, ${q(hash)}, 1, 1, ${expires})
     ON CONFLICT(username) DO UPDATE SET is_active = 1,
       password_hash = CASE WHEN admin_users.must_change_password = 1 THEN excluded.password_hash ELSE admin_users.password_hash END,
       temp_expires_at = CASE WHEN admin_users.must_change_password = 1 THEN excluded.temp_expires_at ELSE admin_users.temp_expires_at END;`,
    `INSERT INTO admin_audit (actor, action, target) VALUES ('workflow', 'bootstrap', ${q(username)});`,
  );
}
const out = resolve(process.argv[2] || join(HERE, "../admin.sql"));
writeFileSync(out, lines.join("\n") + "\n");
console.log(`Scritto ${out} per: ${usernames.join(", ")}.`);
console.log("Accedi da /admin/login/ entro 24 ore con l'username e la password temporanea: al primo accesso il pannello chiede di cambiarla.");
