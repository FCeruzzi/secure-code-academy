// Autenticazione del pannello: password, sessioni, blocco anti-bruteforce.
// Porta apps/accounts (login, primo accesso obbligato, limite ai tentativi).
import type { AdminUser, Env } from "../env";

const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Token corto per i link dei tornei, come secrets.token_urlsafe(12). */
export function shortToken(): string {
  return randomToken(12);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** Formato `pbkdf2_sha256$<iterazioni>$<salt b64>$<hash b64>`, come Django. */
export async function hashPassword(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2_sha256$${iterations}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algo, iter, salt, hash] = (encoded || "").split("$");
  if (algo !== "pbkdf2_sha256" || !iter || !salt || !hash) return false;
  const iterations = parseInt(iter, 10);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const computed = await pbkdf2(password, unb64(salt), iterations);
  return timingSafeEqual(computed, unb64(hash));
}

export const iterations = (env: Env) => {
  const n = parseInt(env.PBKDF2_ITERATIONS || "", 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 100000) : 100000;
};

export function adminUsernames(env: Env): string[] {
  return (env.ADMIN_USERNAMES || "")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
}

// --- Validazione delle password (i validatori di Django) ------------------------

// Le password più comuni della lista di Django (CommonPasswordValidator), le prime.
const COMMON = new Set(
  `123456 password 12345678 qwerty 123456789 12345 1234 111111 1234567 dragon 123123 baseball abc123
football monkey letmein 696969 shadow master 666666 qwertyuiop 123321 mustang 1234567890 michael
654321 superman 1qaz2wsx 7777777 121212 000000 qazwsx 123qwe killer trustno1 jordan jennifer zxcvbnm
asdfgh hunter buster soccer harley batman andrew tigger sunshine iloveyou 2000 charlie robert thomas
hockey ranger daniel starwars klaster 112233 george computer michelle jessica pepper 1111 zxcvbn
555555 11111111 131313 freedom 777777 pass maggie 159753 aaaaaa ginger princess joshua cheese amanda
summer love ashley 6969 nicole chelsea biteme matthew access yankees 987654321 dallas austin thunder
taylor matrix minecraft password1 password123 admin admin123 welcome welcome1 qwerty123 changeme
passw0rd p@ssw0rd 12341234 abcd1234 1q2w3e4r iloveyou1 sicurezza ciao1234 password! cambiami`.split(/\s+/),
);

/** Restituisce i messaggi di errore (vuoto = password accettata). */
export function passwordProblems(password: string, user: { username?: string; email?: string }): string[] {
  const errors: string[] = [];
  if (password.length < 8) {
    errors.push("Questa password è troppo corta. Deve contenere almeno 8 caratteri.");
  }
  if (COMMON.has(password.trim().toLowerCase())) errors.push("Questa password è troppo comune.");
  if (/^\d+$/.test(password)) errors.push("Questa password è interamente numerica.");
  const lower = password.toLowerCase();
  for (const [label, value] of [
    ["username", user.username],
    ["indirizzo email", (user.email || "").split("@")[0]],
  ] as const) {
    const v = (value || "").toLowerCase();
    if (v.length >= 3 && (lower.includes(v) || v.includes(lower))) {
      errors.push(`La password è troppo simile a ${label}.`);
      break;
    }
  }
  return errors;
}

// --- Sessioni -------------------------------------------------------------------

export const SESSION_SECONDS = 1800;
// Il rinnovo della scadenza si scrive al massimo una volta al minuto, per non
// fare una scrittura su D1 a ogni richiesta del pannello.
const REFRESH_AFTER_MS = 60_000;

export async function createSession(db: D1Database, userId: number): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await db
    .prepare("INSERT INTO admin_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, now + SESSION_SECONDS * 1000, now)
    .run();
  // Pulizia opportunistica delle sessioni scadute.
  await db.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").bind(now).run();
  return token;
}

export async function userForToken(db: D1Database, token: string): Promise<AdminUser | null> {
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT s.expires_at, u.id, u.username, u.email, u.is_active, u.must_change_password
       FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .bind(hash)
    .first<AdminUser & { expires_at: number }>();
  const now = Date.now();
  if (!row || row.expires_at < now || !row.is_active) return null;
  if (row.expires_at - now < SESSION_SECONDS * 1000 - REFRESH_AFTER_MS) {
    await db
      .prepare("UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?")
      .bind(now + SESSION_SECONDS * 1000, hash)
      .run();
  }
  const { expires_at: _ignored, ...user } = row;
  return user;
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
}

