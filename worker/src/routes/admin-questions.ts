// Pannello: banca delle domande e quiz dei microcorsi. Porta apps/quizzes/admin_views.py.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { BundleError, exportQuestions, importQuestions, questionRow } from "../lib/content";
import { Form } from "../lib/form";
import { badRequest, intParam, notFound, readJson, str } from "../lib/http";
import { DIFFICULTIES, publicQuestion, QTYPE_LABELS, QTYPES, validateQuestionData, ValidationError } from "../lib/questions";

export const questionRoutes = new Hono<AppEnv>();

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const PAGE_SIZE = 25;

// Colonne ordinabili → espressione SQL, come sort_fields nella versione Django.
const SORTS: Record<string, string> = {
  prompt: "lower(q.prompt)",
  qtype: `lower(CASE q.qtype ${QTYPES.map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(" ")} END)`,
  course: "lower(c.title)",
  difficulty: "q.difficulty",
  language: "lower(json_extract(q.data, '$.language'))",
};

function filters(query: Record<string, string>) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (query.qtype) {
    where.push("q.qtype = ?");
    args.push(query.qtype);
  }
  if (query.course) {
    where.push("c.slug = ?");
    args.push(query.course);
  }
  if (/^\d+$/.test(query.difficulty || "")) {
    where.push("q.difficulty = ?");
    args.push(parseInt(query.difficulty, 10));
  }
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
}

questionRoutes.get("/questions", async (c) => {
  const db = c.env.DB;
  const query = c.req.query();
  const { where, args } = filters(query);
  // Object.hasOwn: «constructor» e simili non sono colonne.
  const sort = Object.hasOwn(SORTS, query.sort || "") ? query.sort : "";
  const dir = query.dir === "desc" ? "DESC" : "ASC";
  // NULLS LAST in entrambe le direzioni, come nulls_last=True nella versione Django.
  const order = sort
    ? `${SORTS[sort]} IS NULL, ${SORTS[sort]} ${dir}, q.id DESC`
    : "c.sort_order IS NULL, c.sort_order, q.course_id IS NULL, q.course_id, q.id DESC";
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM questions q LEFT JOIN courses c ON c.id = q.course_id ${where}`)
    .bind(...args)
    .first<{ n: number }>();
  const total = count?.n ?? 0;
  const numPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  let page = parseInt(query.page || "1", 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (page > numPages) page = numPages;
  const [rows, courses] = await db.batch([
    db
      .prepare(
        `SELECT q.id, q.qtype, q.prompt, q.difficulty, q.is_active, json_extract(q.data, '$.language') AS language,
                c.title AS course_title, c.slug AS course_slug
         FROM questions q LEFT JOIN courses c ON c.id = q.course_id ${where}
         ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .bind(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE),
    db.prepare("SELECT id, slug, title FROM courses ORDER BY sort_order, id"),
  ]);
  return c.json({
    questions: (rows.results as Record<string, any>[]).map((q) => ({ ...q, is_active: Boolean(q.is_active), qtype_label: QTYPE_LABELS[q.qtype] })),
    page,
    num_pages: numPages,
    count: total,
    sort,
    dir: dir.toLowerCase(),
    courses: courses.results,
    qtypes: QTYPES,
    difficulties: DIFFICULTIES,
  });
});

questionRoutes.get("/questions/export", async (c) => {
  const q = c.req.query();
  return c.json(await exportQuestions(c.env.DB, { qtype: q.qtype, course: q.course }));
});

questionRoutes.post("/questions/import", async (c) => {
  try {
    const count = await importQuestions(c.env.DB, await readJson(c));
    return c.json({ count, message: `${count} domande importate.` });
  } catch (e) {
    if (e instanceof BundleError) throw badRequest(`Import non riuscito: ${e.message}`);
    throw e;
  }
});

async function readMeta(db: D1Database, data: Record<string, unknown>) {
  const f = new Form(data);
  const qtype = f.choice("qtype", QTYPES.map(([k]) => k));
  const courseRaw = str(data.course_id).trim();
  let courseId: number | null = null;
  if (courseRaw) {
    courseId = parseInt(courseRaw, 10);
    const exists = Number.isInteger(courseId) && (await db.prepare("SELECT 1 FROM courses WHERE id = ?").bind(courseId).first());
    if (!exists) f.error("course_id", "Scegli un'opzione valida. La scelta effettuata non compare tra quelle disponibili.");
  }
  const difficulty = f.choice("difficulty", ["1", "2", "3"]);
  const prompt = f.body("prompt", { required: true });
  const explanation = f.body("explanation");
  const isActive = f.bool("is_active");
  f.check();
  return { qtype, courseId, difficulty: parseInt(difficulty, 10), prompt, explanation, isActive };
}

