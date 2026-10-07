// Errori e utility comuni alle route.
import type { Context } from "hono";

/** Errore che diventa una risposta JSON {error} con lo status indicato. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what = "Pagina non trovata.") => new HttpError(404, what);
export const badRequest = (msg: string, extra: Record<string, unknown> = {}) => new HttpError(400, msg, extra);

export async function readJson<T = Record<string, unknown>>(c: Context): Promise<T> {
  try {
    const body = await c.req.json();
    if (typeof body !== "object" || body === null) throw new Error();
    return body as T;
  } catch {
    throw badRequest("Il corpo della richiesta non è un JSON valido.");
  }
}

export function intParam(c: Context, name: string): number {
  const raw = c.req.param(name) ?? "";
  if (!/^\d+$/.test(raw)) throw notFound();
  return parseInt(raw, 10);
}

export const bool = (v: unknown) => v === true || v === 1 || v === "1" || v === "true" || v === "on";

export function str(v: unknown, max = 100000): string {
  if (v === null || v === undefined) return "";
  return String(v).slice(0, max);
}

/** Intero positivo; `fallback` se mancante. Lancia 400 se non numerico. */
export function posInt(v: unknown, field: string, fallback: number | null = null): number | null {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < 0) {
    throw badRequest(`${field}: inserisci un numero intero positivo.`, { field });
  }
  return n;
}

/** Porta django.utils.text.slugify (ASCII, minuscolo, trattini). */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

export const SLUG_RE = /^[-a-zA-Z0-9_]+$/;

/** Uno slug unico in `table` (con filtro opzionale), come core/text.unique_slug. */
export async function uniqueSlug(
  db: D1Database,
  table: string,
  value: string,
  excludeId: number | null = null,
  scope: { column: string; value: number } | null = null,
): Promise<string> {
  const base = slugify(value) || "item";
  let candidate = base;
  for (let n = 2; ; n++) {
    let sql = `SELECT 1 FROM ${table} WHERE slug = ?`;
    const args: unknown[] = [candidate];
    if (scope) {
      sql += ` AND ${scope.column} = ?`;
      args.push(scope.value);
    }
    if (excludeId !== null) {
      sql += " AND id != ?";
      args.push(excludeId);
    }
    const hit = await db.prepare(sql).bind(...args).first();
    if (!hit) return candidate;
    candidate = `${base}-${n}`;
  }
}

/** Link HTTPS a un file pubblicato altrove (PDF, immagini): _clean_media_url. */
export function cleanMediaUrl(url: unknown, field = "url"): string {
  const u = str(url, 500).trim();
  if (!u.toLowerCase().startsWith("https://")) {
    throw badRequest("Il link deve iniziare con https:// — un file servito via http verrebbe bloccato dal browser.", { field });
  }
  try {
    if (!new URL(u).host) throw new Error();
  } catch {
    throw badRequest("Il link non contiene un indirizzo valido.", { field });
  }
  return u;
}

/** URL generico (risorse, laboratorio): http o https. */
export function cleanUrl(url: unknown, field = "url", required = true): string {
  const u = str(url, 500).trim();
  if (!u) {
    if (required) throw badRequest("Inserisci un link.", { field });
    return "";
  }
  try {
    const parsed = new URL(u);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.host) throw new Error();
  } catch {
    throw badRequest("Inserisci un URL valido.", { field });
  }
  return u;
}

export const nowIso = () => new Date().toISOString();
