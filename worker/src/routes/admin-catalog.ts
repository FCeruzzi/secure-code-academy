// Pannello: corsi, materiale del corso, microcorsi, slide, immagini, import/export.
// Porta apps/catalog/admin_views.py.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
  BundleError,
  exportBundle,
  exportCourse,
  importBundle,
  importCourseMeta,
  imagesMap,
  normalizeSection,
  rerenderSlides,
  SECTIONS,
} from "../lib/content";
import { Form } from "../lib/form";
import { badRequest, intParam, notFound, readJson, uniqueSlug } from "../lib/http";
import { renderMarkdown } from "../lib/render";

export const catalogRoutes = new Hono<AppEnv>();

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

async function getCourse(db: D1Database, id: number) {
  const course = await db.prepare("SELECT * FROM courses WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!course) throw notFound("Corso non trovato.");
  return course;
}

async function getMicrocourse(db: D1Database, id: number) {
  const mc = await db
    .prepare("SELECT m.*, c.title AS course_title, c.slug AS course_slug FROM microcourses m JOIN courses c ON c.id = m.course_id WHERE m.id = ?")
    .bind(id)
    .first<Record<string, any>>();
  if (!mc) throw notFound("Microcorso non trovato.");
  return mc;
}

const courseOut = (c: Record<string, any>) => ({
  id: c.id,
  title: c.title,
  slug: c.slug,
  icon: c.icon,
  description: c.description,
  lab_url: c.lab_url,
  order: c.sort_order,
  is_published: Boolean(c.is_published),
});

const mcOut = (m: Record<string, any>) => ({
  id: m.id,
  course_id: m.course_id,
  title: m.title,
  slug: m.slug,
  summary: m.summary,
  difficulty: m.difficulty,
  estimated_minutes: m.estimated_minutes,
  order: m.sort_order,
  is_published: Boolean(m.is_published),
});

function bundleErrors(e: unknown, prefix: string): never {
  if (e instanceof BundleError) throw badRequest(`${prefix}: ${e.message}`);
  throw e;
}

// --- Corsi -------------------------------------------------------------------------

catalogRoutes.get("/courses", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM microcourses m WHERE m.course_id = c.id) AS mc_count
     FROM courses c ORDER BY c.sort_order, c.id`,
  ).all<Record<string, any>>();
  return c.json({ courses: results.map((r) => ({ ...courseOut(r), mc_count: r.mc_count })) });
});

async function saveCourse(db: D1Database, data: Record<string, unknown>, existing: Record<string, any> | null) {
  const f = new Form(data);
  const title = f.text("title", { required: true, max: 200 });
  let slug = f.slug("slug");
  const icon = f.text("icon", { max: 16 });
  const description = f.text("description");
  // Alla creazione il laboratorio non c'è ancora (passo 1 di 2), come nella versione Django.
  const labUrl = existing ? f.url("lab_url") : "";
  const order = f.int("order", { fallback: existing?.sort_order ?? 0 });
  const published = f.bool("is_published");
  if (slug) {
    const clash = await db.prepare("SELECT 1 FROM courses WHERE slug = ? AND id != ?").bind(slug, existing?.id ?? -1).first();
    if (clash) f.error("slug", "Corso con questo Slug esiste già.");
  }
  f.check();
  if (!slug) slug = await uniqueSlug(db, "courses", title, existing?.id ?? null);
  if (existing) {
    await db
      .prepare(
        `UPDATE courses SET title = ?, slug = ?, icon = ?, description = ?, lab_url = ?, sort_order = ?,
         is_published = ?, updated_at = ${NOW} WHERE id = ?`,
      )
      .bind(title, slug, icon, description, labUrl, order, published ? 1 : 0, existing.id)
      .run();
    return existing.id as number;
  }
  const row = await db
    .prepare("INSERT INTO courses (title, slug, icon, description, sort_order, is_published) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(title, slug, icon, description, order, published ? 1 : 0)
    .first<{ id: number }>();
  return row!.id;
}

catalogRoutes.post("/courses", async (c) => {
  const id = await saveCourse(c.env.DB, await readJson(c), null);
  return c.json({ id, message: "Corso salvato." });
});

catalogRoutes.get("/courses/:id", async (c) => {
  const db = c.env.DB;
  const course = await getCourse(db, intParam(c, "id"));
  const [pres, res] = await db.batch([
    db.prepare("SELECT id, title, url, page_count FROM presentations WHERE course_id = ? ORDER BY sort_order, id").bind(course.id),
    db.prepare("SELECT id, title, url FROM resources WHERE course_id = ? ORDER BY sort_order, id").bind(course.id),
  ]);
  return c.json({ course: courseOut(course), presentations: pres.results, resources: res.results });
});

catalogRoutes.put("/courses/:id", async (c) => {
  const db = c.env.DB;
  const course = await getCourse(db, intParam(c, "id"));
  await saveCourse(db, await readJson(c), course);
  return c.json({ id: course.id, message: "Corso salvato." });
});

catalogRoutes.delete("/courses/:id", async (c) => {
  const db = c.env.DB;
  const course = await getCourse(db, intParam(c, "id"));
  // Come nella versione Django: microcorsi, slide, quiz e materiale vanno via in cascata; le
  // domande restano nella banca senza corso (SET NULL).
  await db.prepare("DELETE FROM courses WHERE id = ?").bind(course.id).run();
  return c.json({ message: "Corso eliminato." });
});

catalogRoutes.get("/courses/:id/export", async (c) => {
  const payload = await exportCourse(c.env.DB, intParam(c, "id"));
  if (!payload) throw notFound("Corso non trovato.");
  return c.json(payload);
});

/** Prima parte dell'import di un corso: i microcorsi arrivano dopo, uno per volta. */
catalogRoutes.post("/courses/import", async (c) => {
  try {
    const course = await importCourseMeta(c.env.DB, await readJson(c));
    return c.json({ ...course, message: `Corso «${course.title}» importato.` });
  } catch (e) {
    bundleErrors(e, "Import non riuscito");
  }
});

// --- Materiale del corso: presentazioni e risorse ---------------------------------

catalogRoutes.post("/courses/:id/presentations", async (c) => {
  const db = c.env.DB;
  const course = await getCourse(db, intParam(c, "id"));
  const f = new Form(await readJson(c));
  const title = f.text("title", { max: 200 });
  const url = f.mediaUrl("url");
  const pageCount = f.int("page_count", { fallback: 0 });
  f.check();
  const max = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM presentations WHERE course_id = ?").bind(course.id).first<{ m: number }>();
  await db
    .prepare("INSERT INTO presentations (course_id, title, url, page_count, sort_order) VALUES (?, ?, ?, ?, ?)")
    .bind(course.id, title, url, pageCount, (max?.m ?? 0) + 1)
    .run();
  return c.json({ message: "Presentazione aggiunta." });
});

catalogRoutes.delete("/presentations/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM presentations WHERE id = ?").bind(intParam(c, "id")).run();
  if (!res.meta.changes) throw notFound("Presentazione non trovata.");
  return c.json({ message: "Presentazione eliminata." });
});

catalogRoutes.post("/courses/:id/resources", async (c) => {
  const db = c.env.DB;
  const course = await getCourse(db, intParam(c, "id"));
  const body = await readJson(c);
  const f = new Form(body);
  const title = f.text("title", { max: 200 });
  const url = f.url("url");
  if (!title || !url) throw badRequest("Inserisci titolo e link della risorsa.");
  f.check();
  const max = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM resources WHERE course_id = ?").bind(course.id).first<{ m: number }>();
  await db
    .prepare("INSERT INTO resources (course_id, title, url, sort_order) VALUES (?, ?, ?, ?)")
    .bind(course.id, title, url, (max?.m ?? 0) + 1)
    .run();
  return c.json({ message: "Risorsa aggiunta." });
});

catalogRoutes.delete("/resources/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM resources WHERE id = ?").bind(intParam(c, "id")).run();
  if (!res.meta.changes) throw notFound("Risorsa non trovata.");
  return c.json({ message: "Risorsa rimossa." });
});

// --- Microcorsi ----------------------------------------------------------------------

catalogRoutes.get("/courses/:id/microcourses", async (c) => {
  const db = c.env.DB;
  const course = await getCourse(db, intParam(c, "id"));
  const { results } = await db
    .prepare(
      `SELECT m.*, (SELECT COUNT(*) FROM slides s WHERE s.microcourse_id = m.id) AS slide_count,
        (SELECT COUNT(*) FROM quizzes z JOIN quiz_questions qq ON qq.quiz_id = z.id WHERE z.microcourse_id = m.id) AS question_count
       FROM microcourses m WHERE m.course_id = ? ORDER BY m.sort_order, m.id`,
    )
    .bind(course.id)
    .all<Record<string, any>>();
  return c.json({
    course: courseOut(course),
    microcourses: results.map((m) => ({ ...mcOut(m), slide_count: m.slide_count, question_count: m.question_count })),
  });
});

async function saveMicrocourse(db: D1Database, courseId: number, data: Record<string, unknown>, existing: Record<string, any> | null) {
  const f = new Form(data);
  const title = f.text("title", { required: true, max: 200 });
  let slug = f.slug("slug");
  const summary = f.text("summary");
  const difficulty = f.int("difficulty", { fallback: existing?.difficulty ?? 1, max: 32767 });
  const minutes = f.int("estimated_minutes", { fallback: existing?.estimated_minutes ?? 10, max: 32767 });
  const order = f.int("order", { fallback: existing?.sort_order ?? 0 });
  const published = f.bool("is_published");
  if (slug) {
    const clash = await db
      .prepare("SELECT 1 FROM microcourses WHERE course_id = ? AND slug = ? AND id != ?")
      .bind(courseId, slug, existing?.id ?? -1)
      .first();
    if (clash) f.error("slug", "Microcorso con questi Course e Slug esiste già.");
  }
  f.check();
  if (!slug) slug = await uniqueSlug(db, "microcourses", title, existing?.id ?? null, { column: "course_id", value: courseId });
  if (existing) {
    await db
      .prepare(
        `UPDATE microcourses SET title = ?, slug = ?, summary = ?, difficulty = ?, estimated_minutes = ?,
         sort_order = ?, is_published = ?, updated_at = ${NOW} WHERE id = ?`,
      )
      .bind(title, slug, summary, difficulty, minutes, order, published ? 1 : 0, existing.id)
      .run();
    return existing.id as number;
  }
  const row = await db
    .prepare(
      `INSERT INTO microcourses (course_id, title, slug, summary, difficulty, estimated_minutes, sort_order, is_published)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(courseId, title, slug, summary, difficulty, minutes, order, published ? 1 : 0)
    .first<{ id: number }>();
  return row!.id;
}

