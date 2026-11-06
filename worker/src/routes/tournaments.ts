// Tornei: pagine dei giocatori e controllo della gara dal pannello. Lo stato live
// sta nel Durable Object TournamentRoom (src/tournament/room.ts).
import { Hono, type Context } from "hono";
import type { AppEnv, Env } from "../env";
import { ipKey, shortToken } from "../lib/auth";
import { Form } from "../lib/form";
import { HttpError, intParam, notFound, readJson, str, uniqueSlug } from "../lib/http";
import { SUMMARY_SQL } from "../lib/questions";
import { MAX_ARCHIVE_BYTES } from "../tournament/archive";
import { planRounds } from "../tournament/mix";
import {
  AVATARS,
  DEFAULT_START_DELAY_SECONDS,
  MAX_START_DELAY_SECONDS,
  MIN_REVEAL_SECONDS,
  MIN_START_DELAY_SECONDS,
  poolCounts,
  TOURNAMENT_POOL,
  type Result,
  type Status,
  type TournamentConfig,
} from "../tournament/room";

export const playerRoutes = new Hono<AppEnv>();
export const tournamentAdminRoutes = new Hono<AppEnv>();

const room = (env: Env, token: string) => env.TOURNAMENT.get(env.TOURNAMENT.idFromName(token));

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new HttpError(r.status, r.error);
  return r.value;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{8,40}$/;

// Token già visti in D1 da questa istanza: il polling dei giocatori non rilegge
// il database a ogni richiesta.
const knownTokens = new Set<string>();

/**
 * Il token dell'URL, solo se è di un torneo esistente: un token inventato non
 * deve far nascere un Durable Object (con le sue tabelle) per ogni richiesta.
 */
async function tokenParam(c: Context<AppEnv>): Promise<string> {
  const token = c.req.param("token") ?? "";
  if (!TOKEN_RE.test(token)) throw notFound("Torneo non trovato.");
  if (!knownTokens.has(token)) {
    const row = await c.env.DB.prepare("SELECT 1 FROM tournaments WHERE join_token = ?").bind(token).first();
    if (!row) throw notFound("Torneo non trovato.");
    if (knownTokens.size > 1000) knownTokens.clear();
    knownTokens.add(token);
  }
  return token;
}

// --- Giocatori ----------------------------------------------------------------------

playerRoutes.get("/avatars", (c) => c.json({ avatars: AVATARS }));

playerRoutes.get("/:token", async (c) => {
  const token = await tokenParam(c);
  const view = await room(c.env, token).view(c.req.header("X-Participant") || null, c.req.query("v") || null);
  if (!view) throw notFound("Torneo non trovato.");
  return c.json(view);
});

playerRoutes.post("/:token/join", async (c) => {
  const token = await tokenParam(c);
  const body = await readJson<{ display_name?: unknown; avatar?: unknown; pin?: unknown }>(c);
  const network = ipKey(c.req.header("CF-Connecting-IP") || "unknown");
  const res = await room(c.env, token).join(c.req.header("X-Participant") || null, body.display_name, body.avatar, network, body.pin);
  return c.json(unwrap(res));
});

playerRoutes.post("/:token/answer", async (c) => {
  const token = await tokenParam(c);
  const body = await readJson<{ submission?: unknown }>(c);
  const res = await room(c.env, token).answer(c.req.header("X-Participant") || null, body.submission);
  return c.json(unwrap(res));
});

// --- Pannello -----------------------------------------------------------------------

interface TournamentRow {
  id: number;
  title: string;
  slug: string;
  join_token: string;
  description: string;
  pool_size: number | null;
  num_rounds: number;
  per_question_seconds: number;
  reveal_seconds: number;
  start_delay_seconds: number;
  points_correct: number;
  time_bonus: number;
  status: Status;
  participant_count: number;
}

async function getTournament(db: D1Database, id: number) {
  const t = await db.prepare("SELECT * FROM tournaments WHERE id = ?").bind(id).first<TournamentRow>();
  if (!t) throw notFound("Torneo non trovato.");
  const [courses, picks] = await db.batch([
    db
      .prepare("SELECT c.id, c.title FROM tournament_courses tc JOIN courses c ON c.id = tc.course_id WHERE tc.tournament_id = ? ORDER BY c.sort_order, c.id")
      .bind(id),
    db.prepare("SELECT question_id FROM tournament_picks WHERE tournament_id = ? ORDER BY question_id").bind(id),
  ]);
  return {
    ...t,
    courses: courses.results as { id: number; title: string }[],
    question_ids: (picks.results as { question_id: number }[]).map((r) => r.question_id),
  };
}

