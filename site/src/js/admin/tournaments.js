// Pannello: tornei, controllo della gara, monitor live e report.
import { avatar, downloadJson, flash, go, notify, param, url, widthPct } from "../core.js";
import { adminPage } from "./base.js";

const idParam = () => (/^\d+$/.test(param("id")) ? param("id") : "");
const STATUS_LABELS = { DRAFT: "Bozza", OPEN: "Aperto", RUNNING: "In corso", CLOSED: "Chiuso" };
const QTYPE_LABELS = {
  TRUE_FALSE: "Vero / Falso",
  MULTIPLE_CHOICE: "Scelta multipla",
  FIND_WRONG_LINE: "Individua la riga errata",
  CODE_COMPARISON: "Confronto di codice",
};
const DIFFICULTY_LABELS = { 1: "Base", 2: "Intermedio", 3: "Avanzato" };

// Mix dei tipi per round, come worker/src/tournament/mix.ts (che decide davvero all'avvio).
const MIX = [
  ["TRUE_FALSE", 15],
  ["MULTIPLE_CHOICE", 15],
  ["FIND_WRONG_LINE", 30],
  ["CODE_COMPARISON", 40],
];
function mixCounts(n) {
  const rows = MIX.map(([t, pct], i) => ({ t, i, base: Math.floor((n * pct) / 100), rest: (n * pct) / 100 - Math.floor((n * pct) / 100) }));
  let left = n - rows.reduce((s, r) => s + r.base, 0);
  for (const r of [...rows].sort((a, b) => b.rest - a.rest || a.i - b.i)) {
    if (left <= 0) break;
    r.base += 1;
    left -= 1;
  }
  return Object.fromEntries(rows.map((r) => [r.t, r.base]));
}

export const adminTournamentList = () =>
  adminPage({
    tournaments: [],
    statusLabel: (s) => STATUS_LABELS[s] || s,
    async init() {
      await this.loadWith(() => this.reload());
    },
    async reload() {
      this.tournaments = (await this.call("/api/admin/tournaments")).tournaments;
    },
    duplicate(t) {
      return this.action(`/api/admin/tournaments/${t.id}/duplicate`, {
        then: (res) => {
          flash(res.message);
          for (const w of res.warnings || []) flash(w, "warning");
          go("admin/tornei/modifica/", { id: res.id });
        },
      });
    },
    remove(t) {
      this.askDelete(t.title, () =>
        this.action(`/api/admin/tournaments/${t.id}`, {
          method: "DELETE",
          then: async (res) => {
            notify(res.message);
            await this.reload();
          },
        }),
      );
    },
  });

const emptyTournament = () => ({
  title: "",
  slug: "",
  description: "",
  courses: [],
  pool_size: "",
  num_rounds: 1,
  per_question_seconds: 60,
  start_delay_seconds: 5,
  reveal_seconds: 10,
  points_correct: 100,
  time_bonus: false,
  question_ids: [],
});