catalogRoutes.post("/courses/:id/microcourses", async (c) => {
  const db = c.env.DB;
  const course = await getCourse(db, intParam(c, "id"));
  const id = await saveMicrocourse(db, course.id, await readJson(c), null);
  return c.json({ id, message: "Microcorso salvato." });
});

catalogRoutes.get("/microcourses/:id", async (c) => {
  const db = c.env.DB;
  const mc = await getMicrocourse(db, intParam(c, "id"));
  const [slides, images, qcount] = await db.batch([
    db.prepare("SELECT id, title, section, sort_order FROM slides WHERE microcourse_id = ? ORDER BY sort_order, id").bind(mc.id),
    db.prepare("SELECT id, ref_key, url, alt_text FROM slide_images WHERE microcourse_id = ? ORDER BY id").bind(mc.id),
    db.prepare("SELECT COUNT(*) AS n FROM quizzes z JOIN quiz_questions qq ON qq.quiz_id = z.id WHERE z.microcourse_id = ?").bind(mc.id),
  ]);
  return c.json({
    microcourse: mcOut(mc),
    course: { id: mc.course_id, title: mc.course_title, slug: mc.course_slug },
    slides: (slides.results as Record<string, any>[]).map((s) => ({ id: s.id, title: s.title, section: s.section, order: s.sort_order })),
    images: images.results,
    question_count: (qcount.results[0] as { n: number }).n,
  });
});

