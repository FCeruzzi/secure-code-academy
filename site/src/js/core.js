// Utility comuni: configurazione, link con il prefisso del sito, chiamate all'API,
// messaggi «flash» fra una pagina e l'altra, sessione del pannello.

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || "";

export const config = {
  base: meta("sca-base") || "/",
  api: meta("sca-api").replace(/\/+$/, ""),
};

/**
 * Il percorso di una pagina interna, con ogni segmento codificato: niente schema,
 * host, `//`, `.` o `..` possono arrivarci da un valore preso dall'URL. Resta solo
 * la barra finale («corso/»).
 */
function cleanPath(path) {
  const parts = String(path).split("/");
  const out = [];
  parts.forEach((part, i) => {
    if (part === "" || part === "." || part === "..") {
      if (i === parts.length - 1 && out.length) out.push("");
      return;
    }
    out.push(encodeURIComponent(part));
  });
  return out.join("/");
}

/**
 * Link interno al sito, con il prefisso di GitHub Pages e i parametri (anche quelli
 * già scritti nel percorso, come nel `next` del login). Chiavi e valori sono
 * codificati con encodeURIComponent.
 */
export function url(path = "/", params = {}) {
  const raw = String(path);
  const q = raw.indexOf("?");
  const merged = new Map(q === -1 ? [] : new URLSearchParams(raw.slice(q + 1)));
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") merged.set(k, String(v));
  }
  const query = [...merged].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return config.base + cleanPath(q === -1 ? raw : raw.slice(0, q)) + (query ? `?${query}` : "");
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

/** Va a una pagina del sito. Solo sulla stessa origine: un parametro non porta mai altrove. */
export function go(path, params) {
  const target = new URL(url(path, params), location.href);
  location.href = target.origin === location.origin ? target.href : new URL(config.base, location.href).href;
}

/**
 * Solo percorsi interni al pannello («admin/…», con eventuali parametri): il `next`
 * del login non può portare su un altro sito né fuori dal pannello.
 */
export function safeNext(next) {
  const value = String(next || "");
  return /^admin\/[A-Za-z0-9/_\-?=&%.]*$/.test(value) && !/\.\.|\/\//.test(value) ? value : "admin/";
}

/** La pagina del pannello in cui si è, per tornarci dopo il login. */
export const currentAdminPath = () => safeNext(location.pathname.slice(config.base.length) + location.search);

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
// Il token sta in sessionStorage: come un cookie di sessione sparisce alla chiusura del
// browser, e scade comunque dopo 30 minuti di inattività.
//
// sessionStorage è per scheda: una scheda nuova chiede il token a quelle già aperte su un
// BroadcastChannel, che non esce dall'origine. Niente localStorage né cookie: chiuse tutte le
// schede la sessione finisce. L'uscita (o la scadenza) in una scheda chiude anche le altre.

const TOKEN_KEY = "sca_admin_token";
const USER_KEY = "sca_admin_user";

const channel = (() => {
  try {
    return new BroadcastChannel("sca-admin");
  } catch {
    return null;
  }
})();

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
  /** Esce da questa scheda e, con `everywhere`, dalle altre che usano lo stesso token. */
  clear(everywhere = true) {
    const token = admin.token();
    session.removeItem(TOKEN_KEY);
    session.removeItem(USER_KEY);
    if (everywhere && token && channel) channel.postMessage({ type: "logout", token });
  },
};

/** Un consulente lavora solo sui contenuti: il pannello nasconde il resto (il blocco vero è nel Worker). */
export const isConsultant = () => admin.user()?.role === "consultant";

if (channel) {
  channel.addEventListener("message", (e) => {
    const m = e.data || {};
    const token = admin.token();
    if (m.type === "ask" && token && typeof m.id === "string") {
      channel.postMessage({ type: "session", id: m.id, token, user: admin.user() });
    } else if (m.type === "logout" && token && m.token === token) {
      admin.clear(false);
      window.dispatchEvent(new CustomEvent("sca-logout"));
    }
  });
}

/** Senza token in questa scheda, prova a riceverlo da un'altra già aperta (entro `wait` ms). */
export function shareSession(wait = 400) {
  if (admin.token() || !channel) return Promise.resolve(Boolean(admin.token()));
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const finish = (found) => {
      channel.removeEventListener("message", onReply);
      clearTimeout(timer);
      resolve(found);
    };
    const onReply = (e) => {
      const m = e.data || {};
      if (m.type !== "session" || m.id !== id || typeof m.token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(m.token)) return;
      admin.set(m.token, m.user && typeof m.user === "object" ? m.user : null);
      finish(true);
    };
    const timer = setTimeout(() => finish(false), wait);
    channel.addEventListener("message", onReply);
    channel.postMessage({ type: "ask", id });
  });
}

// --- Messaggi «flash» -------------------------------------------------------------
// Un messaggio scritto prima di cambiare pagina compare in cima alla pagina successiva.

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
    const body = data && typeof data === "object" ? data : {};
    super(typeof body.error === "string" && body.error ? body.error : `Errore ${status}`);
    this.status = status;
    // Solo quello che il sito usa: gli errori dei campi e il primo accesso da completare.
    this.data = {
      errors: body.errors && typeof body.errors === "object" ? body.errors : undefined,
      setup_required: Boolean(body.setup_required),
    };
  }
}

/**
 * Chiamata all'API del Worker. Con `auth` manda il token del pannello e, se la
 * sessione è scaduta o il primo accesso non è completato, porta alla pagina
 * giusta (login o primo accesso).
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
      go("admin/login/", { next: currentAdminPath() });
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
// Il risultato va sempre in x-text (testo, mai HTML): niente da ripulire, un
// eventuale `<script>` citato in una domanda si legge com'è scritto.
export const truncate = (s, n) => {
  const t = String(s || "");
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
