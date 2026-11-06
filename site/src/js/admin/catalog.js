// Pannello: corsi, materiale del corso, microcorsi, slide e immagini, import/export.
import { downloadJson, notify, param, SECTION_LABELS, truncate, url } from "../core.js";
import { adminPage } from "./base.js";

const SECTIONS = Object.entries(SECTION_LABELS);

const idParam = (name = "id") => (/^\d+$/.test(param(name)) ? param(name) : "");

// --- Corsi ------------------------------------------------------------------------------

export const adminCourseList = () =>
  adminPage({
    courses: [],
    async init() {
      await this.loadWith(() => this.reload());
    },
    async reload() {
      this.courses = (await this.call("/api/admin/courses")).courses;
    },
    async exportCourse(c) {
      const data = await this.action(`/api/admin/courses/${c.id}/export`, { method: "GET" });
      if (data) downloadJson(data, `corso-${c.slug}.json`);
    },
    remove(c) {
      this.askDelete(c.title, () =>
        this.action(`/api/admin/courses/${c.id}`, {
          method: "DELETE",
          then: async (res) => {
            notify(res.message);
            await this.reload();
          },
        }),
      );
    },
  });

const emptyCourse = () => ({ title: "", slug: "", icon: "", description: "", lab_url: "", order: 0, is_published: false });

export const adminCourseForm = () =>
  adminPage({
    course: null,
    presentations: [],
    resources: [],
    form: emptyCourse(),
    pres: { title: "", url: "", page_count: 0 },
    presErrors: {},
    res: { title: "", url: "" },
    async init() {
      const id = idParam();
      if (!id) {
        this.state = "ready";
        return;
      }
      await this.loadWith(() => this.reload(id));
    },
    async reload(id = this.course.id) {
      const data = await this.call(`/api/admin/courses/${id}`);
      Object.assign(this, { course: data.course, presentations: data.presentations, resources: data.resources });
      this.form = { ...emptyCourse(), ...data.course };
    },
    get title() {
      return this.course ? "Modifica corso" : "Nuovo corso — passo 1 di 2";
    },
    async submit() {
      const res = this.course
        ? await this.submitForm(`/api/admin/courses/${this.course.id}`, "PUT", this.form)
        : await this.submitForm("/api/admin/courses", "POST", this.form);
      if (!res) return;
      // Un corso nuovo atterra sulla sua pagina di modifica, per il materiale.
      if (this.course) this.done(res.message, "admin/corsi/");
      else this.done(res.message, "admin/corsi/modifica/", { id: res.id });
    },
    async addPresentation() {
      this.presErrors = {};
      try {
        const res = await this.call(`/api/admin/courses/${this.course.id}/presentations`, { method: "POST", json: this.pres });
        notify(res.message);
        this.pres = { title: "", url: "", page_count: 0 };
        await this.reload();
      } catch (e) {
        if (e.data && e.data.errors) this.presErrors = e.data.errors;
        notify(e.message, "error");
      }
    },
    async removePresentation(p) {
      if (!confirm("Eliminare la presentazione?")) return;
      await this.action(`/api/admin/presentations/${p.id}`, {
        method: "DELETE",
        then: async (res) => {
          notify(res.message);
          await this.reload();
        },
      });
    },
    async addResource() {
      await this.action(`/api/admin/courses/${this.course.id}/resources`, {
        json: this.res,
        then: async (r) => {
          notify(r.message);
          this.res = { title: "", url: "" };
          await this.reload();
        },
      });
    },
    async removeResource(r) {
      await this.action(`/api/admin/resources/${r.id}`, {
        method: "DELETE",
        then: async (res) => {
          notify(res.message);
          await this.reload();
        },
      });
    },
  });

/** I corsi di un file: un corso solo ("course") o più corsi ("courses"). */
function courseBundles(payload) {
  if (payload && Array.isArray(payload.courses)) return payload.courses;
  if (payload && payload.course) return [payload];
  return null;
}

