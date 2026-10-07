// Contenuti: slide renderizzate, domande, import/export dei bundle JSON.
// Porta apps/catalog/services.py e apps/quizzes/serialization.py, con gli stessi
// formati: un file esportato dal pannello della versione Django si reimporta qui.
import { badRequest, bool, cleanMediaUrl, cleanUrl, HttpError, SLUG_RE, str } from "./http";
import { renderMarkdown } from "./render";
import { renderQuestion, validateQuestionData, ValidationError, type QuestionData } from "./questions";

export const BUNDLE_VERSION = "1.0";
export const SECTIONS: [string, string][] = [
  ["ATTACK", "Attacco"],
  ["DEFENSE", "Difesa"],
  ["CHALLENGE", "Sfida"],
  ["THEORY", "Teoria"],
];
const SECTION_KEYS = SECTIONS.map(([k]) => k);

export class BundleError extends Error {}

// Un file importato vale quanto un form compilato da chi non conosciamo: stessi
// controlli dei form del pannello. In particolare i link finiscono in href e
// src di iframe, quindi solo http(s), e https per ciò che la pagina incorpora.

function bundleSlug(v: unknown, label: string, max = 210): string {
  const s = str(v).trim();
  if (s && (!SLUG_RE.test(s) || s.length > max)) {
    throw new BundleError(`${label}: inserisci uno «slug» valido (lettere, numeri, trattini bassi o trattini, al massimo ${max} caratteri).`);
  }
  return s;
}

function bundleText(v: unknown, label: string, max = 200): string {
  const s = str(v).trim();
  if (s.length > max) throw new BundleError(`${label}: al massimo ${max} caratteri (ne ha ${s.length}).`);
  return s;
}

function bundleUrl(v: unknown, label: string, { embed = false } = {}): string {
  if (!str(v).trim()) return "";
  try {
    return embed ? cleanMediaUrl(v) : cleanUrl(v, "url", false);
  } catch (e) {
    if (e instanceof HttpError) throw new BundleError(`${label}: ${e.message}`);
    throw e;
  }
}

export async function imagesMap(db: D1Database, mcId: number): Promise<Record<string, string>> {
  const { results } = await db
    .prepare("SELECT ref_key, url FROM slide_images WHERE microcourse_id = ?")
    .bind(mcId)
    .all<{ ref_key: string; url: string }>();
  return Object.fromEntries(results.map((r) => [r.ref_key, r.url]));
}

/** Ri-renderizza tutte le slide di un microcorso (dopo un cambio di immagini). */
export async function rerenderSlides(db: D1Database, mcId: number): Promise<void> {
  const images = await imagesMap(db, mcId);
  const { results } = await db
    .prepare("SELECT id, body_markdown FROM slides WHERE microcourse_id = ?")
    .bind(mcId)
    .all<{ id: number; body_markdown: string }>();
  if (!results.length) return;
  await db.batch(
    results.map((s) =>
      db.prepare("UPDATE slides SET body_html = ? WHERE id = ?").bind(renderMarkdown(s.body_markdown, images), s.id),
    ),
  );
}

export function normalizeSection(v: unknown): string {
  const s = str(v).toUpperCase();
  return SECTION_KEYS.includes(s) ? s : "THEORY";
}

/** I campi di una domanda pronti per INSERT/UPDATE (render compreso). */
export function questionRow(qtype: string, prompt: string, explanation: string, data: QuestionData) {
  return {
    qtype,
    prompt,
    explanation,
    data: JSON.stringify(data ?? {}),
    render: JSON.stringify(renderQuestion(qtype, prompt, explanation, data ?? {})),
  };
}

function validateOrBundleError(qtype: string, data: unknown) {
  try {
    validateQuestionData(qtype, data);
  } catch (e) {
    if (e instanceof ValidationError) throw new BundleError(e.message);
    throw e;
  }
}

// --- Import di un microcorso --------------------------------------------------

interface BundleOptions {
  /** Import di un corso intero: non toccare titolo/pubblicazione del corso. */
  fromCourse?: boolean;
}

