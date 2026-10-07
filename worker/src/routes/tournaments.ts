// Tornei: pagine dei giocatori e controllo della gara dal pannello.
// Porta apps/tournaments/views.py e admin_views.py; lo stato live sta nel
// Durable Object TournamentRoom (src/tournament/room.ts).
import { Hono, type Context } from "hono";
import type { AppEnv, Env } from "../env";
import { ipKey, shortToken } from "../lib/auth";
import { Form } from "../lib/form";
import { HttpError, intParam, notFound, readJson, str, uniqueSlug } from "../lib/http";
import { AVATARS, TOURNAMENT_POOL, type Result, type Status, type TournamentConfig } from "../tournament/room";

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
  const body = await readJson<{ display_name?: unknown; avatar?: unknown }>(c);
  const network = ipKey(c.req.header("CF-Connecting-IP") || "unknown");
  const res = await room(c.env, token).join(c.req.header("X-Participant") || null, body.display_name, body.avatar, network);
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
  points_correct: number;
  time_bonus: number;
  status: Status;
  participant_count: number;
}

async function getTournament(db: D1Database, id: number) {
  const t = await db.prepare("SELECT * FROM tournaments WHERE id = ?").bind(id).first<TournamentRow>();
  if (!t) throw notFound("Torneo non trovato.");
  const { results } = await db
    .prepare("SELECT c.id, c.title FROM tournament_courses tc JOIN courses c ON c.id = tc.course_id WHERE tc.tournament_id = ? ORDER BY c.sort_order, c.id")
    .bind(id)
    .all<{ id: number; title: string }>();
  return { ...t, courses: results };
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
    reveal_seconds: t.reveal_seconds,
    points_correct: t.points_correct,
    time_bonus: Boolean(t.time_bonus),
  };
}

const tournamentOut = (t: TournamentRow & { courses: { id: number; title: string }[] }) => ({
  id: t.id,
  title: t.title,
  slug: t.slug,
  join_token: t.join_token,
  description: t.description,
  pool_size: t.pool_size,
  num_rounds: t.num_rounds,
  per_question_seconds: t.per_question_seconds,
  reveal_seconds: t.reveal_seconds,
  points_correct: t.points_correct,
  time_bonus: Boolean(t.time_bonus),
  status: t.status,
  participant_count: t.participant_count,
  courses: t.courses,
});

async function distinctPoolCount(db: D1Database, courseIds: number[]): Promise<number> {
  if (!courseIds.length) return 0;
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM questions q WHERE ${TOURNAMENT_POOL} AND q.course_id IN (${courseIds.map(() => "?").join(",")})`)
    .bind(...courseIds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

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

async function saveTournament(c: { env: Env }, data: Record<string, unknown>, existing: TournamentRow | null, userId: number) {
  const db = c.env.DB;
  const f = new Form(data);
  const title = f.text("title", { required: true, max: 200 });
  let slug = f.slug("slug");
  const description = f.text("description");
  const poolSize = f.optionalInt("pool_size", { min: 1 });
  const numRounds = f.int("num_rounds", { fallback: 1, min: 1, max: 100 });
  const perQuestion = f.int("per_question_seconds", { fallback: 60, min: 1, max: 3600 });
  const revealSeconds = f.int("reveal_seconds", { fallback: 5, min: 0, max: 600 });
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
         reveal_seconds = ?, points_correct = ?, time_bonus = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? RETURNING *`,
      )
      .bind(title, slug, description, poolSize, numRounds, perQuestion, revealSeconds, points, timeBonus ? 1 : 0, existing.id)
      .first<TournamentRow>())!;
  } else {
    row = (await db
      .prepare(
        `INSERT INTO tournaments (title, slug, join_token, description, pool_size, num_rounds, per_question_seconds,
         reveal_seconds, points_correct, time_bonus, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .bind(title, slug, shortToken(), description, poolSize, numRounds, perQuestion, revealSeconds, points, timeBonus ? 1 : 0, userId)
      .first<TournamentRow>())!;
  }
  await db.batch([
    db.prepare("DELETE FROM tournament_courses WHERE tournament_id = ?").bind(row.id),
    ...courseIds.map((cid) => db.prepare("INSERT INTO tournament_courses (tournament_id, course_id) VALUES (?, ?)").bind(row.id, cid)),
  ]);
  await room(c.env, row.join_token).configure(configOf(row, courseIds));

  const warnings: string[] = [];
  if (poolSize && numRounds > 1) {
    const needed = poolSize * numRounds;
    const available = await distinctPoolCount(db, courseIds);
    if (available < needed) {
      warnings.push(
        `Attenzione: gli argomenti selezionati hanno ${available} domande distinte, ma ne servono ${needed} per ${numRounds} round ` +
          `da ${poolSize} senza ripetizioni: gli ultimi round avranno meno domande.`,
      );
    }
  }
  return { id: row.id, warnings };
}

tournamentAdminRoutes.post("/tournaments", async (c) => {
  const res = await saveTournament(c, await readJson(c), null, c.get("user").id);
  return c.json({ ...res, message: "Torneo salvato." });
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

tournamentAdminRoutes.get("/tournaments/:id/manage", async (c) => {
  const t = await getTournament(c.env.DB, intParam(c, "id"));
  let info = await room(c.env, t.join_token).manageInfo();
  if (!info) {
    // Torneo creato fuori dal pannello (per esempio con SQL diretto sul database): il DO nasce qui.
    await room(c.env, t.join_token).configure(configOf(t, t.courses.map((x) => x.id)));
    info = await room(c.env, t.join_token).manageInfo();
  }
  const fresh = await getTournament(c.env.DB, t.id);
  return c.json({ tournament: tournamentOut(fresh), ...info });
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
  const courseIds = t.courses.map((x) => x.id);
  const available = await distinctPoolCount(db, courseIds);
  if (!available) {
    throw new HttpError(400, "Serve almeno un argomento con domande attive della banca (fuori dai quiz dei microcorsi) prima di avviare.");
  }
  const warnings: string[] = [];
  if (t.num_rounds > 1) {
    // I round non ripetono le domande: avvisa se il pool non basta per tutti.
    const needed = (t.pool_size || available) * t.num_rounds;
    if (available < needed) {
      warnings.push(
        `Attenzione: gli argomenti offrono ${available} domande distinte, non abbastanza per ${t.num_rounds} round senza ` +
          "ripetizioni: gli ultimi round avranno meno domande. Aggiungi domande o riduci round/pool.",
      );
    }
  }
  const { message } = await control(c, (r) => r.start());
  return c.json({ message, warnings });
});

tournamentAdminRoutes.post("/tournaments/:id/next-round", async (c) => {
  const { message } = await control(c, (r) => r.startNextRound());
  return c.json({ message });
});

tournamentAdminRoutes.post("/tournaments/:id/next", async (c) => {
  const { message } = await control(c, (r) => r.next());
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