export const adminCourseImport = () =>
  adminPage({
    state: "ready",
    progress: "",
    tree: [],
    get chosen() {
      return this.tree.filter((n) => n.checked);
    },
    async loadFile() {
      this.tree = [];
      const payload = await this.readFile();
      if (!payload) return;
      const bundles = courseBundles(payload);
      if (!bundles || bundles.some((b) => !b?.course?.slug)) {
        this.fileError = "Il file non contiene corsi (servono \"course\" con lo slug, o la lista \"courses\").";
        return;
      }
      const existing = new Set((await this.call("/api/admin/courses")).courses.map((c) => c.slug));
      this.tree = bundles.map((b) => {
        const exists = existing.has(b.course.slug);
        // Un consulente non sostituisce un corso già presente: il Worker lo rifiuta.
        const locked = exists && this.consultant;
        return {
          course: b.course,
          bundle: b,
          exists,
          locked,
          checked: !locked,
          mcs: (Array.isArray(b.microcourses) ? b.microcourses : []).map((m) => ({ bundle: m, checked: !locked })),
        };
      });
    },
    toggleCourse(node, on) {
      if (node.locked) return;
      node.checked = on;
      for (const m of node.mcs) m.checked = on;
    },
    async submit() {
      const chosen = this.chosen;
      if (!chosen.length) return;
      const replaced = chosen.filter((n) => n.exists).map((n) => n.course.title || n.course.slug);
      if (replaced.length && !confirm(`Questi corsi esistono già e verranno sostituiti (microcorsi, slide, quiz e materiale):\n\n${replaced.join("\n")}\n\nContinuare?`)) return;
      this.busy = true;
      try {
        let mcCount = 0;
        for (const [ci, node] of chosen.entries()) {
          this.progress = `Corso ${ci + 1} di ${chosen.length}…`;
          // Prima il corso, poi un microcorso per richiesta: un corso intero in una
          // sola richiesta supererebbe il limite di CPU del Worker.
          const { microcourses, ...rest } = node.bundle;
          const course = await this.call("/api/admin/courses/import", { method: "POST", json: { ...rest, kind: "course" } });
          const mcs = node.mcs.filter((m) => m.checked);
          for (const [i, m] of mcs.entries()) {
            this.progress = `Corso ${ci + 1} di ${chosen.length}: microcorso ${i + 1} di ${mcs.length}…`;
            await this.call("/api/admin/microcourses/import", {
              method: "POST",
              json: { bundle: m.bundle, course_slug: course.slug, course_title: course.title },
            });
            mcCount++;
          }
        }
        this.done(`${chosen.length} corsi e ${mcCount} microcorsi importati.`, "admin/corsi/");
      } catch (e) {
        notify(e.message.startsWith("Import non riuscito") ? e.message : `Import non riuscito: ${e.message}`, "error");
      } finally {
        this.busy = false;
        this.progress = "";
      }
    },
  });

export const adminCourseExport = () =>
  adminPage({
    tree: [],
    progress: "",
    async init() {
      await this.loadWith(async () => {
        const courses = (await this.call("/api/admin/courses")).courses;
        const lists = await Promise.all(courses.map((c) => this.call(`/api/admin/courses/${c.id}/microcourses`)));
        this.tree = courses.map((c, i) => ({
          course: c,
          checked: false,
          mcs: lists[i].microcourses.map((mc) => ({ mc, checked: false })),
        }));
      });
    },
    get chosenCourses() {
      return this.tree.filter((n) => n.checked).length;
    },
    get chosenMcs() {
      return this.tree.reduce((n, node) => n + (node.checked ? node.mcs.filter((m) => m.checked).length : 0), 0);
    },
    toggleCourse(node, on) {
      node.checked = on;
      for (const m of node.mcs) m.checked = on;
    },
    setAll(on) {
      for (const node of this.tree) this.toggleCourse(node, on);
    },
    async exportChosen() {
      const nodes = this.tree.filter((n) => n.checked);
      if (!nodes.length) return;
      this.busy = true;
      try {
        const courses = [];
        for (const [i, node] of nodes.entries()) {
          this.progress = `Corso ${i + 1} di ${nodes.length}…`;
          const data = await this.call(`/api/admin/courses/${node.course.id}/export`);
          const keep = new Set(node.mcs.filter((m) => m.checked).map((m) => m.mc.slug));
          data.microcourses = (data.microcourses || []).filter((b) => keep.has(b.microcourse?.slug));
          courses.push(data);
        }
        if (courses.length === 1) downloadJson(courses[0], `corso-${courses[0].course.slug}.json`);
        else downloadJson({ version: "1.0", kind: "courses", courses }, "corsi.json");
      } catch (e) {
        notify(`Export non riuscito: ${e.message}`, "error");
      } finally {
        this.busy = false;
        this.progress = "";
      }
    },
  });

