import { describe, expect, it } from "vitest";
import { mixCounts, planRounds } from "../src/tournament/mix";

describe("mix dei tipi nei tornei", () => {
  it("15/15/30/40 con l'arrotondamento concordato", () => {
    expect(mixCounts(10)).toEqual({ TRUE_FALSE: 2, MULTIPLE_CHOICE: 1, FIND_WRONG_LINE: 3, CODE_COMPARISON: 4 });
    expect(mixCounts(20)).toEqual({ TRUE_FALSE: 3, MULTIPLE_CHOICE: 3, FIND_WRONG_LINE: 6, CODE_COMPARISON: 8 });
    expect(mixCounts(5)).toEqual({ TRUE_FALSE: 1, MULTIPLE_CHOICE: 1, FIND_WRONG_LINE: 1, CODE_COMPARISON: 2 });
    expect(mixCounts(1)).toEqual({ TRUE_FALSE: 0, MULTIPLE_CHOICE: 0, FIND_WRONG_LINE: 0, CODE_COMPARISON: 1 });
    for (let n = 0; n <= 60; n++) {
      const c = mixCounts(n);
      expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(n);
      // Mai più di un posto di scarto dalla quota esatta.
      expect(Math.abs(c.CODE_COMPARISON - n * 0.4)).toBeLessThan(1);
      expect(Math.abs(c.TRUE_FALSE - n * 0.15)).toBeLessThan(1);
    }
  });

  it("piano: round più grande possibile, o cosa manca", () => {
    const available = { TRUE_FALSE: 10, MULTIPLE_CHOICE: 10, FIND_WRONG_LINE: 6, CODE_COMPARISON: 8 };
    // Senza «domande per round»: il round più grande che il pool compone (20 → 6 riga errata, 8 confronti).
    expect(planRounds(available, null, 1, null)).toMatchObject({ per_round: 20, problems: [] });
    expect(planRounds(available, null, 2, null)).toMatchObject({ per_round: 11, problems: [] });
    expect(planRounds(available, 10, 2, null).problems).toEqual([]);
    const short = planRounds(available, 10, 3, null);
    expect(short.per_round).toBe(0);
    expect(short.problems[0]).toContain("12 «Confronto di codice» (8 disponibili)");
    expect(short.problems[0]).not.toContain("«Vero / Falso»");
    // Solo vero/falso: nessun round possibile.
    expect(planRounds({ TRUE_FALSE: 30 }, null, 1, null).per_round).toBe(0);
    // Domande scelte a mano: tutte, divise per i round.
    expect(planRounds({ TRUE_FALSE: 2, MULTIPLE_CHOICE: 1, FIND_WRONG_LINE: 3, CODE_COMPARISON: 4 }, null, 1, 10)).toMatchObject({ per_round: 10, manual: true, problems: [] });
    expect(planRounds({ TRUE_FALSE: 3, MULTIPLE_CHOICE: 1, FIND_WRONG_LINE: 3, CODE_COMPARISON: 3 }, null, 1, 10).problems[0]).toContain("Le domande scelte");
    expect(planRounds({}, null, 1, null).problems[0]).toContain("fuori dai quiz");
  });
});
