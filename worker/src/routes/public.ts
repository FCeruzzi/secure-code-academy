// API pubbliche: catalogo, slide, presentazioni e quiz dei microcorsi.
// Porta apps/core/views.py, apps/catalog/views.py e apps/quizzes/views.py.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { HttpError, intParam, notFound, readJson } from "../lib/http";
import { grade, parseSubmission, publicQuestion, type RenderedQuestion } from "../lib/questions";

export const publicRoutes = new Hono<AppEnv>();

interface CourseRow {
  id: number;
  slug: string;
  title: string;
  description: string;
  icon: string;
  lab_url: string;
}

const publicCourse = (c: CourseRow) => ({
  slug: c.slug,
  title: c.title,
  description: c.description,
  icon: c.icon,
  lab_url: c.lab_url,
});

publicRoutes.get("/home", async (c) => {
  const db = c.env.DB;
  const [courses, open] = await db.batch([
    db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM microcourses m WHERE m.course_id = c.id AND m.is_published = 1) AS mc_count
       FROM courses c WHERE c.is_published = 1 ORDER BY c.sort_order, c.id`,
    ),
    // Un solo torneo con le iscrizioni aperte, in evidenza come banner.
    db.prepare("SELECT title, join_token FROM tournaments WHERE status = 'OPEN' ORDER BY created_at DESC, id DESC LIMIT 1"),
  ]);
  return c.json({
    courses: (courses.results as (CourseRow & { mc_count: number })[]).map((r) => ({ ...publicCourse(r), mc_count: r.mc_count })),
    open_tournament: open.results[0] ?? null,
  });
});

publicRoutes.get("/courses", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM courses WHERE is_published = 1 ORDER BY sort_order, id").all<CourseRow>();
  return c.json({ courses: results.map(publicCourse) });
});

async function publishedCourse(db: D1Database, slug: string): Promise<CourseRow> {
  const course = await db.prepare("SELECT * FROM courses WHERE slug = ? AND is_published = 1").bind(slug).first<CourseRow>();
  if (!course) throw notFound("Corso non trovato.");
  return course;
}

publicRoutes.get("/courses/:slug", async (c) => {
  const db = c.env.DB;
  const course = await publishedCourse(db, c.req.param("slug"));
  const [mcs, pres, res] = await db.batch([
    // `entry` dice dove porta il microcorso, come il redirect di
    // microcourse_detail: alla prima slide, al quiz se non ha slide, altrimenti
    // di nuovo al corso.
    db
      .prepare(
        `SELECT m.id, m.slug, m.title, m.summary, m.estimated_minutes, m.difficulty,
          CASE
            WHEN EXISTS (SELECT 1 FROM slides s WHERE s.microcourse_id = m.id) THEN 'slide'
            WHEN EXISTS (SELECT 1 FROM quizzes q JOIN quiz_questions qq ON qq.quiz_id = q.id WHERE q.microcourse_id = m.id) THEN 'quiz'
            ELSE 'course'
          END AS entry
         FROM microcourses m WHERE m.course_id = ? AND m.is_published = 1 ORDER BY m.sort_order, m.id`,
      )
      .bind(course.id),
    db.prepare("SELECT id, title, page_count FROM presentations WHERE course_id = ? ORDER BY sort_order, id").bind(course.id),
    db.prepare("SELECT title, url FROM resources WHERE course_id = ? ORDER BY sort_order, id").bind(course.id),
  ]);
  return c.json({
    course: publicCourse(course),
    microcourses: mcs.results,
    presentations: pres.results,
    resources: res.results,
  });
});

publicRoutes.get("/courses/:slug/presentations/:id", async (c) => {
  const db = c.env.DB;
  const course = await publishedCourse(db, c.req.param("slug"));
  const p = await db
    .prepare("SELECT id, title, url, page_count FROM presentations WHERE id = ? AND course_id = ?")
    .bind(intParam(c, "id"), course.id)
    .first();
  if (!p) throw notFound("Presentazione non trovata.");
  return c.json({ course: publicCourse(course), presentation: p });
});

async function publishedMicrocourse(db: D1Database, courseSlug: string, mcSlug: string) {
  const mc = await db
    .prepare(
      `SELECT m.id, m.slug, m.title, c.slug AS course_slug, c.title AS course_title
       FROM microcourses m JOIN courses c ON c.id = m.course_id
       WHERE c.slug = ? AND m.slug = ? AND m.is_published = 1 AND c.is_published = 1`,
    )
    .bind(courseSlug, mcSlug)
    .first<{ id: number; slug: string; title: string; course_slug: string; course_title: string }>();
  if (!mc) throw notFound("Microcorso non disponibile.");
  return mc;
}

/** Dove porta un microcorso: come il redirect di microcourse_detail nella versione Django. */
publicRoutes.get("/courses/:slug/:mc", async (c) => {
  const db = c.env.DB;
  const mc = await publishedMicrocourse(db, c.req.param("slug"), c.req.param("mc"));
  const row = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM slides WHERE microcourse_id = ?1) AS has_slides,
              EXISTS (SELECT 1 FROM quizzes q JOIN quiz_questions qq ON qq.quiz_id = q.id WHERE q.microcourse_id = ?1) AS has_quiz`,
    )
    .bind(mc.id)
    .first<{ has_slides: number; has_quiz: number }>();
  const entry = row?.has_slides ? "slide" : row?.has_quiz ? "quiz" : "course";
  return c.json({ course: { slug: mc.course_slug, title: mc.course_title }, mc: { id: mc.id, slug: mc.slug, title: mc.title }, entry });
});

