// Accesso al pannello e gestione degli amministratori. Porta apps/accounts.
import { Hono, type MiddlewareHandler } from "hono";
import type { Context } from "hono";
import type { AdminUser, AppEnv } from "../env";
import {
  adminUsernames,
  audit,
  clearLimit,
  createSession,
  destroySession,
  destroyUserSessions,
  hitLimit,
  ipKey,
  passwordProblems,
  TEMP_PASSWORD_MS,
  temporaryPassword,
  userForToken,
  userKey,
} from "../lib/auth";
import { hashPw, verifyPw } from "../lib/hasher";
import { HttpError, badRequest, intParam, notFound, readJson, str } from "../lib/http";

export const authRoutes = new Hono<AppEnv>();

const bearer = (header: string | undefined) => (header?.startsWith("Bearer ") ? header.slice(7).trim() : "");

// Raggiungibili anche durante il primo accesso, come le eccezioni di
// AdminSetupRequiredMiddleware.
const SETUP_EXEMPT = new Set(["/api/admin/me", "/api/admin/setup", "/api/admin/logout"]);

/** Richiede un admin autenticato; durante il primo accesso consente solo il setup. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await userForToken(c.env.DB, bearer(c.req.header("Authorization")));
  if (!user || !adminUsernames(c.env).includes(user.username.toLowerCase())) {
    throw new HttpError(401, "Sessione scaduta: accedi di nuovo.", { login_required: true });
  }
  if (user.must_change_password && !SETUP_EXEMPT.has(c.req.path)) {
    throw new HttpError(403, "Prima di continuare imposta la tua password.", { setup_required: true });
  }
  c.set("user", user);
  await next();
};

const publicUser = (u: AdminUser) => ({
  id: u.id,
  username: u.username,
  email: u.email,
  must_change_password: Boolean(u.must_change_password),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function cleanEmail(db: D1Database, value: unknown, excludeId: number | null): Promise<string> {
  const email = str(value, 254).trim().toLowerCase();
  if (!email) throw badRequest("Questo campo è obbligatorio.", { errors: { email: ["Questo campo è obbligatorio."] } });
  if (!EMAIL_RE.test(email)) {
    throw badRequest("Inserisci un indirizzo email valido.", { errors: { email: ["Inserisci un indirizzo email valido."] } });
  }
  const clash = await db
    .prepare("SELECT 1 FROM admin_users WHERE lower(email) = ? AND id != ?")
    .bind(email, excludeId ?? -1)
    .first();
  if (clash) {
    const msg = "Questa email è già usata da un altro amministratore.";
    throw badRequest(msg, { errors: { email: [msg] } });
  }
  return email;
}

function checkNewPassword(p1: string, p2: string, user: { username: string; email: string }) {
  const errors: Record<string, string[]> = {};
  if (!p1) errors.new_password1 = ["Questo campo è obbligatorio."];
  if (!p2) errors.new_password2 = ["Questo campo è obbligatorio."];
  if (p1 && p2 && p1 !== p2) errors.new_password2 = ["Le password non coincidono."];
  if (p1) {
    const problems = passwordProblems(p1, user);
    if (problems.length) errors.new_password1 = [...(errors.new_password1 || []), ...problems];
  }
  return errors;
}

const clientIp = (c: Context<AppEnv>) => c.req.header("CF-Connecting-IP") || "unknown";

const TOO_MANY = "Troppi tentativi di accesso falliti. Riprova tra qualche minuto.";

/**
 * Le azioni sugli altri amministratori si confermano con la propria password:
 * un token di sessione rubato da solo non basta per prendersi un account.
 */
