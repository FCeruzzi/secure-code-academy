import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import sqliBase from "./fixtures/sqli_base.json";
import bank from "./fixtures/bank.json";
import xssBase from "./fixtures/xss_base.json";
import { hashPassword } from "../src/lib/auth";
import { importBundle, importQuestions } from "../src/lib/content";

const BASE = "https://api.test";
const ORIGIN = "https://example.github.io";

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

async function createAdmin(username = "alice", password = "Temporanea!2026", mustChange = true, tempExpiresAt = Date.now() + 3600_000) {
  await env.DB.prepare("INSERT INTO admin_users (username, password_hash, must_change_password, temp_expires_at) VALUES (?, ?, ?, ?)")
    .bind(username, await hashPassword(password, 1000), mustChange ? 1 : 0, mustChange ? tempExpiresAt : null)
    .run();
}

const login = (username: string, password: string, ip = "10.0.0.1") =>
  api("/api/admin/login", { method: "POST", json: { username, password }, headers: { "CF-Connecting-IP": ip } });

async function loggedIn(username = "alice"): Promise<string> {
  await createAdmin(username, "Una-Password-Lunga-42", false);
  const res = await api("/api/admin/login", { method: "POST", json: { username, password: "Una-Password-Lunga-42" } });
  expect(res.status).toBe(200);
  return res.body.token;
}

const TABLES = [
  "tournament_questions", "tournament_courses", "tournaments", "quiz_questions", "quizzes", "questions",
  "slide_images", "slides", "presentations", "resources", "microcourses", "courses",
  "admin_sessions", "login_attempts", "admin_audit", "admin_users",
];

beforeEach(async () => {
  // Lo storage è condiviso tra i test: si riparte ogni volta da un database vuoto.
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await importBundle(env.DB, structuredClone(sqliBase));
});