publicRoutes.get("/courses/:slug/:mc/slides/:n", async (c) => {
  const db = c.env.DB;
  const mc = await publishedMicrocourse(db, c.req.param("slug"), c.req.param("mc"));
  const position = intParam(c, "n");
  const [slides, quiz] = await db.batch([
    db.prepare("SELECT title, section, body_html FROM slides WHERE microcourse_id = ? ORDER BY sort_order, id").bind(mc.id),
    db
      .prepare("SELECT COUNT(*) AS n FROM quizzes q JOIN quiz_questions qq ON qq.quiz_id = q.id WHERE q.microcourse_id = ?")
      .bind(mc.id),
  ]);
  const list = slides.results as { title: string; section: string; body_html: string }[];
  if (position < 1 || position > list.length) throw notFound("Slide non trovata.");
  return c.json({
    course: { slug: mc.course_slug, title: mc.course_title },
    mc: { id: mc.id, slug: mc.slug, title: mc.title },
    slide: list[position - 1],
    position,
    total: list.length,
    has_quiz: ((quiz.results[0] as { n: number }).n || 0) > 0,
  });
});

// --- Quiz dei microcorsi ---------------------------------------------------------

interface QuestionRow {
  id: number;
  qtype: string;
  data: string;
  render: string;
}

async function quizOf(db: D1Database, mcId: number) {
  const mc = await db
    .prepare(
      `SELECT m.id, m.slug, m.title, c.slug AS course_slug, c.title AS course_title
       FROM microcourses m JOIN courses c ON c.id = m.course_id
       WHERE m.id = ? AND m.is_published = 1 AND c.is_published = 1`,
    )
    .bind(mcId)
    .first<{ id: number; slug: string; title: string; course_slug: string; course_title: string }>();
  if (!mc) throw notFound("Microcorso non disponibile.");
  const { results } = await db
    .prepare(
      `SELECT q.id, q.qtype, q.data, q.render FROM quizzes z
       JOIN quiz_questions qq ON qq.quiz_id = z.id JOIN questions q ON q.id = qq.question_id
       WHERE z.microcourse_id = ? ORDER BY qq.sort_order, qq.id`,
    )
    .bind(mcId)
    .all<QuestionRow>();
  return { mc, questions: results };
}

publicRoutes.get("/quiz/:mcId", async (c) => {
  const { mc, questions } = await quizOf(c.env.DB, intParam(c, "mcId"));
  if (!questions.length) throw notFound("Nessun quiz disponibile per questo microcorso.");
  return c.json({
    mc: { id: mc.id, slug: mc.slug, title: mc.title },
    course: { slug: mc.course_slug, title: mc.course_title },
    // Le domande arrivano senza soluzione e senza spiegazione: la correzione è
    // sul server, come nella versione Django.
    questions: questions.map((q) => publicQuestion(q.id, q.qtype, JSON.parse(q.data), JSON.parse(q.render))),
  });
});

publicRoutes.post("/quiz/:mcId/answer", async (c) => {
  const { questions } = await quizOf(c.env.DB, intParam(c, "mcId"));
  const body = await readJson<{ question_id?: unknown; submission?: unknown }>(c);
  const q = questions.find((x) => x.id === Number(body.question_id));
  if (!q) throw new HttpError(404, "Domanda non trovata.");
  const submitted = parseSubmission(q.qtype, body.submission);
  const result = grade(q.qtype, JSON.parse(q.data), submitted);
  const render = JSON.parse(q.render) as RenderedQuestion;
  return c.json({ ...result, submitted, explanation_html: render.explanation_html });
});
