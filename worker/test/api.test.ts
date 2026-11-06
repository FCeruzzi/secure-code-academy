import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import sqliBase from "./fixtures/sqli_base.json";
import bank from "./fixtures/bank.json";
import xssBase from "./fixtures/xss_base.json";
import otherArchive from "./fixtures/torneo-esterno.json";
import { hashPassword } from "../src/lib/auth";
import { importBundle, importQuestions } from "../src/lib/content";
import { DEFAULT_START_DELAY_SECONDS } from "../src/tournament/room";

const BASE = "https://api.test";
const ORIGIN = "https://example.github.io";

/**
 * Password dei test, generate a ogni esecuzione: nel codice non c'è nessuna
 * credenziale, nemmeno di prova. Abbastanza lunghe e varie per i controlli di
 * robustezza (passwordProblems).
 */
function testPassword(label: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${label}-${btoa(String.fromCharCode(...bytes)).replace(/[^A-Za-z0-9]/g, "k")}-7`;
}
const TEMP_PW = testPassword("Temp");
const ADMIN_PW = testPassword("Admin");
const NEW_PW = testPassword("Nuova");
const OTHER_PW = testPassword("Altra");
const WRONG_PW = testPassword("Errata");

async function api(path: string, init: RequestInit & { token?: string; participant?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.participant) headers.set("X-Participant", init.participant);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  headers.set("CF-Connecting-IP", headers.get("CF-Connecting-IP") || "10.0.0.1");
  const res = await SELF.fetch(BASE + path, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const body = res.headers.get("Content-Type")?.includes("json") ? await res.json<any>() : null;
  return { status: res.status, body, headers: res.headers };
}

async function createAdmin(username = "alice", password = TEMP_PW, mustChange = true, tempExpiresAt = Date.now() + 3600_000) {
  await env.DB.prepare("INSERT INTO admin_users (username, password_hash, must_change_password, temp_expires_at) VALUES (?, ?, ?, ?)")
    .bind(username, await hashPassword(password, 1000), mustChange ? 1 : 0, mustChange ? tempExpiresAt : null)
    .run();
}

const login = (username: string, password: string, ip = "10.0.0.1", device?: string) =>
  api("/api/admin/login", {
    method: "POST",
    json: { username, password, ...(device ? { device } : {}) },
    headers: { "CF-Connecting-IP": ip },
  });

async function loggedIn(username = "alice"): Promise<string> {
  await createAdmin(username, ADMIN_PW, false);
  const res = await api("/api/admin/login", { method: "POST", json: { username, password: ADMIN_PW } });
  expect(res.status).toBe(200);
  return res.body.token;
}

const TABLES = [
  "tournament_picks", "tournament_questions", "tournament_courses", "tournaments", "quiz_questions", "quizzes", "questions",
  "slide_images", "slides", "presentations", "resources", "microcourses", "courses",
  "admin_sessions", "admin_devices", "login_attempts", "admin_audit", "admin_users",
];

beforeEach(async () => {
  // Lo storage è condiviso tra i test: si riparte ogni volta da un database vuoto.
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await importBundle(env.DB, structuredClone(sqliBase));
});

describe("API pubblica", () => {
  it("ogni risposta porta gli header di sicurezza, HSTS compreso", async () => {
    const res = await api("/api/home");
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("home, corso, slide", async () => {
    const home = await api("/api/home");
    expect(home.status).toBe(200);
    expect(home.body.courses).toEqual([expect.objectContaining({ slug: "sql-injection", mc_count: 1 })]);
    expect(home.body.open_tournament).toBeNull();

    const course = await api("/api/courses/sql-injection");
    expect(course.body.microcourses[0]).toMatchObject({ slug: "base", entry: "slide" });

    const slide = await api("/api/courses/sql-injection/base/slides/1");
    expect(slide.body).toMatchObject({ position: 1, has_quiz: true });
    expect(slide.body.slide.body_html).toContain("<");
    expect((await api(`/api/courses/sql-injection/base/slides/${slide.body.total + 1}`)).status).toBe(404);
    expect((await api("/api/courses/nessuno")).status).toBe(404);
  });

  it("i contenuti non pubblicati non si vedono", async () => {
    await env.DB.prepare("UPDATE microcourses SET is_published = 0").run();
    expect((await api("/api/courses/sql-injection/base/slides/1")).status).toBe(404);
    const course = await api("/api/courses/sql-injection");
    expect(course.body.microcourses).toEqual([]);
  });

  it("quiz: domande senza soluzione, correzione sul server", async () => {
    const mc = await env.DB.prepare("SELECT id FROM microcourses WHERE slug = 'base'").first<{ id: number }>();
    const quiz = await api(`/api/quiz/${mc!.id}`);
    expect(quiz.status).toBe(200);
    const raw = JSON.stringify(quiz.body);
    expect(raw).not.toMatch(/"correct"|"answer"|correct_lines|explanation/);

    const tf = quiz.body.questions.find((q: any) => q.qtype === "TRUE_FALSE");
    const row = await env.DB.prepare("SELECT data FROM questions WHERE id = ?").bind(tf.id).first<{ data: string }>();
    const answer = JSON.parse(row!.data).answer;
    const right = await api(`/api/quiz/${mc!.id}/answer`, { method: "POST", json: { question_id: tf.id, submission: { answer } } });
    expect(right.body).toMatchObject({ correct: true, solution: { answer } });
    expect(typeof right.body.explanation_html).toBe("string");
    const wrong = await api(`/api/quiz/${mc!.id}/answer`, { method: "POST", json: { question_id: tf.id, submission: { answer: !answer } } });
    expect(wrong.body.correct).toBe(false);
    // Una domanda di un altro quiz non si corregge qui.
    expect((await api(`/api/quiz/${mc!.id}/answer`, { method: "POST", json: { question_id: 999999, submission: {} } })).status).toBe(404);
  });

  it("CORS solo per l'origine del sito", async () => {
    const ok = await SELF.fetch(BASE + "/api/home", { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "GET" } });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const no = await SELF.fetch(BASE + "/api/home", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } });
    expect(no.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("accesso al pannello", () => {
  it("credenziali errate, blocco dopo 5 tentativi per IP", async () => {
    await createAdmin();
    for (let i = 0; i < 5; i++) {
      const r = await login("alice", WRONG_PW, "1.2.3.4");
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("Username o password non corretti.");
    }
    expect((await login("alice", TEMP_PW, "1.2.3.4")).status).toBe(429);
    // Lo stesso /64 IPv6 conta come un solo indirizzo.
    for (let i = 0; i < 5; i++) await login("nessuno" + i, "x", `2001:db8:1:2::${i + 1}`);
    expect((await login("nessuno9", "x", "2001:db8:1:2:ffff::9")).status).toBe(429);
  });

  it("blocco per account, anche cambiando IP", async () => {
    await createAdmin();
    for (let i = 0; i < 5; i++) await login("alice", WRONG_PW, `198.51.100.${i + 1}`);
    expect((await login("alice", TEMP_PW, "203.0.113.7")).status).toBe(429);
    // Un altro account dallo stesso IP no.
    await createAdmin("bruno");
    expect((await login("bruno", TEMP_PW, "203.0.113.7")).status).toBe(200);
  });

  it("tentativi in parallelo: oltre il limite nessuno arriva alla verifica", async () => {
    await createAdmin();
    const results = await Promise.all(Array.from({ length: 20 }, () => login("alice", WRONG_PW, "192.0.2.1")));
    expect(results.filter((r) => r.status === 400)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(15);
  });

  it("più di 20 tentativi in un minuto da indirizzi diversi sospendono il login per 30 secondi", async () => {
    await createAdmin("alice", ADMIN_PW, false);
    // Venti tentativi, ognuno con IP e username propri: nessun limite per IP o account scatta.
    for (let i = 0; i < 20; i++) {
      expect((await login(`ospite${i}`, WRONG_PW, `198.18.0.${i + 1}`)).status).toBe(400);
    }
    const tripped = await login("ospite99", WRONG_PW, "198.18.1.1");
    expect(tripped.status).toBe(429);
    expect(tripped.body.error).toContain("temporaneamente sospeso");
    expect(tripped.headers.get("Retry-After")).toBe("30");
    // Durante la pausa nemmeno le credenziali giuste entrano, da nessun indirizzo.
    const blocked = await login("alice", ADMIN_PW, "203.0.113.99");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    // I tentativi respinti durante la pausa non toccano i contatori dell'IP.
    const ipRow = await env.DB.prepare("SELECT 1 FROM login_attempts WHERE ip = 'ip:203.0.113.99'").first();
    expect(ipRow).toBeNull();
    // Una sola riga nel registro, quando parte la pausa.
    const paused = await env.DB.prepare("SELECT details FROM admin_audit WHERE action = 'login_paused'").all<{ details: string }>();
    expect(paused.results).toHaveLength(1);
    expect(paused.results[0].details).toContain("21 tentativi in 60 secondi");
    // Finita la pausa si entra, e il conto riparte da zero.
    await env.DB.prepare("UPDATE login_attempts SET expires_at = 0 WHERE ip = 'global:pause'").run();
    const ok = await login("alice", ADMIN_PW, "203.0.113.99");
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ username: "alice", needs_setup: false });
  });

  it("gli accessi riusciti non contano fra i tentativi della sospensione", async () => {
    await createAdmin("alice", ADMIN_PW, false);
    for (let i = 0; i < 18; i++) await login(`ospite${i}`, WRONG_PW, `198.18.4.${i + 1}`);
    for (let i = 0; i < 3; i++) expect((await login("alice", ADMIN_PW, `203.0.113.${i + 10}`)).status).toBe(200);
    // 18 + 2 falliti = 20: ancora aperto. Il 21° fallito sospende.
    expect((await login("ospite18", WRONG_PW, "198.18.4.200")).status).toBe(400);
    expect((await login("ospite19", WRONG_PW, "198.18.4.201")).status).toBe(400);
    expect((await login("ospite20", WRONG_PW, "198.18.4.202")).status).toBe(429);
  });

  it("un solo indirizzo non basta a sospendere il login degli altri", async () => {
    await createAdmin("alice", ADMIN_PW, false);
    // Oltre 20 richieste dallo stesso IP: dopo 5 le ferma il limite per IP, che non conta nel totale.
    for (let i = 0; i < 30; i++) await login(`ospite${i}`, WRONG_PW, "198.18.2.2");
    expect((await login("alice", ADMIN_PW, "203.0.113.98")).status).toBe(200);
  });

  it("dispositivo riconosciuto: il blocco dell'account e la sospensione non fermano il titolare", async () => {
    await createAdmin("alice", ADMIN_PW, false);
    const first = await login("alice", ADMIN_PW, "203.0.113.20");
    expect(first.status).toBe(200);
    const device = first.body.device as string;
    expect(device).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Nel database c'è solo l'hash del codice.
    const stored = await env.DB.prepare("SELECT token_hash FROM admin_devices").all<{ token_hash: string }>();
    expect(stored.results).toHaveLength(1);
    expect(stored.results[0].token_hash).not.toBe(device);

    // Qualcuno blocca l'account da un solo indirizzo (il contatore dell'account sale anche
    // quando il suo IP è già fermo): senza dispositivo il titolare resta fuori, con il dispositivo entra.
    for (let i = 0; i < 8; i++) await login("alice", WRONG_PW, "198.51.100.66");
    expect((await login("alice", ADMIN_PW, "203.0.113.21")).status).toBe(429);
    const fromDevice = await login("alice", ADMIN_PW, "203.0.113.21", device);
    expect(fromDevice.status).toBe(200);
    expect(fromDevice.body.device).toBe(device);

    // Sospensione globale: senza dispositivo nessuno entra, con il dispositivo sì.
    for (let i = 0; i < 21; i++) await login(`ospite${i}`, WRONG_PW, `198.18.7.${i + 1}`);
    expect((await login("alice", ADMIN_PW, "203.0.113.22")).status).toBe(429);
    expect((await login("alice", ADMIN_PW, "203.0.113.22", device)).status).toBe(200);
  });

  it("dispositivo riconosciuto: ha un suo limite e vale solo per il suo account", async () => {
    await createAdmin("alice", ADMIN_PW, false);
    await createAdmin("bruno", OTHER_PW, false);
    const device = (await login("alice", ADMIN_PW, "203.0.113.30")).body.device;
    // Con l'account di un altro il codice non conta: bruno, bloccato, resta bloccato.
    for (let i = 0; i < 6; i++) await login("bruno", WRONG_PW, `198.51.100.${i + 70}`);
    expect((await login("bruno", OTHER_PW, "203.0.113.31", device)).status).toBe(429);
    // Cinque password sbagliate dal dispositivo, poi anche quella giusta aspetta.
    for (let i = 0; i < 5; i++) expect((await login("alice", WRONG_PW, "203.0.113.32", device)).status).toBe(400);
    expect((await login("alice", ADMIN_PW, "203.0.113.32", device)).status).toBe(429);
    // Il limite è del dispositivo: account e IP non sono stati toccati.
    expect((await login("alice", ADMIN_PW, "203.0.113.33")).status).toBe(200);
    const failed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'login_failed' AND details = 'dispositivo riconosciuto'",
    ).first<{ n: number }>();
    expect(failed!.n).toBe(5);
    // Un codice inventato vale come nessun codice.
    expect((await login("alice", ADMIN_PW, "203.0.113.34", "x".repeat(43))).status).toBe(200);
  });

  it("reset della password e disattivazione cancellano i dispositivi", async () => {
    const token = await loggedIn();
    const confirm = { confirm_password: ADMIN_PW };
    await createAdmin("bruno", OTHER_PW, false);
    const devices = async () =>
      (await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM admin_devices d JOIN admin_users u ON u.id = d.user_id WHERE u.username = 'bruno'",
      ).first<{ n: number }>())!.n;
    const bruno = (await api("/api/admin/admins", { token })).body.admins.find((a: any) => a.username === "bruno");
    const old = (await login("bruno", OTHER_PW, "203.0.113.40")).body.device;
    expect(await devices()).toBe(1);
    const reset = await api(`/api/admin/admins/${bruno.id}/reset-password`, { method: "POST", token, json: confirm });
    expect(await devices()).toBe(0);
    // Il vecchio codice non salta più il blocco dell'account.
    for (let i = 0; i < 6; i++) await login("bruno", WRONG_PW, `198.51.100.${i + 80}`);
    expect((await login("bruno", reset.body.temporary_password, "203.0.113.41", old)).status).toBe(429);
    // Disattivando l'account se ne vanno anche i dispositivi nuovi.
    await env.DB.prepare("DELETE FROM login_attempts").run();
    expect((await login("bruno", reset.body.temporary_password, "203.0.113.42")).status).toBe(200);
    expect(await devices()).toBe(1);
    await api(`/api/admin/admins/${bruno.id}/toggle`, { method: "POST", token, json: confirm });
    expect(await devices()).toBe(0);
  });

  it("un blocco del login dall'esterno non ferma le conferme di chi è già collegato", async () => {
    const token = await loggedIn();
    for (let i = 0; i < 6; i++) await login("alice", WRONG_PW, `198.51.100.${i + 90}`);
    expect((await login("alice", ADMIN_PW, "203.0.113.50")).status).toBe(429);
    const created = await api("/api/admin/consultants", {
      method: "POST",
      token,
      json: { username: "mario.rossi", confirm_password: ADMIN_PW },
    });
    expect(created.status).toBe(200);
  });

  it("username fuori dall'elenco autorizzato", async () => {
    await createAdmin("intruso");
    const r = await login("intruso", TEMP_PW);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("non è fra gli amministratori autorizzati");
  });

  it("account inesistente o disattivato: stessa risposta", async () => {
    await createAdmin("carla", ADMIN_PW, false);
    await env.DB.prepare("UPDATE admin_users SET is_active = 0 WHERE username = 'carla'").run();
    expect((await login("carla", ADMIN_PW)).body.error).toBe("Username o password non corretti.");
    expect((await login("fantasma", ADMIN_PW, "10.0.0.2")).body.error).toBe("Username o password non corretti.");
  });

  it("password temporanea scaduta", async () => {
    await createAdmin("alice", TEMP_PW, true, Date.now() - 1000);
    const r = await login("alice", TEMP_PW);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("scaduta");
  });

  it("primo accesso obbligato, poi pannello", async () => {
    await createAdmin();
    const first = await login("alice", TEMP_PW);
    const token = first.body.token;
    expect(first.body.user.must_change_password).toBe(true);
    const blocked = await api("/api/admin/courses", { token });
    expect(blocked.status).toBe(403);
    expect(blocked.body.setup_required).toBe(true);

    const weak = await api("/api/admin/setup", { method: "POST", token, json: { new_password1: "123", new_password2: "123" } });
    expect(weak.status).toBe(400);
    expect(weak.body.errors.new_password1.join(" ")).toContain("troppo corta");
    const same = await api("/api/admin/setup", { method: "POST", token, json: { new_password1: TEMP_PW, new_password2: TEMP_PW } });
    expect(same.body.errors.new_password1).toContain("Scegli una password diversa da quella temporanea.");

    const ok = await api("/api/admin/setup", { method: "POST", token, json: { new_password1: NEW_PW, new_password2: NEW_PW } });
    expect(ok.status).toBe(200);
    expect((await api("/api/admin/courses", { token })).status).toBe(200);
    const row = await env.DB.prepare("SELECT temp_expires_at FROM admin_users WHERE username = 'alice'").first<{ temp_expires_at: number | null }>();
    expect(row!.temp_expires_at).toBeNull();
    expect(ok.body.user).not.toHaveProperty("email");
    const cols = await env.DB.prepare("SELECT name FROM pragma_table_info('admin_users')").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).not.toContain("email");

    await api("/api/admin/logout", { method: "POST", token });
    expect((await api("/api/admin/courses", { token })).status).toBe(401);
  });

  it("senza token: 401", async () => {
    expect((await api("/api/admin/dashboard")).status).toBe(401);
    expect((await api("/api/admin/dashboard", { token: "inventato" })).status).toBe(401);
  });

  it("gestione amministratori: password monouso, conferma, registro", async () => {
    const token = await loggedIn();
    const list = await api("/api/admin/admins", { token });
    expect(list.body.available).toEqual(["bruno", "carla"]);
    const me = list.body.me;
    const confirm = { confirm_password: ADMIN_PW };

    // Senza (o con la sbagliata) password di conferma non si crea nulla.
    const noConfirm = await api("/api/admin/admins", { method: "POST", token, json: { username: "bruno" } });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.errors.confirm_password).toBeTruthy();
    expect((await api("/api/admin/admins", { method: "POST", token, json: { username: "bruno", confirm_password: "no" } })).status).toBe(400);

    const created = await api("/api/admin/admins", { method: "POST", token, json: { username: "bruno", ...confirm } });
    expect(created.status).toBe(200);
    const temp = created.body.temporary_password as string;
    expect(temp).toMatch(/^[A-Za-z2-9]{5}(-[A-Za-z2-9]{5}){3}$/);
    expect((await api("/api/admin/admins", { method: "POST", token, json: { username: "bruno", ...confirm } })).status).toBe(400);
    expect((await api("/api/admin/admins", { method: "POST", token, json: { username: "mallory", ...confirm } })).status).toBe(400);
    expect((await api(`/api/admin/admins/${me}/toggle`, { method: "POST", token, json: confirm })).status).toBe(400);
    expect((await api(`/api/admin/admins/${me}/reset-password`, { method: "POST", token, json: confirm })).status).toBe(400);

    const bruno = (await api("/api/admin/admins", { token })).body.admins.find((a: any) => a.username === "bruno");
    const brunoLogin = await login("bruno", temp);
    expect(brunoLogin.body.user.must_change_password).toBe(true);
    // Niente email: l'account si identifica solo con lo username.
    expect(brunoLogin.body.user).not.toHaveProperty("email");
    expect((await api(`/api/admin/admins/${bruno.id}`, { method: "PUT", token, json: { email: "x@example.it" } })).status).toBe(404);

    // Il reset genera una password nuova: la vecchia non vale più.
    const reset = await api(`/api/admin/admins/${bruno.id}/reset-password`, { method: "POST", token, json: confirm });
    expect(reset.body.temporary_password).not.toBe(temp);
    expect((await login("bruno", temp)).status).toBe(400);
    expect((await api("/api/admin/me", { token: brunoLogin.body.token })).status).toBe(401);

    const again = await login("bruno", reset.body.temporary_password);
    expect((await api(`/api/admin/admins/${bruno.id}/toggle`, { method: "POST", token })).status).toBe(400);
    await api(`/api/admin/admins/${bruno.id}/toggle`, { method: "POST", token, json: confirm });
    expect((await api("/api/admin/me", { token: again.body.token })).status).toBe(401);

    const log = await api("/api/admin/audit", { token });
    const actions = log.body.entries.map((e: any) => e.action);
    for (const a of ["admin_created", "password_reset", "admin_disabled", "login", "login_failed"]) expect(actions).toContain(a);
    expect(JSON.stringify(log.body)).not.toContain(temp);
  });
});

describe("consulenti: solo i contenuti", () => {
  async function consultant(username = "mario.rossi"): Promise<string> {
    await env.DB.prepare("INSERT INTO admin_users (username, password_hash, must_change_password, role) VALUES (?, ?, 0, 'consultant')")
      .bind(username, await hashPassword(ADMIN_PW, 1000))
      .run();
    const res = await login(username, ADMIN_PW);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("consultant");
    return res.body.token;
  }

  it("un amministratore crea il consulente, che sceglie la sua password", async () => {
    const token = await loggedIn();
    const confirm = { confirm_password: ADMIN_PW };
    for (const bad of ["ab", "Con Spazi", "-trattino", "BRUNO", "alice"]) {
      const res = await api("/api/admin/consultants", { method: "POST", token, json: { username: bad, ...confirm } });
      expect(res.status, bad).toBe(400);
      expect(res.body.errors.username, bad).toBeTruthy();
    }
    expect((await api("/api/admin/consultants", { method: "POST", token, json: { username: "mario.rossi", confirm_password: "no" } })).status).toBe(400);

    const created = await api("/api/admin/consultants", { method: "POST", token, json: { username: "Mario.Rossi", ...confirm } });
    expect(created.status).toBe(200);
    expect(created.body.username).toBe("mario.rossi");
    const temp = created.body.temporary_password as string;
    expect((await api("/api/admin/consultants", { method: "POST", token, json: { username: "mario.rossi", ...confirm } })).status).toBe(400);
    const row = (await api("/api/admin/admins", { token })).body.admins.find((a: any) => a.username === "mario.rossi");
    expect(row.role).toBe("consultant");
    // Gli username della lista restano proposti solo come amministratori.
    expect((await api("/api/admin/admins", { token })).body.available).toEqual(["bruno", "carla"]);

    const first = await login("mario.rossi", temp);
    expect(first.body.user).toMatchObject({ role: "consultant", must_change_password: true });
    const setup = await api("/api/admin/setup", {
      method: "POST", token: first.body.token, json: { new_password1: OTHER_PW, new_password2: OTHER_PW },
    });
    expect(setup.status).toBe(200);
    expect(setup.body.user.role).toBe("consultant");
    expect((await api("/api/admin/courses", { token: first.body.token })).status).toBe(200);
    expect((await api("/api/admin/tournaments", { token: first.body.token })).status).toBe(403);

    // Un consulente non crea account.
    expect((await api("/api/admin/consultants", { method: "POST", token: first.body.token, json: { username: "altro", confirm_password: OTHER_PW } })).status).toBe(403);
    const actions = (await api("/api/admin/audit", { token })).body.entries.map((e: any) => e.action);
    expect(actions).toContain("consultant_created");
  });

  it("lavora su corsi e banca domande, non sul resto", async () => {
    const token = await consultant();
    const course = await env.DB.prepare("SELECT id FROM courses WHERE slug = 'sql-injection'").first<{ id: number }>();
    const mc = await env.DB.prepare("SELECT id FROM microcourses WHERE slug = 'base'").first<{ id: number }>();
    const slide = await env.DB.prepare("SELECT id FROM slides ORDER BY id LIMIT 1").first<{ id: number }>();
    const bankQ = await api("/api/admin/questions", {
      method: "POST", token,
      json: { qtype: "TRUE_FALSE", prompt: "Vero?", difficulty: 1, data: { statement: "s", answer: true } },
    });
    expect(bankQ.status).toBe(200);

    for (const path of [
      "/api/admin/me", "/api/admin/dashboard", "/api/admin/courses", `/api/admin/courses/${course!.id}`,
      `/api/admin/courses/${course!.id}/microcourses`, `/api/admin/microcourses/${mc!.id}`, `/api/admin/slides/${slide!.id}`,
      "/api/admin/questions", `/api/admin/questions/${bankQ.body.id}`, `/api/admin/microcourses/${mc!.id}/quiz`,
      `/api/admin/courses/${course!.id}/export`,
    ]) {
      expect((await api(path, { token })).status, path).toBe(200);
    }
    for (const [method, path] of [
      ["GET", "/api/admin/tournaments"], ["POST", "/api/admin/tournaments"], ["GET", "/api/admin/tournament-courses"],
      ["GET", "/api/admin/tournament-questions"], ["GET", "/api/admin/admins"], ["POST", "/api/admin/admins"],
      ["GET", "/api/admin/audit"], ["DELETE", `/api/admin/courses/${course!.id}`], ["DELETE", `/api/admin/courses/${course!.id}/`],
      ["POST", "/api/admin/questions/clear-bank"],
    ]) {
      const res = await api(path, { method, token, json: method === "GET" ? undefined : {} });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.forbidden).toBe(true);
    }
    expect(await env.DB.prepare("SELECT id FROM courses WHERE id = ?").bind(course!.id).first()).not.toBeNull();

    // Le eliminazioni più piccole fanno parte del lavoro sui contenuti.
    expect((await api(`/api/admin/slides/${slide!.id}`, { method: "DELETE", token })).status).toBe(200);
    expect((await api(`/api/admin/questions/${bankQ.body.id}`, { method: "DELETE", token })).status).toBe(200);

    // Import: un corso nuovo sì, la sostituzione di uno presente no.
    const existing = await api("/api/admin/courses/import", { method: "POST", token, json: { course: { slug: "sql-injection", title: "Altro" } } });
    expect(existing.status).toBe(400);
    expect(existing.body.error).toContain("solo un amministratore");
    expect((await env.DB.prepare("SELECT title FROM courses WHERE id = ?").bind(course!.id).first<{ title: string }>())!.title).not.toBe("Altro");
    expect(await env.DB.prepare("SELECT id FROM microcourses WHERE id = ?").bind(mc!.id).first()).not.toBeNull();
    const fresh = await api("/api/admin/courses/import", { method: "POST", token, json: { course: { slug: "xss", title: "XSS" } } });
    expect(fresh.status).toBe(200);
    expect(fresh.body.replaced).toBe(false);
  });

  it("finire nella lista degli amministratori non lo promuove", async () => {
    const token = await consultant("carla");
    expect((await api("/api/admin/admins", { token })).status).toBe(403);
    expect((await api("/api/admin/me", { token })).body.user.role).toBe("consultant");
  });

  it("un amministratore conserva ogni sezione", async () => {
    const token = await loggedIn();
    expect((await api("/api/admin/me", { token })).body.user.role).toBe("admin");
    for (const path of ["/api/admin/tournaments", "/api/admin/admins", "/api/admin/audit"]) {
      expect((await api(path, { token })).status, path).toBe(200);
    }
    const replaced = await api("/api/admin/courses/import", { method: "POST", token, json: { course: { slug: "sql-injection", title: "Nuovo" } } });
    expect(replaced.body.replaced).toBe(true);
  });
});

describe("contenuti dal pannello", () => {
  it("corso, microcorso, slide, immagini e pubblicazione", async () => {
    const token = await loggedIn();
    const c = await api("/api/admin/courses", { method: "POST", token, json: { title: "Cross-Site Request Forgery", is_published: true } });
    expect(c.status).toBe(200);
    const course = (await api(`/api/admin/courses/${c.body.id}`, { token })).body.course;
    expect(course.slug).toBe("cross-site-request-forgery");
    expect((await api("/api/admin/courses", { method: "POST", token, json: { title: "Altro", slug: course.slug } })).status).toBe(400);

    const bad = await api(`/api/admin/courses/${c.body.id}/presentations`, { method: "POST", token, json: { url: "http://insicuro/x.pdf" } });
    expect(bad.status).toBe(400);
    await api(`/api/admin/courses/${c.body.id}/presentations`, { method: "POST", token, json: { title: "Slide", url: "https://cdn.example/csrf.pdf", page_count: 12 } });
    const pres = (await api(`/api/admin/courses/${c.body.id}`, { token })).body.presentations;
    expect(pres).toHaveLength(1);
    expect((await api(`/api/courses/${course.slug}/presentations/${pres[0].id}`)).body.presentation.url).toBe("https://cdn.example/csrf.pdf");
    expect((await api(`/api/admin/presentations/${pres[0].id}`, { method: "DELETE", token })).status).toBe(200);

    const mc = await api(`/api/admin/courses/${c.body.id}/microcourses`, { method: "POST", token, json: { title: "Base", is_published: true } });
    const slide = await api(`/api/admin/microcourses/${mc.body.id}/slides`, {
      method: "POST",
      token,
      json: { title: "Intro", section: "ATTACK", body_markdown: "![schema](img:schema)" },
    });
    expect(slide.status).toBe(200);
    let pub = await api(`/api/courses/${course.slug}/base/slides/1`);
    // Finché l'immagine non esiste, img:schema non è un link valido.
    expect(pub.body.slide.body_html).not.toContain("<img");
    await api(`/api/admin/microcourses/${mc.body.id}/images`, { method: "POST", token, json: { ref_key: "schema", url: "https://cdn.example/s.png" } });
    pub = await api(`/api/courses/${course.slug}/base/slides/1`);
    expect(pub.body.slide.body_html).toContain('src="https://cdn.example/s.png"');
  });

  it("export e reimport di un corso", async () => {
    const token = await loggedIn();
    const course = await env.DB.prepare("SELECT id FROM courses WHERE slug = 'sql-injection'").first<{ id: number }>();
    await api(`/api/admin/courses/${course!.id}/resources`, { method: "POST", token, json: { title: "OWASP", url: "https://owasp.org" } });
    const exported = (await api(`/api/admin/courses/${course!.id}/export`, { token })).body;
    expect(exported.kind).toBe("course");
    expect(exported.course.resources).toHaveLength(1);
    expect(exported.microcourses[0].quiz.questions.length).toBeGreaterThan(0);

    await api(`/api/admin/courses/${course!.id}`, { method: "DELETE", token });
    expect((await api("/api/courses/sql-injection")).status).toBe(404);

    const meta = await api("/api/admin/courses/import", { method: "POST", token, json: exported });
    expect(meta.status).toBe(200);
    for (const bundle of exported.microcourses) {
      const r = await api("/api/admin/microcourses/import", {
        method: "POST",
        token,
        json: { bundle, course_slug: exported.course.slug, course_title: exported.course.title },
      });
      expect(r.status).toBe(200);
    }
    const again = await api("/api/courses/sql-injection");
    expect(again.body.resources).toHaveLength(1);
    expect(again.body.microcourses).toHaveLength(1);
  });

  it("domande: validazione del contenuto e quiz builder", async () => {
    const token = await loggedIn();
    const course = await env.DB.prepare("SELECT id FROM courses WHERE slug = 'sql-injection'").first<{ id: number }>();
    const q = await api("/api/admin/questions", {
      method: "POST",
      token,
      json: { qtype: "TRUE_FALSE", course_id: course!.id, difficulty: "2", prompt: "Vero o falso?", is_active: true },
    });
    expect(q.status).toBe(200);
    const invalid = await api(`/api/admin/questions/${q.body.id}/content`, { method: "PUT", token, json: { data: { answer: "si" } } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/^Contenuto non valido/);
    const valid = await api(`/api/admin/questions/${q.body.id}/content`, { method: "PUT", token, json: { data: { answer: true, statement: "Il cielo è blu." } } });
    expect(valid.status).toBe(200);

    const list = await api("/api/admin/questions?qtype=TRUE_FALSE&sort=difficulty&dir=desc", { token });
    expect(list.body.questions[0].id).toBe(q.body.id);
    // Negli elenchi un Vero/Falso si riconosce dall'affermazione, non da «Vero o falso?».
    expect(list.body.questions[0]).toMatchObject({ prompt: "Vero o falso?", summary: "Il cielo è blu." });

    const mc = await env.DB.prepare("SELECT id FROM microcourses WHERE slug = 'base'").first<{ id: number }>();
    const before = (await api(`/api/admin/microcourses/${mc!.id}/quiz`, { token })).body.items.length;
    await api(`/api/admin/microcourses/${mc!.id}/quiz`, { method: "POST", token, json: { question_id: q.body.id } });
    const items = (await api(`/api/admin/microcourses/${mc!.id}/quiz`, { token })).body.items;
    expect(items).toHaveLength(before + 1);
    const last = items[items.length - 1];
    expect(last.summary).toBe("Il cielo è blu.");
    await api(`/api/admin/quiz-items/${last.id}/move`, { method: "POST", token, json: { direction: "up" } });
    const moved = (await api(`/api/admin/microcourses/${mc!.id}/quiz`, { token })).body.items;
    expect(moved[moved.length - 2].question_id).toBe(q.body.id);
  });
});

/** Domande in più per la banca di prova: il mix dei tornei vuole tutti e quattro i tipi. */
function mixBank(n = 4) {
  const fwl = (i: number) => ({
    qtype: "FIND_WRONG_LINE",
    prompt: `Riga errata ${i}?`,
    course_slug: "sql-injection",
    difficulty: 2,
    data: { language: "python", code: `ok = ${i}\ndb.execute(f"SELECT {x}")`, correct_lines: [2], start_line: 1 },
  });
  const cc = (i: number) => ({
    qtype: "CODE_COMPARISON",
    prompt: `Quale è sicura ${i}?`,
    course_slug: "sql-injection",
    difficulty: 2,
    data: { language: "python", snippet_a: `db.execute("SELECT ?", (x,)) # ${i}`, snippet_b: `db.execute(f"SELECT {x}") # ${i}`, correct: "a" },
  });
  const mc = (i: number) => ({
    qtype: "MULTIPLE_CHOICE",
    prompt: `Quale difesa ${i}?`,
    course_slug: "xss",
    difficulty: 1,
    data: { multiple: i % 2 === 0, options: [{ id: "a", text: "Escape" }, { id: "b", text: "Nulla" }, { id: "c", text: "CSP" }], correct: i % 2 === 0 ? ["a", "c"] : ["a"] },
  });
  const range = Array.from({ length: n }, (_, i) => i + 1);
  return { version: "1.0", kind: "questions", questions: [...range.map(fwl), ...range.map(cc), ...range.map(mc)] };
}

