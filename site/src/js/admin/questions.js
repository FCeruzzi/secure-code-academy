// Pannello: banca delle domande, editor del contenuto, quiz dei microcorsi.
// Porta apps/quizzes/admin_views.py e l'editor di question_content.html.
import { difficultyStars, downloadJson, languageLabel, notify, param, qtypeEmoji, truncate, url } from "../core.js";
import { adminPage } from "./base.js";

const idParam = (name = "id") => (/^\d+$/.test(param(name)) ? param(name) : "");

const QTYPES = [
  ["TRUE_FALSE", "Vero / Falso"],
  ["MULTIPLE_CHOICE", "Scelta multipla"],
  ["FIND_WRONG_LINE", "Individua la riga errata"],
  ["CODE_COMPARISON", "Confronto di codice"],
];
const DIFFICULTIES = [
  [1, "Base"],
  [2, "Intermedio"],
  [3, "Avanzato"],
];

const questionHelpers = { qtypeEmoji, difficultyStars, languageLabel, truncate, QTYPES, DIFFICULTIES };

export const adminQuestionList = () =>
  adminPage({
    ...questionHelpers,
    questions: [],
    courses: [],
    page: 1,
    numPages: 1,
    count: 0,
    filters: { qtype: param("qtype"), course: param("course"), difficulty: param("difficulty") },
    sort: param("sort"),
    dir: param("dir") === "desc" ? "desc" : "asc",
    async init() {
      await this.loadWith(() => this.reload(parseInt(param("page") || "1", 10) || 1));
    },
    query(extra = {}) {
      const q = { ...this.filters, sort: this.sort, dir: this.sort ? this.dir : "", ...extra };
      return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== "" && v !== undefined && v !== null));
    },
    async reload(page = this.page) {
      const qs = new URLSearchParams(this.query({ page }));
      const data = await this.call(`/api/admin/questions?${qs}`);
      Object.assign(this, { questions: data.questions, courses: data.courses, page: data.page, numPages: data.num_pages, count: data.count });
      // L'indirizzo riflette filtri, ordinamento e pagina, come la querystring della versione Django.
      history.replaceState(null, "", url("admin/domande/", this.query({ page: this.page > 1 ? this.page : "" })));
    },
    async filter() {
      await this.reload(1);
    },
    async sortBy(key) {
      this.dir = this.sort === key && this.dir === "asc" ? "desc" : "asc";
      this.sort = key;
      await this.reload(1);
    },
    async exportQuestions() {
      const qs = new URLSearchParams(this.query());
      const data = await this.action(`/api/admin/questions/export?${qs}`, { method: "GET" });
      if (data) downloadJson(data, "banca-domande.json");
    },
    remove(q) {
      this.askDelete(`[${q.qtype_label}] ${truncate(q.prompt, 60)}`, () =>
        this.action(`/api/admin/questions/${q.id}`, {
          method: "DELETE",
          then: async (res) => {
            notify(res.message);
            await this.reload();
          },
        }),
      );
    },
  });

/** Passo 1 (nuova domanda) o modifica dei dati di una domanda esistente. */
export const adminQuestionMeta = () =>
  adminPage({
    ...questionHelpers,
    question: null,
    courses: [],
    form: { qtype: "", course_id: "", difficulty: "1", prompt: "", explanation: "", is_active: true },
    async init() {
      const id = idParam();
      await this.loadWith(async () => {
        if (id) {
          const data = await this.call(`/api/admin/questions/${id}`);
          this.question = data.question;
          this.courses = data.courses;
          const q = data.question;
          this.form = {
            qtype: q.qtype,
            course_id: q.course_id ? String(q.course_id) : "",
            difficulty: String(q.difficulty),
            prompt: q.prompt,
            explanation: q.explanation,
            is_active: q.is_active,
          };
        } else {
          this.courses = (await this.call("/api/admin/tournament-courses")).courses;
        }
      });
    },
    get step1() {
      return !this.question;
    },
    get title() {
      return this.question ? "Modifica dati della domanda" : "Nuova domanda — passo 1 di 2";
    },
    get backUrl() {
      return this.question ? url("admin/domande/contenuto/", { id: this.question.id }) : url("admin/domande/");
    },
    async submit() {
      const res = this.question
        ? await this.submitForm(`/api/admin/questions/${this.question.id}/meta`, "PUT", this.form)
        : await this.submitForm("/api/admin/questions", "POST", this.form);
      if (res) this.done(res.message, "admin/domande/contenuto/", { id: res.id });
    },
  });

