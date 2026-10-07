// Componenti Alpine delle pagine pubbliche: catalogo, slide, quiz, tornei.
import {
  admin,
  api,
  ApiError,
  avatar,
  AVATARS,
  difficultyLabel,
  go,
  local,
  mix,
  notify,
  param,
  readJson,
  SECTION_LABELS,
  sectionColor,
  session,
  takeFlash,
  url,
  widthPct,
  writeJson,
} from "./core.js";

const SITE = "Secure Code Academy";

/** Funzioni usate dai template, disponibili in ogni componente. */
export const helpers = {
  url,
  avatar,
  sectionColor,
  sectionLabel: (s) => SECTION_LABELS[s] || s,
  difficultyLabel,
  widthPct,
};

/** Base di una pagina che carica dati: stato, errore, 404. */
function page(def) {
  return mix(helpers, {
    state: "loading",
    error: "",
    fail(e) {
      if (e instanceof ApiError && e.status === 404) this.state = "notfound";
      else {
        this.error = e && e.message ? e.message : "";
        this.state = "error";
      }
    },
  }, def);
}

const setTitle = (...parts) => {
  document.title = [...parts.filter(Boolean), SITE].join(" · ");
};

// --- Intestazione e messaggi ---------------------------------------------------------

export const navBar = () => ({
  loggedIn: Boolean(admin.token()),
  async logout() {
    try {
      await api("/api/admin/logout", { method: "POST", auth: true });
    } catch {
      // La sessione potrebbe essere già scaduta: si esce comunque.
    }
    admin.clear();
    go("/");
  },
});

export const flashMessages = () => ({
  messages: takeFlash(),
  last: 0,
  init() {
    // Un'azione nella pagina sostituisce i messaggi precedenti, come una nuova
    // pagina nella versione Django; quelli che arrivano insieme (esito più avvisi) restano uniti.
    window.addEventListener("sca-flash", (e) => {
      const now = Date.now();
      this.messages = now - this.last < 500 ? [...this.messages, e.detail] : [e.detail];
      this.last = now;
    });
  },
});

// --- Catalogo -------------------------------------------------------------------------

export const homePage = () =>
  page({
    courses: [],
    openTournament: null,
    async load() {
      try {
        const data = await api("/api/home");
        this.courses = data.courses;
        this.openTournament = data.open_tournament;
        this.state = "ready";
      } catch (e) {
        this.fail(e);
      }
    },
  });

export const courseListPage = () =>
  page({
    courses: [],
    async load() {
      try {
        this.courses = (await api("/api/courses")).courses;
        this.state = "ready";
      } catch (e) {
        this.fail(e);
      }
    },
  });

/** Dove porta un microcorso dalla pagina del corso. */
function microcourseEntry(courseSlug, mc, entry) {
  if (entry === "slide") return url("slide/", { c: courseSlug, m: mc.slug, n: 1 });
  if (entry === "quiz") return url("quiz/", { m: mc.id });
  return url("corso/", { c: courseSlug });
}

export const coursePage = () =>
  page({
    course: null,
    microcourses: [],
    presentations: [],
    resources: [],
    async load() {
      const slug = param("c");
      if (!slug) return (this.state = "notfound");
      try {
        const data = await api(`/api/courses/${encodeURIComponent(slug)}`);
        Object.assign(this, data);
        setTitle(data.course.title);
        this.state = "ready";
      } catch (e) {
        this.fail(e);
      }
    },
    mcUrl(mc) {
      return microcourseEntry(this.course.slug, mc, mc.entry);
    },
  });

export const microcoursePage = () =>
  page({
    async load() {
      const c = param("c");
      const m = param("m");
      if (!c || !m) return (this.state = "notfound");
      try {
        const data = await api(`/api/courses/${encodeURIComponent(c)}/${encodeURIComponent(m)}`);
        location.replace(microcourseEntry(c, data.mc, data.entry));
      } catch (e) {
        this.fail(e);
      }
    },
  });

