// Pannello: banca delle domande, editor del contenuto, quiz dei microcorsi.
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
    // Id scelti con le caselle: restano selezionati cambiando pagina o filtri.
    selected: [],
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
      // L'indirizzo riflette filtri, ordinamento e pagina: la vista si può ricaricare o condividere.
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
    async exportSelected() {
      const data = await this.action("/api/admin/questions/export", { method: "POST", json: { ids: this.selected } });
      if (data) downloadJson(data, "domande-selezionate.json");
    },
    get pageAllSelected() {
      return this.questions.length > 0 && this.questions.every((q) => this.selected.includes(q.id));
    },
    togglePage(on) {
      const ids = this.questions.map((q) => q.id);
      this.selected = on ? [...new Set([...this.selected, ...ids])] : this.selected.filter((id) => !ids.includes(id));
    },
    async selectAllFiltered() {
      const qs = new URLSearchParams(this.query());
      const data = await this.action(`/api/admin/questions/ids?${qs}`, { method: "GET" });
      if (data) this.selected = [...new Set([...this.selected, ...data.ids])];
    },
    remove(q) {
      this.askDelete(`[${q.qtype_label}] ${truncate(q.summary || q.prompt, 60)}`, () =>
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

/** JSON con le chiavi ordinate: due domande uguali danno la stessa stringa. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
const questionKey = (qtype, prompt, data) => `${qtype}\n${String(prompt || "").trim()}\n${canonical(data || {})}`;

// Domande per richiesta: ognuna si renderizza sul Worker, che ha pochi ms di
// CPU per richiesta. Se un blocco non passa, si riprova una domanda per volta.
const IMPORT_BATCH = 5;

const STATUS = {
  new: ["Nuova", "bg-emerald-500/15 text-emerald-300"],
  bank: ["Già nella banca", "bg-slate-700 text-slate-300"],
  quiz: ["Già in un quiz", "bg-amber-500/15 text-amber-300"],
  dup: ["Doppia nel file", "bg-slate-700 text-slate-400"],
};

export const adminQuestionImport = () =>
  adminPage({
    ...questionHelpers,
    state: "ready",
    rows: [],
    replace: false,
    progress: "",
    get checkedCount() {
      return this.rows.filter((r) => r.checked).length;
    },
    get summary() {
      const n = (s) => this.rows.filter((r) => r.status === s).length;
      return `${n("new")} nuove · ${n("bank")} già nella banca · ${n("quiz")} già in un quiz` + (n("dup") ? ` · ${n("dup")} doppie` : "");
    },
    statusLabel: (s) => STATUS[s][0],
    statusClass: (s) => STATUS[s][1],
    async loadFile() {
      this.rows = [];
      const payload = await this.readFile();
      if (!payload) return;
      const items = Array.isArray(payload?.questions) ? payload.questions : null;
      if (!items) {
        this.fileError = "Il JSON non contiene la lista 'questions'.";
        return;
      }
      if (items.some((q) => typeof q !== "object" || q === null)) {
        this.fileError = "Ogni domanda deve essere un oggetto JSON.";
        return;
      }
      // Domande già presenti: confronto su tipo, testo e dati.
      const existing = (await this.call("/api/admin/questions/fingerprints")).questions;
      const known = new Map();
      for (const e of existing) {
        let data = {};
        try {
          data = JSON.parse(e.data || "{}");
        } catch {
          // dati illeggibili: la domanda non coincide con nessuna
        }
        const key = questionKey(e.qtype, e.prompt, data);
        known.set(key, known.get(key) === "quiz" || e.in_quiz ? "quiz" : "bank");
      }
      const seen = new Set();
      this.rows = items.map((q) => {
        const key = questionKey(q.qtype, q.prompt, q.data);
        const status = seen.has(key) ? "dup" : known.get(key) || "new";
        seen.add(key);
        return { q, status, checked: status === "new" };
      });
      this.applyReplace();
    },
    /** Con la sostituzione le domande «già nella banca» vengono cancellate: vanno reimportate. */
    applyReplace() {
      for (const r of this.rows) if (r.status === "bank") r.checked = this.replace;
    },
    setAll(v) {
      for (const r of this.rows) r.checked = v;
    },
    setNewOnly() {
      for (const r of this.rows) r.checked = r.status === "new" || (this.replace && r.status === "bank");
    },
    async sendBatch(batch) {
      try {
        await this.call("/api/admin/questions/import", { method: "POST", json: { version: "1.0", kind: "questions", questions: batch } });
        return batch.length;
      } catch (e) {
        // Errore di validazione: inutile riprovare. Altrimenti (limite di CPU,
        // rete) si riprova una domanda alla volta.
        if (e.status === 400 || batch.length === 1) throw e;
        let n = 0;
        for (const q of batch) n += await this.sendBatch([q]);
        return n;
      }
    },
    async submit() {
      const chosen = this.rows.filter((r) => r.checked).map((r) => r.q);
      if (!chosen.length) return;
      if (this.replace && !confirm("Eliminare tutte le domande della banca che non stanno in un quiz e sostituirle con quelle selezionate?")) return;
      this.busy = true;
      let imported = 0;
      try {
        let prefix = "";
        if (this.replace) {
          this.progress = "Svuoto la banca…";
          prefix = (await this.call("/api/admin/questions/clear-bank", { method: "POST" })).message + " ";
        }
        for (let i = 0; i < chosen.length; i += IMPORT_BATCH) {
          this.progress = `Importo ${Math.min(i + IMPORT_BATCH, chosen.length)} di ${chosen.length}…`;
          imported += await this.sendBatch(chosen.slice(i, i + IMPORT_BATCH));
        }
        this.done(`${prefix}${imported} domande importate.`, "admin/domande/");
      } catch (e) {
        const msg = e.message.startsWith("Import non riuscito") ? e.message : `Import non riuscito: ${e.message}`;
        notify(`${msg} (${imported} domande importate prima dell'errore)`, "error");
      } finally {
        this.busy = false;
        this.progress = "";
      }
    },
  });

