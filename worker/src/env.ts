import type { PasswordHasher } from "./lib/hasher";
import type { TournamentRoom } from "./tournament/room";

export interface Env {
  DB: D1Database;
  TOURNAMENT: DurableObjectNamespace<TournamentRoom>;
  HASHER: DurableObjectNamespace<PasswordHasher>;
  SITE_ORIGIN: string;
  ADMIN_USERNAMES: string;
  PBKDF2_ITERATIONS: string;
}

export interface AdminUser {
  id: number;
  username: string;
  email: string;
  is_active: number;
  must_change_password: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: AdminUser };
};
