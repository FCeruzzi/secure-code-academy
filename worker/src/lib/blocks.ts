// «Individua la riga errata»: un clic su una riga sceglie il suo blocco.
//
// Il blocco è il più interno che contiene la riga cliccata, dalla «{» alla «}» che la
// chiude: un «if» dentro un metodo è un blocco a sé; una riga direttamente nel corpo di
// un metodo sceglie il metodo intero, con la firma e le annotazioni sopra. Classi e
// altre dichiarazioni di tipo non sono mai un blocco: al massimo un clic sceglie un
// metodo. È blocco la sola riga fuori da ogni blocco, nei file di dati e di
// configurazione (JSON, YAML, HTML, Terraform, pipeline…) e nelle domande fatte di un
// solo blocco di codice che è un solo metodo: lì un clic nel corpo sceglierebbe tutto.
// La stessa funzione decide cosa evidenzia la pagina e cosa accetta la correzione.

/** [indice del file, prima riga, ultima riga] (numeri di riga come li vede chi gioca). */
export type Block = [number, number, number];

export interface BlockFile {
  name: string;
  content: string;
  language: string;
  start_line: number;
}

const KEY = /^(\d+):(-?\d+)$/;

const BRACE_LANGS = new Set([
  "java", "javascript", "js", "jsx", "typescript", "ts", "tsx", "csharp", "cs", "c#", "go",
  "golang", "php", "kotlin", "kt", "c", "cpp", "c++", "rust", "swift", "scala", "dart",
  "solidity",
]);
const EXT_LANG: Record<string, string> = {
  ".java": "java", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript", ".cs": "csharp",
  ".go": "go", ".php": "php", ".kt": "kotlin", ".c": "c", ".h": "c", ".cpp": "cpp",
  ".rs": "rust", ".swift": "swift", ".scala": "scala", ".dart": "dart", ".py": "python",
  ".rb": "ruby",
};
const DATA_EXTS = new Set([
  ".json", ".yml", ".yaml", ".ini", ".md", ".html", ".htm", ".xml", ".sql", ".env",
  ".properties", ".toml", ".cfg", ".conf", ".txt", ".csv", ".sh", ".bash", ".lock",
  ".css", ".scss", ".less", ".tf", ".hcl", ".groovy", ".gradle",
]);
const CONTAINER = new RegExp(
  String.raw`^\s*(?:(?:public|private|protected|internal|abstract|final|static|sealed|partial|export|` +
    String.raw`default|data|open|inner|readonly|declare|pub|unsafe|companion|annotation)\s+)*` +
    String.raw`(?:class|interface|enum|record|struct|namespace|module|trait|impl|object|@interface)\b` +
    String.raw`|^\s*type\s+\w+\s+(?:struct|interface)\b`,
);
const ANNOTATION = /^\s*(?:@[\w.]+(?:\(.*\))?|\[[A-Za-z][^\]]*\])\s*$/;
const DEF = /^\s*(?:async\s+)?def\b/;
const PY_BLOCK = /^\s*(?:async\s+)?(?:def|if|elif|else|for|while|with|try|except|finally|match|case)\b/;
const END = /^\s*end\b/;

type Span = [number, number];

/** "brace", "python", "ruby" oppure "line" (una riga per blocco) per un file. */
function mode(name: string, language: string): string {
  const lower = (name || "").toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
  if (["dockerfile", "jenkinsfile", "makefile"].some((s) => lower.endsWith(s)) || DATA_EXTS.has(ext)) return "line";
  const lang = EXT_LANG[ext] || (language || "").trim().toLowerCase();
  if (BRACE_LANGS.has(lang)) return "brace";
  if (lang === "python" || lang === "py") return "python";
  if (lang === "ruby" || lang === "rb") return "ruby";
  return "line";
}

