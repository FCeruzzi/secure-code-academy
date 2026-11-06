// Domande: validazione del payload, correzione, preparazione per la pagina.
import { randomInt } from "./random";
import { highlightCode, highlightLines, renderMarkdown } from "./render";

export const TRUE_FALSE = "TRUE_FALSE";
export const MULTIPLE_CHOICE = "MULTIPLE_CHOICE";
export const FIND_WRONG_LINE = "FIND_WRONG_LINE";
export const CODE_COMPARISON = "CODE_COMPARISON";

export const QTYPES: [string, string][] = [
  [TRUE_FALSE, "Vero / Falso"],
  [MULTIPLE_CHOICE, "Scelta multipla"],
  [FIND_WRONG_LINE, "Individua la riga errata"],
  [CODE_COMPARISON, "Confronto di codice"],
];
export const QTYPE_LABELS: Record<string, string> = Object.fromEntries(QTYPES);

export const DIFFICULTIES: [number, string][] = [
  [1, "Base"],
  [2, "Intermedio"],
  [3, "Avanzato"],
];

export type QuestionData = Record<string, any>;

/**
 * Il testo con cui una domanda compare negli elenchi. Un Vero/Falso ha quasi
 * sempre per testo «Vero o falso?» e la domanda vera nell'affermazione: negli
 * elenchi si mostra quella.
 */
export function questionSummary(qtype: string, prompt: string, data: QuestionData | null | undefined): string {
  if (qtype === TRUE_FALSE) {
    const statement = str(data?.statement).trim();
    if (statement) return statement;
  }
  return prompt;
}

/** Lo stesso testo calcolato in SQL, per gli elenchi letti da D1 (tabella con alias `q`). */
export const SUMMARY_SQL = `CASE WHEN q.qtype = '${TRUE_FALSE}'
  THEN COALESCE(NULLIF(TRIM(json_extract(q.data, '$.statement')), ''), q.prompt) ELSE q.prompt END`;

export class ValidationError extends Error {}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

// --- Individua la riga errata: un blocco di codice o un piccolo progetto ----------
// Due forme di `data`:
// - un blocco: {language, code, start_line, correct_lines: [12, …]};
// - un progetto: {language, files: [{name, content, language?, start_line?}, …],
//   correct_lines: [{file: nome, line: 12}, …]}.
// Entrambe diventano un elenco di file e chiavi di risposta "<indice file>:<riga>".

export const SINGLE_NAME = "codice";
const KEY = /^(\d+):(-?\d+)$/;

export interface WrongLineFile {
  name: string;
  content: string;
  language: string;
  start_line: number;
}

const toInt = (v: unknown, fallback: number | null): number | null => {
  const n = Number(v);
  return Number.isInteger(n) ? n : fallback;
};

export function isProject(d: QuestionData): boolean {
  return Array.isArray(d?.files) && d.files.length > 0;
}

export function wrongLineFiles(data: QuestionData): WrongLineFile[] {
  const d = data || {};
  const language = str(d.language);
  if (isProject(d)) {
    return (d.files as unknown[])
      .filter((f): f is QuestionData => typeof f === "object" && f !== null)
      .map((f) => ({
        name: str(f.name),
        content: str(f.content),
        language: str(f.language) || language,
        start_line: toInt(f.start_line, 1) ?? 1,
      }));
  }
  return [{ name: SINGLE_NAME, content: str(d.code), language, start_line: toInt(d.start_line, 1) || 1 }];
}

/** Le righe errate come insieme di chiavi "i:n". */
export function correctKeys(data: QuestionData): Set<string> {
  const d = data || {};
  const index = new Map(wrongLineFiles(d).map((f, i) => [f.name, i]));
  const keys = new Set<string>();
  for (const entry of Array.isArray(d.correct_lines) ? d.correct_lines : []) {
    let i: number | undefined;
    let n: number | null;
    if (typeof entry === "object" && entry !== null) {
      i = index.get(str((entry as QuestionData).file));
      n = toInt((entry as QuestionData).line, null);
    } else {
      i = 0;
      n = toInt(entry, null);
    }
    if (i !== undefined && n !== null) keys.add(`${i}:${n}`);
  }
  return keys;
}