/** Domande per round e per tipo con cui partirebbe la gara, e cosa manca se non può. */
async function planOf(db: D1Database, t: { id: number; pool_size: number | null; num_rounds: number }) {
  const pool = await poolCounts(db, t.id);
  return planRounds(pool.counts, t.pool_size, t.num_rounds, pool.manual ? pool.total : null);
}

function configOf(t: TournamentRow, courseIds: number[]): TournamentConfig {
  return {
    id: t.id,
    token: t.join_token,
    title: t.title,
    description: t.description,
    course_ids: courseIds,
    pool_size: t.pool_size,
    num_rounds: t.num_rounds,
    per_question_seconds: t.per_question_seconds,
    reveal_seconds: Math.max(MIN_REVEAL_SECONDS, t.reveal_seconds),
    start_delay_seconds: t.start_delay_seconds ?? DEFAULT_START_DELAY_SECONDS,
    points_correct: t.points_correct,
    time_bonus: Boolean(t.time_bonus),
  };
}

const tournamentOut = (t: TournamentRow & { courses: { id: number; title: string }[]; question_ids: number[] }) => ({
  id: t.id,
  title: t.title,
  slug: t.slug,
  join_token: t.join_token,
  description: t.description,
  pool_size: t.pool_size,
  num_rounds: t.num_rounds,
  per_question_seconds: t.per_question_seconds,
  reveal_seconds: t.reveal_seconds,
  start_delay_seconds: t.start_delay_seconds,
  points_correct: t.points_correct,
  time_bonus: Boolean(t.time_bonus),
  status: t.status,
  participant_count: t.participant_count,
  courses: t.courses,
  question_ids: t.question_ids,
});

tournamentAdminRoutes.get("/tournaments", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.title, t.status, t.participant_count, t.join_token,
            (SELECT COUNT(*) FROM tournament_courses tc WHERE tc.tournament_id = t.id) AS course_count
     FROM tournaments t ORDER BY t.created_at DESC, t.id DESC`,
  ).all();
  return c.json({ tournaments: results });
});

/** Corsi tra cui scegliere nel form. */
tournamentAdminRoutes.get("/tournament-courses", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, title FROM courses ORDER BY sort_order, id").all();
  return c.json({ courses: results });
});

/** Le domande della banca che un torneo può usare, per sceglierle a mano. */
tournamentAdminRoutes.get("/tournament-questions", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT q.id, q.qtype, substr(q.prompt, 1, 200) AS prompt, substr(${SUMMARY_SQL}, 1, 200) AS summary,
            q.difficulty, q.course_id, c.title AS course_title
     FROM questions q LEFT JOIN courses c ON c.id = q.course_id
     WHERE ${TOURNAMENT_POOL} ORDER BY c.sort_order, c.id, q.qtype, q.id`,
  ).all();
  return c.json({ questions: results });
});