catalogRoutes.put("/microcourses/:id", async (c) => {
  const db = c.env.DB;
  const mc = await getMicrocourse(db, intParam(c, "id"));
  await saveMicrocourse(db, mc.course_id, await readJson(c), mc);
  return c.json({ id: mc.id, message: "Microcorso salvato." });
});

catalogRoutes.delete("/microcourses/:id", async (c) => {
  const db = c.env.DB;
  const mc = await getMicrocourse(db, intParam(c, "id"));
  // Le domande del quiz restano nella banca, come nella versione Django (cade solo il quiz).
  await db.prepare("DELETE FROM microcourses WHERE id = ?").bind(mc.id).run();
  return c.json({ message: "Microcorso eliminato.", course_id: mc.course_id });
});

catalogRoutes.get("/microcourses/:id/export", async (c) => {
  const payload = await exportBundle(c.env.DB, intParam(c, "id"));
  if (!payload) throw notFound("Microcorso non trovato.");
  return c.json(payload);
});

catalogRoutes.post("/microcourses/import", async (c) => {
  const body = await readJson<Record<string, any>>(c);
  // Dall'import di un corso arrivano { bundle, course_slug, course_title }.
  const fromCourse = typeof body.bundle === "object" && body.bundle !== null;
  const bundle = fromCourse ? body.bundle : body;
  if (fromCourse) {
    bundle.microcourse = { ...(bundle.microcourse || {}), course_slug: body.course_slug, course_title: body.course_title };
  }
  try {
    const mc = await importBundle(c.env.DB, bundle, { fromCourse });
    return c.json({ ...mc, message: `Microcorso «${mc.title}» importato.` });
  } catch (e) {
    bundleErrors(e, fromCourse ? "Import non riuscito" : "Bundle non valido");
  }
});

// --- Slide --------------------------------------------------------------------------

