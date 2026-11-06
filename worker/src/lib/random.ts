// Numeri casuali dal generatore crittografico del runtime. Nel Worker non si usa
// Math.random, nemmeno dove la casualità non protegge nulla (pulizie, ordine delle
// domande): così non c'è da chiedersi caso per caso se sia prevedibile.

const RANGE = 0x1_0000_0000; // 2^32: i valori di un Uint32

/** Intero casuale in [0, max), senza lo sbilanciamento del modulo. */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0 || max > RANGE) throw new RangeError("randomInt: max fuori intervallo");
  // Scarta la coda che non si divide per max: ogni valore resta equiprobabile.
  const limit = RANGE - (RANGE % max);
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % max;
}

/** Vero con probabilità `p` (fra 0 e 1). */
export const chance = (p: number): boolean => randomInt(1_000_000) < p * 1_000_000;

/** Copia di `items` in ordine casuale (Fisher–Yates). */
export function shuffled<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