async function saveTournament(c: { env: Env }, data: Record<string, unknown>, existing: TournamentRow | null, userId: number) {
  const db = c.env.DB;
  const f = new Form(data);
  const title = f.text("title", { required: true, max: 200 });
  let slug = f.slug("slug");
  const description = f.text("description");
  const poolSize = f.optionalInt("pool_size", { min: 1 });
  const numRounds = f.int("num_rounds", { fallback: 1, min: 1, max: 100 });
  const perQuestion = f.int("per_question_seconds", { fallback: 60, min: 1, max: 3600 });
  const revealSeconds = f.int("reveal_seconds", { fallback: MIN_REVEAL_SECONDS, min: MIN_REVEAL_SECONDS, max: 600 });
  const startDelay = f.int("start_delay_seconds", {
    fallback: DEFAULT_START_DELAY_SECONDS,
    min: MIN_START_DELAY_SECONDS,
    max: MAX_START_DELAY_SECONDS,
  });
  const points = f.int("points_correct", { fallback: 100, min: 0, max: 100000 });
  const timeBonus = f.bool("time_bonus");
  const rawCourses = Array.isArray(data.courses) ? data.courses : [];
  const wanted = [...new Set(rawCourses.map((x) => Number(x)).filter((x) => Number.isInteger(x)))];
  let courseIds: number[] = [];
  if (wanted.length) {
    const { results } = await db
      .prepare(`SELECT id FROM courses WHERE id IN (${wanted.map(() => "?").join(",")})`)
      .bind(...wanted)
      .all<{ id: number }>();
    courseIds = results.map((r) => r.id);
    if (courseIds.length !== wanted.length) f.error("courses", "Scegli un'opzione valida.");
  }
  // Domande scelte a mano: solo quelle che un torneo può usare (attive, fuori dai quiz).
  const rawPicks = Array.isArray(data.question_ids) ? data.question_ids : [];
  const pickIds = [...new Set(rawPicks.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))];
  if (pickIds.length) {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM questions q WHERE q.id IN (SELECT value FROM json_each(?)) AND ${TOURNAMENT_POOL}`)
      .bind(JSON.stringify(pickIds))
      .first<{ n: number }>();
    if ((row?.n ?? 0) !== pickIds.length) {
      f.error("question_ids", "Alcune domande scelte non sono più utilizzabili (disattivate o finite in un quiz): ricarica la pagina.");
    }
  }
  if (slug) {
    const clash = await db.prepare("SELECT 1 FROM tournaments WHERE slug = ? AND id != ?").bind(slug, existing?.id ?? -1).first();
    if (clash) f.error("slug", "Torneo con questo Slug esiste già.");
  }
  f.check();
  if (!slug) slug = await uniqueSlug(db, "tournaments", title, existing?.id ?? null);

  let row: TournamentRow;
  if (existing) {
    row = (await db
      .prepare(
        `UPDATE tournaments SET title = ?, slug = ?, description = ?, pool_size = ?, num_rounds = ?, per_question_seconds = ?,
         reveal_seconds = ?, start_delay_seconds = ?, points_correct = ?, time_bonus = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? RETURNING *`,
      )
      .bind(title, slug, description, poolSize, numRounds, perQuestion, revealSeconds, startDelay, points, timeBonus ? 1 : 0, existing.id)
      .first<TournamentRow>())!;
  } else {
    row = (await db
      .prepare(
        `INSERT INTO tournaments (title, slug, join_token, description, pool_size, num_rounds, per_question_seconds,
         reveal_seconds, start_delay_seconds, points_correct, time_bonus, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .bind(title, slug, shortToken(), description, poolSize, numRounds, perQuestion, revealSeconds, startDelay, points, timeBonus ? 1 : 0, userId)
      .first<TournamentRow>())!;
  }
  await db.batch([
    db.prepare("DELETE FROM tournament_courses WHERE tournament_id = ?").bind(row.id),
    ...courseIds.map((cid) => db.prepare("INSERT INTO tournament_courses (tournament_id, course_id) VALUES (?, ?)").bind(row.id, cid)),
    db.prepare("DELETE FROM tournament_picks WHERE tournament_id = ?").bind(row.id),
    db
      .prepare("INSERT INTO tournament_picks (tournament_id, question_id) SELECT ?, value FROM json_each(?)")
      .bind(row.id, JSON.stringify(pickIds)),
  ]);
  await room(c.env, row.join_token).configure(configOf(row, courseIds));

  // Si avvisa subito se con queste impostazioni la gara non potrà partire.
  const plan = await planOf(db, row);
  const warnings = plan.problems.map((p) => `Attenzione, così la gara non può partire: ${p}`);
  return { id: row.id, warnings };
}

tournamentAdminRoutes.post("/tournaments", async (c) => {
  const res = await saveTournament(c, await readJson(c), null, c.get("user").id);
  return c.json({ ...res, message: "Torneo salvato." });
});

const TOO_BIG = "Il file è troppo grande (al massimo 4 MB).";

/**
 * Import del backup di un torneo (tournament/archive.ts): nasce sempre un torneo
 * nuovo, con un codice nuovo. Il Worker non legge il JSON (costa CPU, e qui ce n'è
 * poca): lo passa al Durable Object del nuovo torneo, che lo controlla e lo scrive.
 */