// --- Editor del contenuto (passo 2) ---------------------------------------------------

function hydrateFiles(d, side) {
  const files = d[`files_${side}`];
  if (Array.isArray(files) && files.length) return files.map((f) => ({ name: f.name || "", content: f.content || "", language: f.language || "" }));
  const snip = d[`snippet_${side}`];
  if (snip) return [{ name: "codice", content: snip, language: "" }];
  return [{ name: "", content: "", language: "" }];
}

// La riga errata si modifica come elenco di file, con le righe errate come [indice file, riga].
// Un solo file «codice» senza linguaggio proprio si salva nella forma a blocco unico
// (code + correct_lines numerate), quella delle domande di prima.
const SINGLE_NAME = "codice";
function hydrateWrongLine(d) {
  let files;
  let correct;
  if (Array.isArray(d.files) && d.files.length) {
    files = d.files.map((f) => ({ name: f.name || "", content: f.content || "", language: f.language || "", start_line: Number(f.start_line) || 1 }));
    correct = (d.correct_lines || [])
      .filter((e) => e && typeof e === "object")
      .map((e) => [files.findIndex((f) => f.name === String(e.file)), Number(e.line)])
      .filter(([i, n]) => i >= 0 && n);
  } else {
    files = [{ name: SINGLE_NAME, content: d.code || "", language: "", start_line: Number(d.start_line) || 1 }];
    correct = (d.correct_lines || []).map((n) => [0, Number(n)]).filter(([, n]) => n);
  }
  return { language: d.language || "java", files, correct, f: 0 };
}
const fileLines = (file) => (file.content || "").split("\n");
const fileStart = (file) => Number(file.start_line) || 1;

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