/** Le righe scelte come chiavi "i:n"; un numero da solo è una riga dell'unico file. */
export function submittedKeys(values: unknown): Set<string> {
  const keys = new Set<string>();
  for (const v of Array.isArray(values) ? values : []) {
    const text = str(v).trim();
    const m = KEY.exec(text);
    if (m) keys.add(`${parseInt(m[1], 10)}:${parseInt(m[2], 10)}`);
    else if (/^-?\d+$/.test(text)) keys.add(`0:${parseInt(text, 10)}`);
  }
  return keys;
}

export function sortKeys(keys: Iterable<string>): string[] {
  const parts = (k: string) => k.split(":").map((x) => parseInt(x, 10));
  return [...keys].sort((a, b) => parts(a)[0] - parts(b)[0] || parts(a)[1] - parts(b)[1]);
}

/** "web/OrderController.java:14" per un progetto, "14" per un blocco. */
export function keyLabel(data: QuestionData, key: string): string {
  const m = KEY.exec(key);
  if (!m) return key;
  const i = parseInt(m[1], 10);
  const n = parseInt(m[2], 10);
  if (!isProject(data)) return String(n);
  const files = wrongLineFiles(data);
  return `${files[i]?.name ?? `file ${i + 1}`}:${n}`;
}

function validateWrongLine(d: QuestionData): void {
  const lines = d.correct_lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ValidationError("Richiede 'correct_lines' con almeno una riga errata.");
  }
  if (!isProject(d)) {
    if ("files" in d && d.files !== null && !(Array.isArray(d.files) && d.files.length === 0)) {
      throw new ValidationError("'files' deve essere una lista di file.");
    }
    if (!str(d.code).trim()) throw new ValidationError("Individua-la-riga richiede 'code' (oppure 'files').");
    const total = str(d.code).split("\n").length;
    const start = parseInt(String(d.start_line ?? 1), 10) || 1;
    for (const ln of lines) {
      if (!Number.isInteger(ln) || typeof ln === "boolean" || ln < start || ln > start + total - 1) {
        throw new ValidationError(`Numero di riga non valido: ${ln}.`);
      }
    }
    return;
  }
  const ranges = new Map<string, [number, number]>();
  for (const f of d.files as unknown[]) {
    if (typeof f !== "object" || f === null) {
      throw new ValidationError("Ogni file deve essere un oggetto con 'name' e 'content'.");
    }
    const file = f as QuestionData;
    const name = str(file.name).trim();
    if (!name || !str(file.content).trim()) throw new ValidationError("Ogni file deve avere 'name' e 'content'.");
    if (name !== file.name) {
      throw new ValidationError(`Il nome del file «${file.name}» non deve avere spazi all'inizio o alla fine.`);
    }
    if (ranges.has(name)) throw new ValidationError(`Due file si chiamano «${name}»: i nomi devono essere unici.`);
    if ("language" in file && typeof file.language !== "string") {
      throw new ValidationError("Il 'language' di un file deve essere un testo.");
    }
    const start = file.start_line ?? 1;
    if (!Number.isInteger(start) || typeof start === "boolean") {
      throw new ValidationError(`'start_line' del file «${name}» deve essere un numero.`);
    }
    ranges.set(name, [start, start + str(file.content).split("\n").length - 1]);
  }
  for (const entry of lines) {
    if (typeof entry !== "object" || entry === null) {
      throw new ValidationError('Con \'files\' ogni riga errata si indica come {"file": nome, "line": numero}.');
    }
    const { file, line } = entry as QuestionData;
    const range = ranges.get(file);
    if (!range) throw new ValidationError(`Riga errata in un file che non esiste: «${file}».`);
    if (!Number.isInteger(line) || typeof line === "boolean" || line < range[0] || line > range[1]) {
      throw new ValidationError(`Riga ${line} non valida per il file «${file}».`);
    }
  }
}

