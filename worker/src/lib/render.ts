// Markdown ed evidenziazione del codice: porta apps/core/rendering.py.
//
// Gira nel Worker al salvataggio dal pannello: l'HTML si salva già pronto.
//
// Differenze dalla versione Django, volute:
// - l'HTML grezzo nel Markdown viene mostrato come testo (markdown-it con
//   `html: false`) invece di essere filtrato da bleach. Non serve un sanitizer:
//   nessun tag arriva al browser se non quelli che il parser genera;
// - l'evidenziazione usa highlight.js al posto di Pygments, con un tema che
//   riprende la stessa palette (site/src/css/highlight.css).
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import http from "highlight.js/lib/languages/http";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash, c, cpp, csharp, css, dockerfile, go, http, ini, java, javascript, json,
  kotlin, php, plaintext, python, ruby, shell, sql, typescript, xml, yaml,
};
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);

// Nomi dei lexer Pygments usati nei contenuti che highlight.js non conosce come
// alias. Tutto il resto (html, js, jsx, sh, yml, py, …) è già un alias.
const ALIASES: Record<string, string> = {
  text: "plaintext",
  txt: "plaintext",
  "c#": "csharp",
  cs: "csharp",
  console: "shell",
  shell: "shell",
  properties: "ini",
  toml: "ini",
  jinja: "xml",
  "html+jinja": "xml",
  docker: "dockerfile",
};

const AUTO_LANGUAGES = Object.keys(LANGUAGES).filter((l) => l !== "plaintext");

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function resolveLanguage(language: string | undefined | null): string | null {
  const name = (language || "").trim().toLowerCase();
  if (!name) return null;
  const mapped = Object.hasOwn(ALIASES, name) ? ALIASES[name] : name;
  // hljs cerca i linguaggi in oggetti semplici: «constructor» lo troverebbe.
  if (mapped in Object.prototype) return "plaintext";
  return hljs.getLanguage(mapped) ? mapped : "plaintext";
}

function highlight(code: string, language: string | undefined | null, guess = false): string {
  const lang = resolveLanguage(language);
  if (lang) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  // Come il codehilite di Python-Markdown (guess_lang): senza linguaggio prova
  // a indovinarlo, ma solo per i blocchi del Markdown.
  if (guess) return hljs.highlightAuto(code, AUTO_LANGUAGES).value;
  return escapeHtml(code);
}

const ALLOWED_LINK = /^(https?:|mailto:)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

// Come bleach con protocols=["http","https","mailto"]: i link relativi passano,
// qualunque altro schema (javascript:, data:, file:, …) viene scartato.
md.validateLink = (url: string) => {
  const u = url.trim();
  return !HAS_SCHEME.test(u) || ALLOWED_LINK.test(u);
};

// bleach eliminava l'attributo style (allineamento delle tabelle compreso).
md.core.ruler.push("strip_style", (state) => {
  for (const token of state.tokens) {
    if (token.attrs) token.attrs = token.attrs.filter(([name]) => name !== "style");
  }
});

function codeBlock(content: string, info: string): string {
  const lang = (info || "").trim().split(/\s+/)[0] || "";
  const body = highlight(content.replace(/\n$/, ""), lang, true);
  // La classe del linguaggio serve al tema (site/src/css/input.css).
  const resolved = resolveLanguage(lang);
  const cls = resolved && resolved !== "plaintext" ? ` class="language-${resolved}"` : "";
  return `<div class="codehilite"><pre><code${cls}>${body}\n</code></pre></div>\n`;
}

md.renderer.rules.fence = (tokens, idx) => codeBlock(tokens[idx].content, tokens[idx].info);
md.renderer.rules.code_block = (tokens, idx) => codeBlock(tokens[idx].content, "");

/**
 * Markdown → HTML. `images` è la mappa `{ref_key: url}` di un microcorso: ogni
 * `img:<ref_key>` del sorgente viene sostituito con il link reale prima del
 * parsing, esattamente come render_markdown nella versione Django.
 */
export function renderMarkdown(text: string | null | undefined, images?: Record<string, string>): string {
  let src = text || "";
  if (images) {
    for (const [refKey, url] of Object.entries(images)) {
      src = src.split(`img:${refKey}`).join(url);
    }
  }
  return md.render(src);
}

/** Un unico blocco di codice evidenziato (span dei token, senza wrapper). */
export function highlightCode(code: string | null | undefined, language: string | null | undefined): string {
  return highlight(code || "", language || "text").replace(/\n+$/, "");
}

/** Una stringa HTML per riga, per le righe cliccabili di FIND_WRONG_LINE. */
export function highlightLines(code: string | null | undefined, language: string | null | undefined): string[] {
  return (code || "").split("\n").map((line) =>
    line.trim() === "" ? "&nbsp;" : highlight(line, language || "text").replace(/\n+$/, ""),
  );
}