describe("tornei", () => {
  async function setupTournament(token: string, extra: Record<string, unknown> = {}) {
    await importBundle(env.DB, structuredClone(xssBase));
    await importQuestions(env.DB, structuredClone(bank));
    await importQuestions(env.DB, mixBank());
    const { results } = await env.DB.prepare("SELECT id FROM courses").all<{ id: number }>();
    const t = await api("/api/admin/tournaments", {
      method: "POST",
      token,
      json: { title: "Gara", courses: results.map((r) => r.id), pool_size: 2, num_rounds: 2, per_question_seconds: 60, points_correct: 100, time_bonus: false, ...extra },
    });
    expect(t.status).toBe(200);
    const manage = await api(`/api/admin/tournaments/${t.body.id}/manage`, { token });
    // `code`: il codice pubblico del torneo, quello del link di invito.
    return { id: t.body.id as number, code: manage.body.tournament.join_token as string };
  }

  /**
   * Modifica lo stato del Durable Object del torneo, come se fosse passato del tempo.
   * La sveglia resta quella già programmata: una nel passato partirebbe da sola mentre
   * il test legge D1; la si esegue con runDurableObjectAlarm, che la attende.
   */
  async function shiftRoom(token: string, change: (state: any) => void) {
    await runInDurableObject(env.TOURNAMENT.get(env.TOURNAMENT.idFromName(token)), (instance) => {
      // state e save sono privati del Durable Object: qui servono dall'esterno.
      const room = instance as unknown as { state: any; save(): void };
      change(room.state);
      room.save();
    });
  }

  /** Salta i secondi di margine con cui parte la prima domanda (quelli del torneo). */
  const skipStartDelay = (token: string) =>
    shiftRoom(token, (s) => {
      s.current_started_at -= s.start_delay_seconds * 1000;
    });

  /** Apre le iscrizioni e restituisce il PIN, che vede solo il pannello. */
  async function openTournament(token: string, id: number): Promise<string> {
    expect((await api(`/api/admin/tournaments/${id}/status`, { method: "POST", token, json: { status: "OPEN" } })).status).toBe(200);
    const pin = (await api(`/api/admin/tournaments/${id}/manage`, { token })).body.join_pin;
    expect(pin).toMatch(/^\d{6}$/);
    return pin as string;
  }

  type Frozen = { round: number; ord: number; question_id: number; qtype: string; data: any; render: any };

  /** Le domande come le ha congelate il torneo (la copia con opzioni e lati rimescolati). */
  async function frozenItems(code: string): Promise<{ items: Frozen[]; round: number; index: number }> {
    let out: { items: Frozen[]; round: number; index: number } | undefined;
    await runInDurableObject(env.TOURNAMENT.get(env.TOURNAMENT.idFromName(code)), (instance) => {
      // sql e state sono privati del Durable Object: qui servono dall'esterno.
      const room = instance as unknown as { sql: SqlStorage; state: any };
      const items = room.sql
        .exec<Record<string, any>>("SELECT round, ord, question_id, qtype, data, render FROM items ORDER BY round, ord")
        .toArray()
        .map((r) => ({ ...r, data: JSON.parse(r.data), render: JSON.parse(r.render) }) as Frozen);
      out = { items, round: room.state.current_round, index: room.state.current_index };
    });
    return out!;
  }

  /** La risposta giusta alla domanda in corso, dalla copia del torneo (non dalla banca). */
  async function correctSubmission(code: string) {
    const { items, round, index } = await frozenItems(code);
    const { qtype, data } = items.filter((i) => i.round === round)[index];
    if (qtype === "TRUE_FALSE") return { answer: data.answer };
    if (qtype === "MULTIPLE_CHOICE") return { selected: data.correct };
    if (qtype === "FIND_WRONG_LINE") return { lines: data.correct_lines };
    return { choice: data.correct };
  }

  it("iscrizione, gara, punteggi, round e report", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin);

    expect((await api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name: "Ada", avatar: "owl" } })).status).toBe(409);
    const pin = await openTournament(admin, t.id);
    expect((await api("/api/home")).body.open_tournament).toMatchObject({ title: "Gara", join_token: t.code });

    expect((await api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name: "  ", avatar: "owl", pin } })).status).toBe(400);
    expect((await api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name: "Ada", avatar: "pony", pin } })).status).toBe(400);
    const ada = (await api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name: "<Ada>", avatar: "owl", pin } })).body.participant_token;
    const bob = (await api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name: "Bob", avatar: "cat", pin } })).body.participant_token;
    // Rientrare con lo stesso token non crea un secondo iscritto.
    expect((await api(`/api/t/${t.code}/join`, { method: "POST", participant: ada, json: {} })).body.participant_token).toBe(ada);
    let view = await api(`/api/t/${t.code}`, { participant: ada });
    expect(view.body.me.display_name).toBe("Ada");
    expect(view.body.participants).toHaveLength(2);

    const start = await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin });
    expect(start.status).toBe(200);
    expect((await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin })).status).toBe(400);
    expect((await api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name: "Tardi", avatar: "owl" } })).status).toBe(409);
    await skipStartDelay(t.code);

    view = await api(`/api/t/${t.code}`, { participant: ada });
    const card = view.body.card;
    expect(card).toMatchObject({ run_phase: "QUESTION", index: 1, total: 2, current_round: 1 });
    // Mai una domanda dei quiz pubblici, che ne mostrano la soluzione.
    const inQuiz = await env.DB.prepare("SELECT 1 FROM quiz_questions WHERE question_id = ?").bind(card.question.id).first();
    expect(inQuiz).toBeNull();
    expect(JSON.stringify(card)).not.toMatch(/"correct"|correct_lines|explanation/);
    // Stessa chiave: niente domanda nella risposta.
    const same = await api(`/api/t/${t.code}?v=${encodeURIComponent(card.view_key)}`, { participant: ada });
    expect(same.body.card.unchanged).toBe(true);
    expect(same.body.card.question).toBeUndefined();

    expect((await api(`/api/t/${t.code}/answer`, { method: "POST", json: { submission: {} } })).status).toBe(403);
    const good = await correctSubmission(t.code);
    expect((await api(`/api/t/${t.code}/answer`, { method: "POST", participant: ada, json: { submission: good } })).body.accepted).toBe(true);
    view = await api(`/api/t/${t.code}`, { participant: ada });
    expect(view.body.card.answered).toBe(1);
    expect(view.body.card.my_submission).toEqual(expect.any(Object));

    // L'admin forza il reveal: Ada prende 100 punti, Bob va in timeout.
    await api(`/api/admin/tournaments/${t.id}/next`, { method: "POST", token: admin });
    view = await api(`/api/t/${t.code}`, { participant: ada });
    expect(view.body.card.run_phase).toBe("REVEAL");
    expect(view.body.card.reveal).toMatchObject({ correct: true, points: 100, timed_out: false });
    const bobView = await api(`/api/t/${t.code}`, { participant: bob });
    expect(bobView.body.card.reveal).toMatchObject({ correct: false, points: 0, timed_out: true });
    expect(view.body.participants[0]).toMatchObject({ display_name: "Ada", score: 100 });
    // Le risposte tardive non contano.
    expect((await api(`/api/t/${t.code}/answer`, { method: "POST", participant: bob, json: { submission: good } })).body.accepted).toBe(false);

    // Seconda domanda, poi fine round → intervallo.
    await api(`/api/admin/tournaments/${t.id}/next`, { method: "POST", token: admin });
    await api(`/api/admin/tournaments/${t.id}/next`, { method: "POST", token: admin });
    await api(`/api/admin/tournaments/${t.id}/next`, { method: "POST", token: admin });
    const monitor = await api(`/api/admin/tournaments/${t.id}/monitor`, { token: admin });
    expect(monitor.body).toMatchObject({ run_phase: "INTERMISSION", current_round: 1, num_rounds: 2 });

    await api(`/api/admin/tournaments/${t.id}/next-round`, { method: "POST", token: admin });
    view = await api(`/api/t/${t.code}`, { participant: ada });
    expect(view.body.card).toMatchObject({ run_phase: "QUESTION", current_round: 2, index: 1 });
    // Anche il secondo round parte dopo i secondi di margine: fino ad allora la domanda resta sul server.
    expect(view.body.card.view_key).toBe("w-2-0");
    expect(view.body.card.question).toBeUndefined();
    await skipStartDelay(t.code);
    view = await api(`/api/t/${t.code}?v=w-2-0`, { participant: ada });
    expect(view.body.card.view_key).toBe("q-2-0");
    expect(view.body.card.question).toEqual(expect.any(Object));

    const finish = await api(`/api/admin/tournaments/${t.id}/finish`, { method: "POST", token: admin });
    expect(finish.status).toBe(200);
    view = await api(`/api/t/${t.code}`, { participant: ada });
    expect(view.body.status).toBe("CLOSED");
    expect(view.body.participants.every((p: any) => p.finished)).toBe(true);
    expect((await api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name: "X", avatar: "owl" } })).status).toBe(403);

    const report = await api(`/api/admin/tournaments/${t.id}/report`, { token: admin });
    expect(report.body.total_answers).toBe(6);
    expect(report.body.total_correct).toBe(1);
    expect(report.body.part_rows[0].p.display_name).toBe("Ada");
    expect(report.body.part_rows[0].answers[0]).toMatchObject({ correct: true, points: 100 });
    // Dal dettaglio del partecipante si apre la domanda.
    const first = report.body.part_rows[0].answers[0];
    expect(first.question_id).toEqual(expect.any(Number));
    expect(first.summary).toEqual(expect.any(String));

    // Le domande usate in un torneo non si eliminano.
    const used = await env.DB.prepare("SELECT question_id FROM tournament_questions LIMIT 1").first<{ question_id: number }>();
    expect((await api(`/api/admin/questions/${used!.question_id}`, { method: "DELETE", token: admin })).status).toBe(400);

    // Torna in bozza: iscritti e domande azzerati.
    await api(`/api/admin/tournaments/${t.id}/status`, { method: "POST", token: admin, json: { status: "DRAFT" } });
    const manage = await api(`/api/admin/tournaments/${t.id}/manage`, { token: admin });
    expect(manage.body).toMatchObject({ status: "DRAFT", participants: [], items: [], join_pin: null });
    expect((await api(`/api/admin/questions/${used!.question_id}`, { method: "DELETE", token: admin })).status).toBe(200);
  });

  it("bonus velocità e scadenza con la sveglia del Durable Object", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin, { per_question_seconds: 1, num_rounds: 1, pool_size: 1, time_bonus: true });
    const pin = await openTournament(admin, t.id);
    const ada = (await api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name: "Ada", avatar: "owl", pin } })).body.participant_token;
    await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin });
    await skipStartDelay(t.code);
    await api(`/api/t/${t.code}/answer`, { method: "POST", participant: ada, json: { submission: await correctSubmission(t.code) } });

    // Nessuna richiesta al torneo: a farlo avanzare sono solo le sveglie (scadenza
    // della domanda, poi fine della soluzione), che aggiornano anche lo specchio in D1.
    const stub = env.TOURNAMENT.get(env.TOURNAMENT.idFromName(t.code));
    await new Promise((r) => setTimeout(r, 1500));
    await runDurableObjectAlarm(stub);
    expect((await env.DB.prepare("SELECT status FROM tournaments WHERE id = ?").bind(t.id).first())?.status).toBe("RUNNING");
    // I 10 secondi della soluzione, fatti passare spostando l'orologio del torneo.
    await shiftRoom(t.code, (s) => {
      s.reveal_started_at -= 10_000;
    });
    await runDurableObjectAlarm(stub);
    const mirrored = await env.DB.prepare("SELECT status, participant_count FROM tournaments WHERE id = ?").bind(t.id).first();
    expect(mirrored).toMatchObject({ status: "CLOSED", participant_count: 1 });
    const view = await api(`/api/t/${t.code}`, { participant: ada });
    expect(view.body.status).toBe("CLOSED");
    // 100 punti base più un bonus proporzionale al tempo rimasto (meno di 100).
    expect(view.body.me.score).toBeGreaterThan(100);
    expect(view.body.me.score).toBeLessThan(200);
  });

  it("token inventato: 404 senza creare il torneo", async () => {
    expect((await api("/api/t/InventatoDaMe123")).status).toBe(404);
    expect((await api("/api/t/InventatoDaMe123/join", { method: "POST", json: { display_name: "X", avatar: "owl" } })).status).toBe(404);
  });

  it("tetto alle iscrizioni dalla stessa rete", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin);
    const pin = await openTournament(admin, t.id);
    const join = (i: number, ip: string) =>
      api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name: `P${i}`, avatar: "owl", pin }, headers: { "CF-Connecting-IP": ip } });
    for (let i = 0; i < 40; i++) expect((await join(i, "203.0.113.5")).status).toBe(200);
    expect((await join(41, "203.0.113.5")).status).toBe(429);
    expect((await join(42, "203.0.113.6")).status).toBe(200);
  });

  it("ogni round rispetta il mix; senza i tipi necessari la gara non parte", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin, { pool_size: 10, num_rounds: 1 });
    const manage = await api(`/api/admin/tournaments/${t.id}/manage`, { token: admin });
    expect(manage.body.plan).toMatchObject({ per_round: 10, problems: [] });
    await api(`/api/admin/tournaments/${t.id}/status`, { method: "POST", token: admin, json: { status: "OPEN" } });
    expect((await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin })).status).toBe(200);
    const items = (await api(`/api/admin/tournaments/${t.id}/manage`, { token: admin })).body.items as { qtype: string }[];
    const count = (qt: string) => items.filter((i) => i.qtype === qt).length;
    expect([count("TRUE_FALSE"), count("MULTIPLE_CHOICE"), count("FIND_WRONG_LINE"), count("CODE_COMPARISON")]).toEqual([2, 1, 3, 4]);
    // La gara si apre sempre con un Vero/Falso.
    expect(items[0].qtype).toBe("TRUE_FALSE");

    // Due round da 10 vogliono 8 confronti di codice: ce ne sono 5.
    const t2 = await api("/api/admin/tournaments", {
      method: "POST",
      token: admin,
      json: { title: "Troppi round", courses: [manage.body.tournament.courses[0].id, manage.body.tournament.courses[1].id], pool_size: 10, num_rounds: 2, per_question_seconds: 60, points_correct: 100 },
    });
    expect(t2.body.warnings[0]).toContain("non può partire");
    await api(`/api/admin/tournaments/${t2.body.id}/status`, { method: "POST", token: admin, json: { status: "OPEN" } });
    const blocked = await api(`/api/admin/tournaments/${t2.body.id}/start`, { method: "POST", token: admin });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toContain("«Confronto di codice» (5 disponibili)");
  });

  it("domande scelte a mano dalla banca, con il controllo del mix", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin, { pool_size: "", num_rounds: 1 });
    const eligible = (await api("/api/admin/tournament-questions", { token: admin })).body.questions as { id: number; qtype: string }[];
    const inQuiz = await env.DB.prepare("SELECT question_id FROM quiz_questions LIMIT 1").first<{ question_id: number }>();
    expect(eligible.some((q) => q.id === inQuiz!.question_id)).toBe(false);
    const take = (qt: string, n: number) => eligible.filter((q) => q.qtype === qt).slice(0, n).map((q) => q.id);
    const picks = [...take("TRUE_FALSE", 2), ...take("MULTIPLE_CHOICE", 1), ...take("FIND_WRONG_LINE", 3), ...take("CODE_COMPARISON", 4)];
    const base = (await api(`/api/admin/tournaments/${t.id}`, { token: admin })).body.tournament;
    const save = (question_ids: number[]) =>
      api(`/api/admin/tournaments/${t.id}`, { method: "PUT", token: admin, json: { ...base, pool_size: "", courses: [], question_ids } });

    // Una domanda di un quiz non si può scegliere.
    const bad = await save([...picks, inQuiz!.question_id]);
    expect(bad.status).toBe(400);
    expect(bad.body.errors.question_ids).toBeTruthy();

    // Un confronto in meno: salvato, ma con l'avviso, e la gara non parte.
    const short = await save(picks.filter((id) => id !== take("CODE_COMPARISON", 4)[3]));
    expect(short.body.warnings[0]).toContain("Le domande scelte");
    await api(`/api/admin/tournaments/${t.id}/status`, { method: "POST", token: admin, json: { status: "OPEN" } });
    expect((await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin })).status).toBe(400);

    const ok = await save(picks);
    expect(ok.body.warnings).toEqual([]);
    expect((await api(`/api/admin/tournaments/${t.id}`, { token: admin })).body.tournament.question_ids).toEqual([...picks].sort((a, b) => a - b));
    expect((await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin })).status).toBe(200);
    const items = (await api(`/api/admin/tournaments/${t.id}/manage`, { token: admin })).body.items as { prompt: string }[];
    expect(items).toHaveLength(10);
    const frozen = await env.DB.prepare("SELECT question_id FROM tournament_questions WHERE tournament_id = ? ORDER BY question_id").bind(t.id).all<{ question_id: number }>();
    expect(frozen.results.map((r) => r.question_id)).toEqual([...picks].sort((a, b) => a - b));
  });

  it("scelta multipla: conta fra «Hanno risposto» solo dopo la conferma, poi non cambia", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin, { pool_size: 10, num_rounds: 1 });
    const pin = await openTournament(admin, t.id);
    const ada = (await api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name: "Ada", avatar: "owl", pin } })).body.participant_token;
    await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin });
    await skipStartDelay(t.code);
    let card = (await api(`/api/t/${t.code}`, { participant: ada })).body.card;
    for (let i = 0; i < 10 && card.question.qtype !== "MULTIPLE_CHOICE"; i++) {
      // Gli altri tipi: risposta modificabile fino al reveal.
      const good = await correctSubmission(t.code);
      expect((await api(`/api/t/${t.code}/answer`, { method: "POST", participant: ada, json: { submission: good } })).body.accepted).toBe(true);
      expect((await api(`/api/t/${t.code}/answer`, { method: "POST", participant: ada, json: { submission: good } })).body.accepted).toBe(true);
      await api(`/api/admin/tournaments/${t.id}/next`, { method: "POST", token: admin });
      await api(`/api/admin/tournaments/${t.id}/next`, { method: "POST", token: admin });
      card = (await api(`/api/t/${t.code}`, { participant: ada })).body.card;
    }
    expect(card.question.qtype).toBe("MULTIPLE_CHOICE");
    expect(card.answered).toBe(0);
    const good = await correctSubmission(t.code);
    expect((await api(`/api/t/${t.code}/answer`, { method: "POST", participant: ada, json: { submission: good } })).body.accepted).toBe(true);
    expect((await api(`/api/t/${t.code}`, { participant: ada })).body.card.answered).toBe(1);
    const chosen = (good as { selected: string[] }).selected;
    const other = card.question.options.find((o: any) => !chosen.includes(o.id)).id;
    const again = await api(`/api/t/${t.code}/answer`, { method: "POST", participant: ada, json: { submission: { selected: [other] } } });
    expect(again.status).toBe(409);
    await api(`/api/admin/tournaments/${t.id}/next`, { method: "POST", token: admin });
    expect((await api(`/api/t/${t.code}`, { participant: ada })).body.card.reveal.correct).toBe(true);
  });

  it("all'avvio il timer parte dopo 5 secondi; prima le risposte non contano", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin, { pool_size: 10, num_rounds: 1, per_question_seconds: 30 });
    const pin = await openTournament(admin, t.id);
    const ada = (await api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name: "Ada", avatar: "owl", pin } })).body.participant_token;
    const before = Date.now();
    await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin });
    const card = (await api(`/api/t/${t.code}`, { participant: ada })).body.card;
    // Prima del via la domanda non lascia il server: la scheda dice solo quando parte.
    expect(card.question).toBeUndefined();
    expect(card.my_submission).toBeUndefined();
    expect(card.view_key).toBe("w-1-0");
    expect(card.starts_ms).toBeGreaterThanOrEqual(before + DEFAULT_START_DELAY_SECONDS * 1000);
    expect(card.deadline_ms).toBe(card.starts_ms + 30_000);
    const monitor = (await api(`/api/admin/tournaments/${t.id}/monitor`, { token: admin })).body;
    expect(monitor).toMatchObject({ starts_ms: card.starts_ms, per_question_seconds: 30 });

    const good = await correctSubmission(t.code);
    expect((await api(`/api/t/${t.code}/answer`, { method: "POST", participant: ada, json: { submission: good } })).body.accepted).toBe(false);
    await skipStartDelay(t.code);
    const started = (await api(`/api/t/${t.code}?v=w-1-0`, { participant: ada })).body.card;
    expect(started.view_key).toBe("q-1-0");
    expect(started.question.qtype).toBe("TRUE_FALSE");
    expect((await api(`/api/t/${t.code}/answer`, { method: "POST", participant: ada, json: { submission: good } })).body.accepted).toBe(true);
    // Le domande successive partono subito, senza margine.
    await api(`/api/admin/tournaments/${t.id}/next`, { method: "POST", token: admin });
    await api(`/api/admin/tournaments/${t.id}/next`, { method: "POST", token: admin });
    const second = (await api(`/api/t/${t.code}`, { participant: ada })).body.card;
    expect(second.index).toBe(2);
    expect(second.starts_ms).toBeLessThanOrEqual(Date.now());
  });

  it("soluzione: almeno 10 secondi, 10 se non indicata", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin);
    const base = (await api(`/api/admin/tournaments/${t.id}`, { token: admin })).body.tournament;
    expect(base.reveal_seconds).toBe(10);
    const short = await api(`/api/admin/tournaments/${t.id}`, {
      method: "PUT",
      token: admin,
      json: { ...base, courses: base.courses.map((c: any) => c.id), reveal_seconds: 5 },
    });
    expect(short.status).toBe(400);
    expect(short.body.errors.reveal_seconds).toBeTruthy();
    const longer = await api(`/api/admin/tournaments/${t.id}`, {
      method: "PUT",
      token: admin,
      json: { ...base, courses: base.courses.map((c: any) => c.id), reveal_seconds: 15 },
    });
    expect(longer.status).toBe(200);

    // Un torneo salvato prima del minimo parte comunque con 10 secondi.
    await env.DB.prepare("UPDATE tournaments SET reveal_seconds = 3 WHERE id = ?").bind(t.id).run();
    await api(`/api/admin/tournaments/${t.id}/status`, { method: "POST", token: admin, json: { status: "OPEN" } });
    await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin });
    expect((await api(`/api/t/${t.code}`)).body.rules.reveal_seconds).toBe(10);
  });

  it("secondi prima della prima domanda: da 3 a 60, 5 se non indicati", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin, { pool_size: 10, num_rounds: 1, per_question_seconds: 30 });
    const base = (await api(`/api/admin/tournaments/${t.id}`, { token: admin })).body.tournament;
    expect(base.start_delay_seconds).toBe(DEFAULT_START_DELAY_SECONDS);
    const put = (start_delay_seconds: number) =>
      api(`/api/admin/tournaments/${t.id}`, {
        method: "PUT",
        token: admin,
        json: { ...base, courses: base.courses.map((c: any) => c.id), start_delay_seconds },
      });
    for (const wrong of [2, 61]) {
      const res = await put(wrong);
      expect(res.status).toBe(400);
      expect(res.body.errors.start_delay_seconds).toBeTruthy();
    }
    expect((await put(10)).status).toBe(200);
    expect((await api(`/api/t/${t.code}`)).body.rules.start_delay_seconds).toBe(10);

    const pin = await openTournament(admin, t.id);
    const ada = (await api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name: "Ada", avatar: "owl", pin } })).body.participant_token;
    const before = Date.now();
    await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin });
    const card = (await api(`/api/t/${t.code}`, { participant: ada })).body.card;
    expect(card.starts_ms).toBeGreaterThanOrEqual(before + 10_000);
    expect(card.starts_ms).toBeLessThan(Date.now() + 10_000 + 1000);
    expect(card.deadline_ms).toBe(card.starts_ms + 30_000);
  });

  it("duplica: una copia nuova, in bozza, con le stesse impostazioni", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin, {
      pool_size: "",
      num_rounds: 1,
      per_question_seconds: 45,
      reveal_seconds: 12,
      start_delay_seconds: 7,
      time_bonus: true,
    });
    const eligible = (await api("/api/admin/tournament-questions", { token: admin })).body.questions as { id: number; qtype: string; summary: string }[];
    expect(eligible.find((q) => q.qtype === "TRUE_FALSE")?.summary).not.toMatch(/^Vero o falso\?$/i);
    const take = (qt: string, n: number) => eligible.filter((q) => q.qtype === qt).slice(0, n).map((q) => q.id);
    const picks = [...take("TRUE_FALSE", 2), ...take("MULTIPLE_CHOICE", 1), ...take("FIND_WRONG_LINE", 3), ...take("CODE_COMPARISON", 4)];
    const base = (await api(`/api/admin/tournaments/${t.id}`, { token: admin })).body.tournament;
    await api(`/api/admin/tournaments/${t.id}`, { method: "PUT", token: admin, json: { ...base, pool_size: "", courses: [], question_ids: picks } });
    const pin = await openTournament(admin, t.id);
    await api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name: "Ada", avatar: "owl", pin } });

    const dup = await api(`/api/admin/tournaments/${t.id}/duplicate`, { method: "POST", token: admin });
    expect(dup.status).toBe(200);
    expect(dup.body.warnings).toEqual([]);
    const copy = (await api(`/api/admin/tournaments/${dup.body.id}/manage`, { token: admin })).body;
    expect(copy.tournament).toMatchObject({
      title: "Gara (copia)",
      status: "DRAFT",
      participant_count: 0,
      per_question_seconds: 45,
      reveal_seconds: 12,
      start_delay_seconds: 7,
      time_bonus: true,
      num_rounds: 1,
    });
    expect(copy.tournament.join_token).not.toBe(t.code);
    expect(copy.tournament.slug).not.toBe(base.slug);
    expect(copy.tournament.question_ids).toEqual([...picks].sort((a, b) => a - b));
    expect(copy.participants).toEqual([]);
    expect(copy.plan.problems).toEqual([]);
    // L'originale non cambia.
    const original = (await api(`/api/admin/tournaments/${t.id}/manage`, { token: admin })).body;
    expect(original).toMatchObject({ status: "OPEN" });
    expect(original.participants).toHaveLength(1);
    // Solo per gli amministratori.
    expect((await api(`/api/admin/tournaments/${t.id}/duplicate`, { method: "POST" })).status).toBe(401);
  });

  it("PIN di iscrizione: il link da solo non basta", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin);
    const pin = await openTournament(admin, t.id);
    // Il PIN non esce dal pannello: né nella pagina del torneo né nella home.
    expect(JSON.stringify((await api(`/api/t/${t.code}`)).body)).not.toContain(pin);
    expect(JSON.stringify((await api("/api/home")).body)).not.toContain(pin);
    const wrongPin = pin === "000000" ? "111111" : "000000";
    const join = (json: Record<string, unknown>) =>
      api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name: "Ada", avatar: "owl", ...json } });
    const none = await join({});
    expect(none.status).toBe(400);
    expect(none.body.error).toContain("PIN");
    const wrong = await join({ pin: wrongPin });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain("PIN non corretto");
    // Contano solo le cifre: «123 456» va bene.
    const ada = await join({ pin: ` ${pin.slice(0, 3)} ${pin.slice(3)} ` });
    expect(ada.status).toBe(200);
    // Chi è già iscritto rientra con il suo codice, senza PIN.
    const back = await api(`/api/t/${t.code}/join`, { method: "POST", participant: ada.body.participant_token, json: {} });
    expect(back.body.participant_token).toBe(ada.body.participant_token);

    // Nuovo PIN: il vecchio non vale più.
    let fresh = pin;
    while (fresh === pin) {
      const res = await api(`/api/admin/tournaments/${t.id}/pin`, { method: "POST", token: admin });
      expect(res.status).toBe(200);
      fresh = res.body.pin;
    }
    expect(fresh).toMatch(/^\d{6}$/);
    expect((await api(`/api/admin/tournaments/${t.id}/manage`, { token: admin })).body.join_pin).toBe(fresh);
    expect((await join({ display_name: "Bob", pin })).status).toBe(400);
    expect((await join({ display_name: "Bob", pin: fresh })).status).toBe(200);
    expect((await api(`/api/admin/tournaments/${t.id}/pin`, { method: "POST" })).status).toBe(401);

    // In bozza il PIN non c'è, e riaprendo ne nasce uno nuovo.
    await api(`/api/admin/tournaments/${t.id}/status`, { method: "POST", token: admin, json: { status: "DRAFT" } });
    expect((await api(`/api/admin/tournaments/${t.id}/manage`, { token: admin })).body.join_pin).toBeNull();
    expect((await api(`/api/admin/tournaments/${t.id}/pin`, { method: "POST", token: admin })).status).toBe(400);
    expect(await openTournament(admin, t.id)).toMatch(/^\d{6}$/);
  });

  it("PIN: oltre 30 sbagliati dalla stessa rete si aspetta, e «Nuovo PIN» azzera il conto", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin);
    const pin = await openTournament(admin, t.id);
    const wrongPin = pin === "000000" ? "111111" : "000000";
    const join = (p: string, ip: string, display_name = "Ada") =>
      api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name, avatar: "owl", pin: p }, headers: { "CF-Connecting-IP": ip } });
    for (let i = 0; i < 30; i++) expect((await join(wrongPin, "203.0.113.70")).status).toBe(400);
    // Anche il PIN giusto aspetta: altrimenti provarli tutti funzionerebbe lo stesso.
    const blocked = await join(pin, "203.0.113.70");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain("Troppi PIN sbagliati");
    // Le altre reti no.
    expect((await join(pin, "203.0.113.71", "Bob")).status).toBe(200);
    // L'organizzatore genera un nuovo PIN: il conto riparte.
    const fresh = (await api(`/api/admin/tournaments/${t.id}/pin`, { method: "POST", token: admin })).body.pin;
    expect((await join(fresh, "203.0.113.70")).status).toBe(200);
  });

  it("nomi dei partecipanti: senza caratteri invisibili, e uno per persona", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin);
    const pin = await openTournament(admin, t.id);
    const join = (display_name: string) => api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name, avatar: "owl", pin } });
    const me = async (token: string) => (await api(`/api/t/${t.code}`, { participant: token })).body.me.display_name;
    const ada = await join("Ada\u202E\u200B  Lovelace");
    expect(ada.status).toBe(200);
    expect(await me(ada.body.participant_token)).toBe("Ada Lovelace");
    // Lo stesso nome con maiuscole o spazi diversi: no.
    const twin = await join(" ada   LOVELACE ");
    expect(twin.status).toBe(400);
    expect(twin.body.error).toContain("C'è già un partecipante");
    // Un nome fatto solo di caratteri invisibili non è un nome.
    expect((await join("\u200B\u2066\u2069\uFEFF")).status).toBe(400);
    // Le emoji composte restano intere.
    const grace = await join("👩‍💻 Grace");
    expect(grace.status).toBe(200);
    expect(await me(grace.body.participant_token)).toBe("👩‍💻 Grace");
  });

  it("l'organizzatore rimuove un partecipante, punti e risposte compresi", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin, { pool_size: 10, num_rounds: 1 });
    const pin = await openTournament(admin, t.id);
    const join = (display_name: string) => api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name, avatar: "owl", pin } });
    const ada = (await join("Ada")).body.participant_token;
    const troll = (await join("Troll")).body.participant_token;
    await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin });
    await skipStartDelay(t.code);
    const good = await correctSubmission(t.code);
    for (const p of [ada, troll]) await api(`/api/t/${t.code}/answer`, { method: "POST", participant: p, json: { submission: good } });
    const before = (await api(`/api/admin/tournaments/${t.id}/monitor`, { token: admin })).body;
    expect(before).toMatchObject({ n: 2, answered: 2 });
    const trollId = before.participants.find((p: any) => p.display_name === "Troll").id;

    expect((await api(`/api/admin/tournaments/${t.id}/participants/${trollId}/remove`, { method: "POST" })).status).toBe(401);
    const removed = await api(`/api/admin/tournaments/${t.id}/participants/${trollId}/remove`, { method: "POST", token: admin });
    expect(removed.status).toBe(200);
    expect(removed.body.message).toContain("Troll");
    expect((await api(`/api/admin/tournaments/${t.id}/monitor`, { token: admin })).body).toMatchObject({ n: 1, answered: 1 });
    expect((await env.DB.prepare("SELECT participant_count FROM tournaments WHERE id = ?").bind(t.id).first())?.participant_count).toBe(1);
    // Il codice del rimosso non vale più, e a gara avviata non si rientra.
    expect((await api(`/api/t/${t.code}`, { participant: troll })).body.me).toBeNull();
    expect((await api(`/api/t/${t.code}/answer`, { method: "POST", participant: troll, json: { submission: good } })).status).toBe(403);
    const rejoin = await api(`/api/t/${t.code}/join`, { method: "POST", participant: troll, json: { display_name: "Troll2", avatar: "owl", pin } });
    expect(rejoin.status).toBe(409);
    expect((await api(`/api/admin/tournaments/${t.id}/participants/999/remove`, { method: "POST", token: admin })).status).toBe(404);
    // Nel report il rimosso non c'è.
    await api(`/api/admin/tournaments/${t.id}/finish`, { method: "POST", token: admin });
    const report = (await api(`/api/admin/tournaments/${t.id}/report`, { token: admin })).body;
    expect(report.part_rows.map((r: any) => r.p.display_name)).toEqual(["Ada"]);
  });

  it("la gara congela una copia: id delle opzioni nuovi e lati a caso, stessa risposta giusta", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin, { pool_size: 10, num_rounds: 1 });
    await openTournament(admin, t.id);
    await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin });
    const { items } = await frozenItems(t.code);
    expect(items).toHaveLength(10);
    const textsOf = (d: any, ids: string[]) => ids.map((id) => d.options.find((o: any) => o.id === id).text).sort();
    const codeOf = (d: any, side: string) => d[`snippet_${side}`] ?? JSON.stringify(d[`files_${side}`]);
    for (const item of items) {
      const row = await env.DB.prepare("SELECT data, render FROM questions WHERE id = ?").bind(item.question_id).first<{ data: string; render: string }>();
      const bankData = JSON.parse(row!.data);
      const bankRender = JSON.parse(row!.render);
      if (item.qtype === "MULTIPLE_CHOICE") {
        // Id «a», «b»… nell'ordine della copia; stesse opzioni, stessa risposta giusta.
        expect(item.data.options.map((o: any) => o.id)).toEqual(["a", "b", "c", "d", "e", "f"].slice(0, bankData.options.length));
        expect(item.data.options.map((o: any) => o.text).sort()).toEqual(bankData.options.map((o: any) => o.text).sort());
        expect(textsOf(item.data, item.data.correct)).toEqual(textsOf(bankData, bankData.correct));
      } else if (item.qtype === "CODE_COMPARISON") {
        // Il codice giusto è lo stesso; le etichette restano al loro posto; il render segue i dati.
        expect(codeOf(item.data, item.data.correct)).toEqual(codeOf(bankData, bankData.correct));
        expect([item.data.label_a, item.data.label_b]).toEqual([bankData.label_a, bankData.label_b]);
        const swapped = item.data.correct !== bankData.correct;
        expect(item.render.files_a).toEqual(swapped ? bankRender.files_b : bankRender.files_a);
      } else {
        expect(item.data).toEqual(bankData);
      }
    }
  });

  it("senza domande di banca il torneo non parte", async () => {
    const admin = await loggedIn();
    const { results } = await env.DB.prepare("SELECT id FROM courses").all<{ id: number }>();
    const t = await api("/api/admin/tournaments", {
      method: "POST",
      token: admin,
      json: { title: "Solo quiz", courses: results.map((r) => r.id), num_rounds: 1, per_question_seconds: 60, points_correct: 100 },
    });
    const start = await api(`/api/admin/tournaments/${t.body.id}/start`, { method: "POST", token: admin });
    expect(start.status).toBe(400);
    expect(start.body.error).toContain("fuori dai quiz");
  });

  /** Una gara di un round giocata fino in fondo: Ada indovina la prima, Bob la seconda; l'altro va in timeout. */
  async function playedTournament(admin: string) {
    const t = await setupTournament(admin, { num_rounds: 1, pool_size: 3 });
    const pin = await openTournament(admin, t.id);
    const join = async (display_name: string, avatar: string) =>
      (await api(`/api/t/${t.code}/join`, { method: "POST", json: { display_name, avatar, pin } })).body.participant_token as string;
    const ada = await join("Ada", "owl");
    const bob = await join("Bob", "cat");
    expect((await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin })).status).toBe(200);
    await skipStartDelay(t.code);
    await api(`/api/t/${t.code}/answer`, { method: "POST", participant: ada, json: { submission: await correctSubmission(t.code) } });
    await api(`/api/admin/tournaments/${t.id}/next`, { method: "POST", token: admin });
    await api(`/api/admin/tournaments/${t.id}/next`, { method: "POST", token: admin });
    await api(`/api/t/${t.code}/answer`, { method: "POST", participant: bob, json: { submission: await correctSubmission(t.code) } });
    expect((await api(`/api/admin/tournaments/${t.id}/finish`, { method: "POST", token: admin })).status).toBe(200);
    return { ...t, ada, bob };
  }

  it("backup: l'export reimportato ricrea classifica, domande e report in un torneo nuovo", async () => {
    const admin = await loggedIn();
    const t = await playedTournament(admin);
    const exp = await api(`/api/admin/tournaments/${t.id}/export`, { token: admin });
    expect(exp.status).toBe(200);
    expect(exp.body).toMatchObject({ format: "secure-code-academy/tournament", version: 1, source: "cloudflare" });
    expect(exp.body.tournament).toMatchObject({ title: "Gara", status: "CLOSED", num_rounds: 1, pool_size: 3, points_correct: 100 });
    expect(exp.body.questions).toHaveLength(3);
    expect(exp.body.participants.map((p: any) => [p.rank, p.display_name, p.score])).toEqual([
      [1, "Ada", 100],
      [2, "Bob", 100],
    ]);
    expect(exp.body.answers).toHaveLength(4);
    // Niente PIN né codici: né quelli dei giocatori né quello del torneo.
    const raw = JSON.stringify(exp.body);
    for (const code of [t.ada, t.bob, t.code]) expect(raw).not.toContain(code);
    expect(raw).not.toMatch(/"(join_pin|join_token|token|network|pin)"/);

    const imp = await api("/api/admin/tournaments/import", { method: "POST", token: admin, json: exp.body });
    expect(imp.status).toBe(200);
    expect(imp.body.id).not.toBe(t.id);
    expect(imp.body.warnings).toEqual([]);
    const manage = (await api(`/api/admin/tournaments/${imp.body.id}/manage`, { token: admin })).body;
    expect(manage.status).toBe("CLOSED");
    expect(manage.join_pin).toBeNull();
    expect(manage.tournament.title).toBe("Gara");
    expect(manage.tournament.join_token).not.toBe(t.code);
    // I corsi tornano collegati per titolo.
    expect(manage.tournament.courses.map((c: any) => c.title).sort()).toEqual([...exp.body.tournament.courses].sort());
    expect(manage.participants.map((p: any) => [p.display_name, p.score])).toEqual([
      ["Ada", 100],
      ["Bob", 100],
    ]);
    expect(manage.items).toHaveLength(3);
    expect((await env.DB.prepare("SELECT status, participant_count FROM tournaments WHERE id = ?").bind(imp.body.id).first())).toEqual({
      status: "CLOSED",
      participant_count: 2,
    });

    // Report identico, etichette dei confronti di codice comprese.
    const { tournament: _before, ...before } = (await api(`/api/admin/tournaments/${t.id}/report`, { token: admin })).body;
    const { tournament: _after, ...after } = (await api(`/api/admin/tournaments/${imp.body.id}/report`, { token: admin })).body;
    expect(before.total_answers).toBe(4);
    expect(after).toEqual(before);

    // La classifica pubblica del nuovo torneo funziona, e i codici dei giocatori di quello vecchio lì non valgono.
    const view = (await api(`/api/t/${manage.tournament.join_token}`, { participant: t.ada })).body;
    expect(view.status).toBe("CLOSED");
    expect(view.me).toBeNull();
    expect(view.participants.map((p: any) => p.display_name)).toEqual(["Ada", "Bob"]);
    // Le domande importate sono copie: non bloccano la banca.
    expect(await env.DB.prepare("SELECT 1 FROM tournament_questions WHERE tournament_id = ?").bind(imp.body.id).first()).toBeNull();

    // Esportato di nuovo, il torneo importato dà lo stesso contenuto.
    const again = (await api(`/api/admin/tournaments/${imp.body.id}/export`, { token: admin })).body;
    for (const key of ["tournament", "questions", "participants", "answers"]) expect(again[key], key).toEqual(exp.body[key]);
  });

  it("backup: file non validi, troppo grandi o mandati da un consulente non lasciano niente", async () => {
    const admin = await loggedIn();
    const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM tournaments").first<{ n: number }>())!.n;
    const before = await count();
    const base = { format: "secure-code-academy/tournament", version: 1, tournament: { title: "T" }, questions: [], participants: [], answers: [] };
    const tf = { key: 1, round: 1, order: 1, qtype: "TRUE_FALSE", prompt: "Vero o falso?", data: { statement: "Sì", answer: true } };
    const cases: [unknown, string][] = [
      [{ ...base, format: "altro" }, "non è il backup di un torneo"],
      [{ ...base, version: 2 }, "Versione del file non supportata"],
      [{ ...base, tournament: { title: "  " } }, "Torneo, titolo"],
      [{ ...base, questions: [{ ...tf, data: { statement: "Sì" } }] }, "Domanda 1"],
      [{ ...base, questions: [{ ...tf, round: 2 }] }, "Domanda 1, round"],
      [{ ...base, questions: [tf, { ...tf, key: 2 }] }, "Domanda 2"],
      [{ ...base, participants: [{ key: 1, display_name: "A" }, { key: 1, display_name: "B" }] }, "Partecipante 2"],
      [{ ...base, questions: [tf], participants: [{ key: 1, display_name: "A" }], answers: [{ participant: 2, question: 1 }] }, "Risposta 1"],
    ];
    for (const [json, message] of cases) {
      const res = await api("/api/admin/tournaments/import", { method: "POST", token: admin, json });
      expect(res.status, message).toBe(400);
      expect(res.body.error, message).toContain(message);
    }
    const broken = await api("/api/admin/tournaments/import", { method: "POST", token: admin, headers: { "Content-Type": "application/json" }, body: "{" });
    expect(broken.status).toBe(400);
    expect(broken.body.error).toContain("JSON valido");
    const big = await api("/api/admin/tournaments/import", {
      method: "POST",
      token: admin,
      headers: { "Content-Type": "application/json" },
      body: " ".repeat(4 * 1024 * 1024 + 1),
    });
    expect(big.status).toBe(413);
    expect(await count()).toBe(before);

    // I tornei, backup compreso, restano agli amministratori.
    await env.DB.prepare("INSERT INTO admin_users (username, password_hash, must_change_password, role) VALUES (?, ?, 0, 'consultant')")
      .bind("mario.rossi", await hashPassword(ADMIN_PW, 1000))
      .run();
    const consultant = (await login("mario.rossi", ADMIN_PW)).body.token;
    expect((await api("/api/admin/tournaments/import", { method: "POST", token: consultant, json: base })).status).toBe(403);
    const t = await setupTournament(admin);
    expect((await api(`/api/admin/tournaments/${t.id}/export`, { token: consultant })).status).toBe(403);
    expect((await api(`/api/admin/tournaments/${t.id}/export`)).status).toBe(401);
  });

  it("backup: l'HTML del file non passa, le domande si rendono di nuovo", async () => {
    const admin = await loggedIn();
    const file = structuredClone(otherArchive) as any;
    file.questions[0].prompt = "<script>alert(1)</script> Vero?";
    file.questions[0].explanation = "<img src=x onerror=alert(1)> [link](javascript:alert(1))";
    const imp = await api("/api/admin/tournaments/import", { method: "POST", token: admin, json: file });
    expect(imp.status).toBe(200);
    const report = (await api(`/api/admin/tournaments/${imp.body.id}/report`, { token: admin })).body;
    const rows = report.part_rows.flatMap((r: any) => r.answers);
    const html = rows.map((a: any) => a.explanation_html).join("");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // Il link javascript: resta testo, senza <a href>.
    expect(html).not.toMatch(/<img|<script|<a\s|href=/);
  });

  it("backup: il file vero esportato da un'altra installazione si importa", async () => {
    const admin = await loggedIn();
    const imp = await api("/api/admin/tournaments/import", { method: "POST", token: admin, json: otherArchive });
    expect(imp.status).toBe(200);
    // Il corso del file qui non c'è: si dice, e il report non cambia.
    expect(imp.body.warnings.join(" ")).toContain("SQLi");
    const manage = (await api(`/api/admin/tournaments/${imp.body.id}/manage`, { token: admin })).body;
    expect(manage.status).toBe("CLOSED");
    expect(manage.items).toHaveLength(otherArchive.questions.length);
    expect(manage.participants.map((p: any) => [p.display_name, p.score])).toEqual(
      otherArchive.participants.map((p) => [p.display_name, p.score]),
    );
    const report = (await api(`/api/admin/tournaments/${imp.body.id}/report`, { token: admin })).body;
    expect(report.total_answers).toBe(otherArchive.answers.length);
    expect(report.total_correct).toBe(otherArchive.answers.filter((a) => a.is_correct).length);
    expect(report.topic_rows.map((r: any) => r.name)).toEqual(["SQLi"]);
  });

  it("backup: un file di un'altra installazione con valori da sistemare, e una bozza che torna bozza", async () => {
    const admin = await loggedIn();
    const course = "Corso che qui non c'è";
    const file = {
      format: "secure-code-academy/tournament",
      version: 1,
      exported_at: "2026-10-20T10:00:00+00:00",
      source: "altra-installazione",
      tournament: {
        title: "Gara altrove",
        description: "",
        status: "CLOSED",
        num_rounds: 1,
        per_question_seconds: 30,
        reveal_seconds: 5,
        start_delay_seconds: 5,
        points_correct: 100,
        time_bonus: true,
        pool_size: 2,
        round_mix: null,
        started_at: "2026-10-20T09:00:00+00:00",
        finished_at: "2026-10-20T09:30:00+00:00",
        courses: [course],
      },
      questions: [
        { key: 501, round: 1, order: 1, qtype: "TRUE_FALSE", prompt: "Vero o falso?", explanation: "**Sì**", course, difficulty: 1, data: { statement: "Le query parametrizzate evitano la SQL injection.", answer: true } },
        { key: 502, round: 1, order: 2, qtype: "CODE_COMPARISON", prompt: "Quale è sicura?", explanation: "", course: null, difficulty: 2, data: { language: "python", snippet_a: "a()", snippet_b: "b()", correct: "b" } },
      ],
      participants: [
        { key: 7, rank: 1, display_name: "Carla", avatar_key: "fox", score: 290, finished: true, joined_at: "2026-10-20T08:55:00+00:00", finished_at: "2026-10-20T09:30:00+00:00" },
        { key: 9, rank: 2, display_name: "Dino‮<b>", avatar_key: "pony", score: 0, finished: true },
      ],
      answers: [
        { participant: 7, question: 501, submitted: { answer: true }, is_correct: true, timed_out: false, points: 150, answered_at: "2026-10-20T09:01:00+00:00" },
        { participant: 7, question: 502, submitted: { choice: "b" }, is_correct: true, timed_out: false, points: 140, answered_at: "2026-10-20T09:02:00+00:00" },
        // Incoerente: un timeout non è mai giusto né prende punti.
        { participant: 9, question: 501, submitted: {}, is_correct: true, timed_out: true, points: 100, answered_at: "2026-10-20T09:01:30+00:00" },
      ],
    };
    const imp = await api("/api/admin/tournaments/import", { method: "POST", token: admin, json: file });
    expect(imp.status).toBe(200);
    expect(imp.body.warnings.join(" ")).toContain(course);
    const manage = (await api(`/api/admin/tournaments/${imp.body.id}/manage`, { token: admin })).body;
    // I secondi della soluzione salgono al minimo di oggi.
    expect(manage.tournament).toMatchObject({ title: "Gara altrove", reveal_seconds: 10, time_bonus: true, courses: [] });
    // Nome pulito, avatar sconosciuto → ninja, punteggio = somma dei punti.
    expect(manage.participants.map((p: any) => [p.display_name, p.avatar_key, p.score])).toEqual([
      ["Carla", "fox", 290],
      ["Dinob", "ninja", 0],
    ]);
    const report = (await api(`/api/admin/tournaments/${imp.body.id}/report`, { token: admin })).body;
    expect(report).toMatchObject({ total_answers: 3, total_correct: 2 });
    expect(report.topic_rows.map((r: any) => r.name).sort()).toEqual([course, "Senza corso"]);
    const carla = report.part_rows[0].answers;
    const tfRow = carla.find((a: any) => a.qtype === "TRUE_FALSE");
    expect(tfRow).toMatchObject({ your_text: "Vero", correct_text: "Vero", points: 150, topic: course });
    // L'HTML della spiegazione lo rende il Worker, dal Markdown.
    expect(tfRow.explanation_html).toContain("<strong>Sì</strong>");
    expect(["Versione A", "Versione B"]).toContain(carla.find((a: any) => a.qtype === "CODE_COMPARISON").your_text);

    // Un torneo mai giocato torna in bozza, con le impostazioni e i corsi dello stesso titolo.
    const draft = await setupTournament(admin, { title: "Bozza", num_rounds: 2, pool_size: 2 });
    const exp = (await api(`/api/admin/tournaments/${draft.id}/export`, { token: admin })).body;
    expect(exp.questions).toEqual([]);
    const back = await api("/api/admin/tournaments/import", { method: "POST", token: admin, json: exp });
    expect(back.status).toBe(200);
    const again = (await api(`/api/admin/tournaments/${back.body.id}/manage`, { token: admin })).body;
    expect(again.status).toBe("DRAFT");
    expect(again.tournament).toMatchObject({ title: "Bozza", num_rounds: 2, pool_size: 2 });
    expect(again.tournament.courses.map((c: any) => c.title).sort()).toEqual([...exp.tournament.courses].sort());
    expect(again.plan.problems).toEqual([]);
  });
});