/** Lancia ValidationError con lo stesso messaggio di validate_question_data. */
export function validateQuestionData(qtype: string, data: unknown): void {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ValidationError("Il payload 'data' deve essere un oggetto JSON.");
  }
  const d = data as QuestionData;

  if (qtype === TRUE_FALSE) {
    if (!("answer" in d) || typeof d.answer !== "boolean") {
      throw new ValidationError("Vero/Falso richiede 'answer' booleano (true/false).");
    }
    if (!str(d.statement).trim()) {
      throw new ValidationError("Vero/Falso richiede un 'statement' (affermazione).");
    }
  } else if (qtype === MULTIPLE_CHOICE) {
    const options = d.options;
    if (!Array.isArray(options) || options.length < 2) {
      throw new ValidationError("Scelta multipla richiede almeno 2 'options'.");
    }
    const ids: string[] = [];
    for (const opt of options) {
      if (typeof opt !== "object" || opt === null || !("id" in opt) || !("text" in opt)) {
        throw new ValidationError("Ogni opzione deve avere 'id' e 'text'.");
      }
      ids.push(String(opt.id));
    }
    const correct = d.correct;
    if (!Array.isArray(correct) || correct.length === 0) {
      throw new ValidationError("Scelta multipla richiede 'correct' (lista di id).");
    }
    for (const c of correct) {
      if (!ids.includes(String(c))) {
        throw new ValidationError(`L'id corretto '${c}' non è tra le opzioni.`);
      }
    }
  } else if (qtype === FIND_WRONG_LINE) {
    validateWrongLine(d);
  } else if (qtype === CODE_COMPARISON) {
    const sideOk = (side: "a" | "b") => {
      const files = d[`files_${side}`];
      if (Array.isArray(files) && files.length) {
        for (const f of files) {
          if (typeof f !== "object" || f === null || !str(f.name).trim() || !str(f.content).trim()) {
            throw new ValidationError("Ogni file del confronto deve avere 'name' e 'content'.");
          }
          if ("language" in f && typeof f.language !== "string") {
            throw new ValidationError("Il 'language' di un file deve essere un testo.");
          }
        }
        return true;
      }
      return Boolean(str(d[`snippet_${side}`]).trim());
    };
    if (!sideOk("a") || !sideOk("b")) {
      throw new ValidationError(
        "Confronto richiede due versioni: 'files_a'/'files_b' (oppure 'snippet_a'/'snippet_b').",
      );
    }
    if (!["a", "b"].includes(String(d.correct))) {
      throw new ValidationError("Confronto richiede 'correct' uguale a 'a' o 'b'.");
    }
  } else {
    throw new ValidationError(`Tipo di domanda sconosciuto: ${qtype}`);
  }
}

// --- Correzione ----------------------------------------------------------------

export type Submission = Record<string, unknown>;
export interface GradeResult {
  correct: boolean;
  solution: Record<string, unknown>;
}

function normBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  return ["true", "1", "vero", "yes", "on"].includes(String(v).trim().toLowerCase());
}


