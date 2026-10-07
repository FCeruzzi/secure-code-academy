// Hash delle password in un Durable Object.
//
// PBKDF2 a 100.000 iterazioni costa circa 20 ms di CPU: oltre i 10 ms per
// richiesta che il piano gratuito concede a un Worker. Una richiesta a un
// Durable Object ha un suo limite di CPU, molto più ampio, quindi il calcolo si
// fa qui e il Worker si limita ad aspettarne il risultato (attesa che non
// consuma CPU).
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { hashPassword, iterations, verifyPassword } from "./auth";

export class PasswordHasher extends DurableObject<Env> {
  async hash(password: string): Promise<string> {
    return hashPassword(password, iterations(this.env));
  }

  /**
   * Senza hash (account inesistente o disattivato) calcola comunque un PBKDF2
   * con le stesse iterazioni: i tempi di risposta non rivelano quali username
   * esistono.
   */
  async verify(password: string, encoded: string | null): Promise<boolean> {
    if (!encoded) {
      await hashPassword(password, iterations(this.env));
      return false;
    }
    return verifyPassword(password, encoded);
  }
}

// Più istanze scelte a caso: un'ondata di login non si accoda tutta su una sola.
const SHARDS = 8;
const hasher = (env: Env) => env.HASHER.get(env.HASHER.idFromName(`password-hasher-${Math.floor(Math.random() * SHARDS)}`));

export const hashPw = (env: Env, password: string) => hasher(env).hash(password);
export const verifyPw = (env: Env, password: string, encoded: string | null) => hasher(env).verify(password, encoded);
