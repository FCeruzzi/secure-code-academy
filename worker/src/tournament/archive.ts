// Backup di un torneo in un file JSON, per scaricarlo e ricaricarlo.
//
// Il formato ha un nome e una versione ("format", "version") e resta stabile: un file
// esportato da un'installazione si importa in un'altra. Contiene la copia delle domande
// congelata dal torneo (opzioni e lati del confronto come li hanno visti i giocatori),
// i partecipanti e le risposte: classifica e report si ricalcolano da questi. Non
// contiene il PIN, i token dei giocatori, le reti da cui si sono iscritti né gli
// account del pannello.
//
// L'import crea sempre un torneo nuovo. Del file non si prende nessun HTML: il testo
// delle domande si rende di nuovo qui, come al salvataggio di una domanda.
import { MULTIPLE_CHOICE, parseSubmission, QTYPE_LABELS, validateQuestionData, ValidationError, type QuestionData } from "../lib/questions";
import { MIX, type Counts } from "./mix";
import {
  AVATAR_KEYS,
  cleanDisplayName,
  DEFAULT_START_DELAY_SECONDS,
  MAX_PARTICIPANTS,
  MAX_START_DELAY_SECONDS,
  MIN_REVEAL_SECONDS,
  MIN_START_DELAY_SECONDS,
} from "./rules";

export const FORMAT = "secure-code-academy/tournament";
export const VERSION = 1;

/** Il file più grande che si accetta: un torneo vero sta molto sotto. */
export const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_QUESTIONS = 1000;

const STATUSES = ["DRAFT", "OPEN", "RUNNING", "CLOSED"] as const;
type ArchiveStatus = (typeof STATUSES)[number];
const MAX_KEY = 999_999_999;
const MAX_TEXT = 20_000;
const MAX_DATA = 200_000;
const MAX_POINTS = 1_000_000;
const FIRST_DAY = Date.UTC(2000, 0, 1);
const LAST_DAY = Date.UTC(2100, 0, 1);
const DEFAULT_AVATAR = "ninja";

/** Un file che non si può importare: il messaggio dice dove e perché. */
export class ArchiveError extends Error {}

export interface ArchiveTournament {
  title: string;
  description: string;
  /** Lo stato al momento dell'export (l'import decide il suo: chiuso o bozza). */
  status: ArchiveStatus;
  num_rounds: number;
  per_question_seconds: number;
  reveal_seconds: number;
  start_delay_seconds: number;
  points_correct: number;
  time_bonus: boolean;
  pool_size: number | null;
  round_mix: Counts | null;
  started_at: number | null;
  finished_at: number | null;
  /** Titoli dei corsi scelti: l'import li collega ai corsi con lo stesso titolo. */
  courses: string[];
}

export interface ArchiveQuestion {
  key: number;
  round: number;
  order: number;
  qtype: string;
  prompt: string;
  explanation: string;
  course: string | null;
  difficulty: number | null;
  data: QuestionData;
}

export interface ArchiveParticipant {
  key: number;
  display_name: string;
  avatar_key: string;
  finished: boolean;
  joined_at: number | null;
  finished_at: number | null;
}

export interface ArchiveAnswer {
  participant: number;
  question: number;
  submitted: Record<string, unknown>;
  is_correct: boolean;
  timed_out: boolean;
  points: number;
  answered_at: number | null;
}

export interface Archive {
  exported_at: number | null;
  tournament: ArchiveTournament;
  questions: ArchiveQuestion[];
  participants: ArchiveParticipant[];
  answers: ArchiveAnswer[];
}

// --- Export ------------------------------------------------------------------------