describe("import: stessi controlli dei form", () => {
  const course = (extra: Record<string, unknown>) => ({ version: "1.0", kind: "course", course: { slug: "c1", title: "C1", ...extra }, microcourses: [] });

  it("link non http(s) rifiutati", async () => {
    const token = await loggedIn();
    for (const bad of [
      { lab_url: "javascript:alert(document.domain)" },
      { presentations: [{ title: "P", url: "javascript:alert(1)" }] },
      { presentations: [{ title: "P", url: "http://esempio.it/a.pdf" }] },
      { resources: [{ title: "R", url: "data:text/html,<script>alert(1)</script>" }] },
      { slug: "../x" },
    ]) {
      const r = await api("/api/admin/courses/import", { method: "POST", token, json: course(bad) });
      expect(r.status).toBe(400);
    }
    expect(await env.DB.prepare("SELECT 1 FROM courses WHERE slug = 'c1'").first()).toBeNull();

    const bundle = structuredClone(sqliBase) as any;
    bundle.images = [{ ref_key: "x", url: "javascript:alert(1)" }];
    const r = await api("/api/admin/microcourses/import", { method: "POST", token, json: bundle });
    expect(r.status).toBe(400);

    const good = await api("/api/admin/courses/import", {
      method: "POST",
      token,
      json: course({ lab_url: "https://lab.esempio.it", presentations: [{ title: "P", url: "https://cdn.esempio.it/a.pdf" }], resources: [{ title: "R", url: "http://esempio.it" }] }),
    });
    expect(good.status).toBe(200);
  });

  it("ordinamento con nomi riservati: niente errore 500", async () => {
    const token = await loggedIn();
    expect((await api("/api/admin/questions?sort=constructor", { token })).status).toBe(200);
    expect((await api("/api/admin/questions?sort=__proto__", { token })).status).toBe(200);
  });
});