export const slidePage = () =>
  page({
    course: null,
    mc: null,
    slide: null,
    position: 0,
    total: 0,
    hasQuiz: false,
    async load() {
      const c = param("c");
      const m = param("m");
      const n = parseInt(param("n") || "1", 10);
      if (!c || !m || !Number.isInteger(n)) return (this.state = "notfound");
      try {
        const data = await api(`/api/courses/${encodeURIComponent(c)}/${encodeURIComponent(m)}/slides/${n}`);
        Object.assign(this, { course: data.course, mc: data.mc, slide: data.slide, position: data.position, total: data.total, hasQuiz: data.has_quiz });
        setTitle(data.slide.title || data.mc.title);
        this.state = "ready";
      } catch (e) {
        this.fail(e);
      }
    },
    slideUrl(n) {
      return url("slide/", { c: this.course.slug, m: this.mc.slug, n });
    },
  });

export const presentationPage = () =>
  page({
    course: null,
    presentation: null,
    async load() {
      const c = param("c");
      const p = param("p");
      if (!c || !/^\d+$/.test(p)) return (this.state = "notfound");
      try {
        const data = await api(`/api/courses/${encodeURIComponent(c)}/presentations/${p}`);
        Object.assign(this, data);
        setTitle(data.presentation.title || "Presentazione");
        this.state = "ready";
      } catch (e) {
        this.fail(e);
      }
    },
  });

// --- Quiz dei microcorsi ----------------------------------------------------------------
// I risultati stanno in sessionStorage, come nella sessione della versione Django: una mappa
// {id domanda: corretta?}, azzerata dalla pagina di inizio del quiz.

const quizKey = (mcId) => `quiz_${mcId}`;

function quizPage(def) {
  return page(mix({
    mc: null,
    course: null,
    questions: [],
    async loadQuiz() {
      const m = param("m");
      if (!/^\d+$/.test(m)) {
        this.state = "notfound";
        return false;
      }
      try {
        const data = await api(`/api/quiz/${m}`);
        Object.assign(this, data);
        setTitle(`Quiz · ${data.mc.title}`);
        return true;
      } catch (e) {
        this.fail(e);
        return false;
      }
    },
    mcUrl() {
      return url("microcorso/", { c: this.course.slug, m: this.mc.slug });
    },
  }, def));
}

export const quizStartPage = () =>
  quizPage({
    total: 0,
    async load() {
      if (!(await this.loadQuiz())) return;
      writeJson(session, quizKey(this.mc.id), { results: {} });
      this.total = this.questions.length;
      this.state = "ready";
    },
  });

/** Selezione vuota per una domanda (anche per il torneo). */
export function emptySelection() {
  return { answer: "", selected: [], lines: [], choice: "" };
}

/** Dalla selezione alla risposta da inviare al server. */
export function submissionOf(q, sel) {
  if (q.qtype === "TRUE_FALSE") return { answer: sel.answer === "true" };
  if (q.qtype === "MULTIPLE_CHOICE") return { selected: [...sel.selected] };
  if (q.qtype === "FIND_WRONG_LINE") return { lines: [...sel.lines] };
  if (q.qtype === "CODE_COMPARISON") return { choice: sel.choice || null };
  return {};
}

/** Ripristina la selezione da una risposta già inviata. */
export function selectionOf(q, submitted) {
  const sel = emptySelection();
  if (!submitted) return sel;
  if (q.qtype === "TRUE_FALSE" && typeof submitted.answer === "boolean") sel.answer = submitted.answer ? "true" : "false";
  if (q.qtype === "MULTIPLE_CHOICE") sel.selected = (submitted.selected || []).map(String);
  if (q.qtype === "FIND_WRONG_LINE") sel.lines = (submitted.lines || []).map(Number);
  if (q.qtype === "CODE_COMPARISON") sel.choice = submitted.choice || "";
  return sel;
}

const isWide = (q) => Boolean(q && (q.qtype === "CODE_COMPARISON" || q.qtype === "FIND_WRONG_LINE"));

