// Un torneo live: un Durable Object per torneo, identificato dal join_token.
// Porta apps/tournaments/services.py e la parte di stato di views.py.
//
// Il DO esegue una richiesta alla volta, quindi non serve il select_for_update
// della versione Django: le transizioni (reveal, avanzamento, chiusura) non possono più
// sovrapporsi. Le scadenze le fa scattare una sveglia (alarm) anche se nessuno
// sta interrogando il torneo; ogni richiesta controlla comunque se una scadenza
// è passata, come advance_if_due.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { shortToken } from "../lib/auth";
import { answerTexts, grade, parseSubmission, publicQuestion, type QuestionData, type RenderedQuestion } from "../lib/questions";

export const AVATARS = [
  { key: "ninja", emoji: "🥋", label: "Ninja" },
  { key: "robot", emoji: "🤖", label: "Robot" },
  { key: "alien", emoji: "👾", label: "Alieno" },
  { key: "detective", emoji: "🔍", label: "Detective" },
  { key: "wizard", emoji: "🧙", label: "Mago" },
  { key: "ghost", emoji: "👻", label: "Fantasma" },
  { key: "dragon", emoji: "🐉", label: "Drago" },
  { key: "fox", emoji: "🦊", label: "Volpe" },
  { key: "cat", emoji: "🐱", label: "Gatto" },
  { key: "owl", emoji: "🦉", label: "Gufo" },
  { key: "shark", emoji: "🦈", label: "Squalo" },
  { key: "unicorn", emoji: "🦄", label: "Unicorno" },
];
const AVATAR_KEYS = new Set(AVATARS.map((a) => a.key));

/**
 * Le domande che un torneo può pescare: attive e fuori da ogni quiz dei
 * microcorsi. Il quiz pubblico dà la soluzione di ogni sua domanda, quindi una
 * domanda condivisa si potrebbe risolvere lì durante la gara.
 */
export const TOURNAMENT_POOL = "q.is_active = 1 AND q.id NOT IN (SELECT question_id FROM quiz_questions)";

/** Tetto alle iscrizioni: per torneo e per rete (una classe dietro NAT ci sta). */
export const MAX_PARTICIPANTS = 200;
export const MAX_PER_NETWORK = 40;

export type Status = "DRAFT" | "OPEN" | "RUNNING" | "CLOSED";
export type Phase = "QUESTION" | "REVEAL" | "INTERMISSION";

export interface TournamentConfig {
  id: number;
  token: string;
  title: string;
  description: string;
  course_ids: number[];
  pool_size: number | null;
  num_rounds: number;
  per_question_seconds: number;
  reveal_seconds: number;
  points_correct: number;
  time_bonus: boolean;
}

interface RunState {
  status: Status;
  run_phase: Phase;
  current_round: number;
  current_index: number;
  current_started_at: number | null;
  reveal_started_at: number | null;
  started_at: number | null;
  finished_at: number | null;
}

type State = TournamentConfig & RunState;

type Item = {
  round: number;
  ord: number;
  question_id: number;
  qtype: string;
  prompt: string;
  explanation: string;
  course_id: number | null;
  course_title: string | null;
  data: string;
  render: string;
};

type ParticipantRow = {
  id: number;
  token: string;
  display_name: string;
  avatar_key: string;
  score: number;
  finished: number;
  finished_at: number | null;
};

type AnswerRow = {
  participant_id: number;
  question_id: number;
  submitted: string;
  is_correct: number;
  timed_out: number;
  awarded_points: number;
  answered_at: number;
};

/** Risultato di un'operazione: o i dati, o un errore leggibile con lo status HTTP. */
export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (status: number, error: string): Result<never> => ({ ok: false, status, error });

const STATUS_LABELS: Record<Status, string> = { DRAFT: "Bozza", OPEN: "Aperto", RUNNING: "In corso", CLOSED: "Chiuso" };