async function confirmSelf(c: Context<AppEnv>, body: Record<string, unknown>): Promise<void> {
  const user = c.get("user");
  const password = str(body.confirm_password, 4096);
  const fail = (msg: string) => badRequest(msg, { errors: { confirm_password: [msg] } });
  if (!password) throw fail("Per confermare inserisci la tua password.");
  const keys = [userKey(user.username)];
  if (await hitLimit(c.env.DB, keys)) throw new HttpError(429, TOO_MANY);
  const row = await c.env.DB.prepare("SELECT password_hash FROM admin_users WHERE id = ?").bind(user.id).first<{ password_hash: string }>();
  if (!(await verifyPw(c.env, password, row?.password_hash ?? null))) throw fail("Password non corretta.");
  await clearLimit(c.env.DB, keys);
}

/** Nuova password temporanea, valida TEMP_PASSWORD_MS: la vede solo chi la genera. */
async function issueTemporary(c: Context<AppEnv>) {
  const password = temporaryPassword();
  const expiresAt = Date.now() + TEMP_PASSWORD_MS;
  return { password, expiresAt, hash: await hashPw(c.env, password) };
}

// --- Login / logout ------------------------------------------------------------

authRoutes.post("/login", async (c) => {
  const db = c.env.DB;
  const ip = clientIp(c);
  const body = await readJson<{ username?: string; password?: string }>(c);
  const username = str(body.username, 150).trim();
  const password = str(body.password, 4096);
  if (!username || !password) {
    throw badRequest("Inserisci username e password.");
  }
  // Limite per IP e per account, contato prima della verifica.
  const keys = [ipKey(ip), userKey(username)];
  if (await hitLimit(db, keys)) throw new HttpError(429, TOO_MANY);
  const row = await db
    .prepare("SELECT * FROM admin_users WHERE username = ?")
    .bind(username)
    .first<AdminUser & { password_hash: string; temp_expires_at: number | null }>();
  // Account inesistente o disattivato: il PBKDF2 si calcola comunque.
  const ok = await verifyPw(c.env, password, row?.is_active ? row.password_hash : null);
  if (!ok || !row) {
    await audit(db, { action: "login_failed", target: username, ip });
    throw badRequest("Username o password non corretti.");
  }
  if (!adminUsernames(c.env).includes(row.username.toLowerCase())) {
    await audit(db, { action: "login_failed", target: row.username, ip, details: "username non autorizzato" });
    throw badRequest("Questo account non è fra gli amministratori autorizzati.");
  }
  if (row.must_change_password && !(row.temp_expires_at && row.temp_expires_at > Date.now())) {
    await audit(db, { action: "login_failed", target: row.username, ip, details: "password temporanea scaduta" });
    throw badRequest("La password temporanea è scaduta: chiedi a un altro amministratore di generarne una nuova.");
  }
  await clearLimit(db, keys);
  await db.prepare("UPDATE admin_users SET last_login = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(row.id).run();
  await audit(db, { actor: row.username, action: "login", ip });
  const token = await createSession(db, row.id);
  return c.json({ token, user: publicUser(row) });
});

authRoutes.post("/logout", async (c) => {
  await destroySession(c.env.DB, bearer(c.req.header("Authorization")));
  return c.json({ ok: true });
});

authRoutes.get("/me", (c) => c.json({ user: publicUser(c.get("user")) }));

// --- Primo accesso e cambio password -------------------------------------------

authRoutes.post("/setup", async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  if (!user.must_change_password) return c.json({ user: publicUser(user) });
  const body = await readJson<Record<string, unknown>>(c);
  const errors: Record<string, string[]> = {};
  let email = "";
  try {
    email = await cleanEmail(db, body.email, user.id);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    Object.assign(errors, e.extra.errors);
  }
  const p1 = str(body.new_password1, 4096);
  const p2 = str(body.new_password2, 4096);
  Object.assign(errors, checkNewPassword(p1, p2, { username: user.username, email }));
  if (p1 && !errors.new_password1) {
    const row = await db.prepare("SELECT password_hash FROM admin_users WHERE id = ?").bind(user.id).first<{ password_hash: string }>();
    // La password temporanea l'ha vista anche chi l'ha generata: tenerla
    // annullerebbe il senso del primo accesso.
    if (row && (await verifyPw(c.env, p1, row.password_hash))) {
      errors.new_password1 = ["Scegli una password diversa da quella temporanea."];
    }
  }
  if (Object.keys(errors).length) throw badRequest("Correggi gli errori indicati.", { errors });
  await db
    .prepare("UPDATE admin_users SET email = ?, password_hash = ?, must_change_password = 0, temp_expires_at = NULL WHERE id = ?")
    .bind(email, await hashPw(c.env, p1), user.id)
    .run();
  await destroyUserSessions(db, user.id, bearer(c.req.header("Authorization")));
  await audit(db, { actor: user.username, action: "setup_completed", ip: clientIp(c), details: email });
  return c.json({
    user: { ...publicUser(user), email, must_change_password: false },
    message: "Password impostata. Benvenuto nell'area amministratore.",
  });
});