export const quizPlayPage = () =>
  quizPage({
    index: 0,
    sel: emptySelection(),
    feedback: null,
    busy: false,
    submitError: "",
    async load() {
      if (!(await this.loadQuiz())) return;
      this.state = "ready";
    },
    get q() {
      return this.questions[this.index];
    },
    get rv() {
      return this.feedback;
    },
    get wide() {
      return isWide(this.q);
    },
    get isLast() {
      return this.index + 1 >= this.questions.length;
    },
    changed() {},
    toggleLine(n) {
      this.sel.lines = this.sel.lines.includes(n) ? this.sel.lines.filter((x) => x !== n) : [...this.sel.lines, n];
    },
    async submit() {
      this.busy = true;
      this.submitError = "";
      try {
        const res = await api(`/api/quiz/${this.mc.id}/answer`, {
          method: "POST",
          json: { question_id: this.q.id, submission: submissionOf(this.q, this.sel) },
        });
        const stored = readJson(session, quizKey(this.mc.id), { results: {} });
        stored.results = stored.results || {};
        stored.results[String(this.q.id)] = Boolean(res.correct);
        writeJson(session, quizKey(this.mc.id), stored);
        this.feedback = res;
      } catch (e) {
        this.submitError = e.message;
      } finally {
        this.busy = false;
      }
    },
    next() {
      if (this.isLast) {
        go("quiz/risultati/", { m: this.mc.id });
        return;
      }
      this.index += 1;
      this.sel = emptySelection();
      this.feedback = null;
    },
  });