describe("banca domande: import a blocchi, sostituzione, export scelto", () => {
  it("limite per richiesta, sostituzione della banca ed export delle domande scelte", async () => {
    const token = await loggedIn();
    // Il bundle del beforeEach ha un quiz: le sue domande non si toccano.
    const inQuiz = (await env.DB.prepare("SELECT COUNT(*) AS n FROM quiz_questions").first<{ n: number }>())!.n;
    expect(inQuiz).toBeGreaterThan(0);

    const many = { version: "1.0", kind: "questions", questions: Array.from({ length: 51 }, () => bank.questions[0]) };
    expect((await api("/api/admin/questions/import", { method: "POST", token, json: many })).status).toBe(400);
    const ok = await api("/api/admin/questions/import", { method: "POST", token, json: bank });
    expect(ok.body.count).toBe(bank.questions.length);

    const fp = await api("/api/admin/questions/fingerprints", { token });
    expect(fp.body.questions.filter((q: any) => q.in_quiz)).toHaveLength(inQuiz);
    expect(typeof fp.body.questions[0].data).toBe("string");

    const ids = (await api("/api/admin/questions/ids?course=xss", { token })).body.ids as number[];
    expect(ids.length).toBe(bank.questions.filter((q) => q.course_slug === "xss").length);
    const exp = await api("/api/admin/questions/export", { method: "POST", token, json: { ids } });
    expect(exp.body.questions).toHaveLength(ids.length);
    expect(exp.body.questions.every((q: any) => q.course_slug === "xss")).toBe(true);

    // Una domanda della banca usata in un torneo: non si cancella, si disattiva.
    const t = await env.DB.prepare("INSERT INTO tournaments (title, slug, join_token) VALUES ('T', 't', 'tokentoken1') RETURNING id").first<{ id: number }>();
    await env.DB.prepare("INSERT INTO tournament_questions (tournament_id, question_id, round, sort_order) VALUES (?, ?, 1, 1)").bind(t!.id, ids[0]).run();
    const clear = await api("/api/admin/questions/clear-bank", { method: "POST", token });
    expect(clear.body).toMatchObject({ deleted: bank.questions.length - 1, deactivated: 1 });
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM questions").first<{ n: number }>();
    expect(left!.n).toBe(inQuiz + 1);
    const used = await env.DB.prepare("SELECT is_active FROM questions WHERE id = ?").bind(ids[0]).first<{ is_active: number }>();
    expect(used!.is_active).toBe(0);
  });

  it("un corso con lo stesso slug viene sostituito, la banca resta collegata", async () => {
    const token = await loggedIn();
    await importQuestions(env.DB, structuredClone(bank));
    const course = await env.DB.prepare("SELECT id FROM courses WHERE slug = 'sql-injection'").first<{ id: number }>();
    const bankBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE course_id = ? AND id NOT IN (SELECT question_id FROM quiz_questions)").bind(course!.id).first<{ n: number }>();
    const quizQuestions = await env.DB.prepare("SELECT question_id FROM quiz_questions").all<{ question_id: number }>();

    const res = await api("/api/admin/courses/import", {
      method: "POST",
      token,
      json: { version: "1.0", kind: "course", course: { slug: "sql-injection", title: "SQL Injection (nuovo)", resources: [{ title: "R", url: "https://owasp.org" }] } },
    });
    expect(res.body).toMatchObject({ id: course!.id, replaced: true });
    // Il vecchio microcorso «base» e le domande del suo quiz non ci sono più…
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM microcourses WHERE course_id = ?").bind(course!.id).first<{ n: number }>())!.n).toBe(0);
    const stillThere = await env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(quizQuestions.results.map((r) => r.question_id)))
      .first<{ n: number }>();
    expect(stillThere!.n).toBe(0);
    // …le domande della banca invece restano al loro corso.
    const bankAfter = await env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE course_id = ?").bind(course!.id).first<{ n: number }>();
    expect(bankAfter!.n).toBe(bankBefore!.n);
    expect((await api("/api/courses/sql-injection")).body.resources).toHaveLength(1);
  });
});