export const adminQuestionImport = () =>
  adminPage({
    state: "ready",
    async submit() {
      const payload = await this.readFile();
      if (!payload) return;
      this.busy = true;
      try {
        const res = await this.call("/api/admin/questions/import", { method: "POST", json: payload });
        this.done(res.message, "admin/domande/");
      } catch (e) {
        notify(e.message.startsWith("Import non riuscito") ? e.message : `Import non riuscito: ${e.message}`, "error");
      } finally {
        this.busy = false;
      }
    },
  });

// --- Editor del contenuto (passo 2) ---------------------------------------------------

function hydrateFiles(d, side) {
  const files = d[`files_${side}`];
  if (Array.isArray(files) && files.length) return files.map((f) => ({ name: f.name || "", content: f.content || "" }));
  const snip = d[`snippet_${side}`];
  if (snip) return [{ name: "codice", content: snip }];
  return [{ name: "", content: "" }];
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

export const adminQuestionContent = () =>
  adminPage({
    question: null,
    languages: ["java", "python", "javascript", "typescript", "php", "sql", "html", "csharp", "cpp", "go", "ruby", "bash", "text"],
    qtype: "TRUE_FALSE",
    tf: { statement: "", answer: true },
    mc: { multiple: false, options: [] },
    fwl: { language: "java", code: "", start_line: 1, correct_lines: [] },
    cc: { language: "java", label_a: "Versione A", label_b: "Versione B", correct: "a", files_a: [], files_b: [] },
    async init() {
      const id = idParam();
      if (!id) return (this.state = "notfound");
      await this.loadWith(async () => {
        const data = await this.call(`/api/admin/questions/${id}`);
        this.question = data.question;
        this.hydrate(data.question.qtype, data.question.data || {});
      });
    },
    hydrate(qtype, d) {
      this.qtype = qtype || "TRUE_FALSE";
      this.tf = { statement: d.statement || "", answer: d.answer === undefined ? true : !!d.answer };
      this.mc = {
        multiple: !!d.multiple,
        options:
          Array.isArray(d.options) && d.options.length
            ? d.options.map((o) => ({ text: o.text || "", ok: (d.correct || []).map(String).includes(String(o.id)) }))
            : [
                { text: "", ok: true },
                { text: "", ok: false },
              ],
      };
      this.fwl = {
        language: d.language || "java",
        code: d.code || "",
        start_line: d.start_line || 1,
        correct_lines: Array.isArray(d.correct_lines) ? d.correct_lines.slice() : [],
      };
      this.cc = {
        language: d.language || "java",
        label_a: d.label_a || "Versione A",
        label_b: d.label_b || "Versione B",
        correct: d.correct === "b" ? "b" : "a",
        files_a: hydrateFiles(d, "a"),
        files_b: hydrateFiles(d, "b"),
      };
    },
    optLetter(i) {
      return LETTERS[i] || `o${i}`;
    },
    addOption() {
      this.mc.options.push({ text: "", ok: false });
    },
    removeOption(i) {
      this.mc.options.splice(i, 1);
      if (!this.mc.options.some((o) => o.ok) && this.mc.options[0]) this.mc.options[0].ok = true;
    },
    pickSingle(i) {
      this.mc.options.forEach((o, j) => (o.ok = j === i));
    },
    normalizeCorrect() {
      if (this.mc.multiple) return;
      let i = this.mc.options.findIndex((o) => o.ok);
      if (i < 0) i = 0;
      this.mc.options.forEach((o, j) => (o.ok = j === i));
    },
    get fwlLines() {
      return (this.fwl.code || "").split("\n");
    },
    lineNo(i) {
      return (Number(this.fwl.start_line) || 1) + i;
    },
    toggleLine(i) {
      const n = this.lineNo(i);
      const idx = this.fwl.correct_lines.indexOf(n);
      if (idx >= 0) this.fwl.correct_lines.splice(idx, 1);
      else this.fwl.correct_lines.push(n);
    },
    isBadLine(i) {
      return this.fwl.correct_lines.includes(this.lineNo(i));
    },
    sortedLines() {
      return [...this.fwl.correct_lines].sort((a, b) => a - b).join(", ");
    },
    filesOf(side) {
      return side === "a" ? this.cc.files_a : this.cc.files_b;
    },
    addFile(side) {
      this.filesOf(side).push({ name: "", content: "" });
    },
    removeFile(side, i) {
      const arr = this.filesOf(side);
      arr.splice(i, 1);
      if (!arr.length) arr.push({ name: "", content: "" });
    },
    buildData() {
      if (this.qtype === "TRUE_FALSE") return { statement: this.tf.statement, answer: !!this.tf.answer };
      if (this.qtype === "MULTIPLE_CHOICE") {
        const options = this.mc.options.map((o, i) => ({ id: this.optLetter(i), text: o.text }));
        const correct = this.mc.options.map((o, i) => (o.ok ? this.optLetter(i) : null)).filter((x) => x);
        return { multiple: !!this.mc.multiple, options, correct };
      }
      if (this.qtype === "FIND_WRONG_LINE") {
        const start = Number(this.fwl.start_line) || 1;
        const total = this.fwlLines.length;
        const correct_lines = this.fwl.correct_lines.filter((n) => n >= start && n <= start + total - 1).sort((a, b) => a - b);
        return { language: this.fwl.language, code: this.fwl.code, correct_lines, start_line: start };
      }
      if (this.qtype === "CODE_COMPARISON") {
        return {
          language: this.cc.language,
          label_a: this.cc.label_a,
          label_b: this.cc.label_b,
          files_a: this.cc.files_a.map((f) => ({ name: f.name, content: f.content })),
          files_b: this.cc.files_b.map((f) => ({ name: f.name, content: f.content })),
          correct: this.cc.correct,
        };
      }
      return {};
    },
    fullQuestion() {
      const q = this.question || {};
      return {
        qtype: this.qtype,
        prompt: q.prompt || "",
        explanation: q.explanation || "",
        difficulty: q.difficulty || 1,
        is_active: q.is_active !== false,
        data: this.buildData(),
      };
    },
    get jsonText() {
      return JSON.stringify(this.fullQuestion(), null, 2);
    },
    download() {
      downloadJson(this.fullQuestion(), `${(this.qtype || "domanda").toLowerCase()}.json`);
    },
    get difficultyLabel() {
      return (DIFFICULTIES.find(([v]) => v === Number(this.question?.difficulty)) || [0, ""])[1];
    },
    async submit() {
      const res = await this.submitForm(`/api/admin/questions/${this.question.id}/content`, "PUT", { data: this.buildData() });
      if (res) this.done(res.message, "admin/domande/");
    },
  });

// --- Quiz di un microcorso -------------------------------------------------------------

export const adminQuizManage = () =>
  adminPage({
    ...questionHelpers,
    mc: null,
    course: null,
    items: [],
    available: [],
    search: "",
    onlyCourse: true,
    selected: null,
    preview: null,
    async init() {
      const id = idParam("mc");
      if (!id) return (this.state = "notfound");
      await this.loadWith(() => this.reload(id));
    },
    async reload(id = this.mc.id) {
      const data = await this.call(`/api/admin/microcourses/${id}/quiz`);
      Object.assign(this, { mc: data.microcourse, course: data.course, items: data.items, available: data.available });
    },
    get filtered() {
      const s = this.search.trim().toLowerCase();
      return this.available.filter((q) => {
        if (this.onlyCourse && q.course_id !== this.course.id) return false;
        return s === "" || truncate(q.prompt, 100000).toLowerCase().includes(s);
      });
    },
    async select(q) {
      this.selected = q.id;
      const data = await this.action(`/api/admin/questions/${q.id}/preview`, { method: "GET" });
      if (data) this.preview = { ...data, meta: q };
    },
    async add() {
      if (!this.selected) return;
      await this.action(`/api/admin/microcourses/${this.mc.id}/quiz`, {
        json: { question_id: this.selected },
        then: async (res) => {
          if (res.message) notify(res.message);
          this.selected = null;
          this.preview = null;
          await this.reload();
        },
      });
    },
    async removeItem(it) {
      await this.action(`/api/admin/quiz-items/${it.id}`, {
        method: "DELETE",
        then: async (res) => {
          notify(res.message);
          await this.reload();
        },
      });
    },
    async move(it, direction) {
      await this.action(`/api/admin/quiz-items/${it.id}/move`, { json: { direction }, then: () => this.reload() });
    },
  });
