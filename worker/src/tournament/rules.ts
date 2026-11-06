// Regole dei tornei che servono sia al Durable Object (room.ts) sia al backup in
// JSON (archive.ts): avatar, limiti dei tempi, tetto agli iscritti, pulizia dei nomi.

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
export const AVATAR_KEYS = new Set(AVATARS.map((a) => a.key));

/** La soluzione resta visibile almeno tanto, anche nei tornei salvati prima del minimo. */
export const MIN_REVEAL_SECONDS = 10;

/**
 * All'avvio della gara e di ogni round il timer della prima domanda parte dopo
 * qualche secondo (un'impostazione del torneo): chi arriva dalla sala d'attesa fa in
 * tempo a caricare la pagina, e la domanda compare a tutti nello stesso momento.
 * Almeno 3 secondi: la sala d'attesa controlla ogni 2.
 */
export const DEFAULT_START_DELAY_SECONDS = 5;
export const MIN_START_DELAY_SECONDS = 3;
export const MAX_START_DELAY_SECONDS = 60;

/** Tetto alle iscrizioni di un torneo. */
export const MAX_PARTICIPANTS = 200;

/** Caratteri invisibili o che cambiano la direzione del testo: in un nome servono solo a ingannare. */
const INVISIBLE = /[­᠎​‌‎‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Il nome mostrato in classifica: normalizzato, senza caratteri di controllo né invisibili, al massimo 40. */
export function cleanDisplayName(raw: unknown): string {
  const name = String(raw ?? "")
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .replace(/[<>\x00-\x1f\x7f-\x9f]/g, "")
    .trim();
  return Array.from(name).slice(0, 40).join("").trim();
}