authRoutes.post("/password", async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const body = await readJson<Record<string, unknown>>(c);
  const old = str(body.old_password, 4096);
  const p1 = str(body.new_password1, 4096);
  const p2 = str(body.new_password2, 4096);
  const row = await db.prepare("SELECT password_hash FROM admin_users WHERE id = ?").bind(user.id).first<{ password_hash: string }>();
  const errors: Record<string, string[]> = {};
  if (!old) errors.old_password = ["Questo campo è obbligatorio."];
  else if (!row || !(await verifyPw(c.env, old, row.password_hash))) {
    errors.old_password = ["La tua vecchia password non è stata inserita correttamente. Inseriscila nuovamente."];
  }
  Object.assign(errors, checkNewPassword(p1, p2, user));
  if (Object.keys(errors).length) throw badRequest("Correggi gli errori indicati.", { errors });
  await db.prepare("UPDATE admin_users SET password_hash = ? WHERE id = ?").bind(await hashPw(c.env, p1), user.id).run();
  // Come update_session_auth_hash: la sessione corrente resta, le altre cadono.
  await destroyUserSessions(db, user.id, bearer(c.req.header("Authorization")));
  await audit(db, { actor: user.username, action: "password_changed", ip: clientIp(c) });
  return c.json({ message: "Password aggiornata correttamente." });
});

// --- Dashboard -------------------------------------------------------------------