/** round() di Python (pareggi al pari), come la percentuale della versione Django. */
function pyRound(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (Math.abs(diff - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(x);
}

export const quizResultsPage = () =>
  quizPage({
    correct: 0,
    total: 0,
    pct: 0,
    async load() {
      if (!(await this.loadQuiz())) return;
      const results = readJson(session, quizKey(this.mc.id), { results: {} }).results || {};
      this.correct = Object.values(results).filter(Boolean).length;
      this.total = this.questions.length;
      this.pct = this.total ? pyRound((this.correct / this.total) * 100) : 0;
      this.state = "ready";
    },
  });

// --- Tornei -----------------------------------------------------------------------------
// Chi gioca è riconosciuto da un token salvato nel browser (localStorage), al
// posto del cookie di sessione della versione Django.

const participantKey = (token) => `sca_t_${token}`;

export const tournamentPage = (kind) =>
  page({
    kind,
    token: param("k"),
    t: null,
    me: null,
    participants: [],
    card: null,
    q: null,
    rv: null,
    sel: emptySelection(),
    viewKey: "",
    skew: 0,
    now: Date.now(),
    avatars: AVATARS,
    form: { display_name: "", avatar: "" },
    joinError: "",
    busy: false,
    timer: null,

    get participant() {
      return local.getItem(participantKey(this.token)) || "";
    },
    get wide() {
      return isWide(this.q);
    },
    get remaining() {
      return this.card ? this.card.deadline_ms - (this.now - this.skew) : 0;
    },
    get expired() {
      return Boolean(this.card && this.card.deadline_ms && this.remaining <= 0);
    },
    clock() {
      const s = Math.max(0, Math.floor(this.remaining / 1000));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    },
    revealSeconds() {
      if (!this.card) return 0;
      return Math.max(0, Math.ceil((this.card.reveal_ms - (this.now - this.skew)) / 1000));
    },

    async fetchView() {
      const v = this.kind === "play" && this.viewKey ? `?v=${encodeURIComponent(this.viewKey)}` : "";
      const data = await api(`/api/t/${encodeURIComponent(this.token)}${v}`, { participant: this.participant });
      this.t = data;
      this.me = data.me;
      this.participants = data.participants;
      this.skew = Date.now() - data.now_ms;
      setTitle(data.title, "Torneo");
      return data;
    },

    applyCard(card) {
      if (!card) {
        this.card = null;
        return;
      }
      if (card.unchanged && this.card) {
        this.card = { ...this.card, ...card };
        return;
      }
      this.card = card;
      this.viewKey = card.view_key;
      this.q = card.question || null;
      this.rv = card.reveal || null;
      if (this.q && card.run_phase === "QUESTION") this.sel = selectionOf(this.q, card.my_submission);
    },

    async load() {
      if (!/^[A-Za-z0-9_-]{8,40}$/.test(this.token)) return (this.state = "notfound");
      let data;
      try {
        data = await this.fetchView();
      } catch (e) {
        return this.fail(e);
      }
      const { status } = data;
      const route = {
        landing: () => (status === "CLOSED" ? "concluded" : "ready"),
        join: () => {
          if (status === "CLOSED") return "concluded";
          if (this.me) return go("t/sala/", { k: this.token });
          return status === "OPEN" ? "ready" : "closed";
        },
        waiting: () => {
          if (!this.me) return go("t/", { k: this.token });
          if (status === "RUNNING") return go("t/gioca/", { k: this.token });
          return status === "CLOSED" ? "concluded" : "ready";
        },
        play: () => {
          if (!this.me) return go("t/", { k: this.token });
          if (status === "OPEN") return go("t/sala/", { k: this.token });
          if (status !== "RUNNING") return "concluded";
          this.applyCard(data.card);
          return "ready";
        },
        finish: () => "ready",
        leaderboard: () => "ready",
      }[this.kind];
      const next = route();
      if (typeof next === "string") this.state = next;
      if (this.state !== "ready") return;
      if (this.kind === "waiting") this.poll(2000, 2000);
      if (this.kind === "leaderboard") this.poll(3000, 3000);
      if (this.kind === "play") {
        this.poll(1200, 1500);
        setInterval(() => (this.now = Date.now()), 200);
      }
    },

    /** Polling a intervalli, senza sovrapposizioni. */
    poll(firstDelay, every) {
      const tick = async () => {
        try {
          const data = await this.fetchView();
          this.react(data);
        } catch {
          // Un errore di rete passeggero: si riprova al giro successivo.
        }
        this.timer = setTimeout(tick, every);
      };
      this.timer = setTimeout(tick, firstDelay);
    },

    /** Come i redirect htmx della versione Django quando lo stato del torneo cambia. */
    react(data) {
      if (this.kind === "waiting") {
        if (!data.me) return go("t/", { k: this.token });
        if (data.status === "RUNNING") return go("t/gioca/", { k: this.token });
        if (data.status === "CLOSED") return go("t/fine/", { k: this.token });
      }
      if (this.kind === "play") {
        if (data.status === "CLOSED") return go("t/fine/", { k: this.token });
        if (data.status !== "RUNNING") return go("t/sala/", { k: this.token });
        this.applyCard(data.card);
      }
    },

    async join() {
      this.busy = true;
      this.joinError = "";
      try {
        const res = await api(`/api/t/${encodeURIComponent(this.token)}/join`, {
          method: "POST",
          json: this.form,
          participant: this.participant,
        });
        local.setItem(participantKey(this.token), res.participant_token);
        go("t/sala/", { k: this.token });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) this.state = "closed";
        else if (e instanceof ApiError && e.status === 403) this.state = "concluded";
        else this.joinError = e.message;
      } finally {
        this.busy = false;
      }
    },

    toggleLine(n) {
      this.sel.lines = this.sel.lines.includes(n) ? this.sel.lines.filter((x) => x !== n) : [...this.sel.lines, n];
      this.changed();
    },

    /** Ogni selezione parte subito: vale l'ultima, fino al reveal. */
    async changed() {
      if (!this.q || this.expired) return;
      try {
        const res = await api(`/api/t/${encodeURIComponent(this.token)}/answer`, {
          method: "POST",
          json: { submission: submissionOf(this.q, this.sel) },
          participant: this.participant,
        });
        if (!res.accepted) this.react(await this.fetchView());
      } catch (e) {
        notify(e.message, "error");
      }
    },
  });