describe("modifica della domanda in un'unica schermata", () => {
  it("salva tipo, dati e contenuto insieme; un contenuto non valido non cambia nulla", async () => {
    const token = await loggedIn();
    const course = await env.DB.prepare("SELECT id FROM courses WHERE slug = 'sql-injection'").first<{ id: number }>();
    const created = await api("/api/admin/questions", {
      method: "POST",
      token,
      json: { qtype: "TRUE_FALSE", course_id: "", difficulty: "1", prompt: "Vero o falso?", explanation: "", is_active: true },
    });
    const id = created.body.id as number;
    const save = (json: unknown) => api(`/api/admin/questions/${id}`, { method: "PUT", token, json });
    const meta = { qtype: "MULTIPLE_CHOICE", course_id: String(course!.id), difficulty: "3", prompt: "Quale difesa?", explanation: "Perché sì.", is_active: true };

    // Tipo nuovo con il contenuto del tipo vecchio: rifiutato, la riga resta com'era.
    const bad = await save({ ...meta, data: { statement: "x", answer: true } });
    expect(bad.status).toBe(400);
    const before = await env.DB.prepare("SELECT qtype, prompt, difficulty FROM questions WHERE id = ?").bind(id).first();
    expect(before).toMatchObject({ qtype: "TRUE_FALSE", prompt: "Vero o falso?", difficulty: 1 });

    const data = { multiple: false, options: [{ id: "a", text: "Query parametrizzate" }, { id: "b", text: "Filtrare gli apici" }], correct: ["a"] };
    const ok = await save({ ...meta, data });
    expect(ok.status).toBe(200);
    const q = (await api(`/api/admin/questions/${id}`, { token })).body.question;
    expect(q).toMatchObject({ qtype: "MULTIPLE_CHOICE", course_id: course!.id, difficulty: 3, prompt: "Quale difesa?", explanation: "Perché sì." });
    expect(q.data.correct).toEqual(["a"]);

    // Errori dei campi come nei form: prompt obbligatorio.
    const missing = await save({ ...meta, prompt: "", data });
    expect(missing.status).toBe(400);
    expect(missing.body.errors.prompt).toBeTruthy();
  });
});