export class TournamentRoom extends DurableObject<Env> {
  private sql: SqlStorage;
  private state: State | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS items (
          round INTEGER NOT NULL, ord INTEGER NOT NULL, question_id INTEGER NOT NULL,
          qtype TEXT NOT NULL, prompt TEXT NOT NULL, explanation TEXT NOT NULL,
          course_id INTEGER, course_title TEXT, data TEXT NOT NULL, render TEXT NOT NULL,
          PRIMARY KEY (round, ord)
        );
        CREATE TABLE IF NOT EXISTS participants (
          id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL, avatar_key TEXT NOT NULL,
          score INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0,
          joined_at INTEGER NOT NULL, finished_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS answers (
          participant_id INTEGER NOT NULL, question_id INTEGER NOT NULL,
          submitted TEXT NOT NULL, is_correct INTEGER NOT NULL DEFAULT 0,
          timed_out INTEGER NOT NULL DEFAULT 0, awarded_points INTEGER NOT NULL DEFAULT 0,
          answered_at INTEGER NOT NULL,
          PRIMARY KEY (participant_id, question_id)
        );
        CREATE TABLE IF NOT EXISTS join_networks (net TEXT PRIMARY KEY, n INTEGER NOT NULL);
      `);
      const row = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'state'").toArray()[0];
      this.state = row ? (JSON.parse(row.v) as State) : null;
    });
  }

  // --- Persistenza --------------------------------------------------------------

  private save(): void {
    this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('state', ?)", JSON.stringify(this.state));
  }

  /** Specchio in D1 per l'elenco del pannello e il banner della home. */
  private async mirror(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM participants").one().n;
    const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
    await this.env.DB.prepare(
      "UPDATE tournaments SET status = ?, participant_count = ?, started_at = ?, finished_at = ? WHERE id = ?",
    )
      .bind(s.status, count, iso(s.started_at), iso(s.finished_at), s.id)
      .run();
  }

  private async scheduleAlarm(): Promise<void> {
    const s = this.state;
    let at: number | null = null;
    if (s && s.status === "RUNNING") {
      if (s.run_phase === "QUESTION" && s.current_started_at) at = s.current_started_at + s.per_question_seconds * 1000;
      else if (s.run_phase === "REVEAL" && s.reveal_started_at) at = s.reveal_started_at + s.reveal_seconds * 1000;
    }
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at + 5);
  }

  async alarm(): Promise<void> {
    if (await this.advanceIfDue()) await this.mirror();
    await this.scheduleAlarm();
  }

  // --- Lettura -----------------------------------------------------------------

  private roundItems(round = this.state?.current_round ?? 0): Item[] {
    return this.sql.exec<Item>("SELECT * FROM items WHERE round = ? ORDER BY ord", round).toArray();
  }

  private currentItem(items = this.roundItems()): Item | null {
    const idx = this.state?.current_index ?? 0;
    return idx >= 0 && idx < items.length ? items[idx] : null;
  }

  private participants(): ParticipantRow[] {
    // Ordine della classifica della versione Django: punteggio, poi chi ha finito prima, poi
    // ordine di iscrizione.
    return this.sql
      .exec<ParticipantRow>("SELECT * FROM participants ORDER BY score DESC, finished_at IS NULL, finished_at, id")
      .toArray();
  }

  private participantByToken(token: string | null | undefined): ParticipantRow | null {
    if (!token) return null;
    return this.sql.exec<ParticipantRow>("SELECT * FROM participants WHERE token = ?", token).toArray()[0] ?? null;
  }

  private answersFor(questionId: number): AnswerRow[] {
    return this.sql
      .exec<AnswerRow>(
        "SELECT a.* FROM answers a JOIN participants p ON p.id = a.participant_id WHERE a.question_id = ?",
        questionId,
      )
      .toArray();
  }

  private questionDeadline(): number | null {
    const s = this.state;
    if (s && s.status === "RUNNING" && s.run_phase === "QUESTION" && s.current_started_at) {
      return s.current_started_at + s.per_question_seconds * 1000;
    }
    return null;
  }

  private revealDeadline(): number | null {
    const s = this.state;
    if (s && s.status === "RUNNING" && s.run_phase === "REVEAL" && s.reveal_started_at) {
      return s.reveal_started_at + s.reveal_seconds * 1000;
    }
    return null;
  }

  // --- Transizioni ------------------------------------------------------------------

  /** Avanza secondo l'orologio del server. Restituisce true se lo stato è cambiato. */
  private async advanceIfDue(now = Date.now()): Promise<boolean> {
    const s = this.state;
    if (!s || s.status !== "RUNNING") return false;
    if (s.run_phase === "QUESTION") {
      const dl = this.questionDeadline();
      if (dl && now > dl) {
        this.enterReveal(now);
        return true;
      }
    } else if (s.run_phase === "REVEAL") {
      const dl = this.revealDeadline();
      if (dl && now > dl) {
        await this.advanceAfterReveal(now);
        return true;
      }
    }
    return false;
  }

  private backfillTimeouts(item: Item | null, now: number): void {
    if (!item) return;
    this.sql.exec(
      `INSERT OR IGNORE INTO answers (participant_id, question_id, submitted, is_correct, timed_out, awarded_points, answered_at)
       SELECT id, ?, '{}', 0, 1, 0, ? FROM participants`,
      item.question_id,
      now,
    );
  }

  /** Corregge e assegna i punti (idempotente: si applica la differenza). */
  private scoreQuestion(item: Item | null): void {
    const s = this.state!;
    if (!item) return;
    const deadline = s.current_started_at ? s.current_started_at + s.per_question_seconds * 1000 : null;
    const data = JSON.parse(item.data) as QuestionData;
    for (const a of this.answersFor(item.question_id)) {
      const result = grade(item.qtype, data, JSON.parse(a.submitted));
      let pts = 0;
      if (result.correct && !a.timed_out) {
        pts = s.points_correct;
        if (s.time_bonus && deadline) {
          const remaining = Math.max(0, (deadline - a.answered_at) / 1000);
          pts += Math.floor((s.points_correct * remaining) / s.per_question_seconds);
        }
      }
      // Chi non ha risposto non ha risposto bene: nella versione Django un Vero/Falso con
      // risposta «Falso» risultava corretto anche per chi era andato in timeout
      // (risposta vuota = falso), con 0 punti ma «✓ Corretto!» e nel report.
      const correct = result.correct && !a.timed_out ? 1 : 0;
      if (a.is_correct !== correct || a.awarded_points !== pts) {
        const delta = pts - a.awarded_points;
        this.sql.exec(
          "UPDATE answers SET is_correct = ?, awarded_points = ? WHERE participant_id = ? AND question_id = ?",
          correct,
          pts,
          a.participant_id,
          a.question_id,
        );
        if (delta) this.sql.exec("UPDATE participants SET score = score + ? WHERE id = ?", delta, a.participant_id);
      }
    }
  }

  private enterReveal(now: number): void {
    const s = this.state!;
    const item = this.currentItem();
    this.backfillTimeouts(item, now);
    this.scoreQuestion(item);
    s.run_phase = "REVEAL";
    s.reveal_started_at = now;
    this.save();
  }

  private close(now: number): void {
    const s = this.state!;
    s.status = "CLOSED";
    s.finished_at = now;
    s.run_phase = "QUESTION";
    s.reveal_started_at = null;
    this.sql.exec("UPDATE participants SET finished = 1, finished_at = ?", now);
    this.save();
  }

  private async advanceAfterReveal(now: number): Promise<void> {
    const s = this.state!;
    const items = this.roundItems();
    if (s.current_index + 1 < items.length) {
      s.current_index += 1;
      s.run_phase = "QUESTION";
      s.current_started_at = now;
      s.reveal_started_at = null;
      this.save();
    } else if (s.current_round < s.num_rounds) {
      // Altri round da giocare: classifica provvisoria finché l'admin non
      // avvia il round successivo.
      s.run_phase = "INTERMISSION";
      s.reveal_started_at = null;
      this.save();
    } else {
      this.close(now);
    }
  }

  /** Estrae le domande del round: un campione casuale, senza quelle già usate. */
  private async freezeRound(round: number): Promise<void> {
    const s = this.state!;
    this.sql.exec("DELETE FROM items WHERE round = ?", round);
    const used = new Set(this.sql.exec<{ question_id: number }>("SELECT question_id FROM items").toArray().map((r) => r.question_id));
    let pool: Item[] = [];
    if (s.course_ids.length) {
      const { results } = await this.env.DB.prepare(
        `SELECT q.id AS question_id, q.qtype, q.prompt, q.explanation, q.course_id, c.title AS course_title, q.data, q.render
         FROM questions q LEFT JOIN courses c ON c.id = q.course_id
         WHERE ${TOURNAMENT_POOL} AND q.course_id IN (${s.course_ids.map(() => "?").join(",")})`,
      )
        .bind(...s.course_ids)
        .all<Item>();
      pool = results.filter((q) => !used.has(q.question_id));
    }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    if (s.pool_size) pool = pool.slice(0, s.pool_size);
    pool.forEach((q, i) => {
      this.sql.exec(
        `INSERT INTO items (round, ord, question_id, qtype, prompt, explanation, course_id, course_title, data, render)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        round, i + 1, q.question_id, q.qtype, q.prompt, q.explanation, q.course_id, q.course_title, q.data, q.render,
      );
    });
    // In D1 restano i collegamenti, che impediscono di eliminare una domanda
    // usata in un torneo.
    const stmts = [this.env.DB.prepare("DELETE FROM tournament_questions WHERE tournament_id = ? AND round = ?").bind(s.id, round)];
    pool.forEach((q, i) =>
      stmts.push(
        this.env.DB.prepare("INSERT OR IGNORE INTO tournament_questions (tournament_id, question_id, round, sort_order) VALUES (?, ?, ?, ?)").bind(
          s.id,
          q.question_id,
          round,
          i + 1,
        ),
      ),
    );
    await this.env.DB.batch(stmts);
  }

  private async startRound(round: number, now: number): Promise<void> {
    const s = this.state!;
    await this.freezeRound(round);
    s.current_round = round;
    s.current_index = 0;
    s.reveal_started_at = null;
    if (!this.roundItems(round).length) {
      // Il pool è esaurito: il round non ha domande. Nella versione Django i giocatori finivano
      // su una pagina senza polling; qui il round si chiude subito.
      if (round < s.num_rounds) s.run_phase = "INTERMISSION";
      else this.close(now);
      this.save();
      return;
    }
    s.run_phase = "QUESTION";
    s.current_started_at = now;
    this.save();
  }

  private resetRun(): void {
    this.sql.exec("DELETE FROM answers");
    this.sql.exec("DELETE FROM participants");
    this.sql.exec("DELETE FROM join_networks");
    this.sql.exec("DELETE FROM items");
    Object.assign(this.state!, {
      status: "DRAFT",
      run_phase: "QUESTION",
      current_round: 0,
      current_index: 0,
      current_started_at: null,
      reveal_started_at: null,
      started_at: null,
      finished_at: null,
    } satisfies RunState);
    this.save();
  }

  // --- RPC: amministrazione ---------------------------------------------------------

  /** Salvataggio dal pannello: la configurazione vale subito, anche a gara in corso. */
  async configure(config: TournamentConfig): Promise<void> {
    if (!this.state) {
      this.state = {
        ...config,
        status: "DRAFT",
        run_phase: "QUESTION",
        current_round: 0,
        current_index: 0,
        current_started_at: null,
        reveal_started_at: null,
        started_at: null,
        finished_at: null,
      };
    } else {
      Object.assign(this.state, config);
    }
    this.save();
    await this.scheduleAlarm();
    await this.mirror();
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.state = null;
  }

  /** Apre le iscrizioni o torna in bozza (che azzera iscritti e domande). */
  async setStatus(status: Status): Promise<Result<string>> {
    const s = this.state;
    if (!s) return fail(404, "Torneo non trovato.");
    if (status === "DRAFT") {
      if (s.status !== "DRAFT") {
        this.resetRun();
        await this.env.DB.prepare("DELETE FROM tournament_questions WHERE tournament_id = ?").bind(s.id).run();
      }
    } else if (status === "OPEN") {
      if (s.status !== "DRAFT") return fail(400, "Le iscrizioni si aprono solo da un torneo in bozza.");
      s.status = "OPEN";
      this.save();
    } else {
      return fail(400, "Stato non valido.");
    }
    await this.scheduleAlarm();
    await this.mirror();
    return ok(`Stato del torneo: ${STATUS_LABELS[s.status]}.`);
  }

  async start(): Promise<Result<string>> {
    const s = this.state;
    if (!s) return fail(404, "Torneo non trovato.");
    if (s.status !== "OPEN") return fail(400, "La gara si avvia solo a iscrizioni aperte.");
    const now = Date.now();
    s.status = "RUNNING";
    s.started_at = now;
    s.finished_at = null;
    await this.startRound(1, now);
    await this.scheduleAlarm();
    await this.mirror();
    return ok("Gara avviata! 🏁");
  }

  async startNextRound(): Promise<Result<string>> {
    const s = this.state;
    if (!s) return fail(404, "Torneo non trovato.");
    if (s.status !== "RUNNING" || s.run_phase !== "INTERMISSION") return fail(400, "Nessun round da avviare.");
    await this.startRound(s.current_round + 1, Date.now());
    await this.scheduleAlarm();
    await this.mirror();
    return ok(`Round ${s.current_round} avviato!`);
  }

  /** «Mostra risposta e prosegui» durante la domanda, «Salta al prossimo» durante il reveal. */
  async next(): Promise<Result<string>> {
    const s = this.state;
    if (!s) return fail(404, "Torneo non trovato.");
    if (s.status !== "RUNNING") return ok("");
    const now = Date.now();
    if (s.run_phase === "QUESTION") this.enterReveal(now);
    else if (s.run_phase === "REVEAL") await this.advanceAfterReveal(now);
    await this.scheduleAlarm();
    await this.mirror();
    return ok("");
  }

  async finishNow(): Promise<Result<string>> {
    const s = this.state;
    if (!s) return fail(404, "Torneo non trovato.");
    if (s.status !== "RUNNING") return ok("Torneo terminato.");
    const now = Date.now();
    if (s.run_phase === "QUESTION") {
      const item = this.currentItem();
      this.backfillTimeouts(item, now);
      this.scoreQuestion(item);
    }
    this.close(now);
    await this.scheduleAlarm();
    await this.mirror();
    return ok("Torneo terminato.");
  }

  /** Pagina «Gestisci»: stato, iscritti e domande estratte. */
  async manageInfo() {
    if (await this.advanceIfDue()) {
      await this.scheduleAlarm();
      await this.mirror();
    }
    const s = this.state;
    if (!s) return null;
    const items = this.sql
      .exec<{ round: number; ord: number; qtype: string; prompt: string }>("SELECT round, ord, qtype, prompt FROM items ORDER BY round, ord")
      .toArray();
    return {
      status: s.status,
      participants: this.participants().map(publicParticipant),
      items,
    };
  }

  /** Monitor live del pannello (ogni 2 s). */
  async monitor() {
    if (await this.advanceIfDue()) {
      await this.scheduleAlarm();
      await this.mirror();
    }
    const s = this.state;
    if (!s) return null;
    const items = this.roundItems();
    const item = this.currentItem(items);
    const answered = new Set(item ? this.answersFor(item.question_id).map((a) => a.participant_id) : []);
    const participants = this.participants();
    const n = participants.length;
    const dl = this.questionDeadline();
    const now = Date.now();
    const expired = Boolean(dl && now > dl);
    return {
      status: s.status,
      run_phase: s.run_phase,
      current_round: s.current_round,
      num_rounds: s.num_rounds,
      q_index: s.current_index + 1,
      q_total: items.length,
      is_last: s.current_index + 1 >= items.length,
      n,
      answered: answered.size,
      expired,
      all_done: n > 0 && (answered.size >= n || expired),
      deadline_ms: dl ?? 0,
      reveal_ms: this.revealDeadline() ?? 0,
      now_ms: now,
      participants: participants.map((p) => ({ ...publicParticipant(p), answered: answered.has(p.id) })),
    };
  }

  /** Report finale: accuratezza per corso e dettaglio per partecipante. */
  async report() {
    const s = this.state;
    if (!s) return null;
    const answers = this.sql
      .exec<AnswerRow & Item>(
        `SELECT a.*, i.qtype, i.prompt, i.explanation, i.course_id, i.course_title, i.data, i.render
         FROM answers a JOIN participants p ON p.id = a.participant_id
         JOIN (SELECT question_id, MIN(round) AS round FROM items GROUP BY question_id) f ON f.question_id = a.question_id
         JOIN items i ON i.question_id = f.question_id AND i.round = f.round
         ORDER BY a.answered_at`,
      )
      .toArray();
    const topics = new Map<number, { name: string; total: number; correct: number; timed_out: number; pct?: number }>();
    for (const a of answers) {
      const key = a.course_id ?? 0;
      const row = topics.get(key) ?? { name: a.course_title || "Senza corso", total: 0, correct: 0, timed_out: 0 };
      row.total += 1;
      if (a.is_correct) row.correct += 1;
      if (a.timed_out) row.timed_out += 1;
      topics.set(key, row);
    }
    const topicRows = [...topics.values()]
      .map((r) => ({ ...r, pct: r.total ? Math.round((r.correct * 100) / r.total) : 0 }))
      .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
    const partRows = this.participants().map((p) => {
      const mine = answers.filter((a) => a.participant_id === p.id);
      const rows = mine.map((a) => {
        const data = JSON.parse(a.data);
        const submitted = JSON.parse(a.submitted);
        const g = grade(a.qtype, data, submitted);
        const [yourText, correctText] = answerTexts(a.qtype, data, submitted, g.solution);
        return {
          qtype: a.qtype,
          prompt: a.prompt,
          topic: a.course_title || "",
          correct: Boolean(a.is_correct),
          timed_out: Boolean(a.timed_out),
          points: a.awarded_points,
          your_text: yourText,
          correct_text: correctText,
          explanation_html: (JSON.parse(a.render) as RenderedQuestion).explanation_html || "",
        };
      });
      return {
        p: publicParticipant(p),
        answers: rows,
        correct: rows.filter((r) => r.correct).length,
        total: rows.length,
      };
    });
    partRows.sort((a, b) => b.p.score - a.p.score || a.p.display_name.localeCompare(b.p.display_name));
    const totalCorrect = answers.filter((a) => a.is_correct).length;
    return {
      topic_rows: topicRows,
      part_rows: partRows,
      total_answers: answers.length,
      total_correct: totalCorrect,
      overall_pct: answers.length ? Math.round((totalCorrect * 100) / answers.length) : 0,
    };
  }

  // --- RPC: giocatori ----------------------------------------------------------------

  async join(token: string | null, displayName: unknown, avatar: unknown, network = ""): Promise<Result<{ participant_token: string }>> {
    const s = this.state;
    if (!s) return fail(404, "Torneo non trovato.");
    const existing = this.participantByToken(token);
    if (existing) return ok({ participant_token: existing.token });
    if (s.status === "CLOSED") return fail(403, "Questo torneo è terminato: non è più possibile parteciparvi né rientrarci.");
    if (s.status !== "OPEN") return fail(409, "Questo torneo non è aperto alle iscrizioni in questo momento.");
    const name = String(displayName ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[<>\x00-\x1f\x7f]/g, "")
      .slice(0, 40);
    if (!name) return fail(400, "Inserisci un nome valido.");
    if (!AVATAR_KEYS.has(String(avatar))) return fail(400, "Avatar non valido.");
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM participants").one().n;
    if (count >= MAX_PARTICIPANTS) return fail(409, "Il torneo ha raggiunto il numero massimo di partecipanti.");
    const fromNet = this.sql.exec<{ n: number }>("SELECT n FROM join_networks WHERE net = ?", network).toArray()[0]?.n ?? 0;
    if (fromNet >= MAX_PER_NETWORK) return fail(429, "Troppe iscrizioni da questa rete.");
    this.sql.exec("INSERT INTO join_networks (net, n) VALUES (?, 1) ON CONFLICT(net) DO UPDATE SET n = n + 1", network);
    const participantToken = shortToken();
    this.sql.exec(
      "INSERT INTO participants (token, display_name, avatar_key, joined_at) VALUES (?, ?, ?, ?)",
      participantToken,
      name,
      String(avatar),
      Date.now(),
    );
    await this.mirror();
    return ok({ participant_token: participantToken });
  }

  async answer(token: string | null, submission: unknown): Promise<Result<{ accepted: boolean }>> {
    const s = this.state;
    if (!s) return fail(404, "Torneo non trovato.");
    const me = this.participantByToken(token);
    if (!me) return fail(403, "Non sei iscritto a questo torneo.");
    const now = Date.now();
    if (await this.advanceIfDue(now)) {
      await this.scheduleAlarm();
      await this.mirror();
    }
    const item = this.currentItem();
    const dl = this.questionDeadline();
    if (s.status !== "RUNNING" || s.run_phase !== "QUESTION" || !item || !dl || now > dl) {
      return ok({ accepted: false });
    }
    const submitted = parseSubmission(item.qtype, submission);
    // L'ultima selezione vale e resta modificabile fino al reveal. Il bonus
    // velocità conta dall'ultima modifica: nella versione Django contava la prima, e si poteva
    // cliccare subito a caso e correggere dopo tenendo il bonus.
    this.sql.exec(
      `INSERT INTO answers (participant_id, question_id, submitted, answered_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(participant_id, question_id) DO UPDATE SET submitted = excluded.submitted,
         answered_at = excluded.answered_at, timed_out = 0`,
      me.id,
      item.question_id,
      JSON.stringify(submitted),
      now,
    );
    return ok({ accepted: true });
  }

  /**
   * Lo stato per le pagine dei giocatori, la sala d'attesa e la classifica. `v`
   * è la chiave della scheda che il browser sta già mostrando: se non è
   * cambiata, la domanda non viene rispedita.
   */
  async view(token: string | null, v: string | null) {
    if (await this.advanceIfDue()) {
      await this.scheduleAlarm();
      await this.mirror();
    }
    const s = this.state;
    if (!s) return null;
    const me = this.participantByToken(token);
    const participants = this.participants();
    const base = {
      title: s.title,
      description: s.description,
      status: s.status,
      token: s.token,
      rules: {
        points_correct: s.points_correct,
        time_bonus: s.time_bonus,
        per_question_seconds: s.per_question_seconds,
        reveal_seconds: s.reveal_seconds,
        num_rounds: s.num_rounds,
      },
      me: me ? publicParticipant(me) : null,
      participants: participants.map(publicParticipant),
      now_ms: Date.now(),
    };
    if (s.status !== "RUNNING") return { ...base, card: null };

    const items = this.roundItems();
    const item = this.currentItem(items);
    const idx = s.current_index;
    const viewKey =
      s.run_phase === "INTERMISSION"
        ? `intermission-${s.current_round}`
        : `${s.run_phase === "REVEAL" ? "reveal" : "q"}-${s.current_round}-${idx}`;
    const answeredRows = item ? this.answersFor(item.question_id) : [];
    const card: Record<string, unknown> = {
      view_key: viewKey,
      run_phase: s.run_phase,
      current_round: s.current_round,
      num_rounds: s.num_rounds,
      index: idx + 1,
      total: items.length,
      is_last: idx + 1 >= items.length,
      deadline_ms: this.questionDeadline() ?? 0,
      reveal_ms: this.revealDeadline() ?? 0,
      answered: answeredRows.length,
      n: participants.length,
    };
    if (v === viewKey || !item || s.run_phase === "INTERMISSION") return { ...base, card: { ...card, unchanged: v === viewKey } };

    const data = JSON.parse(item.data) as QuestionData;
    const render = JSON.parse(item.render) as RenderedQuestion;
    card.question = publicQuestion(item.question_id, item.qtype, data, render);
    const mine = me ? answeredRows.find((a) => a.participant_id === me.id) : undefined;
    if (s.run_phase === "QUESTION") {
      // Per ripristinare la selezione se la pagina viene ricaricata.
      card.my_submission = mine ? JSON.parse(mine.submitted) : null;
    } else {
      // Soluzione e spiegazione arrivano solo al reveal.
      const result = grade(item.qtype, data, mine ? JSON.parse(mine.submitted) : {});
      card.reveal = {
        correct: Boolean(mine?.is_correct),
        solution: result.solution,
        submitted: mine ? JSON.parse(mine.submitted) : {},
        points: mine?.awarded_points ?? 0,
        timed_out: mine ? Boolean(mine.timed_out) : true,
        explanation_html: render.explanation_html,
      };
    }
    return { ...base, card };
  }
}

function publicParticipant(p: ParticipantRow) {
  return {
    id: p.id,
    display_name: p.display_name,
    avatar_key: p.avatar_key,
    score: p.score,
    finished: Boolean(p.finished),
  };
}