export async function importBundle(
  db: D1Database,
  data: unknown,
  opts: BundleOptions = {},
): Promise<{ id: number; title: string; course_id: number }> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new BundleError("Il bundle deve essere un oggetto JSON.");
  }
  const b = data as Record<string, any>;
  const mcData = (b.microcourse || {}) as Record<string, any>;
  const courseSlug = bundleSlug(mcData.course_slug, "microcourse.course_slug");
  const mcSlug = bundleSlug(mcData.slug, "microcourse.slug");
  if (!courseSlug || !mcSlug) {
    throw new BundleError("Il bundle richiede microcourse.course_slug e microcourse.slug.");
  }
  const quizData = (b.quiz || {}) as Record<string, any>;
  const questions = Array.isArray(quizData.questions) ? quizData.questions : [];
  // Prima si valida tutto, poi si scrive: D1 non offre una transazione che
  // abbracci letture e scritture, quindi un errore a metà lascerebbe un bundle
  // importato solo in parte.
  for (const qd of questions) validateOrBundleError(str(qd?.qtype), qd?.data ?? {});
  bundleText(mcData.course_title, "microcourse.course_title");
  bundleText(mcData.course_icon, "microcourse.course_icon", 16);
  bundleText(mcData.title, "microcourse.title");
  const imageRows: { ref: string; url: string; alt: string }[] = [];
  (Array.isArray(b.images) ? b.images : []).forEach((img: Record<string, any>, i: number) => {
    const ref = bundleSlug(img?.ref_key, `images[${i}].ref_key`, 80);
    const url = bundleUrl(img?.url, `images[${i}].url`, { embed: true });
    if (ref && url) imageRows.push({ ref, url, alt: bundleText(img?.alt_text, `images[${i}].alt_text`) });
  });

  // Corso: get_or_create per slug. Il bundle di un microcorso pubblica sempre il
  // corso, come import_bundle nella versione Django.
  let course = await db.prepare("SELECT id, title, icon FROM courses WHERE slug = ?").bind(courseSlug).first<{ id: number; title: string; icon: string }>();
  if (!course) {
    course = await db
      .prepare("INSERT INTO courses (title, slug, is_published) VALUES (?, ?, 1) RETURNING id, title, icon")
      .bind(str(mcData.course_title) || courseSlug, courseSlug)
      .first<{ id: number; title: string; icon: string }>();
  }
  if (!course) throw new BundleError("Impossibile creare il corso.");
  if (!opts.fromCourse) {
    await db
      .prepare("UPDATE courses SET title = ?, icon = ?, is_published = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .bind(str(mcData.course_title) || course.title, str(mcData.course_icon) || course.icon, course.id)
      .run();
  }

  let mc = await db
    .prepare("SELECT id, title, sort_order, difficulty, estimated_minutes FROM microcourses WHERE course_id = ? AND slug = ?")
    .bind(course.id, mcSlug)
    .first<{ id: number; title: string; sort_order: number; difficulty: number; estimated_minutes: number }>();
  if (!mc) {
    mc = await db
      .prepare("INSERT INTO microcourses (course_id, title, slug) VALUES (?, ?, ?) RETURNING id, title, sort_order, difficulty, estimated_minutes")
      .bind(course.id, str(mcData.title) || mcSlug, mcSlug)
      .first();
  }
  if (!mc) throw new BundleError("Impossibile creare il microcorso.");
  const title = str(mcData.title) || mc.title;
  await db
    .prepare(
      `UPDATE microcourses SET title = ?, summary = ?, is_published = ?, sort_order = ?, difficulty = ?,
       estimated_minutes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    )
    .bind(
      title,
      str(mcData.summary),
      mcData.is_published === undefined ? 1 : bool(mcData.is_published) ? 1 : 0,
      Number(mcData.order ?? mc.sort_order) || 0,
      Number(mcData.difficulty ?? mc.difficulty) || 1,
      Number(mcData.estimated_minutes ?? mc.estimated_minutes) || 10,
      mc.id,
    )
    .run();

  // Immagini: link, mai byte. Si aggiornano o si aggiungono, non si tolgono.
  const imgStmts = [];
  for (const { ref, url, alt } of imageRows) {
    imgStmts.push(
      db
        .prepare(
          `INSERT INTO slide_images (microcourse_id, ref_key, url, alt_text) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(microcourse_id, ref_key) DO UPDATE SET url = ?3, alt_text = ?4`,
        )
        .bind(mc.id, ref, url, alt),
    );
  }
  if (imgStmts.length) await db.batch(imgStmts);
  const images = await imagesMap(db, mc.id);

  // Le slide si sostituiscono in blocco.
  const slideStmts = [db.prepare("DELETE FROM slides WHERE microcourse_id = ?").bind(mc.id)];
  for (const s of Array.isArray(b.slides) ? b.slides : []) {
    const body = str(s?.body_markdown);
    slideStmts.push(
      db
        .prepare("INSERT INTO slides (microcourse_id, title, section, body_markdown, body_html, sort_order) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(mc.id, str(s?.title), normalizeSection(s?.section), body, renderMarkdown(body, images), Number(s?.order) || 0),
    );
  }
  await db.batch(slideStmts);

  await importQuiz(db, mc.id, course.id, quizData, questions);
  return { id: mc.id, title, course_id: course.id };
}

async function importQuiz(db: D1Database, mcId: number, courseId: number, quizData: Record<string, any>, questions: any[]) {
  let quiz = await db.prepare("SELECT id, title FROM quizzes WHERE microcourse_id = ?").bind(mcId).first<{ id: number; title: string }>();
  if (!quiz) {
    quiz = await db
      .prepare("INSERT INTO quizzes (microcourse_id, title) VALUES (?, ?) RETURNING id, title")
      .bind(mcId, str(quizData.title))
      .first();
  } else if (str(quizData.title)) {
    await db.prepare("UPDATE quizzes SET title = ? WHERE id = ?").bind(str(quizData.title), quiz.id).run();
  }
  if (!quiz) throw new BundleError("Impossibile creare il quiz.");

  // Via i vecchi collegamenti e le domande usate solo da questo quiz.
  const { results: old } = await db
    .prepare("SELECT question_id FROM quiz_questions WHERE quiz_id = ?")
    .bind(quiz.id)
    .all<{ question_id: number }>();
  await db.prepare("DELETE FROM quiz_questions WHERE quiz_id = ?").bind(quiz.id).run();
  if (old.length) {
    const ids = old.map((r) => r.question_id);
    await db
      .prepare(
        `DELETE FROM questions WHERE id IN (${ids.map(() => "?").join(",")})
         AND id NOT IN (SELECT question_id FROM quiz_questions)
         AND id NOT IN (SELECT question_id FROM tournament_questions)`,
      )
      .bind(...ids)
      .run();
  }
  if (!questions.length) return;

  const inserted = await db.batch(
    questions.map((qd) => {
      const row = questionRow(str(qd.qtype), str(qd.prompt), str(qd.explanation), qd.data ?? {});
      return db
        .prepare(
          `INSERT INTO questions (qtype, prompt, explanation, course_id, difficulty, data, render, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1) RETURNING id`,
        )
        .bind(row.qtype, row.prompt, row.explanation, courseId, Number(qd.difficulty) || 1, row.data, row.render);
    }),
  );
  await db.batch(
    inserted.map((res, i) =>
      db
        .prepare("INSERT INTO quiz_questions (quiz_id, question_id, sort_order) VALUES (?, ?, ?)")
        .bind(quiz!.id, (res.results[0] as { id: number }).id, Number(questions[i].order ?? i + 1) || i + 1),
    ),
  );
}

// --- Export -----------------------------------------------------------------------

export async function exportBundle(db: D1Database, mcId: number): Promise<Record<string, unknown> | null> {
  const mc = await db
    .prepare(
      `SELECT m.*, c.slug AS course_slug, c.title AS course_title, c.icon AS course_icon
       FROM microcourses m JOIN courses c ON c.id = m.course_id WHERE m.id = ?`,
    )
    .bind(mcId)
    .first<Record<string, any>>();
  if (!mc) return null;
  const [images, slides, quiz] = await db.batch([
    db.prepare("SELECT ref_key, alt_text, url FROM slide_images WHERE microcourse_id = ? ORDER BY id").bind(mcId),
    db.prepare("SELECT sort_order, section, title, body_markdown FROM slides WHERE microcourse_id = ? ORDER BY sort_order, id").bind(mcId),
    db.prepare("SELECT id, title FROM quizzes WHERE microcourse_id = ?").bind(mcId),
  ]);
  const quizRow = quiz.results[0] as { id: number; title: string } | undefined;
  let questions: Record<string, unknown>[] = [];
  if (quizRow) {
    const { results } = await db
      .prepare(
        `SELECT q.qtype, q.prompt, q.explanation, q.difficulty, q.data, qq.sort_order,
                c.slug AS course_slug, c.title AS course_title
         FROM quiz_questions qq JOIN questions q ON q.id = qq.question_id
         LEFT JOIN courses c ON c.id = q.course_id
         WHERE qq.quiz_id = ? ORDER BY qq.sort_order, qq.id`,
      )
      .bind(quizRow.id)
      .all<Record<string, any>>();
    questions = results.map((q) => ({
      qtype: q.qtype,
      prompt: q.prompt,
      explanation: q.explanation,
      course_slug: q.course_slug ?? mc.course_slug,
      course_title: q.course_title ?? mc.course_title,
      difficulty: q.difficulty,
      order: q.sort_order,
      data: JSON.parse(q.data || "{}"),
    }));
  }
  return {
    version: BUNDLE_VERSION,
    microcourse: {
      course_slug: mc.course_slug,
      course_title: mc.course_title,
      course_icon: mc.course_icon,
      slug: mc.slug,
      title: mc.title,
      summary: mc.summary,
      difficulty: mc.difficulty,
      estimated_minutes: mc.estimated_minutes,
      is_published: Boolean(mc.is_published),
      order: mc.sort_order,
    },
    images: images.results,
    slides: (slides.results as Record<string, any>[]).map((s) => ({
      order: s.sort_order,
      section: s.section,
      title: s.title,
      body_markdown: s.body_markdown,
    })),
    quiz: { title: quizRow?.title ?? "", questions },
  };
}

/**
 * Export di un corso intero. Rispetto alla versione Django include anche laboratorio,
 * presentazioni e risorse, così l'export è un backup completo del corso.
 */
export async function exportCourse(db: D1Database, courseId: number): Promise<Record<string, unknown> | null> {
  const course = await db.prepare("SELECT * FROM courses WHERE id = ?").bind(courseId).first<Record<string, any>>();
  if (!course) return null;
  const [mcs, pres, res] = await db.batch([
    db.prepare("SELECT id FROM microcourses WHERE course_id = ? ORDER BY sort_order, id").bind(courseId),
    db.prepare("SELECT title, url, page_count, sort_order FROM presentations WHERE course_id = ? ORDER BY sort_order, id").bind(courseId),
    db.prepare("SELECT title, url, sort_order FROM resources WHERE course_id = ? ORDER BY sort_order, id").bind(courseId),
  ]);
  const microcourses = [];
  for (const m of mcs.results as { id: number }[]) microcourses.push(await exportBundle(db, m.id));
  return {
    version: BUNDLE_VERSION,
    kind: "course",
    course: {
      slug: course.slug,
      title: course.title,
      description: course.description,
      icon: course.icon,
      is_published: Boolean(course.is_published),
      order: course.sort_order,
      lab_url: course.lab_url,
      presentations: (pres.results as Record<string, any>[]).map((p) => ({ title: p.title, url: p.url, page_count: p.page_count, order: p.sort_order })),
      resources: (res.results as Record<string, any>[]).map((r) => ({ title: r.title, url: r.url, order: r.sort_order })),
    },
    microcourses,
  };
}

/**
 * Prima metà di import_course: i dati del corso. I microcorsi li importa poi il
 * pannello uno per richiesta (importBundle con fromCourse), per stare nel limite
 * di CPU di una singola richiesta del piano gratuito.
 */
export async function importCourseMeta(db: D1Database, payload: unknown): Promise<{ id: number; slug: string; title: string }> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new BundleError("Il file deve essere un oggetto JSON.");
  }
  const cdata = ((payload as Record<string, any>).course || {}) as Record<string, any>;
  const slug = bundleSlug(cdata.slug, "course.slug");
  if (!slug) throw new BundleError("Il bundle del corso richiede course.slug.");
  bundleText(cdata.title, "course.title");
  bundleText(cdata.icon, "course.icon", 16);
  const labUrl = cdata.lab_url === undefined ? undefined : bundleUrl(cdata.lab_url, "course.lab_url");
  // Prima si valida tutto, poi si scrive (vedi importBundle).
  const presentations = Array.isArray(cdata.presentations)
    ? (cdata.presentations as Record<string, any>[])
        .map((p, i) => ({
          title: bundleText(p?.title, `course.presentations[${i}].title`),
          url: bundleUrl(p?.url, `course.presentations[${i}].url`, { embed: true }),
          page_count: Number(p?.page_count) || 0,
          order: Number(p?.order ?? i + 1) || 0,
        }))
        .filter((p) => p.url)
    : null;
  const resources = Array.isArray(cdata.resources)
    ? (cdata.resources as Record<string, any>[])
        .map((r, i) => ({
          title: bundleText(r?.title, `course.resources[${i}].title`),
          url: bundleUrl(r?.url, `course.resources[${i}].url`),
          order: Number(r?.order ?? i + 1) || 0,
        }))
        .filter((r) => r.title && r.url)
    : null;
  let course = await db.prepare("SELECT * FROM courses WHERE slug = ?").bind(slug).first<Record<string, any>>();
  if (!course) {
    course = await db.prepare("INSERT INTO courses (title, slug) VALUES (?, ?) RETURNING *").bind(str(cdata.title) || slug, slug).first();
  }
  if (!course) throw new BundleError("Impossibile creare il corso.");
  const title = str(cdata.title) || course.title;
  await db
    .prepare(
      `UPDATE courses SET title = ?, description = ?, icon = ?, is_published = ?, sort_order = ?, lab_url = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    )
    .bind(
      title,
      cdata.description === undefined ? course.description : str(cdata.description),
      cdata.icon === undefined ? course.icon : str(cdata.icon),
      cdata.is_published === undefined ? 1 : bool(cdata.is_published) ? 1 : 0,
      Number(cdata.order ?? course.sort_order) || 0,
      labUrl === undefined ? course.lab_url : labUrl,
      course.id,
    )
    .run();
  // Presentazioni e risorse viaggiano solo negli export di questa versione: se il
  // file le contiene, sostituiscono quelle del corso.
  const stmts = [];
  if (presentations) {
    stmts.push(db.prepare("DELETE FROM presentations WHERE course_id = ?").bind(course.id));
    for (const p of presentations) {
      stmts.push(
        db
          .prepare("INSERT INTO presentations (course_id, title, url, page_count, sort_order) VALUES (?, ?, ?, ?, ?)")
          .bind(course.id, p.title, p.url, p.page_count, p.order),
      );
    }
  }
  if (resources) {
    stmts.push(db.prepare("DELETE FROM resources WHERE course_id = ?").bind(course.id));
    for (const r of resources) {
      stmts.push(
        db.prepare("INSERT INTO resources (course_id, title, url, sort_order) VALUES (?, ?, ?, ?)").bind(course.id, r.title, r.url, r.order),
      );
    }
  }
  if (stmts.length) await db.batch(stmts);
  return { id: course.id, slug, title };
}