/** Quello che il Durable Object sa del torneo, per l'export. */
export interface ArchiveSource {
  state: {
    title: string;
    description: string;
    status: string;
    num_rounds: number;
    per_question_seconds: number;
    reveal_seconds: number;
    start_delay_seconds?: number;
    points_correct: number;
    time_bonus: boolean;
    pool_size: number | null;
    round_mix?: Counts | null;
    started_at: number | null;
    finished_at: number | null;
  };
  courses: string[];
  items: { round: number; ord: number; question_id: number; qtype: string; prompt: string; explanation: string; course_title: string | null; data: string }[];
  /** In ordine di classifica. */
  participants: { id: number; display_name: string; avatar_key: string; score: number; finished: number; joined_at: number | null; finished_at: number | null }[];
  answers: { participant_id: number; question_id: number; submitted: string; is_correct: number; timed_out: number; awarded_points: number; answered_at: number }[];
  now: number;
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

/** Il contenuto del file di backup. */
export function archiveOf(src: ArchiveSource): Record<string, unknown> {
  const s = src.state;
  const seen = new Set<number>();
  const questions = [];
  for (const it of src.items) {
    // Una domanda non si ripete fra i round; se capitasse, conta la prima.
    if (seen.has(it.question_id)) continue;
    seen.add(it.question_id);
    questions.push({
      key: it.question_id,
      round: it.round,
      order: it.ord,
      qtype: it.qtype,
      prompt: it.prompt,
      explanation: it.explanation,
      course: it.course_title || null,
      difficulty: null,
      data: JSON.parse(it.data),
    });
  }
  return {
    format: FORMAT,
    version: VERSION,
    exported_at: iso(src.now),
    source: "cloudflare",
    tournament: {
      title: s.title,
      description: s.description,
      status: s.status,
      num_rounds: s.num_rounds,
      per_question_seconds: s.per_question_seconds,
      reveal_seconds: s.reveal_seconds,
      start_delay_seconds: s.start_delay_seconds ?? DEFAULT_START_DELAY_SECONDS,
      points_correct: s.points_correct,
      time_bonus: Boolean(s.time_bonus),
      pool_size: s.pool_size,
      round_mix: s.round_mix ?? null,
      started_at: iso(s.started_at),
      finished_at: iso(s.finished_at),
      courses: src.courses,
    },
    questions,
    participants: src.participants.map((p, i) => ({
      key: p.id,
      rank: i + 1,
      display_name: p.display_name,
      avatar_key: p.avatar_key,
      score: p.score,
      finished: Boolean(p.finished),
      joined_at: iso(p.joined_at),
      finished_at: iso(p.finished_at),
    })),
    answers: src.answers.map((a) => ({
      participant: a.participant_id,
      question: a.question_id,
      submitted: JSON.parse(a.submitted),
      is_correct: Boolean(a.is_correct),
      timed_out: Boolean(a.timed_out),
      points: a.awarded_points,
      answered_at: iso(a.answered_at),
    })),
  };
}

// --- Import ------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function bad(where: string, message: string): never {
  throw new ArchiveError(`${where}: ${message}`);
}

function text(v: unknown, where: string, max: number, required = false): string {
  if (v === undefined || v === null) {
    if (required) bad(where, "manca.");
    return "";
  }
  if (typeof v !== "string") bad(where, "deve essere un testo.");
  if (v.length > max) bad(where, `è troppo lungo (al massimo ${max} caratteri).`);
  if (required && !v.trim()) bad(where, "è vuoto.");
  return v;
}

function int(v: unknown, where: string, min: number, max: number, fallback?: number): number {
  if ((v === undefined || v === null) && fallback !== undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v)) bad(where, "deve essere un numero intero.");
  if (v < min || v > max) bad(where, `deve stare fra ${min} e ${max}.`);
  return v;
}

/** Un intero portato dentro [min, max]: i tornei salvati prima di un limite restano importabili. */
function clamped(v: unknown, where: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v)) bad(where, "deve essere un numero intero.");
  return Math.min(max, Math.max(min, v));
}

function flag(v: unknown, where: string, fallback = false): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  if (v === 0 || v === 1) return v === 1;
  bad(where, "deve essere true o false.");
}

function time(v: unknown, where: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 40) bad(where, "deve essere una data (ISO 8601).");
  const ms = Date.parse(v);
  if (!Number.isFinite(ms) || ms < FIRST_DAY || ms > LAST_DAY) bad(where, "non è una data valida.");
  return ms;
}

function list(v: unknown, where: string, max: number): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) bad(where, "deve essere una lista.");
  if (v.length > max) bad(where, `ha troppi elementi (al massimo ${max}).`);
  return v;
}

function roundMix(v: unknown, where: string): Counts | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) bad(where, "deve essere un oggetto {tipo: numero}.");
  const types = new Set(MIX.map(([t]) => t));
  const out: Counts = {};
  for (const [k, n] of Object.entries(v)) {
    if (!types.has(k)) bad(where, `tipo di domanda sconosciuto: «${k}».`);
    out[k] = int(n, `${where}, ${k}`, 0, MAX_ARCHIVE_QUESTIONS);
  }
  return out;
}

