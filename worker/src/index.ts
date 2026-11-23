// Worker di Secure Code Academy: l'API JSON che il sito su GitHub Pages legge.
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./env";
import { ipKey } from "./lib/auth";
import { BIG_BODY_BYTES, BODY_BYTES, HttpError } from "./lib/http";
import { authRoutes, requireAdmin } from "./routes/admin-auth";
import { catalogRoutes } from "./routes/admin-catalog";
import { questionRoutes } from "./routes/admin-questions";
import { publicRoutes } from "./routes/public";
import { playerRoutes, tournamentAdminRoutes } from "./routes/tournaments";

export { PasswordHasher } from "./lib/hasher";
export { TournamentRoom } from "./tournament/room";

const app = new Hono<AppEnv>();

const allowedOrigins = (env: AppEnv["Bindings"]) =>
  (env.SITE_ORIGIN || "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);

// Il sito sta su un'altra origine (github.io): il CORS risponde solo a quella.
// L'autenticazione è un header Authorization, non un cookie, quindi non ci
// sono credenziali «ambientali» da proteggere con un token CSRF.
app.use("/api/*", (c, next) =>
  cors({
    origin: (origin) => (allowedOrigins(c.env).includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Participant"],
    maxAge: 600,
  })(c, next),
);

app.use("*", async (c, next) => {
  await next();
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  // Uso interno: nessuna risposta dell'API nei motori di ricerca.
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("X-Frame-Options", "DENY");
  c.header("Cache-Control", "no-store");
});

/** Un limite di richieste superato? Senza binding (test, sviluppo) o se il servizio non risponde, no. */
async function overLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return false;
  try {
    return !(await limiter.limit({ key })).success;
  } catch {
    return false;
  }
}

const JOIN_PATH = /^\/api\/t\/[^/]+\/join$/;

// Prima di tutto il resto (D1, Durable Object): troppe richieste dallo stesso indirizzo, o
// un corpo troppo grande, si fermano qui. Gli import accettano file più grandi.
app.use("/api/*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const ip = ipKey(c.req.header("CF-Connecting-IP") || "unknown");
  const path = c.req.path;
  const action = c.req.method === "POST" && (path === "/api/admin/login" || JOIN_PATH.test(path));
  if ((await overLimit(c.env.API_LIMIT, ip)) || (action && (await overLimit(c.env.ACTION_LIMIT, `${path.endsWith("/join") ? "join" : "login"}:${ip}`)))) {
    c.header("Retry-After", "60");
    return c.json({ error: "Troppe richieste: riprova fra un minuto." }, 429);
  }
  const max = path.endsWith("/import") ? BIG_BODY_BYTES : BODY_BYTES;
  if (Number(c.req.header("Content-Length") || 0) > max) {
    return c.json({ error: "Richiesta troppo grande." }, 413);
  }
  return next();
});

app.use("/api/admin/*", async (c, next) => (c.req.path === "/api/admin/login" ? next() : requireAdmin(c, next)));

app.route("/api", publicRoutes);
app.route("/api/t", playerRoutes);
app.route("/api/admin", authRoutes);
app.route("/api/admin", catalogRoutes);
app.route("/api/admin", questionRoutes);
app.route("/api/admin", tournamentAdminRoutes);

app.get("/", (c) => c.json({ name: "Secure Code Academy API", ok: true }));

app.notFound((c) => c.json({ error: "Pagina non trovata." }, 404));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message, ...err.extra }, err.status as 400);
  }
  console.error(err);
  return c.json({ error: "Errore interno del server." }, 500);
});

export default app;
