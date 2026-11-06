import type { PasswordHasher } from "./lib/hasher";
import type { TournamentRoom } from "./tournament/room";

export interface Env {
  DB: D1Database;
  TOURNAMENT: DurableObjectNamespace<TournamentRoom>;
  HASHER: DurableObjectNamespace<PasswordHasher>;
  SITE_ORIGIN: string;
  /** Secret: gli username autorizzati, separati da virgola. */
  ADMIN_USERNAMES: string;
  PBKDF2_ITERATIONS: string;
}

export interface AdminUser {
  id: number;
  username: string;
  is_active: number;
  must_change_password: number;
  /** "admin" oppure "consultant" (solo contenuti: vedi consultantMay). */
  role: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: AdminUser };
};