// --- Banca delle domande --------------------------------------------------------

export async function exportQuestions(db: D1Database, filters: { qtype?: string; course?: string }) {
  let sql = `SELECT q.*, c.slug AS course_slug, c.title AS course_title FROM questions q
             LEFT JOIN courses c ON c.id = q.course_id WHERE 1 = 1`;
  const args: unknown[] = [];
  if (filters.qtype) {
    sql += " AND q.qtype = ?";
    args.push(filters.qtype);
  }
  if (filters.course) {
    sql += " AND c.slug = ?";
    args.push(filters.course);
  }
  sql += " ORDER BY q.id";
  const { results } = await db.prepare(sql).bind(...args).all<Record<string, any>>();
  return {
    version: "1.0",
    kind: "questions",
    questions: results.map((q) => ({
      qtype: q.qtype,
      prompt: q.prompt,
      explanation: q.explanation,
      course_slug: q.course_slug ?? null,
      course_title: q.course_title ?? null,
      difficulty: q.difficulty,
      is_active: Boolean(q.is_active),
      data: JSON.parse(q.data || "{}"),
    })),
  };
}

/** Aggiunge le domande (la banca non ha una chiave naturale). Restituisce quante. */
export async function importQuestions(db: D1Database, payload: unknown): Promise<number> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw badRequest("Il file deve essere un oggetto JSON.");
  }
  const items = (payload as Record<string, any>).questions;
  if (!Array.isArray(items)) throw badRequest("Il JSON non contiene la lista 'questions'.");
  for (const qd of items) {
    if (typeof qd !== "object" || qd === null) throw badRequest("Ogni domanda deve essere un oggetto JSON.");
    validateOrBundleError(str(qd.qtype), qd.data ?? {});
    bundleSlug(qd.course_slug, "course_slug");
    bundleText(qd.course_title, "course_title");
  }
  const courseIds = new Map<string, number>();
  for (const qd of items) {
    const slug = str(qd.course_slug).trim();
    if (!slug || courseIds.has(slug)) continue;
    let row = await db.prepare("SELECT id FROM courses WHERE slug = ?").bind(slug).first<{ id: number }>();
    if (!row) {
      row = await db.prepare("INSERT INTO courses (title, slug) VALUES (?, ?) RETURNING id").bind(str(qd.course_title) || slug, slug).first();
    }
    if (row) courseIds.set(slug, row.id);
  }
  const stmts = items.map((qd: Record<string, any>) => {
    const row = questionRow(str(qd.qtype), str(qd.prompt), str(qd.explanation), qd.data ?? {});
    return db
      .prepare(
        `INSERT INTO questions (qtype, prompt, explanation, course_id, difficulty, data, render, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.qtype,
        row.prompt,
        row.explanation,
        courseIds.get(str(qd.course_slug).trim()) ?? null,
        Number(qd.difficulty) || 1,
        row.data,
        row.render,
        qd.is_active === undefined ? 1 : bool(qd.is_active) ? 1 : 0,
      );
  });
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}
