// Pannello: tornei, controllo della gara, monitor live e report.
// Porta apps/tournaments/admin_views.py.
import { avatar, flash, go, notify, param, url, widthPct } from "../core.js";
import { adminPage } from "./base.js";

const idParam = () => (/^\d+$/.test(param("id")) ? param("id") : "");
const STATUS_LABELS = { DRAFT: "Bozza", OPEN: "Aperto", RUNNING: "In corso", CLOSED: "Chiuso" };
const QTYPE_LABELS = {
  TRUE_FALSE: "Vero / Falso",
  MULTIPLE_CHOICE: "Scelta multipla",
  FIND_WRONG_LINE: "Individua la riga errata",
  CODE_COMPARISON: "Confronto di codice",
};

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
  reveal_seconds: 5,
  points_correct: 100,
  time_bonus: false,
});

export const adminTournamentForm = () =>
  adminPage({
    tournament: null,
    allCourses: [],
    go,
    form: emptyTournament(),
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
        };
      });
    },
    get title() {
      return this.tournament ? "Modifica torneo" : "Nuovo torneo";
    },
    async submit() {
      const payload = { ...this.form, courses: this.form.courses.map(Number) };
      const res = this.tournament
        ? await this.submitForm(`/api/admin/tournaments/${this.tournament.id}`, "PUT", payload)
        : await this.submitForm("/api/admin/tournaments", "POST", payload);
      if (!res) return;
      flash(res.message);
      // Come nella versione Django: l'avviso sul pool di domande segue il messaggio di salvataggio.
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
    monitor: null,
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
      // Monitor ogni 2 s, come nella versione Django: aggiorna anche lo stato del torneo.
      const tick = async () => {
        if (this.status === "RUNNING") {
          try {
            const m = await this.call(`/api/admin/tournaments/${this.t.id}/monitor`);
            this.monitor = m;
            this.skew = Date.now() - m.now_ms;
            if (m.status !== "RUNNING") await this.reload();
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
    clock() {
      const s = Math.max(0, Math.floor(this.remaining / 1000));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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
    finishNow() {
      if (!confirm("Terminare subito il torneo per tutti? I punteggi vengono congelati e viene mostrata la classifica finale.")) return;
      return this.run("finish");
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