// --- Microcorsi ---------------------------------------------------------------------------

export const adminMicrocourseList = () =>
  adminPage({
    course: null,
    microcourses: [],
    truncate,
    async init() {
      const id = idParam("corso");
      if (!id) return (this.state = "notfound");
      await this.loadWith(() => this.reload(id));
    },
    async reload(id = this.course.id) {
      Object.assign(this, await this.call(`/api/admin/courses/${id}/microcourses`));
    },
    async exportMc(mc) {
      const data = await this.action(`/api/admin/microcourses/${mc.id}/export`, { method: "GET" });
      if (data) downloadJson(data, `${mc.slug}.json`);
    },
    remove(mc) {
      this.askDelete(`${this.course.title} · ${mc.title}`, () =>
        this.action(`/api/admin/microcourses/${mc.id}`, {
          method: "DELETE",
          then: async (res) => {
            notify(res.message);
            await this.reload();
          },
        }),
      );
    },
  });

const emptyMc = () => ({ title: "", slug: "", summary: "", difficulty: 1, estimated_minutes: 10, order: 0, is_published: false });

export const adminMicrocourseForm = () =>
  adminPage({
    course: null,
    mc: null,
    slides: [],
    questionCount: 0,
    form: emptyMc(),
    async init() {
      const id = idParam();
      const courseId = idParam("corso");
      if (id) return this.loadWith(() => this.reload(id));
      if (!courseId) return (this.state = "notfound");
      await this.loadWith(async () => {
        this.course = (await this.call(`/api/admin/courses/${courseId}`)).course;
      });
    },
    async reload(id = this.mc.id) {
      const data = await this.call(`/api/admin/microcourses/${id}`);
      Object.assign(this, { mc: data.microcourse, course: data.course, slides: data.slides, questionCount: data.question_count });
      this.form = { ...emptyMc(), ...data.microcourse };
    },
    get title() {
      return this.mc ? "Modifica microcorso" : "Nuovo microcorso — passo 1 di 2";
    },
    get publicUrl() {
      return this.mc ? url("microcorso/", { c: this.course.slug, m: this.mc.slug }) : "";
    },
    async submit() {
      const res = this.mc
        ? await this.submitForm(`/api/admin/microcourses/${this.mc.id}`, "PUT", this.form)
        : await this.submitForm(`/api/admin/courses/${this.course.id}/microcourses`, "POST", this.form);
      if (res) this.done(res.message, "admin/microcorsi/modifica/", { id: res.id });
    },
    async exportMc() {
      const data = await this.action(`/api/admin/microcourses/${this.mc.id}/export`, { method: "GET" });
      if (data) downloadJson(data, `${this.mc.slug}.json`);
    },
    // Trascinamento: la lista si riordina mentre si trascina, l'ordine si salva al rilascio.
    dragIndex: null,
    dragFromOrder: "",
    slideIds() {
      return this.slides.map((s) => s.id).join(",");
    },
    dragStart(i, e) {
      this.dragIndex = i;
      this.dragFromOrder = this.slideIds();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(this.slides[i].id));
    },
    dragOver(i) {
      if (this.dragIndex === null || i === this.dragIndex) return;
      const [s] = this.slides.splice(this.dragIndex, 1);
      this.slides.splice(i, 0, s);
      this.dragIndex = i;
    },
    async dragEnd() {
      if (this.dragIndex === null) return;
      this.dragIndex = null;
      if (this.slideIds() !== this.dragFromOrder) await this.saveSlideOrder();
    },
    async saveSlideOrder() {
      this.busy = true;
      const res = await this.action(`/api/admin/microcourses/${this.mc.id}/slides/order`, {
        method: "PUT",
        json: { ids: this.slides.map((s) => s.id) },
      });
      this.busy = false;
      if (res) {
        this.slides.forEach((s, k) => (s.order = k + 1));
        notify(res.message);
      } else {
        // Ordine non salvato: torna quello del server (senza toccare il form sopra).
        this.slides = (await this.call(`/api/admin/microcourses/${this.mc.id}`)).slides;
      }
    },
    removeSlide(s) {
      this.askDelete(s.title || `Slide ${s.order}`, () =>
        this.action(`/api/admin/slides/${s.id}`, {
          method: "DELETE",
          then: async (res) => {
            notify(res.message);
            await this.reload();
          },
        }),
      );
    },
  });