/** Le righe senza stringhe e commenti, così le loro graffe non contano. */
function codeOnly(lines: string[]): string[] {
  const out: string[] = [];
  let inComment = false;
  for (const line of lines) {
    let buf = "";
    let i = 0;
    const n = line.length;
    while (i < n) {
      if (inComment) {
        const end = line.indexOf("*/", i);
        if (end < 0) break;
        inComment = false;
        i = end + 2;
        continue;
      }
      if (line.startsWith("/*", i)) {
        inComment = true;
        i += 2;
        continue;
      }
      if (line.startsWith("//", i)) break;
      const c = line[i];
      if (c === '"' || c === "'" || c === "`") {
        let j = i + 1;
        while (j < n && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
        buf += " ";
        i = j + 1;
        continue;
      }
      buf += c;
      i += 1;
    }
    out.push(buf);
  }
  return out;
}

/** Una dichiarazione di tipo (class, interface, namespace…): mai un blocco a sé. */
function isType(before: string, header: string): boolean {
  return CONTAINER.test(before.trim() ? before : header);
}

/** (inizio, fine) di ogni blocco tranne i tipi: metodi, i loro «if», cicli, callback, oggetti. */
function braceSpans(lines: string[]): Span[] {
  const code = codeOnly(lines);
  const stack: [number, string][] = [];
  const blocks: [number, number, string][] = [];
  code.forEach((text, idx) => {
    for (let pos = 0; pos < text.length; pos++) {
      const c = text[pos];
      if (c === "{") stack.push([idx, text.slice(0, pos)]);
      else if (c === "}" && stack.length) {
        const [opened, before] = stack.pop()!;
        if (idx > opened) blocks.push([opened, idx, before]);
      }
    }
  });
  const spans: Span[] = [];
  for (const [opened, closed, before] of blocks) {
    let start = opened;
    let header = lines[opened];
    if (!before.trim()) {
      // «{» da sola sulla riga: la firma è la riga prima.
      let prev = opened - 1;
      while (prev >= 0 && !lines[prev].trim()) prev -= 1;
      if (prev >= 0) {
        start = prev;
        header = lines[prev];
      }
    }
    while (start > 0 && ANNOTATION.test(lines[start - 1])) start -= 1;
    if (!isType(before, header)) spans.push([start, closed]);
  }
  return spans;
}

/** Il rientro iniziale, con le tabulazioni ogni 4 colonne. */
function indent(line: string): number {
  let col = 0;
  for (const c of line) {
    if (c === "\t") col = (Math.floor(col / 4) + 1) * 4;
    else if (/\s/.test(c)) col += 1;
    else break;
  }
  return col;
}

/** L'ultima riga di un'intestazione che continua dentro le sue parentesi. */
function signatureEnd(lines: string[], head: number): number {
  let sig = head;
  let depth = 0;
  while (sig < lines.length) {
    for (const c of lines[sig]) {
      if ("([{".includes(c)) depth += 1;
      else if (")]}".includes(c)) depth -= 1;
    }
    if (depth <= 0) break;
    sig += 1;
  }
  return Math.min(sig, lines.length - 1);
}

/**
 * Python: ogni «def» (con i suoi decoratori) e ogni istruzione composta («if», «for»,
 * «with», «try»…), dal rientro. Le classi non sono blocchi.
 */
function pythonSpans(lines: string[]): Span[] {
  const spans: Span[] = [];
  lines.forEach((text, head) => {
    if (!PY_BLOCK.test(text)) return;
    const base = indent(text);
    const sig = signatureEnd(lines, head);
    if (!lines[sig].split("#")[0].trimEnd().endsWith(":")) return; // «if x: return y» su una riga: la riga sola
    let end = sig;
    for (let j = sig + 1; j < lines.length; j++) {
      const body = lines[j];
      if (!body.trim() || body.trimStart().startsWith("#")) continue;
      if (indent(body) <= base) break;
      end = j;
    }
    if (end === sig && sig === head) return;
    let start = head;
    if (DEF.test(text)) {
      while (start > 0 && lines[start - 1].trim().startsWith("@") && indent(lines[start - 1]) === base) start -= 1;
    }
    spans.push([start, end]);
  });
  return spans;
}

/** Ruby: ogni «def … end» (i metodi su una riga restano una riga). */
function rubySpans(lines: string[]): Span[] {
  const spans: Span[] = [];
  lines.forEach((text, head) => {
    if (!DEF.test(text)) return;
    const base = indent(text);
    for (let j = head + 1; j < lines.length; j++) {
      if (lines[j].trim() && indent(lines[j]) === base && END.test(lines[j])) {
        spans.push([head, j]);
        return;
      }
    }
  });
  return spans;
}

/** Per ogni riga, il blocco più piccolo (`smallest`) o più grande che la contiene. */
function holdingSpan(spans: Span[], count: number, smallest: boolean): (Span | null)[] {
  const out: (Span | null)[] = [];
  for (let idx = 0; idx < count; idx++) {
    let best: Span | null = null;
    for (const sp of spans) {
      if (sp[0] > idx || idx > sp[1]) continue;
      const size = sp[1] - sp[0];
      if (!best || (smallest ? size < best[1] - best[0] : size > best[1] - best[0])) best = sp;
    }
    out.push(best);
  }
  return out;
}

/** {"i:n" → [i, prima, ultima]}: il blocco (in numeri di riga) di ogni riga. */
export function fileBlocks(files: BlockFile[]): Map<string, Block> {
  const out = new Map<string, Block>();
  files.forEach((f, i) => {
    const lines = f.content.split("\n");
    const first = f.start_line;
    const m = mode(f.name, f.language);
    const found = m === "brace" ? braceSpans(lines) : m === "python" ? pythonSpans(lines) : m === "ruby" ? rubySpans(lines) : [];
    let spans = holdingSpan(found, lines.length, true);
    const outer = new Set(holdingSpan(found, lines.length, false).filter((sp): sp is Span => sp !== null).map((sp) => sp.join("-")));
    if (files.length === 1 && outer.size < 2) {
      // Un solo blocco di codice che è un solo metodo: la risposta è la riga, come sempre.
      spans = lines.map(() => null);
    }
    spans.forEach((span, idx) => {
      const [s, e] = span ?? [idx, idx];
      out.set(`${i}:${first + idx}`, [i, first + s, first + e]);
    });
  });
  return out;
}

/** Il blocco di una chiave; una chiave sconosciuta è un blocco della sua sola riga. */
export function blockOf(blocks: Map<string, Block>, key: string): Block | null {
  const known = blocks.get(key);
  if (known) return known;
  const m = KEY.exec(String(key));
  if (!m) return null;
  const n = parseInt(m[2], 10);
  return [parseInt(m[1], 10), n, n];
}

export function blockKeys(block: Block): Set<string> {
  const [i, first, last] = block;
  const keys = new Set<string>();
  for (let n = first; n <= last; n++) keys.add(`${i}:${n}`);
  return keys;
}

/** Blocchi senza doppioni, in ordine di file e di riga. */
export function sortBlocks(blocks: Iterable<Block>): Block[] {
  const unique = new Map<string, Block>();
  for (const b of blocks) unique.set(b.join(","), b);
  return [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

/** "0:13-16": il blocco di una riga, come lo riceve la pagina. */
export const blockRef = (b: Block): string => `${b[0]}:${b[1]}-${b[2]}`;