catalogRoutes.post("/microcourses/:id/slides", async (c) => {
  const db = c.env.DB;
  const mc = await getMicrocourse(db, intParam(c, "id"));
  const f = new Form(await readJson(c));
  const title = f.text("title", { max: 200 });
  const section = normalizeSection(f.choice("section", SECTIONS.map(([k]) => k)));
  const body = f.body("body_markdown");
  let order = f.int("order", { fallback: 0 });
  f.check();
  if (!order) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM slides WHERE microcourse_id = ?").bind(mc.id).first<{ n: number }>();
    order = (n?.n ?? 0) + 1;
  }
  const html = renderMarkdown(body, await imagesMap(db, mc.id));
  const row = await db
    .prepare("INSERT INTO slides (microcourse_id, title, section, body_markdown, body_html, sort_order) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(mc.id, title, section, body, html, order)
    .first<{ id: number }>();
  return c.json({ id: row!.id, message: "Slide salvata." });
});

async function getSlide(db: D1Database, id: number) {
  const slide = await db.prepare("SELECT * FROM slides WHERE id = ?").bind(id).first<Record<string, any>>();
  if (!slide) throw notFound("Slide non trovata.");
  return slide;
}

catalogRoutes.get("/slides/:id", async (c) => {
  const db = c.env.DB;
  const slide = await getSlide(db, intParam(c, "id"));
  const mc = await getMicrocourse(db, slide.microcourse_id);
  const { results: images } = await db
    .prepare("SELECT id, ref_key, url, alt_text FROM slide_images WHERE microcourse_id = ? ORDER BY id")
    .bind(mc.id)
    .all();
  return c.json({
    slide: { id: slide.id, title: slide.title, section: slide.section, body_markdown: slide.body_markdown, order: slide.sort_order },
    microcourse: mcOut(mc),
    course: { id: mc.course_id, title: mc.course_title, slug: mc.course_slug },
    images,
  });
});

catalogRoutes.put("/slides/:id", async (c) => {
  const db = c.env.DB;
  const slide = await getSlide(db, intParam(c, "id"));
  const f = new Form(await readJson(c));
  const title = f.text("title", { max: 200 });
  const section = normalizeSection(f.choice("section", SECTIONS.map(([k]) => k)));
  const body = f.body("body_markdown");
  const order = f.int("order", { fallback: slide.sort_order });
  f.check();
  const html = renderMarkdown(body, await imagesMap(db, slide.microcourse_id));
  await db
    .prepare(`UPDATE slides SET title = ?, section = ?, body_markdown = ?, body_html = ?, sort_order = ?, updated_at = ${NOW} WHERE id = ?`)
    .bind(title, section, body, html, order, slide.id)
    .run();
  return c.json({ id: slide.id, message: "Slide salvata." });
});

catalogRoutes.delete("/slides/:id", async (c) => {
  const db = c.env.DB;
  const slide = await getSlide(db, intParam(c, "id"));
  await db.prepare("DELETE FROM slides WHERE id = ?").bind(slide.id).run();
  return c.json({ message: "Slide eliminata.", microcourse_id: slide.microcourse_id });
});

// --- Immagini delle slide --------------------------------------------------------------

catalogRoutes.post("/microcourses/:id/images", async (c) => {
  const db = c.env.DB;
  const mc = await getMicrocourse(db, intParam(c, "id"));
  const f = new Form(await readJson(c));
  const refKey = f.slug("ref_key", 80);
  if (!refKey) f.error("ref_key", "Questo campo è obbligatorio.");
  const url = f.mediaUrl("url");
  const alt = f.text("alt_text", { max: 200 });
  if (refKey) {
    const clash = await db.prepare("SELECT 1 FROM slide_images WHERE microcourse_id = ? AND ref_key = ?").bind(mc.id, refKey).first();
    if (clash) f.error("ref_key", "Immagine slide con questi Microcourse e Chiave di riferimento esiste già.");
  }
  f.check();
  await db.prepare("INSERT INTO slide_images (microcourse_id, ref_key, url, alt_text) VALUES (?, ?, ?, ?)").bind(mc.id, refKey, url, alt).run();
  await rerenderSlides(db, mc.id);
  return c.json({ message: "Immagine aggiunta." });
});

catalogRoutes.delete("/images/:id", async (c) => {
  const db = c.env.DB;
  const img = await db.prepare("SELECT id, microcourse_id FROM slide_images WHERE id = ?").bind(intParam(c, "id")).first<{ id: number; microcourse_id: number }>();
  if (!img) throw notFound("Immagine non trovata.");
  await db.prepare("DELETE FROM slide_images WHERE id = ?").bind(img.id).run();
  await rerenderSlides(db, img.microcourse_id);
  return c.json({ message: "Immagine eliminata." });
});
