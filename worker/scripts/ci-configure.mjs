// Prepara wrangler.toml prima di un comando remoto (deploy, migrazioni, admin):
// trova il database D1 "sca" nell'account Cloudflare, lo crea se non esiste
// ancora, e ne scrive l'id in wrangler.toml. Scrive anche gli amministratori
// autorizzati (ADMIN_USERNAMES, obbligatoria) e, se impostata, SITE_ORIGIN.
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… ADMIN_USERNAMES=… node scripts/ci-configure.mjs
//
// Così il repository non contiene né l'id del database né gli username.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOML = join(HERE, "../wrangler.toml");
const NAME = "sca";

const wrangler = (...args) =>
  execFileSync("npx", ["wrangler", ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"], cwd: join(HERE, "..") });

function findDatabase() {
  const list = JSON.parse(wrangler("d1", "list", "--json"));
  return list.find((db) => db.name === NAME);
}

const admins = (process.env.ADMIN_USERNAMES || "")
  .split(",")
  .map((u) => u.trim().toLowerCase())
  .filter((u) => /^[\w.@+-]+$/.test(u));
if (!admins.length) {
  console.error("::error::Imposta la variabile ADMIN_USERNAMES del repository (username separati da virgola).");
  process.exit(1);
}

let db = findDatabase();
if (!db) {
  console.log(`Database D1 "${NAME}" non trovato: lo creo (regione Europa occidentale).`);
  wrangler("d1", "create", NAME, "--location", "weur");
  db = findDatabase();
}
if (!db) throw new Error(`Impossibile trovare o creare il database D1 "${NAME}".`);

let toml = readFileSync(TOML, "utf-8");
toml = toml.replace(/^database_id = ".*"$/m, `database_id = "${db.uuid}"`);
toml = toml.replace(/^ADMIN_USERNAMES = ".*"$/m, `ADMIN_USERNAMES = "${admins.join(",")}"`);
const origin = (process.env.SITE_ORIGIN || "").trim();
if (origin) toml = toml.replace(/^SITE_ORIGIN = ".*"$/m, `SITE_ORIGIN = "${origin.replace(/"/g, "")}"`);
writeFileSync(TOML, toml);
console.log(`wrangler.toml: database ${db.uuid}, ${admins.length} amministratori${origin ? `, origine del sito ${origin}` : ""}.`);
