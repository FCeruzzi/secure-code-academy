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
  init() {
    window.addEventListener("sca-logout", () => (this.loggedIn = false));
  },
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
    // Un'azione nella pagina sostituisce i messaggi precedenti, come se si cambiasse
    // pagina; quelli che arrivano insieme (esito più avvisi) restano uniti.
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

/** Uno slug di corso o di microcorso (lettere, cifre, trattini, trattini bassi). */
const SLUG = /^[A-Za-z0-9_-]{1,210}$/;

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
      // Solo slug: il corso finisce nel link verso cui si viene mandati.
      if (!SLUG.test(c) || !SLUG.test(m)) return (this.state = "notfound");
      try {
        const data = await api(`/api/courses/${encodeURIComponent(c)}/${encodeURIComponent(m)}`);
        const target = new URL(microcourseEntry(c, data.mc, data.entry), location.href);
        if (target.origin === location.origin) location.replace(target.href);
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
// I risultati stanno in sessionStorage, per la durata della scheda: una mappa
// {id domanda: corretta?}, azzerata dalla pagina di inizio del quiz. Lì si sceglie anche il
// seme del tentativo: a ogni tentativo domande e opzioni arrivano in un ordine diverso.

const quizKey = (mcId) => `quiz_${mcId}`;
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];

/** Il seme del tentativo in corso; se manca (link diretto al quiz) ne crea uno. */
function attemptSeed(mcId) {
  const stored = readJson(session, quizKey(mcId), { results: {} });
  if (Number.isInteger(stored.seed)) return stored.seed;
  stored.seed = newSeed();
  writeJson(session, quizKey(mcId), stored);
  return stored.seed;
}

