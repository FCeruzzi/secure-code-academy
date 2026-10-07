// Utility comuni: configurazione, link con il prefisso del sito, chiamate all'API,
// messaggi «flash» fra una pagina e l'altra, sessione del pannello.

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || "";

export const config = {
  base: meta("sca-base") || "/",
  api: meta("sca-api").replace(/\/+$/, ""),
};

/** Link interno al sito, con il prefisso di GitHub Pages e i parametri. */
export function url(path = "/", params = {}) {
  const clean = String(path).replace(/^\/+/, "");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, v);
  }
  const query = qs.toString();
  return config.base + clean + (query ? `?${query}` : "");
}

/**
 * Solo link http(s). Gli URL dei contenuti arrivano dal database e finiscono in
 * href e src di iframe: uno `javascript:` non deve mai arrivarci.
 */
export function safeUrl(value) {
  try {
    const u = new URL(String(value || ""), location.href);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "about:blank";
  } catch {
    return "about:blank";
  }
}

export const param = (name) => new URLSearchParams(location.search).get(name) || "";

export function go(path, params) {
  location.href = url(path, params);
}

// --- Storage (può non essere disponibile: modalità privata, cookie bloccati) ----

function store(kind) {
  try {
    const s = kind === "local" ? window.localStorage : window.sessionStorage;
    const probe = "__sca__";
    s.setItem(probe, probe);
    s.removeItem(probe);
    return s;
  } catch {
    const mem = new Map();
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
  }
}
export const session = store("session");
export const local = store("local");

export function readJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
export const writeJson = (storage, key, value) => storage.setItem(key, JSON.stringify(value));

// --- Sessione del pannello ------------------------------------------------------
// Il token sta in sessionStorage: come il cookie di sessione della versione Django, sparisce
// alla chiusura del browser, e scade comunque dopo 30 minuti di inattività.

const TOKEN_KEY = "sca_admin_token";
const USER_KEY = "sca_admin_user";

export const admin = {
  token: () => session.getItem(TOKEN_KEY) || "",
  user: () => readJson(session, USER_KEY, null),
  set(token, user) {
    session.setItem(TOKEN_KEY, token);
    writeJson(session, USER_KEY, user);
  },
  setUser(user) {
    writeJson(session, USER_KEY, user);
  },
  clear() {
    session.removeItem(TOKEN_KEY);
    session.removeItem(USER_KEY);
  },
};

// --- Messaggi «flash» -------------------------------------------------------------
// Come i messages di Django: un messaggio scritto prima di cambiare pagina
// compare in cima alla pagina successiva.

const LEVEL_COLORS = { success: "emerald", error: "rose", warning: "amber", info: "sky", debug: "slate" };

export function flash(text, level = "success") {
  if (!text) return;
  const list = readJson(session, "sca_flash", []);
  list.push({ text, color: LEVEL_COLORS[level] || "sky" });
  writeJson(session, "sca_flash", list);
}

export function takeFlash() {
  const list = readJson(session, "sca_flash", []);
  session.removeItem("sca_flash");
  return list;
}

/** Mostra subito un messaggio nella pagina corrente. */
export function notify(text, level = "success") {
  window.dispatchEvent(new CustomEvent("sca-flash", { detail: { text, color: LEVEL_COLORS[level] || "sky" } }));
}

// --- API ----------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(status, data) {
    super((data && data.error) || `Errore ${status}`);
    this.status = status;
    this.data = data || {};
  }
}

/**
 * Chiamata all'API del Worker. Con `auth` manda il token del pannello e, se la
 * sessione è scaduta o il primo accesso non è completato, porta alla pagina
 * giusta come facevano i decoratori della versione Django.
 */
export async function api(path, { method = "GET", json, auth = false, participant, signal } = {}) {
  const headers = {};
  if (json !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = admin.token();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (participant) headers["X-Participant"] = participant;
  let res;
  try {
    res = await fetch(config.api + path, {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal,
      cache: "no-store",
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new ApiError(0, { error: "Impossibile contattare il server. Controlla la connessione e riprova." });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (auth && res.status === 401) {
      admin.clear();
      flash("Sessione scaduta: accedi di nuovo.", "info");
      go("admin/login/", { next: location.pathname.slice(config.base.length) + location.search });
      throw new ApiError(401, data);
    }
    if (auth && res.status === 403 && data && data.setup_required) {
      go("admin/primo-accesso/");
      throw new ApiError(403, data);
    }
    throw new ApiError(res.status, data);
  }
  return data;
}

/** Scarica un oggetto come file JSON (gli export del pannello). */
export function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** Legge un file JSON scelto dall'utente. */
export async function readJsonFile(file, maxBytes = 4 * 1024 * 1024) {
  if (!file) throw new Error("Seleziona un file.");
  if (file.size > maxBytes) throw new Error(`File troppo grande (max ${Math.floor(maxBytes / 1024 / 1024)} MB).`);
  try {
    return JSON.parse(await file.text());
  } catch {
    throw new Error("Il file non è un JSON valido.");
  }
}

// --- Piccole utility di presentazione ------------------------------------------------

export const SECTION_COLORS = { ATTACK: "rose", DEFENSE: "emerald", CHALLENGE: "violet", THEORY: "sky" };
export const SECTION_LABELS = { ATTACK: "Attacco", DEFENSE: "Difesa", CHALLENGE: "Sfida", THEORY: "Teoria" };
export const sectionColor = (s) => SECTION_COLORS[s] || "slate";
export const difficultyLabel = (v) => ({ 1: "Base", 2: "Intermedio", 3: "Avanzato" })[v] || `Difficoltà ${v}`;
export const difficultyStars = (v) => {
  const n = parseInt(v, 10);
  return n >= 1 && n <= 3 ? "⭐".repeat(n) : "⭐";
};
export const QTYPE_EMOJI = { TRUE_FALSE: "⚖️", MULTIPLE_CHOICE: "☑️", FIND_WRONG_LINE: "🐛", CODE_COMPARISON: "🆚" };
export const qtypeEmoji = (q) => QTYPE_EMOJI[q] || "❓";
export const LANGUAGE_LABELS = {
  java: "Java", javascript: "JavaScript", typescript: "TypeScript", python: "Python", php: "PHP",
  csharp: "C#", sql: "SQL", html: "HTML", css: "CSS", yaml: "YAML", json: "JSON", bash: "Bash", text: "Testo",
};
export const languageLabel = (v) => {
  if (!v) return "—";
  const s = String(v);
  return LANGUAGE_LABELS[s.toLowerCase()] || s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
};
export const pluralize = (n, singular, plural) => (Number(n) === 1 ? singular : plural);
export const truncate = (s, n) => {
  const t = String(s || "").replace(/<[^>]*>/g, "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
export const widthPct = (value, total) => (total ? Math.round((value / total) * 100) : 0);

export function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("it-IT", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

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
export const avatar = (key) => AVATARS.find((a) => a.key === key)?.emoji || "❓";

/**
 * Unisce più oggetti mantenendo i getter: lo spread (`...obj`) li valuterebbe
 * una volta sola, copiandone il valore, e i componenti Alpine li perderebbero.
 */
export function mix(...objects) {
  const out = {};
  for (const o of objects) Object.defineProperties(out, Object.getOwnPropertyDescriptors(o));
  return out;
}