export const adminTournamentForm = () =>
  adminPage({
    tournament: null,
    allCourses: [],
    go,
    form: emptyTournament(),
    // "courses": estrazione dalla banca dei corsi; "pick": domande scelte a mano.
    mode: "courses",
    bank: [],
    bankState: "idle",
    bankFilter: { course: "", qtype: "", difficulty: "", q: "" },
    qtypes: Object.entries(QTYPE_LABELS),
    qtypeLabel: (q) => QTYPE_LABELS[q] || q,
    difficultyLabel: (d) => DIFFICULTY_LABELS[d] || "",
    async init() {
      const id = idParam();
      await this.loadWith(async () => {
        this.allCourses = (await this.call("/api/admin/tournament-courses")).courses;
        if (!id) return;
        const t = (await this.call(`/api/admin/tournaments/${id}`)).tournament;
        this.tournament = t;
        this.form = {
          ...emptyTournament(),
          ...t,
          pool_size: t.pool_size ?? "",
          courses: t.courses.map((c) => String(c.id)),
          question_ids: t.question_ids || [],
        };
        if (this.form.question_ids.length) this.mode = "pick";
      });
      if (this.mode === "pick") await this.loadBank();
    },
    get title() {
      return this.tournament ? "Modifica torneo" : "Nuovo torneo";
    },
    async loadBank() {
      if (this.bankState !== "idle") return;
      this.bankState = "loading";
      try {
        this.bank = (await this.call("/api/admin/tournament-questions")).questions;
        // Domande scelte che nel frattempo sono finite in un quiz o disattivate: via.
        const usable = new Set(this.bank.map((q) => q.id));
        this.form.question_ids = this.form.question_ids.filter((id) => usable.has(id));
        this.bankState = "ready";
      } catch (e) {
        this.bankState = "idle";
        notify(e.message, "error");
      }
    },
    get filteredBank() {
      const f = this.bankFilter;
      const s = f.q.trim().toLowerCase();
      return this.bank.filter(
        (q) =>
          (!f.course || String(q.course_id) === f.course) &&
          (!f.qtype || q.qtype === f.qtype) &&
          (!f.difficulty || String(q.difficulty) === f.difficulty) &&
          (!s || `${q.prompt} ${q.summary || ""}`.toLowerCase().includes(s)),
      );
    },
    pickFiltered(on) {
      const ids = new Set(this.filteredBank.map((q) => q.id));
      const rest = this.form.question_ids.filter((id) => !ids.has(id));
      this.form.question_ids = on ? [...rest, ...ids] : rest;
    },
    get rounds() {
      return Math.max(1, Number(this.form.num_rounds) || 1);
    },
    /** Il mix per tipo: per round, in tutto e (con le domande scelte) quante ne hai scelte. */
    get mixRows() {
      const picked = this.mode === "pick";
      const chosen = {};
      const byId = new Map(this.bank.map((q) => [q.id, q.qtype]));
      for (const id of this.form.question_ids) chosen[byId.get(id)] = (chosen[byId.get(id)] || 0) + 1;
      const n = Number(this.form.pool_size) || (picked ? Math.floor(this.form.question_ids.length / this.rounds) : 0);
      const counts = n ? mixCounts(n) : null;
      return MIX.map(([qtype, pct]) => {
        const perRound = counts ? counts[qtype] : null;
        const needed = perRound === null ? null : perRound * this.rounds;
        return {
          qtype,
          pct,
          label: QTYPE_LABELS[qtype],
          perRound,
          needed,
          chosen: chosen[qtype] || 0,
          ok: picked ? (needed === null ? null : (chosen[qtype] || 0) >= needed && n > 0) : null,
        };
      });
    },
    async submit() {
      const pick = this.mode === "pick";
      const payload = {
        ...this.form,
        courses: pick ? [] : this.form.courses.map(Number),
        question_ids: pick ? this.form.question_ids.map(Number) : [],
      };
      const res = this.tournament
        ? await this.submitForm(`/api/admin/tournaments/${this.tournament.id}`, "PUT", payload)
        : await this.submitForm("/api/admin/tournaments", "POST", payload);
      if (!res) return;
      flash(res.message);
      // L'avviso sul pool di domande segue il messaggio di salvataggio.
      for (const w of res.warnings || []) flash(w, "warning");
      this.go("admin/tornei/gestisci/", { id: res.id });
    },
  });