describe("API pubblica", () => {
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
      const r = await login("alice", "sbagliata", "1.2.3.4");
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("Username o password non corretti.");
    }
    expect((await login("alice", "Temporanea!2026", "1.2.3.4")).status).toBe(429);
    // Lo stesso /64 IPv6 conta come un solo indirizzo.
    for (let i = 0; i < 5; i++) await login("nessuno" + i, "x", `2001:db8:1:2::${i + 1}`);
    expect((await login("nessuno9", "x", "2001:db8:1:2:ffff::9")).status).toBe(429);
  });

  it("blocco per account, anche cambiando IP", async () => {
    await createAdmin();
    for (let i = 0; i < 5; i++) await login("alice", "sbagliata", `198.51.100.${i + 1}`);
    expect((await login("alice", "Temporanea!2026", "203.0.113.7")).status).toBe(429);
    // Un altro account dallo stesso IP no.
    await createAdmin("bruno");
    expect((await login("bruno", "Temporanea!2026", "203.0.113.7")).status).toBe(200);
  });

  it("tentativi in parallelo: oltre il limite nessuno arriva alla verifica", async () => {
    await createAdmin();
    const results = await Promise.all(Array.from({ length: 20 }, () => login("alice", "sbagliata", "192.0.2.1")));
    expect(results.filter((r) => r.status === 400)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(15);
  });

  it("username fuori dall'elenco autorizzato", async () => {
    await createAdmin("intruso");
    const r = await login("intruso", "Temporanea!2026");
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("non è fra gli amministratori autorizzati");
  });

  it("account inesistente o disattivato: stessa risposta", async () => {
    await createAdmin("carla", "Una-Password-Lunga-42", false);
    await env.DB.prepare("UPDATE admin_users SET is_active = 0 WHERE username = 'carla'").run();
    expect((await login("carla", "Una-Password-Lunga-42")).body.error).toBe("Username o password non corretti.");
    expect((await login("fantasma", "Una-Password-Lunga-42", "10.0.0.2")).body.error).toBe("Username o password non corretti.");
  });

  it("password temporanea scaduta", async () => {
    await createAdmin("alice", "Temporanea!2026", true, Date.now() - 1000);
    const r = await login("alice", "Temporanea!2026");
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("scaduta");
  });

  it("primo accesso obbligato, poi pannello", async () => {
    await createAdmin();
    const first = await login("alice", "Temporanea!2026");
    const token = first.body.token;
    expect(first.body.user.must_change_password).toBe(true);
    const blocked = await api("/api/admin/courses", { token });
    expect(blocked.status).toBe(403);
    expect(blocked.body.setup_required).toBe(true);

    const weak = await api("/api/admin/setup", { method: "POST", token, json: { email: "f@example.it", new_password1: "123", new_password2: "123" } });
    expect(weak.status).toBe(400);
    expect(weak.body.errors.new_password1.join(" ")).toContain("troppo corta");
    const same = await api("/api/admin/setup", { method: "POST", token, json: { email: "f@example.it", new_password1: "Temporanea!2026", new_password2: "Temporanea!2026" } });
    expect(same.body.errors.new_password1).toContain("Scegli una password diversa da quella temporanea.");

    const ok = await api("/api/admin/setup", { method: "POST", token, json: { email: "f@example.it", new_password1: "Nuova-Password-77", new_password2: "Nuova-Password-77" } });
    expect(ok.status).toBe(200);
    expect((await api("/api/admin/courses", { token })).status).toBe(200);
    const row = await env.DB.prepare("SELECT temp_expires_at FROM admin_users WHERE username = 'alice'").first<{ temp_expires_at: number | null }>();
    expect(row!.temp_expires_at).toBeNull();

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
    const confirm = { confirm_password: "Una-Password-Lunga-42" };

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
    // L'email degli altri non si cambia.
    expect((await api(`/api/admin/admins/${bruno.id}`, { method: "PUT", token, json: { email: "x@example.it" } })).status).toBe(403);
    expect((await api(`/api/admin/admins/${me}`, { method: "PUT", token, json: { email: "alice@example.it" } })).status).toBe(200);

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
    for (const a of ["admin_created", "password_reset", "admin_disabled", "email_changed", "login", "login_failed"]) expect(actions).toContain(a);
    expect(JSON.stringify(log.body)).not.toContain(temp);
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

    const mc = await env.DB.prepare("SELECT id FROM microcourses WHERE slug = 'base'").first<{ id: number }>();
    const before = (await api(`/api/admin/microcourses/${mc!.id}/quiz`, { token })).body.items.length;
    await api(`/api/admin/microcourses/${mc!.id}/quiz`, { method: "POST", token, json: { question_id: q.body.id } });
    const items = (await api(`/api/admin/microcourses/${mc!.id}/quiz`, { token })).body.items;
    expect(items).toHaveLength(before + 1);
    const last = items[items.length - 1];
    await api(`/api/admin/quiz-items/${last.id}/move`, { method: "POST", token, json: { direction: "up" } });
    const moved = (await api(`/api/admin/microcourses/${mc!.id}/quiz`, { token })).body.items;
    expect(moved[moved.length - 2].question_id).toBe(q.body.id);
  });
});

