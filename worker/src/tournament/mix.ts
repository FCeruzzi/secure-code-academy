// Mix dei tipi di domanda in un torneo: 15% vero/falso, 15% scelta multipla,
// 30% individua la riga errata, 40% confronto di codice, in ogni round.
import { QTYPE_LABELS } from "../lib/questions";

export const MIX: readonly (readonly [string, number])[] = [
  ["TRUE_FALSE", 15],
  ["MULTIPLE_CHOICE", 15],
  ["FIND_WRONG_LINE", 30],
  ["CODE_COMPARISON", 40],
];

export const MIX_TEXT = MIX.map(([t, pct]) => `${pct}% ${QTYPE_LABELS[t]}`).join(", ");

export type Counts = Record<string, number>;

/**
 * Domande per tipo in un round da `n`: le quote intere, poi i posti rimasti ai
 * resti più grandi (a pari resto vince il tipo che viene prima in MIX).
 * 10 domande → 2 vero/falso, 1 scelta multipla, 3 riga errata, 4 confronto.
 */
export function mixCounts(n: number): Counts {
  const rows = MIX.map(([t, pct], i) => {
    const exact = (n * pct) / 100;
    return { t, i, base: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = n - rows.reduce((s, r) => s + r.base, 0);
  for (const r of [...rows].sort((a, b) => b.rest - a.rest || a.i - b.i)) {
    if (left <= 0) break;
    r.base += 1;
    left -= 1;
  }
  return Object.fromEntries(rows.map((r) => [r.t, r.base]));
}

export interface Plan {
  /** Domande per round (0 se il mix non si può comporre). */
  per_round: number;
  counts: Counts;
  available: Counts;
  manual: boolean;
  /** Perché la gara non può partire; vuoto se può. */
  problems: string[];
}

const fits = (counts: Counts, available: Counts, rounds: number) => MIX.every(([t]) => counts[t] * rounds <= (available[t] ?? 0));

/**
 * Quante domande per round e di che tipo. `poolSize` è quello del torneo; se
 * manca vale «tutte»: con le domande scelte a mano sono quelle divise per i
 * round, altrimenti il round più grande che il pool riesce a comporre.
 * I round non ripetono domande, quindi ogni tipo deve bastare per tutti.
 */
export function planRounds(available: Counts, poolSize: number | null, rounds: number, picked: number | null): Plan {
  const total = MIX.reduce((s, [t]) => s + (available[t] ?? 0), 0);
  const manual = picked !== null;
  let n: number;
  if (poolSize) n = poolSize;
  else if (manual) n = Math.floor(picked / Math.max(1, rounds));
  else {
    n = 0;
    for (let k = Math.floor(total / Math.max(1, rounds)); k > 0; k--) {
      if (fits(mixCounts(k), available, rounds)) {
        n = k;
        break;
      }
    }
  }
  const problems: string[] = [];
  if (!total) {
    problems.push(
      manual
        ? "Nessuna delle domande scelte è utilizzabile: devono essere attive e fuori dai quiz dei microcorsi."
        : "Serve almeno un corso con domande attive della banca (fuori dai quiz dei microcorsi), oppure scegli le domande dalla banca.",
    );
    return { per_round: 0, counts: mixCounts(0), available, manual, problems };
  }
  const counts = mixCounts(Math.max(n, 1));
  if (!n || !fits(counts, available, rounds)) {
    const missing = MIX.filter(([t]) => counts[t] * rounds > (available[t] ?? 0)).map(
      ([t]) => `${counts[t] * rounds} «${QTYPE_LABELS[t]}» (${available[t] ?? 0} disponibili)`,
    );
    const what = manual ? "Le domande scelte" : "Le domande dei corsi selezionati";
    problems.push(
      `${what} non bastano per il mix del torneo (${MIX_TEXT}): per ${rounds} round da ${Math.max(n, 1)} servono ${missing.join(", ")}.`,
    );
    return { per_round: 0, counts, available, manual, problems };
  }
  return { per_round: n, counts, available, manual, problems };
}