export const adminBundleImport = () =>
  adminPage({
    state: "ready",
    async submit() {
      const payload = await this.readFile();
      if (!payload) return;
      this.busy = true;
      try {
        const res = await this.call("/api/admin/microcourses/import", { method: "POST", json: payload });
        this.done(res.message, "admin/microcorsi/modifica/", { id: res.id });
      } catch (e) {
        notify(e.message, "error");
      } finally {
        this.busy = false;
      }
    },
  });

// --- Slide ------------------------------------------------------------------------------

const emptySlide = () => ({ title: "", section: "THEORY", body_markdown: "", order: 0 });

export const adminSlideForm = () =>
  adminPage({
    sections: SECTIONS,
    mc: null,
    course: null,
    slide: null,
    images: [],
    form: emptySlide(),
    img: { ref_key: "", url: "", alt_text: "" },
    imgErrors: {},
    async init() {
      const id = idParam();
      const mcId = idParam("mc");
      if (id) return this.loadWith(() => this.reload(id));
      if (!mcId) return (this.state = "notfound");
      await this.loadWith(async () => {
        const data = await this.call(`/api/admin/microcourses/${mcId}`);
        this.mc = data.microcourse;
        this.course = data.course;
      });
    },
    async reload(id = this.slide.id) {
      const data = await this.call(`/api/admin/slides/${id}`);
      Object.assign(this, { slide: data.slide, mc: data.microcourse, course: data.course, images: data.images });
      this.form = { ...emptySlide(), ...data.slide };
    },
    get title() {
      return this.slide ? "Modifica slide" : "Nuova slide";
    },
    get backUrl() {
      return url("admin/microcorsi/modifica/", { id: this.mc.id });
    },
    async submit() {
      const res = this.slide
        ? await this.submitForm(`/api/admin/slides/${this.slide.id}`, "PUT", this.form)
        : await this.submitForm(`/api/admin/microcourses/${this.mc.id}/slides`, "POST", this.form);
      // Dopo la creazione si resta sulla slide, per il pannello delle immagini.
      if (res) this.done(res.message, "admin/slide/", { id: res.id });
    },
    async addImage() {
      this.imgErrors = {};
      try {
        const res = await this.call(`/api/admin/microcourses/${this.mc.id}/images`, { method: "POST", json: this.img });
        notify(res.message);
        this.img = { ref_key: "", url: "", alt_text: "" };
        await this.reload();
      } catch (e) {
        if (e.data && e.data.errors) this.imgErrors = e.data.errors;
        notify(e.message, "error");
      }
    },
    async removeImage(im) {
      await this.action(`/api/admin/images/${im.id}`, {
        method: "DELETE",
        then: async (res) => {
          notify(res.message);
          await this.reload();
        },
      });
    },
  });
