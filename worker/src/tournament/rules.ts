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

/**
 * Lettere di altri alfabeti identiche a lettere latine: «Аda» con la А cirillica è un
 * altro nome per il computer, ma lo stesso per chi guarda la classifica.
 */
const LOOKALIKES: Record<string, string> = {
  // cirillico
  "а": "a", "в": "b", "е": "e", "ё": "e", "ѕ": "s", "і": "i", "ї": "i", "ј": "j", "к": "k", "м": "m",
  "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "һ": "h", "ԁ": "d", "ԛ": "q",
  "ԝ": "w", "ӏ": "l", "ɡ": "g",
  // greco
  "α": "a", "β": "b", "γ": "y", "ε": "e", "ζ": "z", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o",
  "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w",
  // latino «speciale»
  "ı": "i", "ȷ": "j", "ł": "l", "ø": "o", "đ": "d", "ħ": "h",
};

/**
 * La chiave per dire se due nomi sono lo stesso nome: senza accenti, maiuscole, spazi
 * doppi né lettere di altri alfabeti travestite da latine. Solo per il confronto: il nome
 * mostrato resta quello scelto.
 */
export function nameKey(name: string): string {
  return Array.from(
    String(name ?? "")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase(),
  )
    .map((c) => LOOKALIKES[c] ?? c)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

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