export const adminTournamentManage = () =>
  adminPage({
    t: null,
    status: "",
    participants: [],
    items: [],
    plan: null,
    monitor: null,
    // PIN di iscrizione: c'è solo a iscrizioni aperte, e lo vede solo il pannello.
    pin: null,
    copied: false,
    skew: 0,
    now: Date.now(),
    avatar,
    widthPct,
    statusLabel: (s) => STATUS_LABELS[s] || s,
    qtypeLabel: (q) => QTYPE_LABELS[q] || q,
    async init() {
      const id = idParam();
      if (!id) return (this.state = "notfound");
      await this.loadWith(() => this.reload(id));
      if (this.state !== "ready") return;
      setInterval(() => (this.now = Date.now()), 200);
      // Monitor ogni 2 s, a iscrizioni aperte e durante la gara: aggiorna anche lo stato del torneo.
      const tick = async () => {
        if (this.status === "RUNNING" || this.status === "OPEN") {
          try {
            const m = await this.call(`/api/admin/tournaments/${this.t.id}/monitor`);
            if (this.status === "OPEN") {
              // A iscrizioni aperte gli iscritti compaiono subito, e chi non deve esserci si toglie.
              this.participants = m.participants;
              if (m.status !== "OPEN") await this.reload();
            } else {
              this.monitor = m;
              this.skew = Date.now() - m.now_ms;
              if (m.status !== "RUNNING") await this.reload();
            }
          } catch {
            // si riprova al giro successivo
          }
        }
        setTimeout(tick, 2000);
      };
      tick();
    },
    async reload(id = this.t.id) {
      const data = await this.call(`/api/admin/tournaments/${id}/manage`);
      this.t = data.tournament;
      this.status = data.status;
      this.participants = data.participants;
      this.items = data.items;
      this.plan = data.plan;
      this.pin = data.join_pin || null;
    },
    /** «2 Vero / Falso · 1 Scelta multipla · …» per un round. */
    get planText() {
      if (!this.plan || !this.plan.per_round) return "";
      return MIX.map(([t]) => `${this.plan.counts[t]} ${QTYPE_LABELS[t]}`).join(" · ");
    },
    get joinUrl() {
      return new URL(url("t/", { k: this.t.join_token }), location.href).href;
    },
    copy() {
      navigator.clipboard.writeText(this.joinUrl);
      this.copied = true;
      setTimeout(() => (this.copied = false), 1500);
    },
    get remaining() {
      return this.monitor ? this.monitor.deadline_ms - (this.now - this.skew) : 0;
    },
    /** Secondi prima che parta il timer della prima domanda, all'avvio. */
    startsIn() {
      if (!this.monitor?.starts_ms) return 0;
      return Math.max(0, Math.ceil((this.monitor.starts_ms - (this.now - this.skew)) / 1000));
    },
    clock() {
      const total = (this.monitor?.per_question_seconds || 0) * 1000;
      const s = Math.max(0, Math.ceil((total ? Math.min(this.remaining, total) : this.remaining) / 1000));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    },
    clockClass() {
      if (this.startsIn() > 0) return "text-sky-300";
      if (this.remaining <= 10000) return "text-rose-400 animate-pulse";
      const total = (this.monitor?.per_question_seconds || 0) * 1000;
      return total && this.remaining < 0.3 * total ? "text-amber-300" : "text-slate-100";
    },
    duplicate(t) {
      return this.action(`/api/admin/tournaments/${t.id}/duplicate`, {
        then: (res) => {
          flash(res.message);
          for (const w of res.warnings || []) flash(w, "warning");
          go("admin/tornei/modifica/", { id: res.id });
        },
      });
    },
    /** Il torneo in un file JSON (partecipanti, classifica, domande, risposte), da reimportare con «Importa torneo». */
    async exportJson() {
      const data = await this.action(`/api/admin/tournaments/${this.t.id}/export`, { method: "GET" });
      if (data) downloadJson(data, `torneo-${this.t.slug}.json`);
    },
    revealSeconds() {
      if (!this.monitor) return 0;
      return Math.max(0, Math.ceil((this.monitor.reveal_ms - (this.now - this.skew)) / 1000));
    },
    get answeredIds() {
      return new Set((this.monitor?.participants || []).filter((p) => p.answered).map((p) => p.id));
    },
    async run(path, json) {
      await this.action(`/api/admin/tournaments/${this.t.id}/${path}`, {
        json,
        then: async (res) => {
          if (res.message) notify(res.message);
          for (const w of res.warnings || []) notify(w, "warning");
          this.monitor = null;
          await this.reload();
          if (this.status === "RUNNING") {
            const m = await this.call(`/api/admin/tournaments/${this.t.id}/monitor`);
            this.monitor = m;
            this.skew = Date.now() - m.now_ms;
          }
        },
      });
    },
    setStatus(status) {
      return this.run("status", { status });
    },
    /** Un PIN nuovo se quello vecchio è girato dove non doveva: chi è già iscritto resta. */
    newPin() {
      if (!confirm("Generare un nuovo PIN? Chi non è ancora entrato dovrà usare quello nuovo; chi è già iscritto resta in gara.")) return;
      return this.action(`/api/admin/tournaments/${this.t.id}/pin`, {
        then: (res) => {
          this.pin = res.pin;
          notify(res.message);
        },
      });
    },
    /** Toglie un iscritto (nome offensivo, iscrizione falsa) con i suoi punti e le sue risposte. */
    removeParticipant(p) {
      if (!confirm(`Togliere «${p.display_name}» dal torneo? Perde punti e risposte, e a gara avviata non può più rientrare.`)) return;
      return this.run(`participants/${p.id}/remove`);
    },
    finishNow() {
      if (!confirm("Terminare subito il torneo per tutti? I punteggi vengono congelati e viene mostrata la classifica finale.")) return;
      return this.run("finish");
    },
  });

