// Worker di Secure Code Academy: l'API JSON che il sito su GitHub Pages legge.
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./env";
import { HttpError } from "./lib/http";
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
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header("X-Frame-Options", "DENY");
  c.header("Cache-Control", "no-store");
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
