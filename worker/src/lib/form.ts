// Validazione dei form del pannello, con i messaggi italiani dei form Django.
import { badRequest, bool, cleanMediaUrl, cleanUrl, HttpError, SLUG_RE, str } from "./http";

export const REQUIRED = "Questo campo è obbligatorio.";

export class Form {
  errors: Record<string, string[]> = {};
  constructor(public data: Record<string, unknown>) {}

  private add(field: string, msg: string) {
    (this.errors[field] ||= []).push(msg);
  }

  text(field: string, { required = false, max = 100000 } = {}): string {
    const v = str(this.data[field]).trim();
    if (required && !v) this.add(field, REQUIRED);
    if (v.length > max) this.add(field, `Assicurati che questo valore contenga al massimo ${max} caratteri (ne ha ${v.length}).`);
    return v;
  }

  /** Testo lungo (Markdown): non si tolgono gli spazi iniziali, che contano. */
  body(field: string, { required = false } = {}): string {
    const v = str(this.data[field]).replace(/\r\n/g, "\n");
    if (required && !v.trim()) this.add(field, REQUIRED);
    return v;
  }

  slug(field: string, max = 210): string {
    const v = str(this.data[field]).trim();
    if (v && !SLUG_RE.test(v)) {
      this.add(field, "Inserisci uno «slug» valido costituito da lettere, numeri, trattini bassi o trattini.");
    }
    if (v.length > max) this.add(field, `Assicurati che questo valore contenga al massimo ${max} caratteri (ne ha ${v.length}).`);
    return v;
  }

  int(field: string, { required = false, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number {
    const raw = this.data[field];
    if (raw === null || raw === undefined || raw === "") {
      if (required) this.add(field, REQUIRED);
      return fallback;
    }
    const n = Number(String(raw).trim());
    if (!Number.isInteger(n)) {
      this.add(field, "Inserisci un numero intero.");
      return fallback;
    }
    if (n < min) this.add(field, `Assicurati che questo valore sia maggiore o uguale a ${min}.`);
    if (n > max) this.add(field, `Assicurati che questo valore sia minore o uguale a ${max}.`);
    return n;
  }

  optionalInt(field: string, { min = 0 } = {}): number | null {
    const raw = this.data[field];
    if (raw === null || raw === undefined || raw === "") return null;
    return this.int(field, { min });
  }

  bool(field: string): boolean {
    return bool(this.data[field]);
  }

  choice<T extends string>(field: string, choices: readonly T[], { required = true } = {}): T {
    const v = str(this.data[field]).trim() as T;
    if (!v) {
      if (required) this.add(field, REQUIRED);
      return v;
    }
    if (!choices.includes(v)) {
      this.add(field, `Scegli un'opzione valida. ${v} non è tra quelle disponibili.`);
    }
    return v;
  }

  url(field: string, { required = false } = {}): string {
    try {
      return cleanUrl(this.data[field], field, required);
    } catch (e) {
      if (e instanceof HttpError) this.add(field, e.message === "Inserisci un link." ? REQUIRED : e.message);
      else throw e;
      return "";
    }
  }

  mediaUrl(field: string): string {
    try {
      return cleanMediaUrl(this.data[field], field);
    } catch (e) {
      if (e instanceof HttpError) this.add(field, e.message);
      else throw e;
      return "";
    }
  }

  error(field: string, msg: string) {
    this.add(field, msg);
  }

  /** Se ci sono errori, risponde 400 con l'elenco per campo. */
  check(): void {
    if (Object.keys(this.errors).length) {
      const first = Object.values(this.errors)[0][0];
      throw badRequest(first, { errors: this.errors });
    }
  }
}