tournamentAdminRoutes.post("/tournaments/import", async (c) => {
  if (Number(c.req.header("Content-Length") || 0) > MAX_ARCHIVE_BYTES) throw new HttpError(413, TOO_BIG);
  const text = await c.req.text();
  if (text.length > MAX_ARCHIVE_BYTES) throw new HttpError(413, TOO_BIG);
  const token = shortToken();
  const { id, warnings } = unwrap(await room(c.env, token).restore(token, text, c.get("user").id));
  return c.json({ id, warnings, message: "Torneo importato." });
});

tournamentAdminRoutes.get("/tournaments/:id", async (c) => {
  const t = await getTournament(c.env.DB, intParam(c, "id"));
  return c.json({ tournament: tournamentOut(t) });
});

tournamentAdminRoutes.put("/tournaments/:id", async (c) => {
  const t = await getTournament(c.env.DB, intParam(c, "id"));
  const res = await saveTournament(c, await readJson(c), t, c.get("user").id);
  return c.json({ ...res, message: "Torneo salvato." });
});

tournamentAdminRoutes.delete("/tournaments/:id", async (c) => {
  const t = await getTournament(c.env.DB, intParam(c, "id"));
  await room(c.env, t.join_token).destroy();
  knownTokens.delete(t.join_token);
  await c.env.DB.prepare("DELETE FROM tournaments WHERE id = ?").bind(t.id).run();
  return c.json({ message: "Torneo eliminato." });
});