async function getQuestion(db: D1Database, id: number) {
  const q = await db
    .prepare("SELECT q.*, c.title AS course_title, c.slug AS course_slug FROM questions q LEFT JOIN courses c ON c.id = q.course_id WHERE q.id = ?")
    .bind(id)
    .first<Record<string, any>>();
  if (!q) throw notFound("Domanda non trovata.");
  return q;
}

const questionOut = (q: Record<string, any>) => ({
  id: q.id,
  qtype: q.qtype,
  qtype_label: QTYPE_LABELS[q.qtype],
  prompt: q.prompt,
  explanation: q.explanation,
  course_id: q.course_id,
  course_title: q.course_title ?? null,
  difficulty: q.difficulty,
  is_active: Boolean(q.is_active),
  data: JSON.parse(q.data || "{}"),
});

/** Passo 1 di 2: i dati della domanda; il contenuto si inserisce dopo. */
questionRoutes.post("/questions", async (c) => {
  const db = c.env.DB;
  const m = await readMeta(db, await readJson(c));
  const row = questionRow(m.qtype, m.prompt, m.explanation, {});
  const res = await db
    .prepare(
      `INSERT INTO questions (qtype, prompt, explanation, course_id, difficulty, data, render, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(row.qtype, row.prompt, row.explanation, m.courseId, m.difficulty, row.data, row.render, m.isActive ? 1 : 0)
    .first<{ id: number }>();
  return c.json({ id: res!.id, message: "Dati salvati. Ora inserisci il contenuto della domanda." });
});

questionRoutes.get("/questions/:id", async (c) => {
  const db = c.env.DB;
  const q = await getQuestion(db, intParam(c, "id"));
  const { results: courses } = await db.prepare("SELECT id, title FROM courses ORDER BY sort_order, id").all();
  return c.json({ question: questionOut(q), courses, qtypes: QTYPES, difficulties: DIFFICULTIES });
});

questionRoutes.put("/questions/:id/meta", async (c) => {
  const db = c.env.DB;
  const q = await getQuestion(db, intParam(c, "id"));
  const m = await readMeta(db, await readJson(c));
  // Cambiare tipo svuota il contenuto: il payload di un tipo non vale per un altro.
  const data = m.qtype === q.qtype ? JSON.parse(q.data || "{}") : {};
  const row = questionRow(m.qtype, m.prompt, m.explanation, data);
  await db
    .prepare(
      `UPDATE questions SET qtype = ?, prompt = ?, explanation = ?, course_id = ?, difficulty = ?, is_active = ?,
       data = ?, render = ?, updated_at = ${NOW} WHERE id = ?`,
    )
    .bind(row.qtype, row.prompt, row.explanation, m.courseId, m.difficulty, m.isActive ? 1 : 0, row.data, row.render, q.id)
    .run();
  return c.json({ id: q.id, message: "Dati della domanda aggiornati." });
});

/** Passo 2 di 2: il contenuto, dall'editor grafico. */
questionRoutes.put("/questions/:id/content", async (c) => {
  const db = c.env.DB;
  const q = await getQuestion(db, intParam(c, "id"));
  const body = await readJson<{ data?: unknown }>(c);
  const data = body.data ?? {};
  try {
    validateQuestionData(q.qtype, data);
  } catch (e) {
    if (e instanceof ValidationError) throw badRequest(`Contenuto non valido: ${e.message}`);
    throw e;
  }
  const row = questionRow(q.qtype, q.prompt, q.explanation, data as Record<string, unknown>);
  await db.prepare(`UPDATE questions SET data = ?, render = ?, updated_at = ${NOW} WHERE id = ?`).bind(row.data, row.render, q.id).run();
  return c.json({ id: q.id, message: "Contenuto della domanda salvato." });
});

questionRoutes.delete("/questions/:id", async (c) => {
  const db = c.env.DB;
  const q = await getQuestion(db, intParam(c, "id"));
  const used = await db.prepare("SELECT 1 FROM tournament_questions WHERE question_id = ? LIMIT 1").bind(q.id).first();
  if (used) throw badRequest("Domanda usata in un torneo: disattivala invece di eliminarla.");
  await db.prepare("DELETE FROM questions WHERE id = ?").bind(q.id).run();
  return c.json({ message: "Domanda eliminata." });
});

/** Anteprima in sola lettura con la soluzione, per il quiz builder. */
questionRoutes.get("/questions/:id/preview", async (c) => {
  const q = await getQuestion(c.env.DB, intParam(c, "id"));
  const data = JSON.parse(q.data || "{}");
  const render = JSON.parse(q.render || "{}");
  return c.json({
    question: publicQuestion(q.id, q.qtype, data, render),
    solution: data,
    explanation_html: render.explanation_html || "",
  });
});

// --- Quiz builder -----------------------------------------------------------------------

async function quizFor(db: D1Database, mcId: number) {
  const mc = await db
    .prepare("SELECT m.id, m.title, m.course_id, c.title AS course_title FROM microcourses m JOIN courses c ON c.id = m.course_id WHERE m.id = ?")
    .bind(mcId)
    .first<{ id: number; title: string; course_id: number; course_title: string }>();
  if (!mc) throw notFound("Microcorso non trovato.");
  let quiz = await db.prepare("SELECT id FROM quizzes WHERE microcourse_id = ?").bind(mc.id).first<{ id: number }>();
  if (!quiz) quiz = await db.prepare("INSERT INTO quizzes (microcourse_id) VALUES (?) RETURNING id").bind(mc.id).first();
  return { mc, quizId: quiz!.id };
}

questionRoutes.get("/microcourses/:id/quiz", async (c) => {
  const db = c.env.DB;
  const { mc, quizId } = await quizFor(db, intParam(c, "id"));
  const [items, available] = await db.batch([
    db
      .prepare(
        `SELECT qq.id, qq.sort_order, q.id AS question_id, q.qtype, q.prompt FROM quiz_questions qq
         JOIN questions q ON q.id = qq.question_id WHERE qq.quiz_id = ? ORDER BY qq.sort_order, qq.id`,
      )
      .bind(quizId),
    db
      .prepare(
        `SELECT q.id, q.qtype, q.prompt, q.difficulty, q.course_id, c.title AS course_title FROM questions q
         LEFT JOIN courses c ON c.id = q.course_id
         WHERE q.is_active = 1 AND q.id NOT IN (SELECT question_id FROM quiz_questions WHERE quiz_id = ?)
         ORDER BY q.id DESC`,
      )
      .bind(quizId),
  ]);
  return c.json({
    microcourse: { id: mc.id, title: mc.title },
    course: { id: mc.course_id, title: mc.course_title },
    items: (items.results as Record<string, any>[]).map((it) => ({ ...it, order: it.sort_order, qtype_label: QTYPE_LABELS[it.qtype] })),
    available: (available.results as Record<string, any>[]).map((q) => ({ ...q, qtype_label: QTYPE_LABELS[q.qtype] })),
  });
});

questionRoutes.post("/microcourses/:id/quiz", async (c) => {
  const db = c.env.DB;
  const { quizId } = await quizFor(db, intParam(c, "id"));
  const body = await readJson<{ question_id?: unknown }>(c);
  const qid = Number(body.question_id);
  const q = Number.isInteger(qid) && (await db.prepare("SELECT id FROM questions WHERE id = ?").bind(qid).first());
  if (!q) throw notFound("Domanda non trovata.");
  const max = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM quiz_questions WHERE quiz_id = ?").bind(quizId).first<{ m: number }>();
  const res = await db
    .prepare("INSERT OR IGNORE INTO quiz_questions (quiz_id, question_id, sort_order) VALUES (?, ?, ?)")
    .bind(quizId, qid, (max?.m ?? 0) + 1)
    .run();
  return c.json({ message: res.meta.changes ? "Domanda aggiunta al quiz." : "" });
});

async function quizItem(db: D1Database, id: number) {
  const item = await db
    .prepare("SELECT qq.id, qq.quiz_id, qq.sort_order, z.microcourse_id FROM quiz_questions qq JOIN quizzes z ON z.id = qq.quiz_id WHERE qq.id = ?")
    .bind(id)
    .first<{ id: number; quiz_id: number; sort_order: number; microcourse_id: number }>();
  if (!item) throw notFound("Elemento del quiz non trovato.");
  return item;
}

questionRoutes.delete("/quiz-items/:id", async (c) => {
  const db = c.env.DB;
  const item = await quizItem(db, intParam(c, "id"));
  await db.prepare("DELETE FROM quiz_questions WHERE id = ?").bind(item.id).run();
  return c.json({ message: "Domanda rimossa dal quiz." });
});

questionRoutes.post("/quiz-items/:id/move", async (c) => {
  const db = c.env.DB;
  const item = await quizItem(db, intParam(c, "id"));
  const body = await readJson<{ direction?: string }>(c);
  const { results: siblings } = await db
    .prepare("SELECT id, sort_order FROM quiz_questions WHERE quiz_id = ? ORDER BY sort_order, id")
    .bind(item.quiz_id)
    .all<{ id: number; sort_order: number }>();
  const idx = siblings.findIndex((s) => s.id === item.id);
  const swap = body.direction === "up" ? siblings[idx - 1] : body.direction === "down" ? siblings[idx + 1] : undefined;
  if (swap) {
    await db.batch([
      db.prepare("UPDATE quiz_questions SET sort_order = ? WHERE id = ?").bind(swap.sort_order, item.id),
      db.prepare("UPDATE quiz_questions SET sort_order = ? WHERE id = ?").bind(item.sort_order, swap.id),
    ]);
  }
  return c.json({ ok: true });
});