describe("tornei", () => {
  async function setupTournament(token: string, extra: Record<string, unknown> = {}) {
    await importBundle(env.DB, structuredClone(xssBase));
    await importQuestions(env.DB, structuredClone(bank));
    const { results } = await env.DB.prepare("SELECT id FROM courses").all<{ id: number }>();
    const t = await api("/api/admin/tournaments", {
      method: "POST",
      token,
      json: { title: "Gara", courses: results.map((r) => r.id), pool_size: 2, num_rounds: 2, per_question_seconds: 60, points_correct: 100, time_bonus: false, ...extra },
    });
    expect(t.status).toBe(200);
    const manage = await api(`/api/admin/tournaments/${t.body.id}/manage`, { token });
    return { id: t.body.id as number, token: manage.body.tournament.join_token as string };
  }

  async function correctSubmission(card: any) {
    const q = card.question;
    const row = await env.DB.prepare("SELECT data FROM questions WHERE id = ?").bind(q.id).first<{ data: string }>();
    const data = JSON.parse(row!.data);
    if (q.qtype === "TRUE_FALSE") return { answer: data.answer };
    if (q.qtype === "MULTIPLE_CHOICE") return { selected: data.correct };
    if (q.qtype === "FIND_WRONG_LINE") return { lines: data.correct_lines };
    return { choice: data.correct };
  }

  it("iscrizione, gara, punteggi, round e report", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin);

    expect((await api(`/api/t/${t.token}/join`, { method: "POST", json: { display_name: "Ada", avatar: "owl" } })).status).toBe(409);
    await api(`/api/admin/tournaments/${t.id}/status`, { method: "POST", token: admin, json: { status: "OPEN" } });
    expect((await api("/api/home")).body.open_tournament).toMatchObject({ title: "Gara", join_token: t.token });

    expect((await api(`/api/t/${t.token}/join`, { method: "POST", json: { display_name: "  ", avatar: "owl" } })).status).toBe(400);
    expect((await api(`/api/t/${t.token}/join`, { method: "POST", json: { display_name: "Ada", avatar: "pony" } })).status).toBe(400);
    const ada = (await api(`/api/t/${t.token}/join`, { method: "POST", json: { display_name: "<Ada>", avatar: "owl" } })).body.participant_token;
    const bob = (await api(`/api/t/${t.token}/join`, { method: "POST", json: { display_name: "Bob", avatar: "cat" } })).body.participant_token;
    // Rientrare con lo stesso token non crea un secondo iscritto.
    expect((await api(`/api/t/${t.token}/join`, { method: "POST", participant: ada, json: {} })).body.participant_token).toBe(ada);
    let view = await api(`/api/t/${t.token}`, { participant: ada });
    expect(view.body.me.display_name).toBe("Ada");
    expect(view.body.participants).toHaveLength(2);

    const start = await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin });
    expect(start.status).toBe(200);
    expect((await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin })).status).toBe(400);
    expect((await api(`/api/t/${t.token}/join`, { method: "POST", json: { display_name: "Tardi", avatar: "owl" } })).status).toBe(409);

    view = await api(`/api/t/${t.token}`, { participant: ada });
    const card = view.body.card;
    expect(card).toMatchObject({ run_phase: "QUESTION", index: 1, total: 2, current_round: 1 });
    // Mai una domanda dei quiz pubblici, che ne mostrano la soluzione.
    const inQuiz = await env.DB.prepare("SELECT 1 FROM quiz_questions WHERE question_id = ?").bind(card.question.id).first();
    expect(inQuiz).toBeNull();
    expect(JSON.stringify(card)).not.toMatch(/"correct"|correct_lines|explanation/);
    // Stessa chiave: niente domanda nella risposta.
    const same = await api(`/api/t/${t.token}?v=${encodeURIComponent(card.view_key)}`, { participant: ada });
    expect(same.body.card.unchanged).toBe(true);
    expect(same.body.card.question).toBeUndefined();

    expect((await api(`/api/t/${t.token}/answer`, { method: "POST", json: { submission: {} } })).status).toBe(403);
    const good = await correctSubmission(card);
    expect((await api(`/api/t/${t.token}/answer`, { method: "POST", participant: ada, json: { submission: good } })).body.accepted).toBe(true);
    view = await api(`/api/t/${t.token}`, { participant: ada });
    expect(view.body.card.answered).toBe(1);
    expect(view.body.card.my_submission).toEqual(expect.any(Object));

    // L'admin forza il reveal: Ada prende 100 punti, Bob va in timeout.
    await api(`/api/admin/tournaments/${t.id}/next`, { method: "POST", token: admin });
    view = await api(`/api/t/${t.token}`, { participant: ada });
    expect(view.body.card.run_phase).toBe("REVEAL");
    expect(view.body.card.reveal).toMatchObject({ correct: true, points: 100, timed_out: false });
    const bobView = await api(`/api/t/${t.token}`, { participant: bob });
    expect(bobView.body.card.reveal).toMatchObject({ correct: false, points: 0, timed_out: true });
    expect(view.body.participants[0]).toMatchObject({ display_name: "Ada", score: 100 });
    // Le risposte tardive non contano.
    expect((await api(`/api/t/${t.token}/answer`, { method: "POST", participant: bob, json: { submission: good } })).body.accepted).toBe(false);

    // Seconda domanda, poi fine round → intervallo.
    await api(`/api/admin/tournaments/${t.id}/next`, { method: "POST", token: admin });
    await api(`/api/admin/tournaments/${t.id}/next`, { method: "POST", token: admin });
    await api(`/api/admin/tournaments/${t.id}/next`, { method: "POST", token: admin });
    const monitor = await api(`/api/admin/tournaments/${t.id}/monitor`, { token: admin });
    expect(monitor.body).toMatchObject({ run_phase: "INTERMISSION", current_round: 1, num_rounds: 2 });

    await api(`/api/admin/tournaments/${t.id}/next-round`, { method: "POST", token: admin });
    view = await api(`/api/t/${t.token}`, { participant: ada });
    expect(view.body.card).toMatchObject({ run_phase: "QUESTION", current_round: 2, index: 1 });
    expect(view.body.card.view_key).toBe("q-2-0");

    const finish = await api(`/api/admin/tournaments/${t.id}/finish`, { method: "POST", token: admin });
    expect(finish.status).toBe(200);
    view = await api(`/api/t/${t.token}`, { participant: ada });
    expect(view.body.status).toBe("CLOSED");
    expect(view.body.participants.every((p: any) => p.finished)).toBe(true);
    expect((await api(`/api/t/${t.token}/join`, { method: "POST", json: { display_name: "X", avatar: "owl" } })).status).toBe(403);

    const report = await api(`/api/admin/tournaments/${t.id}/report`, { token: admin });
    expect(report.body.total_answers).toBe(6);
    expect(report.body.total_correct).toBe(1);
    expect(report.body.part_rows[0].p.display_name).toBe("Ada");
    expect(report.body.part_rows[0].answers[0]).toMatchObject({ correct: true, points: 100 });

    // Le domande usate in un torneo non si eliminano.
    const used = await env.DB.prepare("SELECT question_id FROM tournament_questions LIMIT 1").first<{ question_id: number }>();
    expect((await api(`/api/admin/questions/${used!.question_id}`, { method: "DELETE", token: admin })).status).toBe(400);

    // Torna in bozza: iscritti e domande azzerati.
    await api(`/api/admin/tournaments/${t.id}/status`, { method: "POST", token: admin, json: { status: "DRAFT" } });
    const manage = await api(`/api/admin/tournaments/${t.id}/manage`, { token: admin });
    expect(manage.body).toMatchObject({ status: "DRAFT", participants: [], items: [] });
    expect((await api(`/api/admin/questions/${used!.question_id}`, { method: "DELETE", token: admin })).status).toBe(200);
  });

  it("bonus velocità e scadenza con la sveglia del Durable Object", async () => {
    const admin = await loggedIn();
    const t = await setupTournament(admin, { per_question_seconds: 1, reveal_seconds: 0, num_rounds: 1, pool_size: 1, time_bonus: true });
    await api(`/api/admin/tournaments/${t.id}/status`, { method: "POST", token: admin, json: { status: "OPEN" } });
    const ada = (await api(`/api/t/${t.token}/join`, { method: "POST", json: { display_name: "Ada", avatar: "owl" } })).body.participant_token;
    await api(`/api/admin/tournaments/${t.id}/start`, { method: "POST", token: admin });
    const card = (await api(`/api/t/${t.token}`, { participant: ada })).body.card;
    await api(`/api/t/${t.token}/answer`, { method: "POST", participant: ada, json: { submission: await correctSubmission(card) } });

    // Nessuna richiesta al torneo: a farlo avanzare sono solo le sveglie (scadenza
    // della domanda, poi reveal di 0 secondi), che aggiornano anche lo specchio in D1.
    await new Promise((r) => setTimeout(r, 1500));
    await runDurableObjectAlarm(env.TOURNAMENT.get(env.TOURNAMENT.idFromName(t.token)));
    const mirrored = await env.DB.prepare("SELECT status, participant_count FROM tournaments WHERE id = ?").bind(t.id).first();
    expect(mirrored).toMatchObject({ status: "CLOSED", participant_count: 1 });
    const view = await api(`/api/t/${t.token}`, { participant: ada });
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
    await api(`/api/admin/tournaments/${t.id}/status`, { method: "POST", token: admin, json: { status: "OPEN" } });
    const join = (i: number, ip: string) =>
      api(`/api/t/${t.token}/join`, { method: "POST", json: { display_name: `P${i}`, avatar: "owl" }, headers: { "CF-Connecting-IP": ip } });
    for (let i = 0; i < 40; i++) expect((await join(i, "203.0.113.5")).status).toBe(200);
    expect((await join(41, "203.0.113.5")).status).toBe(429);
    expect((await join(42, "203.0.113.6")).status).toBe(200);
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