function tournamentOf(v: unknown): ArchiveTournament {
  if (!isObj(v)) bad("Torneo", "manca l'oggetto \"tournament\".");
  const status = v.status ?? "CLOSED";
  if (!STATUSES.includes(status as ArchiveStatus)) bad("Torneo, stato", `«${String(status)}» non è uno stato valido.`);
  const courses: string[] = [];
  for (const [i, c] of list(v.courses, "Torneo, corsi", 200).entries()) {
    const title = text(c, `Torneo, corso ${i + 1}`, 200, true).trim();
    if (!courses.includes(title)) courses.push(title);
  }
  return {
    title: text(v.title, "Torneo, titolo", 200, true).trim(),
    description: text(v.description, "Torneo, descrizione", MAX_TEXT),
    status: status as ArchiveStatus,
    num_rounds: int(v.num_rounds, "Torneo, numero di round", 1, 100, 1),
    per_question_seconds: int(v.per_question_seconds, "Torneo, secondi per domanda", 1, 3600, 60),
    reveal_seconds: clamped(v.reveal_seconds, "Torneo, secondi della soluzione", MIN_REVEAL_SECONDS, 600, MIN_REVEAL_SECONDS),
    start_delay_seconds: clamped(
      v.start_delay_seconds,
      "Torneo, secondi prima della prima domanda",
      MIN_START_DELAY_SECONDS,
      MAX_START_DELAY_SECONDS,
      DEFAULT_START_DELAY_SECONDS,
    ),
    points_correct: int(v.points_correct, "Torneo, punti per risposta corretta", 0, 100_000, 100),
    time_bonus: flag(v.time_bonus, "Torneo, bonus velocità"),
    pool_size: v.pool_size === undefined || v.pool_size === null ? null : int(v.pool_size, "Torneo, domande per round", 1, MAX_ARCHIVE_QUESTIONS),
    round_mix: roundMix(v.round_mix, "Torneo, mix dei tipi"),
    started_at: time(v.started_at, "Torneo, inizio"),
    finished_at: time(v.finished_at, "Torneo, fine"),
    courses,
  };
}

function questionOf(v: unknown, i: number, rounds: number): ArchiveQuestion {
  const where = `Domanda ${i + 1}`;
  if (!isObj(v)) bad(where, "deve essere un oggetto.");
  const qtype = text(v.qtype, `${where}, tipo`, 40, true);
  if (!(qtype in QTYPE_LABELS)) bad(where, `tipo di domanda sconosciuto: «${qtype}».`);
  const data = v.data;
  try {
    validateQuestionData(qtype, data);
  } catch (e) {
    if (e instanceof ValidationError) bad(where, e.message);
    throw e;
  }
  if (JSON.stringify(data).length > MAX_DATA) bad(where, "i dati sono troppo grandi.");
  if (qtype === MULTIPLE_CHOICE) {
    const ids = (data as QuestionData).options.map((o: QuestionData) => String(o.id));
    if (new Set(ids).size !== ids.length) bad(where, "due opzioni hanno lo stesso id.");
  }
  const course = v.course === undefined || v.course === null ? null : text(v.course, `${where}, corso`, 200).trim() || null;
  return {
    key: int(v.key, `${where}, chiave`, 1, MAX_KEY),
    round: int(v.round, `${where}, round`, 1, rounds),
    order: int(v.order, `${where}, posizione`, 1, 10_000),
    qtype,
    prompt: text(v.prompt, `${where}, testo`, MAX_TEXT, true),
    explanation: text(v.explanation, `${where}, spiegazione`, MAX_TEXT),
    course,
    difficulty: v.difficulty === undefined || v.difficulty === null ? null : int(v.difficulty, `${where}, difficoltà`, 1, 3),
    data: data as QuestionData,
  };
}

function participantOf(v: unknown, i: number): ArchiveParticipant {
  const where = `Partecipante ${i + 1}`;
  if (!isObj(v)) bad(where, "deve essere un oggetto.");
  const avatar = v.avatar_key === undefined || v.avatar_key === null ? "" : text(v.avatar_key, `${where}, avatar`, 40);
  return {
    key: int(v.key, `${where}, chiave`, 1, MAX_KEY),
    // Lo stesso nome pulito dell'iscrizione. I nomi doppi restano: i tornei giocati
    // prima della regola dei nomi unici possono averne.
    display_name: cleanDisplayName(text(v.display_name, `${where}, nome`, 200)) || `Giocatore ${i + 1}`,
    avatar_key: AVATAR_KEYS.has(avatar) ? avatar : DEFAULT_AVATAR,
    finished: flag(v.finished, `${where}, finito`),
    joined_at: time(v.joined_at, `${where}, iscrizione`),
    finished_at: time(v.finished_at, `${where}, fine`),
  };
}