function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Corregge `submitted`; restituisce {correct, solution}. */
export function grade(qtype: string, data: QuestionData, submitted: Submission | null | undefined): GradeResult {
  const d = data || {};
  const s = submitted || {};
  if (qtype === TRUE_FALSE) {
    const answer = Boolean(d.answer);
    return { correct: normBool(s.answer) === answer, solution: { answer } };
  }
  if (qtype === MULTIPLE_CHOICE) {
    const chosen = new Set((Array.isArray(s.selected) ? s.selected : []).map(String));
    const expected = new Set((Array.isArray(d.correct) ? d.correct : []).map(String));
    return {
      correct: expected.size > 0 && sameSet(chosen, expected),
      solution: { correct: [...expected].sort() },
    };
  }
  if (qtype === FIND_WRONG_LINE) {
    const chosen = submittedKeys(s.lines);
    const expected = correctKeys(d);
    const sorted = sortKeys(expected);
    return {
      correct: expected.size > 0 && sameSet(chosen, expected),
      solution: {
        correct_keys: sorted,
        correct_lines: sorted.map((k) => keyLabel(d, k)),
        // Le righe scelte, nelle stesse chiavi, per l'avviso.
        chosen_keys: sortKeys(chosen),
      },
    };
  }
  if (qtype === CODE_COMPARISON) {
    return {
      correct: String(s.choice ?? "None") === String(d.correct ?? "None"),
      solution: { correct: d.correct },
    };
  }
  return { correct: false, solution: {} };
}

/**
 * Normalizza la risposta inviata dal browser: qualunque forma arrivi, viene
 * ridotta ai soli campi del tipo, con i tipi giusti.
 */
export function parseSubmission(qtype: string, raw: unknown): Submission {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (qtype === TRUE_FALSE) return { answer: r.answer === true || r.answer === "true" };
  if (qtype === MULTIPLE_CHOICE) {
    const sel = Array.isArray(r.selected) ? r.selected : r.selected != null ? [r.selected] : [];
    return { selected: sel.map(String).slice(0, 50) };
  }
  if (qtype === FIND_WRONG_LINE) {
    const raw = Array.isArray(r.lines) ? r.lines : String(r.lines ?? "").split(",");
    return { lines: sortKeys(submittedKeys(raw.slice(0, 500))) };
  }
  if (qtype === CODE_COMPARISON) {
    const choice = r.choice === "a" || r.choice === "b" ? r.choice : null;
    return { choice };
  }
  return {};
}

// --- Rendering per la pagina ----------------------------------------------------

export interface CodeFile {
  index: number;
  name: string;
  lines: { number: number; key: string; html: string }[];
}

export interface RenderedQuestion {
  prompt_html: string;
  explanation_html: string;
  statement_html?: string;
  code_lines?: { number: number; html: string }[];
  code_files?: CodeFile[];
  files_a?: { name: string; html: string }[];
  files_b?: { name: string; html: string }[];
}

function comparisonFiles(d: QuestionData, side: "a" | "b", language: string) {
  const files = d[`files_${side}`];
  if (Array.isArray(files) && files.length) {
    return files.map((f: QuestionData) => ({ name: str(f.name), html: highlightCode(str(f.content), str(f.language) || language) }));
  }
  return [{ name: "", html: highlightCode(str(d[`snippet_${side}`]), language) }];
}

/** HTML pre-renderizzato di una domanda, salvato nella colonna `render`. */
export function renderQuestion(qtype: string, prompt: string, explanation: string, data: QuestionData): RenderedQuestion {
  const out: RenderedQuestion = {
    prompt_html: renderMarkdown(prompt),
    explanation_html: explanation ? renderMarkdown(explanation) : "",
  };
  const d = data || {};
  if (qtype === TRUE_FALSE) {
    out.statement_html = renderMarkdown(str(d.statement));
  } else if (qtype === FIND_WRONG_LINE) {
    out.code_files = wrongLineFiles(d).map((f, i) => ({
      index: i,
      name: f.name,
      lines: highlightLines(f.content, f.language).map((html, n) => ({
        number: f.start_line + n,
        key: `${i}:${f.start_line + n}`,
        html,
      })),
    }));
  } else if (qtype === CODE_COMPARISON) {
    const lang = str(d.language);
    out.files_a = comparisonFiles(d, "a", lang);
    out.files_b = comparisonFiles(d, "b", lang);
  }
  return out;
}

// PRNG deterministico (mulberry32). Senza altro seme si usa l'id della domanda: l'ordine
// resta lo stesso a ogni visita.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Il seme di una domanda: `salt` è il tentativo del quiz o il giocatore del
 * torneo, così ognuno vede le opzioni in un ordine suo. Senza `salt` è l'id.
 */