authRoutes.get("/dashboard", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM courses) AS courses,
            (SELECT COUNT(*) FROM microcourses) AS microcourses,
            (SELECT COUNT(*) FROM questions) AS questions,
            (SELECT COUNT(*) FROM presentations) AS presentations,
            (SELECT COUNT(*) FROM tournaments) AS tournaments,
            (SELECT COALESCE(SUM(participant_count), 0) FROM tournaments) AS participants`,
  ).first();
  return c.json({ counts: row });
});

// --- Amministratori ---------------------------------------------------------------

async function availableUsernames(c: { env: AppEnv["Bindings"] }): Promise<string[]> {
  const { results } = await c.env.DB.prepare("SELECT lower(username) AS u FROM admin_users").all<{ u: string }>();
  const taken = new Set(results.map((r) => r.u));
  return adminUsernames(c.env).filter((u) => !taken.has(u));
}

authRoutes.get("/admins", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, username, email, is_active, must_change_password, last_login FROM admin_users ORDER BY username",
  ).all();
  return c.json({ admins: results, available: await availableUsernames(c), me: c.get("user").id });
});

authRoutes.post("/admins", async (c) => {
  const db = c.env.DB;
  const body = await readJson<Record<string, unknown>>(c);
  const username = str(body.username, 150).trim().toLowerCase();
  if (!adminUsernames(c.env).includes(username)) {
    throw badRequest("Username non autorizzato.", { errors: { username: ["Username non autorizzato."] } });
  }
  if (!(await availableUsernames(c)).includes(username)) {
    throw badRequest("Questo account esiste già.", { errors: { username: ["Questo account esiste già."] } });
  }
  await confirmSelf(c, body);
  const temp = await issueTemporary(c);
  await db
    .prepare("INSERT INTO admin_users (username, password_hash, must_change_password, temp_expires_at) VALUES (?, ?, 1, ?)")
    .bind(username, temp.hash, temp.expiresAt)
    .run();
  await audit(db, { actor: c.get("user").username, action: "admin_created", target: username, ip: clientIp(c) });
  return c.json({
    message: `Account ${username} creato.`,
    username,
    temporary_password: temp.password,
    expires_at: new Date(temp.expiresAt).toISOString(),
  });
});

async function adminById(db: D1Database, id: number) {
  const row = await db.prepare("SELECT id, username, email, is_active FROM admin_users WHERE id = ?").bind(id).first<AdminUser>();
  if (!row) throw notFound("Amministratore non trovato.");
  return row;
}

authRoutes.get("/admins/:id", async (c) => c.json({ admin: await adminById(c.env.DB, intParam(c, "id")) }));

/** L'email si cambia solo per sé stessi: è il recapito di chi possiede l'account. */
authRoutes.put("/admins/:id", async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const target = await adminById(db, intParam(c, "id"));
  if (target.id !== user.id) throw new HttpError(403, "Puoi modificare solo la tua email.");
  const body = await readJson(c);
  const email = await cleanEmail(db, body.email, target.id);
  if (email === (target.email || "").toLowerCase()) {
    return c.json({ message: "Nessuna modifica: l'indirizzo è invariato.", level: "info" });
  }
  await db.prepare("UPDATE admin_users SET email = ? WHERE id = ?").bind(email, target.id).run();
  await audit(db, { actor: user.username, action: "email_changed", target: target.username, ip: clientIp(c), details: `${target.email || "—"} → ${email}` });
  return c.json({ message: "Email aggiornata." });
});

authRoutes.post("/admins/:id/reset-password", async (c) => {
  const db = c.env.DB;
  const target = await adminById(db, intParam(c, "id"));
  if (target.id === c.get("user").id) {
    throw badRequest("Per la tua password usa «Cambia password»: così non perdi l'accesso.");
  }
  await confirmSelf(c, await readJson(c));
  const temp = await issueTemporary(c);
  await db
    .prepare("UPDATE admin_users SET password_hash = ?, must_change_password = 1, temp_expires_at = ? WHERE id = ?")
    .bind(temp.hash, temp.expiresAt, target.id)
    .run();
  await destroyUserSessions(db, target.id);
  await audit(db, { actor: c.get("user").username, action: "password_reset", target: target.username, ip: clientIp(c) });
  return c.json({
    message: `Password di ${target.username} reimpostata: al prossimo accesso dovrà sceglierne una nuova.`,
    username: target.username,
    temporary_password: temp.password,
    expires_at: new Date(temp.expiresAt).toISOString(),
  });
});

authRoutes.post("/admins/:id/toggle", async (c) => {
  const db = c.env.DB;
  const target = await adminById(db, intParam(c, "id"));
  if (target.id === c.get("user").id) throw badRequest("Non puoi disattivare il tuo stesso account.");
  await confirmSelf(c, await readJson(c));
  await db.prepare("UPDATE admin_users SET is_active = 1 - is_active WHERE id = ?").bind(target.id).run();
  if (target.is_active) await destroyUserSessions(db, target.id);
  await audit(db, {
    actor: c.get("user").username,
    action: target.is_active ? "admin_disabled" : "admin_enabled",
    target: target.username,
    ip: clientIp(c),
  });
  return c.json({ message: target.is_active ? `${target.username} disattivato.` : `${target.username} riattivato.` });
});

authRoutes.get("/audit", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, at, actor, action, target, ip, details FROM admin_audit ORDER BY id DESC LIMIT 200",
  ).all();
  return c.json({ entries: results });
});