/**
 * Legge e controlla un file di backup. Tutto o niente: al primo problema lancia
 * ArchiveError con la posizione nel file. Le risposte si normalizzano come quelle
 * dei giocatori, e restano coerenti: chi è andato in timeout ha sbagliato, chi ha
 * sbagliato ha 0 punti.
 */
export function parseArchive(raw: string): Archive {
  if (raw.length > MAX_ARCHIVE_BYTES) throw new ArchiveError("Il file è troppo grande (al massimo 4 MB).");
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new ArchiveError("Il file non è un JSON valido.");
  }
  if (!isObj(doc) || doc.format !== FORMAT) {
    throw new ArchiveError(`Il file non è il backup di un torneo (manca "format": "${FORMAT}").`);
  }
  if (doc.version !== VERSION) {
    throw new ArchiveError(`Versione del file non supportata (${String(doc.version)}): questo sito legge la versione ${VERSION}.`);
  }
  const tournament = tournamentOf(doc.tournament);

  const questions: ArchiveQuestion[] = [];
  const byKey = new Map<number, ArchiveQuestion>();
  const slots = new Set<string>();
  for (const [i, v] of list(doc.questions, "Domande", MAX_ARCHIVE_QUESTIONS).entries()) {
    const q = questionOf(v, i, tournament.num_rounds);
    if (byKey.has(q.key)) bad(`Domanda ${i + 1}`, `la chiave ${q.key} è già usata da un'altra domanda.`);
    const slot = `${q.round}:${q.order}`;
    if (slots.has(slot)) bad(`Domanda ${i + 1}`, `il round ${q.round} ha già una domanda in posizione ${q.order}.`);
    byKey.set(q.key, q);
    slots.add(slot);
    questions.push(q);
  }

  const participants: ArchiveParticipant[] = [];
  const players = new Set<number>();
  for (const [i, v] of list(doc.participants, "Partecipanti", MAX_PARTICIPANTS).entries()) {
    const p = participantOf(v, i);
    if (players.has(p.key)) bad(`Partecipante ${i + 1}`, `la chiave ${p.key} è già usata da un altro partecipante.`);
    players.add(p.key);
    participants.push(p);
  }

  const answers: ArchiveAnswer[] = [];
  const pairs = new Set<string>();
  const maxAnswers = Math.max(1, participants.length * questions.length);
  for (const [i, v] of list(doc.answers, "Risposte", maxAnswers).entries()) {
    const where = `Risposta ${i + 1}`;
    if (!isObj(v)) bad(where, "deve essere un oggetto.");
    const participant = int(v.participant, `${where}, partecipante`, 1, MAX_KEY);
    const question = int(v.question, `${where}, domanda`, 1, MAX_KEY);
    if (!players.has(participant)) bad(where, `il partecipante ${participant} non c'è nel file.`);
    const q = byKey.get(question);
    if (!q) bad(where, `la domanda ${question} non c'è nel file.`);
    const pair = `${participant}:${question}`;
    if (pairs.has(pair)) bad(where, `il partecipante ${participant} ha già una risposta alla domanda ${question}.`);
    pairs.add(pair);
    if (v.submitted !== undefined && v.submitted !== null && !isObj(v.submitted)) bad(where, "la risposta data deve essere un oggetto.");
    const timedOut = flag(v.timed_out, `${where}, timeout`);
    const correct = flag(v.is_correct, `${where}, corretta`) && !timedOut;
    const points = int(v.points, `${where}, punti`, 0, MAX_POINTS, 0);
    answers.push({
      participant,
      question,
      // Una risposta vuota (il timeout) resta vuota: normalizzata, un Vero/Falso diventerebbe «Falso».
      submitted: isObj(v.submitted) && Object.keys(v.submitted).length ? parseSubmission(q.qtype, v.submitted) : {},
      is_correct: correct,
      timed_out: timedOut,
      points: correct ? points : 0,
      answered_at: time(v.answered_at, `${where}, ora`),
    });
  }

  return { exported_at: time(doc.exported_at, "Data dell'export"), tournament, questions, participants, answers };
}
