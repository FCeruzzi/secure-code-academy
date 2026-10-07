// Pannello: corsi, materiale del corso, microcorsi, slide e immagini, import/export.
// Porta apps/catalog/admin_views.py.
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

export const adminCourseImport = () =>
  adminPage({
    state: "ready",
    progress: "",
    async submit() {
      const payload = await this.readFile();
      if (!payload) return;
      this.busy = true;
      try {
        // Prima il corso, poi un microcorso per richiesta: un corso intero in una
        // sola richiesta supererebbe il limite di CPU del Worker.
        const course = await this.call("/api/admin/courses/import", { method: "POST", json: payload });
        const bundles = Array.isArray(payload.microcourses) ? payload.microcourses : [];
        for (let i = 0; i < bundles.length; i++) {
          this.progress = `Microcorso ${i + 1} di ${bundles.length}…`;
          await this.call("/api/admin/microcourses/import", {
            method: "POST",
            json: { bundle: bundles[i], course_slug: course.slug, course_title: course.title },
          });
        }
        this.done(course.message, "admin/corsi/");
      } catch (e) {
        notify(e.message.startsWith("Import non riuscito") ? e.message : `Import non riuscito: ${e.message}`, "error");
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