export function questionSeed(id: number, salt?: number | null): number {
  if (salt === undefined || salt === null) return id || 0;
  let h = Math.imul((salt >>> 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((id || 0) >>> 0, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Fisher-Yates con il PRNG seminato: stesso seme, stesso ordine. */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  const r = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Nel confronto di codice i due pannelli si scambiano (secondo il seme della
 * domanda). Le etichette restano al loro posto: label_a a sinistra, label_b a
 * destra, qualunque codice ci sia. Altrimenti «Versione A» seguirebbe sempre il
 * codice salvato come A, e se quello è il corretto lo direbbe l'etichetta.
 */
export const comparisonSwapped = (seed: number): boolean => rng(seed || 0)() < 0.5;

/** L'etichetta che chi risponde ha visto sopra il codice `side` ("a" o "b"). */
export function comparisonLabel(seed: number, data: QuestionData, side: unknown): string | null {
  if (side !== "a" && side !== "b") return null;
  const left = (side === "a") !== comparisonSwapped(seed);
  return left ? str(data?.label_a) || "Versione A" : str(data?.label_b) || "Versione B";
}

export interface PublicQuestion {
  id: number;
  qtype: string;
  qtype_label: string;
  prompt_html: string;
  statement_html?: string;
  options?: { id: string; text: string }[];
  multiple?: boolean;
  code_files?: CodeFile[];
  is_project?: boolean;
  language?: string;
  files_a?: { name: string; html: string }[];
  files_b?: { name: string; html: string }[];
  label_a?: string;
  label_b?: string;
  cc_swap?: boolean;
}

/**
 * Quello che il browser riceve PRIMA della risposta: niente soluzione e niente
 * spiegazione. Ordine delle opzioni e lato del confronto dipendono da `seed` (vedi
 * questionSeed).
 */
export function publicQuestion(id: number, qtype: string, data: QuestionData, render: RenderedQuestion, seed = id): PublicQuestion {
  const d = data || {};
  const q: PublicQuestion = { id, qtype, qtype_label: QTYPE_LABELS[qtype] || qtype, prompt_html: render.prompt_html };
  if (qtype === TRUE_FALSE) {
    q.statement_html = render.statement_html;
  } else if (qtype === MULTIPLE_CHOICE) {
    const options = (Array.isArray(d.options) ? d.options : []).map((o: QuestionData) => ({ id: String(o.id), text: str(o.text) }));
    q.options = seededShuffle(options, seed || 0);
    q.multiple = Boolean(d.multiple);
  } else if (qtype === FIND_WRONG_LINE) {
    // Le domande salvate prima dei progetti hanno solo code_lines nel render.
    q.code_files = render.code_files ?? [
      {
        index: 0,
        name: SINGLE_NAME,
        lines: (render.code_lines || []).map((l) => ({ ...l, key: `0:${l.number}` })),
      },
    ];
    q.is_project = isProject(d);
    q.language = str(d.language);
  } else if (qtype === CODE_COMPARISON) {
    q.files_a = render.files_a;
    q.files_b = render.files_b;
    q.label_a = str(d.label_a) || "Versione A";
    q.label_b = str(d.label_b) || "Versione B";
    q.cc_swap = comparisonSwapped(seed);
  }
  return q;
}

/** Testi brevi «sua risposta» / «risposta corretta» del report dei tornei (`seed` come in publicQuestion). */
export function answerTexts(
  seed: number,
  qtype: string,
  data: QuestionData,
  submitted: Submission,
  solution: Record<string, unknown>,
): [string, string] {
  const d = data || {};
  const s = submitted || {};
  const boolLabel = (v: unknown) => (v ? "Vero" : "Falso");
  if (qtype === TRUE_FALSE) {
    return [s.answer !== undefined && s.answer !== null ? boolLabel(s.answer) : "—", boolLabel(solution.answer)];
  }
  if (qtype === MULTIPLE_CHOICE) {
    const options = new Map<string, string>((d.options || []).map((o: QuestionData) => [String(o.id), str(o.text)]));
    const chosen = ((s.selected as unknown[]) || []).map((x) => options.get(String(x)) ?? String(x));
    const correct = ((solution.correct as unknown[]) || []).map((x) => options.get(String(x)) ?? String(x));
    return [chosen.join("; ") || "—", correct.join("; ") || "—"];
  }
  if (qtype === FIND_WRONG_LINE) {
    const chosen = sortKeys(submittedKeys(s.lines)).map((k) => keyLabel(d, k)).join(", ");
    const correct = ((solution.correct_lines as unknown[]) || []).join(", ");
    return [chosen ? `riga/e ${chosen}` : "—", correct ? `riga/e ${correct}` : "—"];
  }
  if (qtype === CODE_COMPARISON) {
    return [comparisonLabel(seed, d, s.choice) || "—", comparisonLabel(seed, d, solution.correct) || "—"];
  }
  return ["—", "—"];
}

// --- Copia per i tornei ------------------------------------------------------------

const OPTION_IDS = "abcdefghijklmnopqrstuvwxyz";

/** Scambia `<base>_a` e `<base>_b` (solo le chiavi presenti). */
function swapSides<T extends Record<string, unknown>>(obj: T, base: string): T {
  const out: Record<string, unknown> = { ...obj };
  const a = obj[`${base}_a`];
  const b = obj[`${base}_b`];
  delete out[`${base}_a`];
  delete out[`${base}_b`];
  if (b !== undefined) out[`${base}_a`] = b;
  if (a !== undefined) out[`${base}_b`] = a;
  return out as T;
}

/**
 * La copia di una domanda che il torneo congela all'avvio del round. Il codice è
 * pubblico, e con lui il modo in cui le opzioni si rimescolano per ogni giocatore
 * (`questionSeed` da id della domanda e del giocatore, entrambi noti al browser):
 * gli id della banca («a», «b»…) e il lato dei due codici del confronto direbbero
 * quale risposta l'autore ha scritto per prima, spesso quella giusta. Qui, con un
 * generatore crittografico, le opzioni della scelta multipla prendono un ordine
 * casuale e nuovi id in quell'ordine, e i due codici del confronto si scambiano a
 * caso (le etichette restano al loro posto, come sempre). Correzione, reveal e
 * report leggono la copia, quindi restano coerenti; gli altri tipi non cambiano.
 */
export function tournamentCopy(
  qtype: string,
  data: QuestionData,
  render: RenderedQuestion,
  rand: (max: number) => number = randomInt,
): { data: QuestionData; render: RenderedQuestion } {
  const d = data || {};
  if (qtype === MULTIPLE_CHOICE && Array.isArray(d.options)) {
    const order = d.options.map((_: unknown, i: number) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    const renamed = new Map<string, string>();
    const options = order.map((from: number, pos: number) => {
      const id = pos < OPTION_IDS.length ? OPTION_IDS[pos] : `o${pos + 1}`;
      renamed.set(String(d.options[from]?.id), id);
      return { ...d.options[from], id };
    });
    const correct = (Array.isArray(d.correct) ? d.correct : [])
      .map((c: unknown) => renamed.get(String(c)))
      .filter((c: string | undefined): c is string => c !== undefined);
    return { data: { ...d, options, correct }, render };
  }
  if (qtype === CODE_COMPARISON && rand(2) === 1) {
    const other = (side: unknown) => (side === "a" ? "b" : side === "b" ? "a" : side);
    const swapped = swapSides(swapSides(d, "snippet"), "files");
    return {
      data: { ...swapped, correct: other(d.correct) },
      render: swapSides(render as unknown as Record<string, unknown>, "files") as unknown as RenderedQuestion,
    };
  }
  return { data, render };
}