export async function destroyUserSessions(db: D1Database, userId: number, exceptToken?: string): Promise<void> {
  if (exceptToken) {
    await db
      .prepare("DELETE FROM admin_sessions WHERE user_id = ? AND token_hash != ?")
      .bind(userId, await sha256Hex(exceptToken))
      .run();
  } else {
    await db.prepare("DELETE FROM admin_sessions WHERE user_id = ?").bind(userId).run();
  }
}

// --- Blocco anti-bruteforce -----------------------------------------------------

export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_SECONDS = 300;

/**
 * La chiave del limite per un IP. Un IPv6 si riduce al suo /64: chi ha una rete
 * IPv6 può cambiare a piacere gli ultimi 64 bit dell'indirizzo.
 */
export function ipKey(ip: string): string {
  if (!ip.includes(":")) return `ip:${ip}`;
  if (ip.includes(".")) return `ip:${ip.slice(ip.lastIndexOf(":") + 1)}`; // ::ffff:1.2.3.4
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `ip:${groups
    .slice(0, 4)
    .map((g) => (parseInt(g || "0", 16) || 0).toString(16))
    .join(":")}::/64`;
}

export const userKey = (username: string) => `user:${username.trim().toLowerCase().slice(0, 150)}`;

/**
 * Conta un tentativo su ogni chiave (IP, username) *prima* di verificare la
 * password, con un incremento atomico: anche cento richieste in parallelo
 * vedono ciascuna il proprio numero, e oltre il limite nessuna arriva al
 * PBKDF2. Finestra fissa di LOGIN_LOCKOUT_SECONDS dal primo tentativo.
 * Restituisce true se almeno una chiave ha superato il limite.
 */
export async function hitLimit(db: D1Database, keys: string[]): Promise<boolean> {
  const now = Date.now();
  const results = await db.batch<{ count: number }>(
    keys.map((key) =>
      db
        .prepare(
          `INSERT INTO login_attempts (ip, count, expires_at) VALUES (?1, 1, ?2)
           ON CONFLICT(ip) DO UPDATE SET
             count = CASE WHEN expires_at < ?3 THEN 1 ELSE count + 1 END,
             expires_at = CASE WHEN expires_at < ?3 THEN ?2 ELSE expires_at END
           RETURNING count`,
        )
        .bind(key, now + LOGIN_LOCKOUT_SECONDS * 1000, now),
    ),
  );
  // Pulizia opportunistica: anche gli username inventati lasciano una riga.
  if (Math.random() < 0.05) await db.prepare("DELETE FROM login_attempts WHERE expires_at < ?").bind(now).run();
  return results.some((r) => (r.results[0]?.count ?? 0) > LOGIN_MAX_ATTEMPTS);
}

export async function clearLimit(db: D1Database, keys: string[]): Promise<void> {
  await db.batch(keys.map((key) => db.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(key)));
}

// --- Password temporanee --------------------------------------------------------

/** Validità di una password temporanea generata dal pannello o dal workflow. */
export const TEMP_PASSWORD_MS = 24 * 3600 * 1000;

// Senza caratteri ambigui (0/O, 1/l/I): si detta o si ricopia a mano.
const TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Password monouso casuale, 4 gruppi da 5 caratteri (circa 114 bit). */
export function temporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let part = "";
    // Rifiuto dei valori oltre il multiplo dell'alfabeto: niente bias.
    while (part.length < 5) {
      const [b] = crypto.getRandomValues(new Uint8Array(1));
      if (b < 256 - (256 % TEMP_ALPHABET.length)) part += TEMP_ALPHABET[b % TEMP_ALPHABET.length];
    }
    groups.push(part);
  }
  return groups.join("-");
}

// --- Registro delle azioni ------------------------------------------------------

export interface AuditEntry {
  actor?: string;
  action: string;
  target?: string;
  ip?: string;
  details?: string;
}

/**
 * Su Workers non c'è SMTP: invece delle email di notifica, ogni azione sugli
 * account resta nel registro che tutti gli amministratori vedono nel pannello.
 */
export async function audit(db: D1Database, e: AuditEntry): Promise<void> {
  await db
    .prepare("INSERT INTO admin_audit (actor, action, target, ip, details) VALUES (?, ?, ?, ?, ?)")
    .bind((e.actor ?? "").slice(0, 150), e.action, (e.target ?? "").slice(0, 150), (e.ip ?? "").slice(0, 64), (e.details ?? "").slice(0, 500))
    .run();
  if (Math.random() < 0.02) {
    await db.prepare("DELETE FROM admin_audit WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-180 days')").run();
  }
}