describe("ordine delle slide", () => {
  it("salva l'ordine trascinato e rifiuta elenchi incompleti o di altri microcorsi", async () => {
    const token = await loggedIn();
    const mc = await env.DB.prepare("SELECT id FROM microcourses LIMIT 1").first<{ id: number }>();
    const slides = (await api(`/api/admin/microcourses/${mc!.id}`, { token })).body.slides as { id: number }[];
    expect(slides.length).toBeGreaterThan(2);
    const reversed = slides.map((s) => s.id).reverse();
    const order = (json: unknown) => api(`/api/admin/microcourses/${mc!.id}/slides/order`, { method: "PUT", token, json });

    expect((await order({ ids: reversed })).status).toBe(200);
    const after = (await api(`/api/admin/microcourses/${mc!.id}`, { token })).body.slides as { id: number; order: number }[];
    expect(after.map((s) => s.id)).toEqual(reversed);
    expect(after.map((s) => s.order)).toEqual(reversed.map((_, i) => i + 1));

    expect((await order({ ids: reversed.slice(1) })).status).toBe(400);
    expect((await order({ ids: [...reversed.slice(1), reversed[1]] })).status).toBe(400);
    expect((await order({ ids: [...reversed.slice(1), 999999] })).status).toBe(400);
    expect((await api(`/api/admin/microcourses/${mc!.id}/slides/order`, { method: "PUT", json: { ids: reversed } })).status).toBe(401);
  });
});

describe("quiz: ordine per tentativo", () => {
  it("il seme mescola domande e opzioni; la correzione resta per id", async () => {
    const mc = await env.DB.prepare("SELECT id FROM microcourses LIMIT 1").first<{ id: number }>();
    const plain = (await api(`/api/quiz/${mc!.id}`)).body.questions as { id: number; options?: { id: string }[] }[];
    expect(plain.length).toBeGreaterThan(2);
    const orders = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) {
      const qs = (await api(`/api/quiz/${mc!.id}?seed=${seed}`)).body.questions as { id: number }[];
      expect([...qs.map((q) => q.id)].sort((a, b) => a - b)).toEqual([...plain.map((q) => q.id)].sort((a, b) => a - b));
      orders.add(qs.map((q) => q.id).join(","));
    }
    expect(orders.size).toBeGreaterThan(1);
    // Un seme non valido vale come assente.
    const bad = (await api(`/api/quiz/${mc!.id}?seed=-1`)).body.questions as { id: number }[];
    expect(bad.map((q) => q.id)).toEqual(plain.map((q) => q.id));
  });
});
