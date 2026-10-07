// Domande: validazione del payload, correzione, preparazione per la pagina.
// Porta apps/quizzes/validators.py, grading.py e display.py.
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

export class ValidationError extends Error {}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
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
    if (!str(d.code).trim()) throw new ValidationError("Individua-la-riga richiede 'code'.");
    const lines = d.correct_lines;
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new ValidationError("Richiede 'correct_lines' (lista di numeri di riga).");
    }
    const total = str(d.code).split("\n").length;
    const start = parseInt(String(d.start_line ?? 1), 10) || 1;
    for (const ln of lines) {
      if (!Number.isInteger(ln) || typeof ln === "boolean" || ln < start || ln > start + total - 1) {
        throw new ValidationError(`Numero di riga non valido: ${ln}.`);
      }
    }
  } else if (qtype === CODE_COMPARISON) {
    const sideOk = (side: "a" | "b") => {
      const files = d[`files_${side}`];
      if (Array.isArray(files) && files.length) {
        for (const f of files) {
          if (typeof f !== "object" || f === null || !str(f.name).trim() || !str(f.content).trim()) {
            throw new ValidationError("Ogni file del confronto deve avere 'name' e 'content'.");
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

const isDigits = (x: unknown) => /^\d+$/.test(String(x).trim().replace(/^-+/, ""));

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Corregge `submitted`; restituisce {correct, solution}. Porta grading.grade. */
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
    const chosen = new Set(
      (Array.isArray(s.lines) ? s.lines : []).filter(isDigits).map((x) => parseInt(String(x), 10)),
    );
    const expected = new Set((Array.isArray(d.correct_lines) ? d.correct_lines : []).map((x) => parseInt(String(x), 10)));
    return {
      correct: expected.size > 0 && sameSet(chosen, expected),
      solution: { correct_lines: [...expected].sort((a, b) => a - b) },
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
 * Normalizza la risposta inviata dal browser, come parse_submission: qualunque
 * forma arrivi, viene ridotta ai soli campi del tipo, con i tipi giusti.
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
    return { lines: raw.filter(isDigits).map((x) => parseInt(String(x), 10)).slice(0, 500) };
  }
  if (qtype === CODE_COMPARISON) {
    const choice = r.choice === "a" || r.choice === "b" ? r.choice : null;
    return { choice };
  }
  return {};
}

// --- Rendering per la pagina ----------------------------------------------------

export interface RenderedQuestion {
  prompt_html: string;
  explanation_html: string;
  statement_html?: string;
  code_lines?: { number: number; html: string }[];
  files_a?: { name: string; html: string }[];
  files_b?: { name: string; html: string }[];
}

function comparisonFiles(d: QuestionData, side: "a" | "b", language: string) {
  const files = d[`files_${side}`];
  if (Array.isArray(files) && files.length) {
    return files.map((f: QuestionData) => ({ name: str(f.name), html: highlightCode(str(f.content), language) }));
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
    const start = parseInt(String(d.start_line ?? 1), 10) || 1;
    out.code_lines = highlightLines(str(d.code), str(d.language)).map((html, i) => ({ number: start + i, html }));
  } else if (qtype === CODE_COMPARISON) {
    const lang = str(d.language);
    out.files_a = comparisonFiles(d, "a", lang);
    out.files_b = comparisonFiles(d, "b", lang);
  }
  return out;
}

// PRNG deterministico (mulberry32), seminato dall'id della domanda: come
// random.Random(question.id) nella versione Django, l'ordine resta lo stesso a ogni visita.
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

export interface PublicQuestion {
  id: number;
  qtype: string;
  qtype_label: string;
  prompt_html: string;
  statement_html?: string;
  options?: { id: string; text: string }[];
  multiple?: boolean;
  code_lines?: { number: number; html: string }[];
  language?: string;
  files_a?: { name: string; html: string }[];
  files_b?: { name: string; html: string }[];
  label_a?: string;
  label_b?: string;
  cc_swap?: boolean;
}

/**
 * Quello che il browser riceve PRIMA della risposta: niente soluzione e niente
 * spiegazione. Porta question_context (opzioni mescolate, lato del confronto).
 */
export function publicQuestion(id: number, qtype: string, data: QuestionData, render: RenderedQuestion): PublicQuestion {
  const d = data || {};
  const q: PublicQuestion = { id, qtype, qtype_label: QTYPE_LABELS[qtype] || qtype, prompt_html: render.prompt_html };
  if (qtype === TRUE_FALSE) {
    q.statement_html = render.statement_html;
  } else if (qtype === MULTIPLE_CHOICE) {
    const options = (Array.isArray(d.options) ? d.options : []).map((o: QuestionData) => ({ id: String(o.id), text: str(o.text) }));
    const r = rng(id || 0);
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }
    q.options = options;
    q.multiple = Boolean(d.multiple);
  } else if (qtype === FIND_WRONG_LINE) {
    q.code_lines = render.code_lines;
    q.language = str(d.language);
  } else if (qtype === CODE_COMPARISON) {
    q.files_a = render.files_a;
    q.files_b = render.files_b;
    q.label_a = str(d.label_a) || "Versione A";
    q.label_b = str(d.label_b) || "Versione B";
    q.cc_swap = rng(id || 0)() < 0.5;
  }
  return q;
}

/** Testi brevi «sua risposta» / «risposta corretta» del report dei tornei. */
export function answerTexts(qtype: string, data: QuestionData, submitted: Submission, solution: Record<string, unknown>): [string, string] {
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
    const chosen = ((s.lines as unknown[]) || []).join(", ");
    const correct = ((solution.correct_lines as unknown[]) || []).join(", ");
    return [chosen ? `riga/e ${chosen}` : "—", correct ? `riga/e ${correct}` : "—"];
  }
  if (qtype === CODE_COMPARISON) {
    const labels: Record<string, string> = { a: str(d.label_a) || "Versione A", b: str(d.label_b) || "Versione B" };
    return [labels[String(s.choice)] || "—", labels[String(solution.correct)] || "—"];
  }
  return ["—", "—"];
}