/** «Importa torneo»: il file di «Esporta (JSON)», anche dell'altra versione del sito, diventa un torneo nuovo. */
export const adminTournamentImport = () =>
  adminPage({
    state: "ready",
    payload: null,
    info: null,
    async loadFile() {
      this.payload = null;
      this.info = null;
      const data = await this.readFile();
      if (!data) return;
      if (data.format !== "secure-code-academy/tournament" || typeof data.tournament !== "object" || !data.tournament) {
        this.fileError = "Il file non è il backup di un torneo: usa quello scaricato con «💾 Esporta (JSON)».";
        return;
      }
      const list = (v) => (Array.isArray(v) ? v : []);
      const t = data.tournament;
      const when = t.finished_at || t.started_at || data.exported_at;
      const date = when ? new Date(when) : null;
      this.payload = data;
      this.info = {
        title: String(t.title || "—"),
        when: date && !Number.isNaN(date.getTime()) ? date.toLocaleString("it-IT", { dateStyle: "long", timeStyle: "short" }) : "",
        source: data.source === "cloudflare" ? "un sito su Cloudflare" : data.source ? "un'altra installazione" : "",
        participants: list(data.participants).length,
        questions: list(data.questions).length,
        rounds: Number(t.num_rounds) || 1,
      };
    },
    async submit() {
      if (!this.payload) return;
      this.busy = true;
      await this.action("/api/admin/tournaments/import", {
        json: this.payload,
        then: (res) => {
          flash(res.message);
          for (const w of res.warnings || []) flash(w, "warning");
          go("admin/tornei/gestisci/", { id: res.id });
        },
      });
      this.busy = false;
    },
  });

export const adminTournamentReport = () =>
  adminPage({
    t: null,
    report: null,
    open: null,
    avatar,
    qtypeLabel: (q) => QTYPE_LABELS[q] || q,
    async init() {
      const id = idParam();
      if (!id) return (this.state = "notfound");
      await this.loadWith(async () => {
        const data = await this.call(`/api/admin/tournaments/${id}/report`);
        this.t = data.tournament;
        this.report = data;
      });
    },
    pctColor(pct, kind = "text") {
      const c = pct >= 70 ? "emerald" : pct >= 40 ? "amber" : "rose";
      return kind === "text" ? `text-${c}-300` : `bg-${c}-500`;
    },
  });