function quizPage(def) {
  return page(mix({
    mc: null,
    course: null,
    questions: [],
    async loadQuiz(seeded = false) {
      const m = param("m");
      if (!/^\d+$/.test(m)) {
        this.state = "notfound";
        return false;
      }
      try {
        const data = await api(seeded ? `/api/quiz/${m}?seed=${attemptSeed(m)}` : `/api/quiz/${m}`);
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
      writeJson(session, quizKey(this.mc.id), { results: {}, seed: newSeed() });
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
  // Righe come chiavi "file:riga"; un numero da solo (risposte di prima) è una riga dell'unico file.
  if (q.qtype === "FIND_WRONG_LINE") sel.lines = (submitted.lines || []).map((x) => (/^\d+:-?\d+$/.test(String(x)) ? String(x) : `0:${Number(x)}`));
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
      if (!(await this.loadQuiz(true))) return;
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
    toggleLine(key) {
      this.sel.lines = this.sel.lines.includes(key) ? this.sel.lines.filter((x) => x !== key) : [...this.sel.lines, key];
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

/** Arrotondamento «al pari»: un 0,5 esatto va all'intero pari più vicino. */
function roundHalfEven(x) {
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
      this.pct = this.total ? roundHalfEven((this.correct / this.total) * 100) : 0;
      this.state = "ready";
    },
  });

// --- Tornei -----------------------------------------------------------------------------
// Il torneo si apre dal suo codice pubblico (`?k=`, il link di invito: non è un
// segreto); per iscriversi serve anche il PIN che dà l'organizzatore. Chi gioca è
// riconosciuto dal codice di partecipazione salvato nel browser (localStorage): il
// sito su github.io non può usare cookie dell'API, e senza localStorage non si
// rientrerebbe in gara dopo aver chiuso la scheda. Vale solo per quel torneo e non
// contiene dati personali.

const participantKey = (code) => `sca_t_${code}`;

/** Si gioca un torneo alla volta: entrando in uno nuovo si dimenticano i precedenti. */
function forgetOtherTournaments(code) {
  try {
    const keep = participantKey(code);
    const old = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith("sca_t_") && key !== keep) old.push(key);
    }
    old.forEach((key) => local.removeItem(key));
  } catch {
    // localStorage non disponibile: c'è solo la copia in memoria della pagina.
  }
}

export const tournamentPage = (kind) =>
  page({
    kind,
    code: param("k"),
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
    // Il PIN lo dà l'organizzatore, a voce o in chat: il link da solo non basta per entrare.
    form: { display_name: "", avatar: "", pin: "" },
    joinError: "",
    busy: false,
    timer: null,
    // Scelta multipla: si conferma con un pulsante, poi resta quella.
    confirmed: false,

    get participant() {
      return local.getItem(participantKey(this.code)) || "";
    },
    get wide() {
      return isWide(this.q);
    },
    get needsConfirm() {
      return this.q?.qtype === "MULTIPLE_CHOICE";
    },
    get locked() {
      return this.needsConfirm && this.confirmed;
    },
    get remaining() {
      return this.card ? this.card.deadline_ms - (this.now - this.skew) : 0;
    },
    get expired() {
      return Boolean(this.card && this.card.deadline_ms && this.remaining <= 0);
    },
    get perQuestionMs() {
      return (this.t?.rules?.per_question_seconds || 0) * 1000;
    },
    /** Secondi prima che parta il timer della domanda (il margine all'avvio della gara). */
    startsIn() {
      if (this.card?.run_phase !== "QUESTION" || !this.card?.starts_ms) return 0;
      return Math.max(0, Math.ceil((this.card.starts_ms - (this.now - this.skew)) / 1000));
    },
    get waitingStart() {
      return this.startsIn() > 0;
    },
    clock() {
      const left = this.perQuestionMs ? Math.min(this.remaining, this.perQuestionMs) : this.remaining;
      const s = Math.max(0, Math.ceil(left / 1000));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    },
    /** Quanto tempo resta, in percentuale, per la barra del timer. */
    timePct() {
      if (!this.perQuestionMs) return 0;
      return Math.max(0, Math.min(100, (this.remaining / this.perQuestionMs) * 100));
    },
    /** Verde, ambra sotto il 30%, rosso negli ultimi 10 secondi. */
    timerLevel() {
      if (this.remaining <= 10000) return "danger";
      if (this.perQuestionMs && this.remaining < 0.3 * this.perQuestionMs) return "warn";
      return "ok";
    },
    timerText() {
      return { ok: "text-slate-100", warn: "text-amber-300", danger: "text-rose-400 animate-pulse" }[this.timerLevel()];
    },
    timerBar() {
      return { ok: "bg-emerald-500", warn: "bg-amber-500", danger: "bg-rose-500" }[this.timerLevel()];
    },
    revealSeconds() {
      if (!this.card) return 0;
      return Math.max(0, Math.ceil((this.card.reveal_ms - (this.now - this.skew)) / 1000));
    },

    async fetchView() {
      const v = this.kind === "play" && this.viewKey ? `?v=${encodeURIComponent(this.viewKey)}` : "";
      const data = await api(`/api/t/${encodeURIComponent(this.code)}${v}`, { participant: this.participant });
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
      if (this.q && card.run_phase === "QUESTION") {
        this.sel = selectionOf(this.q, card.my_submission);
        this.confirmed = Boolean(card.my_submission);
      }
    },

    async load() {
      if (!/^[A-Za-z0-9_-]{8,40}$/.test(this.code)) return (this.state = "notfound");
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
          if (this.me) return go("t/sala/", { k: this.code });
          return status === "OPEN" ? "ready" : "closed";
        },
        waiting: () => {
          if (!this.me) return go("t/", { k: this.code });
          if (status === "RUNNING") return go("t/gioca/", { k: this.code });
          return status === "CLOSED" ? "concluded" : "ready";
        },
        play: () => {
          if (!this.me) return go("t/", { k: this.code });
          if (status === "OPEN") return go("t/sala/", { k: this.code });
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
        this.poll(this.nextDelay(1200), 1500);
        setInterval(() => (this.now = Date.now()), 200);
      }
    },

    /**
     * Fra una richiesta e l'altra, di solito `every`. Prima del via la domanda resta sul
     * server: la si chiede appena scatta l'ora di inizio, poi ogni 250 ms finché arriva.
     */
    nextDelay(every) {
      if (this.kind !== "play" || this.card?.run_phase !== "QUESTION" || this.q || !this.card?.starts_ms) return every;
      const untilStart = this.card.starts_ms - (Date.now() - this.skew);
      return untilStart > 0 ? Math.min(every, untilStart + 60) : 250;
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
        this.timer = setTimeout(tick, this.nextDelay(every));
      };
      this.timer = setTimeout(tick, firstDelay);
    },

    /** Cambia pagina quando cambia lo stato del torneo (iscrizioni, gara, fine). */
    react(data) {
      if (this.kind === "waiting") {
        if (!data.me) return go("t/", { k: this.code });
        if (data.status === "RUNNING") return go("t/gioca/", { k: this.code });
        if (data.status === "CLOSED") return go("t/fine/", { k: this.code });
      }
      if (this.kind === "play") {
        if (data.status === "CLOSED") return go("t/fine/", { k: this.code });
        if (data.status !== "RUNNING") return go("t/sala/", { k: this.code });
        this.applyCard(data.card);
      }
    },

    async join() {
      this.busy = true;
      this.joinError = "";
      try {
        const res = await api(`/api/t/${encodeURIComponent(this.code)}/join`, {
          method: "POST",
          json: this.form,
          participant: this.participant,
        });
        forgetOtherTournaments(this.code);
        local.setItem(participantKey(this.code), res.participant_token);
        go("t/sala/", { k: this.code });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) this.state = "closed";
        else if (e instanceof ApiError && e.status === 403) this.state = "concluded";
        else this.joinError = e.message;
      } finally {
        this.busy = false;
      }
    },

    toggleLine(key) {
      this.sel.lines = this.sel.lines.includes(key) ? this.sel.lines.filter((x) => x !== key) : [...this.sel.lines, key];
      this.changed();
    },

    /** Ogni selezione parte subito: vale l'ultima, fino al reveal. La scelta multipla aspetta la conferma. */
    async changed() {
      if (!this.q || this.expired || this.waitingStart || this.needsConfirm) return;
      try {
        const res = await api(`/api/t/${encodeURIComponent(this.code)}/answer`, {
          method: "POST",
          json: { submission: submissionOf(this.q, this.sel) },
          participant: this.participant,
        });
        if (!res.accepted) this.react(await this.fetchView());
      } catch (e) {
        notify(e.message, "error");
      }
    },

    async confirmChoice() {
      if (!this.q || this.expired || this.waitingStart || this.locked || !this.sel.selected.length) return;
      this.busy = true;
      try {
        const res = await api(`/api/t/${encodeURIComponent(this.code)}/answer`, {
          method: "POST",
          json: { submission: submissionOf(this.q, this.sel) },
          participant: this.participant,
        });
        if (res.accepted) this.confirmed = true;
        else this.react(await this.fetchView());
      } catch (e) {
        // 409: già confermata (per esempio da un'altra scheda).
        if (e instanceof ApiError && e.status === 409) this.confirmed = true;
        else notify(e.message, "error");
      } finally {
        this.busy = false;
      }
    },
  });