/** Il backup del torneo in JSON, così come lo scrive il Durable Object (niente JSON.parse qui). */
tournamentAdminRoutes.get("/tournaments/:id/export", async (c) => {
  const t = await getTournament(c.env.DB, intParam(c, "id"));
  const r = room(c.env, t.join_token);
  const courses = t.courses.map((x) => x.title);
  let text = await r.exportArchive(courses);
  if (text === null) {
    // Torneo creato fuori dal pannello: il DO nasce qui, come per «Gestisci».
    await r.configure(configOf(t, t.courses.map((x) => x.id)));
    text = await r.exportArchive(courses);
  }
  if (text === null) throw notFound("Torneo non trovato.");
  return c.body(text, 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
});

/** Una copia del torneo come se fosse nuovo: stesse impostazioni, in bozza, senza iscritti. */
tournamentAdminRoutes.post("/tournaments/:id/duplicate", async (c) => {
  const db = c.env.DB;
  const t = await getTournament(db, intParam(c, "id"));
  const title = `${t.title} (copia)`.slice(0, 200);
  const slug = await uniqueSlug(db, "tournaments", title);
  const row = (await db
    .prepare(
      `INSERT INTO tournaments (title, slug, join_token, description, pool_size, num_rounds, per_question_seconds,
       reveal_seconds, start_delay_seconds, points_correct, time_bonus, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      title,
      slug,
      shortToken(),
      t.description,
      t.pool_size,
      t.num_rounds,
      t.per_question_seconds,
      Math.max(MIN_REVEAL_SECONDS, t.reveal_seconds),
      t.start_delay_seconds,
      t.points_correct,
      t.time_bonus,
      c.get("user").id,
    )
    .first<TournamentRow>())!;
  // Le domande scelte a mano che nel frattempo sono state disattivate o messe in un quiz restano fuori.
  const { results: usable } = await db
    .prepare(`SELECT q.id FROM questions q WHERE q.id IN (SELECT value FROM json_each(?)) AND ${TOURNAMENT_POOL}`)
    .bind(JSON.stringify(t.question_ids))
    .all<{ id: number }>();
  const courseIds = t.courses.map((x) => x.id);
  await db.batch([
    ...courseIds.map((cid) => db.prepare("INSERT INTO tournament_courses (tournament_id, course_id) VALUES (?, ?)").bind(row.id, cid)),
    db
      .prepare("INSERT INTO tournament_picks (tournament_id, question_id) SELECT ?, value FROM json_each(?)")
      .bind(row.id, JSON.stringify(usable.map((r) => r.id))),
  ]);
  await room(c.env, row.join_token).configure(configOf(row, courseIds));

  const warnings: string[] = [];
  const dropped = t.question_ids.length - usable.length;
  if (dropped) {
    warnings.push(`${dropped} delle domande scelte non sono più utilizzabili (disattivate o finite in un quiz) e non sono state copiate.`);
  }
  const plan = await planOf(db, row);
  warnings.push(...plan.problems.map((p) => `Attenzione, così la gara non può partire: ${p}`));
  return c.json({ id: row.id, message: "Torneo duplicato: controlla titolo e impostazioni.", warnings });
});

tournamentAdminRoutes.get("/tournaments/:id/manage", async (c) => {
  const t = await getTournament(c.env.DB, intParam(c, "id"));
  let info = await room(c.env, t.join_token).manageInfo();
  if (!info) {
    // Torneo creato fuori dal pannello (per esempio con SQL diretto sul database): il DO nasce qui.
    await room(c.env, t.join_token).configure(configOf(t, t.courses.map((x) => x.id)));
    info = await room(c.env, t.join_token).manageInfo();
  }
  const fresh = await getTournament(c.env.DB, t.id);
  return c.json({ tournament: tournamentOut(fresh), plan: await planOf(c.env.DB, fresh), ...info });
});

async function control(c: Context<AppEnv>, action: (r: ReturnType<typeof room>) => Promise<Result<string>>) {
  const t = await getTournament(c.env.DB, intParam(c, "id"));
  const r = room(c.env, t.join_token);
  if (!(await r.manageInfo())) await r.configure(configOf(t, t.courses.map((x) => x.id)));
  return { t, message: unwrap(await action(r)) };
}

tournamentAdminRoutes.post("/tournaments/:id/status", async (c) => {
  const body = await readJson<{ status?: string }>(c);
  const status = str(body.status) as Status;
  const { message } = await control(c, (r) => r.setStatus(status));
  return c.json({ message });
});

tournamentAdminRoutes.post("/tournaments/:id/start", async (c) => {
  const db = c.env.DB;
  const t = await getTournament(db, intParam(c, "id"));
  // Il mix dei tipi è un requisito: se il pool non lo compone per tutti i round
  // (che non ripetono domande), la gara non parte.
  const plan = await planOf(db, t);
  if (plan.problems.length) throw new HttpError(400, plan.problems.join(" "));
  // La gara parte con la configurazione di D1 (anche quella aggiornata dalle migrazioni).
  await room(c.env, t.join_token).configure(configOf(t, t.courses.map((x) => x.id)));
  const { message } = await control(c, (r) => r.start(plan.counts));
  return c.json({ message, warnings: [] });
});

tournamentAdminRoutes.post("/tournaments/:id/next-round", async (c) => {
  const { message } = await control(c, (r) => r.startNextRound());
  return c.json({ message });
});

tournamentAdminRoutes.post("/tournaments/:id/next", async (c) => {
  const { message } = await control(c, (r) => r.next());
  return c.json({ message });
});

/** Un PIN di iscrizione nuovo, se quello vecchio è girato dove non doveva. */
tournamentAdminRoutes.post("/tournaments/:id/pin", async (c) => {
  const t = await getTournament(c.env.DB, intParam(c, "id"));
  const r = room(c.env, t.join_token);
  if (!(await r.manageInfo())) await r.configure(configOf(t, t.courses.map((x) => x.id)));
  const pin = unwrap(await r.newPin());
  return c.json({ pin, message: "Nuovo PIN pronto: chi non è ancora entrato deve usare questo." });
});

tournamentAdminRoutes.post("/tournaments/:id/participants/:pid/remove", async (c) => {
  const pid = intParam(c, "pid");
  const { message } = await control(c, (r) => r.removeParticipant(pid));
  return c.json({ message });
});

tournamentAdminRoutes.post("/tournaments/:id/finish", async (c) => {
  const { message } = await control(c, (r) => r.finishNow());
  return c.json({ message });
});

tournamentAdminRoutes.get("/tournaments/:id/monitor", async (c) => {
  const t = await getTournament(c.env.DB, intParam(c, "id"));
  const m = await room(c.env, t.join_token).monitor();
  if (!m) throw notFound("Torneo non trovato.");
  return c.json(m);
});

tournamentAdminRoutes.get("/tournaments/:id/report", async (c) => {
  const t = await getTournament(c.env.DB, intParam(c, "id"));
  const report = await room(c.env, t.join_token).report();
  if (!report) throw notFound("Torneo non trovato.");
  return c.json({ tournament: tournamentOut(t), ...report });
});
