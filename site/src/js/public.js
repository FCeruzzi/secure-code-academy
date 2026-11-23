// Componenti Alpine delle pagine pubbliche: catalogo, slide, quiz, tornei.
import {
  admin,
  announce,
  api,
  ApiError,
  avatar,
  AVATARS,
  difficultyLabel,
  flash,
  focusCardTitle,
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

/**
 * Selezione vuota per una domanda (anche per il torneo). `picks`: nella riga errata, i
 * blocchi scelti ("i:prima-ultima") con la riga cliccata in ognuno; `lines` sono quelle righe.
 */
export function emptySelection() {
  return { answer: "", selected: [], lines: [], choice: "", picks: {} };
}

/** C'è una scelta da confermare? */
export function hasSelection(q, sel) {
  if (!q || !sel) return false;
  if (q.qtype === "TRUE_FALSE") return sel.answer === "true" || sel.answer === "false";
  if (q.qtype === "MULTIPLE_CHOICE") return sel.selected.length > 0;
  if (q.qtype === "FIND_WRONG_LINE") return sel.lines.length > 0;
  if (q.qtype === "CODE_COMPARISON") return sel.choice === "a" || sel.choice === "b";
  return false;
}

// --- Riga errata: un clic sceglie un blocco ------------------------------------------------
// Il server manda con ogni riga il suo blocco (`line.block`, "i:prima-ultima"): il «{ … }» più
// interno che la contiene, al massimo il metodo, oppure la sola riga. La stessa regola vale
// per la correzione, quindi pagina e punteggio non sono mai in disaccordo.

const blockRange = (b) => {
  const [i, r] = String(b).split(":");
  const [s, e] = String(r).split("-").map(Number);
  return [i, s, e];
};

/** La riga `key` ("i:n") sta nel blocco `b`? */
export function inBlock(b, key) {
  if (!b) return false;
  const [i, s, e] = blockRange(b);
  const [fi, n] = String(key).split(":");
  return fi === i && Number(n) >= s && Number(n) <= e;
}

const blocksOverlap = (a, b) => {
  const [i1, s1, e1] = blockRange(a);
  const [i2, s2, e2] = blockRange(b);
  return i1 === i2 && s1 <= e2 && s2 <= e1;
};

/** Il blocco di una riga della domanda (la riga sola se il server non lo dice). */
function blockOfLine(q, key) {
  for (const f of q?.code_files || []) {
    const line = f.lines.find((l) => l.key === key);
    if (line) return line.block || `${f.index}:${line.number}-${line.number}`;
  }
  const [i, n] = String(key).split(":");
  return `${i}:${n}-${n}`;
}

/** Ci sono blocchi di più righe? (Altrimenti la domanda si risponde a righe.) */
const hasBlocks = (q) =>
  (q?.code_files || []).some((f) => f.lines.some((l) => l.block && l.block !== `${f.index}:${l.number}-${l.number}`));

/**
 * Metodi della riga errata, condivisi da quiz e torneo: un clic sceglie il blocco della
 * riga; un nuovo clic sostituisce i blocchi che si sovrappongono (il metodo o l'«if» al suo
 * interno) e un secondo clic sullo stesso blocco lo toglie. Dopo la conferma (`locked`) no.
 */
const blockPicking = {
  inBlock,
  hasBlocks,
  pickLine(key, block) {
    if (this.locked) return;
    const picks = { ...this.sel.picks };
    if (picks[block]) delete picks[block];
    else {
      for (const b of Object.keys(picks)) if (blocksOverlap(b, block)) delete picks[b];
      picks[block] = key;
    }
    this.sel.picks = picks;
    this.sel.lines = Object.values(picks);
    this.changed();
  },
  pickedLine(key) {
    return Object.keys(this.sel.picks || {}).some((b) => inBlock(b, key));
  },
  pickedFile(index) {
    return Object.keys(this.sel.picks || {}).some((b) => b.startsWith(`${index}:`));
  },
};

// --- Classifica laterale e confronto di codice ----------------------------------------------

function readFlag(key, fallback) {
  try {
    const value = local.getItem(key);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key, value) {
  try {
    local.setItem(key, value ? "1" : "0");
  } catch {
    // Senza localStorage la scelta vale solo per questa pagina.
  }
}

/**
 * Classifica laterale dei tornei, come un «tree navigator»: chiusa è una linguetta sul bordo
 * destro, aperta un pannello alto quanto la finestra. Con 📌 resta aperta e la pagina si
 * sposta; senza, si chiude con un clic fuori o con Esc. La scelta resta nel browser. Le righe
 * arrivano con l'aggiornamento della scheda: aprirla non fa richieste in più.
 */
export const sideBoard = () => ({
  pinned: readFlag("sca_lb_pin", false),
  open: false,
  init() {
    this.open = this.pinned || readFlag("sca_lb", false);
  },
  set(open) {
    this.open = open;
    writeFlag("sca_lb", open);
  },
  show() {
    // Dopo il clic che apre: altrimenti lo stesso clic, «fuori» dal pannello, la richiude.
    // Il focus entra nel pannello, così chi usa la tastiera ci arriva subito.
    setTimeout(() => {
      this.set(true);
      this.$nextTick(() => this.$refs.boardClose?.focus());
    }, 0);
  },
  close() {
    if (!this.open) return;
    // Se il focus era nel pannello, torna sulla linguetta che lo riapre.
    const inside = this.$refs.board?.contains(document.activeElement);
    this.set(false);
    if (inside) this.$nextTick(() => this.$refs.boardTab?.focus());
  },
  /** Esc chiude il pannello, ma non quando sopra c'è il confronto a schermo intero. */
  escape() {
    if (!this.pinned && !document.querySelector('[aria-modal="true"]')) this.close();
  },
  togglePin() {
    this.pinned = !this.pinned;
    writeFlag("sca_lb_pin", this.pinned);
  },
});

/**
 * Confronto di codice: due pannelli con i file in un menu a lato, «Sync» (stessa riga,
 * stessa colonna e stesso file nei due pannelli) e «Full screen».
 */
export const codeCompare = () => ({
  sync: readFlag("sca_cc_sync", true),
  full: false,
  fa: 0,
  fb: 0,
  init() {
    this.root = this.$el;
    this.$watch("sync", (on) => {
      writeFlag("sca_cc_sync", on);
      if (on) this.align("a");
    });
    // Una domanda nuova riparte dal primo file, fuori dallo schermo intero.
    this.$watch("q", () => {
      this.fa = 0;
      this.fb = 0;
      this.full = false;
    });
  },
  /** Il codice visibile di un lato ("a" o "b"). */
  visible(side) {
    const pane = this.root.querySelector(`[data-side="${side}"]`);
    if (!pane) return null;
    return Array.from(pane.querySelectorAll("pre")).find((pre) => pre.offsetParent !== null) || null;
  },
  names(side) {
    const pane = this.root.querySelector(`[data-side="${side}"]`);
    return pane ? Array.from(pane.querySelectorAll("pre")).map((pre) => pre.dataset.name || "") : [];
  },
  /** Porta l'altro lato alla posizione di `side`. */
  align(side) {
    const from = this.visible(side);
    const to = this.visible(side === "a" ? "b" : "a");
    if (!from || !to) return;
    const top = to.scrollTop;
    const left = to.scrollLeft;
    to.scrollTop = from.scrollTop;
    to.scrollLeft = from.scrollLeft;
    // Lo scroll appena causato non deve tornare indietro: un codice più corto si ferma
    // prima e riporterebbe su anche l'altro.
    if (to.scrollTop !== top || to.scrollLeft !== left) to.dataset.followed = "1";
  },
  follow(pre, side) {
    if (pre.dataset.followed) {
      delete pre.dataset.followed;
      return;
    }
    if (this.sync) this.align(side);
  },
  /**
   * Il clic in un punto qualsiasi del pannello lo sceglie (come prima, quando tutto il
   * pannello era l'etichetta del radio); i pulsanti dei file no.
   */
  pick(side, event) {
    if (event?.target?.closest("button")) return;
    if (this.locked) return;
    this.sel.choice = side;
    this.changed?.();
  },
  /** Schermo intero: Esc lo chiude e il focus non esce dal confronto. */
  escape() {
    if (this.full) this.full = false;
  },
  trap(event) {
    if (!this.full) return;
    const items = Array.from(
      this.root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => el.getClientRects().length > 0);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  },
  /** Apre un file; con «Sync» apre anche quello con lo stesso nome dall'altro lato. */
  openFile(side, index) {
    this[side === "a" ? "fa" : "fb"] = index;
    if (!this.sync) return;
    const other = side === "a" ? "b" : "a";
    const match = this.names(other).indexOf(this.names(side)[index]);
    if (match >= 0) this[other === "a" ? "fa" : "fb"] = match;
    this.$nextTick(() => this.align(side));
  },
});

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
  if (q.qtype === "FIND_WRONG_LINE") {
    sel.lines = (submitted.lines || []).map((x) => (/^\d+:-?\d+$/.test(String(x)) ? String(x) : `0:${Number(x)}`));
    sel.picks = Object.fromEntries(sel.lines.map((k) => [blockOfLine(q, k), k]));
  }
  if (q.qtype === "CODE_COMPARISON") sel.choice = submitted.choice || "";
  return sel;
}

const isWide = (q) => Boolean(q && (q.qtype === "CODE_COMPARISON" || q.qtype === "FIND_WRONG_LINE"));

export const quizPlayPage = () =>
  quizPage(mix(blockPicking, {
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
    get chosen() {
      return hasSelection(this.q, this.sel);
    },
    changed() {},
    async submit() {
      if (!this.chosen) return;
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
        announce(res.correct ? "Risposta corretta." : "Risposta sbagliata: ecco quella giusta.");
        this.$nextTick(() => focusCardTitle(this.$root));
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
      announce(`Domanda ${this.index + 1} di ${this.questions.length}.`);
      this.$nextTick(() => focusCardTitle(this.$root));
    },
  }));

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
  page(mix(blockPicking, {
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
    // Ogni risposta si conferma con «Conferma risposta», poi resta quella.
    confirmed: false,
    // Per gli annunci a chi usa un lettore di schermo: la fase già annunciata e gli
    // avvisi sul tempo già dati per la domanda in corso.
    phaseKey: "",
    warned: {},

    get participant() {
      return local.getItem(participantKey(this.code)) || "";
    },
    get wide() {
      return isWide(this.q);
    },
    get locked() {
      return this.confirmed;
    },
    /** C'è una scelta (confermata o no). */
    get chosen() {
      return hasSelection(this.q, this.sel);
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
      this.phaseChanged();
    },

    /**
     * Una scheda nuova (domanda, esito, intervallo fra i round): chi usa un lettore di
     * schermo la sente annunciare e il focus va sul suo titolo, se si era perso con quella
     * di prima.
     */
    phaseChanged() {
      const c = this.card;
      if (this.kind !== "play" || !c) return;
      const key = `${c.run_phase}:${c.current_round}:${c.index}:${this.q ? 1 : 0}`;
      if (key === this.phaseKey) return;
      this.phaseKey = key;
      this.warned = {};
      let text = "";
      if (c.run_phase === "INTERMISSION") {
        text = `Round ${c.current_round} di ${c.num_rounds} concluso. In attesa del round successivo.`;
      } else if (c.run_phase === "QUESTION") {
        text = this.q ? `Domanda ${c.index} di ${c.total}: ${this.q.qtype_label || ""}.` : `Domanda ${c.index} di ${c.total} in arrivo.`;
      } else if (c.run_phase === "REVEAL" && this.rv) {
        if (this.rv.correct) text = `Risposta corretta: più ${this.rv.points} punti.`;
        else if (this.rv.timed_out) text = "Tempo scaduto. Ecco la risposta giusta.";
        else text = "Risposta sbagliata. Ecco quella giusta.";
      }
      announce(text);
      this.$nextTick(() => focusCardTitle(this.$root));
    },

    /** Ogni 200 ms: l'ora per il timer e gli avvisi a voce a 30 e a 10 secondi dalla fine. */
    tick() {
      this.now = Date.now();
      const c = this.card;
      if (c?.run_phase !== "QUESTION" || !this.q || !c.deadline_ms || this.waitingStart || this.locked) return;
      const left = this.remaining;
      const marks = [
        ["expired", 0, "Tempo scaduto.", true],
        ["s10", 10000, "Restano 10 secondi.", true],
        ["s30", 30000, "Restano 30 secondi.", false],
      ];
      for (const [name, at, text, urgent] of marks) {
        // Un avviso solo se la domanda dura di più (niente «30 secondi» su una da 20).
        if (left <= at && !this.warned[name] && (at === 0 || this.perQuestionMs > at + 5000)) {
          // Dato questo, quelli più lontani dalla fine non servono più.
          for (const [other, otherAt] of marks) if (otherAt >= at) this.warned[other] = true;
          announce(text, urgent);
          break;
        }
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
      // Un torneo concluso non cambia più: la classifica si legge una volta sola.
      if (this.kind === "leaderboard" && status !== "CLOSED") this.poll(3000, 3000);
      if (this.kind === "play") {
        this.poll(this.nextDelay(1200), 1500);
        setInterval(() => this.tick(), 200);
      }
    },

    /**
     * Fra una richiesta e l'altra, di solito `every`. Prima del via la domanda resta sul
     * server: la si chiede appena scatta l'ora di inizio, poi ogni 250 ms finché arriva.
     */
    nextDelay(every) {
      // Fra un round e l'altro si aspetta l'organizzatore: basta un controllo ogni 5 secondi.
      if (this.kind === "play" && this.card?.run_phase === "INTERMISSION") return Math.max(every, 5000);
      if (this.kind !== "play" || this.card?.run_phase !== "QUESTION" || this.q || !this.card?.starts_ms) return every;
      const untilStart = this.card.starts_ms - (Date.now() - this.skew);
      return untilStart > 0 ? Math.min(every, untilStart + 60) : 250;
    },

    /** Il polling è finito: la classifica di un torneo concluso non cambia più. */
    pollDone() {
      return this.kind === "leaderboard" && this.t?.status === "CLOSED";
    },

    /**
     * Polling a intervalli, senza sovrapposizioni. Ogni richiesta ha un costo anche quando
     * nessuno guarda: con la scheda nascosta si ferma e riparte appena torna visibile. Dopo
     * un errore rallenta (fino a 30 secondi), invece di insistere allo stesso ritmo.
     */
    poll(firstDelay, every) {
      let failures = 0;
      let inFlight = false;
      const schedule = (ms) => {
        clearTimeout(this.timer);
        this.timer = document.hidden || this.pollDone() ? null : setTimeout(tick, ms);
      };
      const tick = async () => {
        this.timer = null;
        if (document.hidden) return;
        inFlight = true;
        try {
          this.react(await this.fetchView());
          failures = 0;
        } catch {
          failures += 1;
        } finally {
          inFlight = false;
        }
        const delay = this.nextDelay(every);
        schedule(failures ? Math.min(30000, delay * 2 ** failures) : delay);
      };
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          clearTimeout(this.timer);
          this.timer = null;
        } else if (!this.timer && !inFlight) {
          schedule(0);
        }
      });
      schedule(firstDelay);
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

    /**
     * «Esci ed elimina i miei dati»: il server toglie nome, personaggio, risposte e punti,
     * il browser dimentica il codice di partecipazione.
     */
    async leave() {
      if (!this.participant || this.busy) return;
      if (!window.confirm("Uscire dal torneo ed eliminare il tuo nome, le risposte e i punti? Non si può annullare.")) return;
      this.busy = true;
      try {
        const res = await api(`/api/t/${encodeURIComponent(this.code)}/leave`, { method: "POST", participant: this.participant });
        local.removeItem(participantKey(this.code));
        flash(res.message);
        go("t/", { k: this.code });
      } catch (e) {
        notify(e.message, "error");
      } finally {
        this.busy = false;
      }
    },

    /** Scegliere non invia nulla: la risposta parte solo con «Conferma risposta». */
    changed() {},

    /**
     * «Conferma risposta», per ogni tipo di domanda: conta la prima conferma, il bonus
     * velocità si calcola da quel momento e poi la risposta non cambia più.
     */
    async confirm() {
      if (!this.q || this.expired || this.waitingStart || this.locked || !this.chosen || this.busy) return;
      this.busy = true;
      try {
        const res = await api(`/api/t/${encodeURIComponent(this.code)}/answer`, {
          method: "POST",
          json: { submission: submissionOf(this.q, this.sel) },
          participant: this.participant,
        });
        if (res.accepted) {
          this.confirmed = true;
          // «Hanno risposto» si aggiorna subito, senza aspettare il giro successivo.
          this.fetchView().then((data) => this.react(data), () => {});
        } else this.react(await this.fetchView());
      } catch (e) {
        // 409: già confermata (per esempio da un'altra scheda).
        if (e instanceof ApiError && e.status === 409) this.confirmed = true;
        else notify(e.message, "error");
      } finally {
        this.busy = false;
      }
    },
  }));