export const adminQuestionContent = () =>
  adminPage({
    ...questionHelpers,
    question: null,
    courses: [],
    languages: ["java", "python", "javascript", "typescript", "php", "sql", "html", "css", "xml", "yaml", "json", "ini", "dockerfile", "bash", "csharp", "kotlin", "cpp", "go", "ruby", "text"],
    // Dati e contenuto si salvano insieme: il tipo scelto nel form decide quale editor mostrare.
    form: { qtype: "TRUE_FALSE", course_id: "", difficulty: "1", prompt: "", explanation: "", is_active: true },
    get qtype() {
      return this.form.qtype;
    },
    tf: { statement: "", answer: true },
    mc: { multiple: false, options: [] },
    fwl: hydrateWrongLine({}),
    cc: { language: "java", label_a: "Versione A", label_b: "Versione B", correct: "a", files_a: [], files_b: [] },
    async init() {
      const id = idParam();
      if (!id) return (this.state = "notfound");
      await this.loadWith(async () => {
        const data = await this.call(`/api/admin/questions/${id}`);
        const q = data.question;
        this.question = q;
        this.courses = data.courses;
        this.form = {
          qtype: q.qtype || "TRUE_FALSE",
          course_id: q.course_id ? String(q.course_id) : "",
          difficulty: String(q.difficulty),
          prompt: q.prompt,
          explanation: q.explanation,
          is_active: q.is_active,
        };
        this.hydrate(q.data || {});
      });
    },
    hydrate(d) {
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
      this.fwl = hydrateWrongLine(d);
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
    get fwlFile() {
      return this.fwl.files[this.fwl.f] || this.fwl.files[0];
    },
    get fwlLines() {
      return fileLines(this.fwlFile);
    },
    lineNo(i) {
      return fileStart(this.fwlFile) + i;
    },
    toggleLine(i) {
      const n = this.lineNo(i);
      const f = this.fwl.f;
      const at = this.fwl.correct.findIndex(([j, m]) => j === f && m === n);
      if (at >= 0) this.fwl.correct.splice(at, 1);
      else this.fwl.correct.push([f, n]);
    },
    isBadLine(i) {
      const n = this.lineNo(i);
      return this.fwl.correct.some(([j, m]) => j === this.fwl.f && m === n);
    },
    fileHasBadLine(i) {
      return this.fwl.correct.some(([j]) => j === i);
    },
    validWrongLines() {
      const files = this.fwl.files;
      return this.fwl.correct
        .filter(([i, n]) => files[i] && n >= fileStart(files[i]) && n < fileStart(files[i]) + fileLines(files[i]).length)
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    },
    isSingleBlock() {
      const files = this.fwl.files;
      return files.length === 1 && files[0].name.trim() === SINGLE_NAME && !files[0].language;
    },
    sortedLines() {
      const single = this.isSingleBlock();
      return this.validWrongLines()
        .map(([i, n]) => (single ? String(n) : `${this.fwl.files[i].name.trim() || `file ${i + 1}`}:${n}`))
        .join(", ");
    },
    addWrongLineFile() {
      this.fwl.files.push({ name: "", content: "", language: "", start_line: 1 });
      this.fwl.f = this.fwl.files.length - 1;
    },
    removeWrongLineFile(i) {
      this.fwl.files.splice(i, 1);
      this.fwl.correct = this.fwl.correct.filter(([j]) => j !== i).map(([j, n]) => [j > i ? j - 1 : j, n]);
      if (!this.fwl.files.length) this.fwl.files.push({ name: SINGLE_NAME, content: "", language: "", start_line: 1 });
      this.fwl.f = Math.min(this.fwl.f, this.fwl.files.length - 1);
    },
    filesOf(side) {
      return side === "a" ? this.cc.files_a : this.cc.files_b;
    },
    addFile(side) {
      this.filesOf(side).push({ name: "", content: "", language: "" });
    },
    removeFile(side, i) {
      const arr = this.filesOf(side);
      arr.splice(i, 1);
      if (!arr.length) arr.push({ name: "", content: "", language: "" });
    },
    buildData() {
      if (this.qtype === "TRUE_FALSE") return { statement: this.tf.statement, answer: !!this.tf.answer };
      if (this.qtype === "MULTIPLE_CHOICE") {
        const options = this.mc.options.map((o, i) => ({ id: this.optLetter(i), text: o.text }));
        const correct = this.mc.options.map((o, i) => (o.ok ? this.optLetter(i) : null)).filter((x) => x);
        return { multiple: !!this.mc.multiple, options, correct };
      }
      if (this.qtype === "FIND_WRONG_LINE") {
        const files = this.fwl.files;
        const wrong = this.validWrongLines();
        if (this.isSingleBlock()) {
          return { language: this.fwl.language, code: files[0].content, correct_lines: wrong.map(([, n]) => n), start_line: fileStart(files[0]) };
        }
        return {
          language: this.fwl.language,
          files: files.map((f) => ({
            name: f.name.trim(),
            content: f.content,
            ...(f.language ? { language: f.language } : {}),
            ...(fileStart(f) !== 1 ? { start_line: fileStart(f) } : {}),
          })),
          correct_lines: wrong.map(([i, n]) => ({ file: files[i].name.trim(), line: n })),
        };
      }
      if (this.qtype === "CODE_COMPARISON") {
        return {
          language: this.cc.language,
          label_a: this.cc.label_a,
          label_b: this.cc.label_b,
          files_a: this.cc.files_a.map((f) => ({ name: f.name, content: f.content, ...(f.language ? { language: f.language } : {}) })),
          files_b: this.cc.files_b.map((f) => ({ name: f.name, content: f.content, ...(f.language ? { language: f.language } : {}) })),
          correct: this.cc.correct,
        };
      }
      return {};
    },
    fullQuestion() {
      return {
        qtype: this.qtype,
        prompt: this.form.prompt || "",
        explanation: this.form.explanation || "",
        difficulty: Number(this.form.difficulty) || 1,
        is_active: this.form.is_active !== false,
        data: this.buildData(),
      };
    },
    get jsonText() {
      return JSON.stringify(this.fullQuestion(), null, 2);
    },
    download() {
      downloadJson(this.fullQuestion(), `${(this.qtype || "domanda").toLowerCase()}.json`);
    },
    async submit() {
      const res = await this.submitForm(`/api/admin/questions/${this.question.id}`, "PUT", { ...this.form, data: this.buildData() });
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
        return s === "" || `${q.prompt} ${q.summary || ""}`.toLowerCase().includes(s);
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
