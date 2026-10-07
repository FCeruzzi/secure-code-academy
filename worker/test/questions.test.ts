import { describe, expect, it } from "vitest";
import { grade, parseSubmission, publicQuestion, renderQuestion, validateQuestionData, ValidationError } from "../src/lib/questions";

describe("grade (come apps/quizzes/grading.py)", () => {
  it("vero/falso", () => {
    expect(grade("TRUE_FALSE", { answer: false }, { answer: false })).toEqual({ correct: true, solution: { answer: false } });
    expect(grade("TRUE_FALSE", { answer: true }, { answer: "vero" }).correct).toBe(true);
    expect(grade("TRUE_FALSE", { answer: true }, {}).correct).toBe(false);
  });

  it("scelta multipla: insieme esatto, senza punteggio parziale", () => {
    const data = { correct: ["a", "c"] };
    expect(grade("MULTIPLE_CHOICE", data, { selected: ["c", "a"] })).toEqual({ correct: true, solution: { correct: ["a", "c"] } });
    expect(grade("MULTIPLE_CHOICE", data, { selected: ["a"] }).correct).toBe(false);
    expect(grade("MULTIPLE_CHOICE", data, { selected: ["a", "c", "a"] }).correct).toBe(true);
    expect(grade("MULTIPLE_CHOICE", { correct: [] }, { selected: [] }).correct).toBe(false);
  });

  it("riga errata", () => {
    const data = { correct_lines: [7, 3] };
    expect(grade("FIND_WRONG_LINE", data, { lines: ["3", 7] })).toEqual({ correct: true, solution: { correct_lines: [3, 7] } });
    expect(grade("FIND_WRONG_LINE", data, { lines: [3] }).correct).toBe(false);
    expect(grade("FIND_WRONG_LINE", data, { lines: ["x", 3, 7] }).correct).toBe(true);
  });

  it("confronto di codice", () => {
    expect(grade("CODE_COMPARISON", { correct: "a" }, { choice: "a" }).correct).toBe(true);
    expect(grade("CODE_COMPARISON", { correct: "a" }, { choice: "b" }).correct).toBe(false);
    expect(grade("CODE_COMPARISON", { correct: "a" }, {}).correct).toBe(false);
  });

  it("tipo sconosciuto", () => {
    expect(grade("BOH", {}, {})).toEqual({ correct: false, solution: {} });
  });
});

describe("validateQuestionData", () => {
  const bad = (qtype: string, data: unknown) => expect(() => validateQuestionData(qtype, data)).toThrow(ValidationError);
  it("rifiuta i payload malformati", () => {
    bad("TRUE_FALSE", { answer: "true", statement: "x" });
    bad("TRUE_FALSE", { answer: true, statement: " " });
    bad("MULTIPLE_CHOICE", { options: [{ id: "a", text: "x" }], correct: ["a"] });
    bad("MULTIPLE_CHOICE", { options: [{ id: "a", text: "x" }, { id: "b", text: "y" }], correct: ["c"] });
    bad("FIND_WRONG_LINE", { code: "a\nb", correct_lines: [3] });
    bad("FIND_WRONG_LINE", { code: "a\nb", start_line: 10, correct_lines: [9] });
    bad("CODE_COMPARISON", { files_a: [{ name: "a", content: "x" }], snippet_b: "y", correct: "c" });
    bad("CODE_COMPARISON", { files_a: [{ name: "", content: "x" }], snippet_b: "y", correct: "a" });
    bad("NOPE", {});
    bad("TRUE_FALSE", []);
  });
  it("accetta i payload validi", () => {
    validateQuestionData("TRUE_FALSE", { answer: false, statement: "x" });
    validateQuestionData("FIND_WRONG_LINE", { code: "a\nb", start_line: 10, correct_lines: [11] });
    validateQuestionData("CODE_COMPARISON", { snippet_a: "x", files_b: [{ name: "b", content: "y" }], correct: "b" });
  });
});

describe("parseSubmission", () => {
  it("normalizza i tipi e scarta il resto", () => {
    expect(parseSubmission("TRUE_FALSE", { answer: "true", extra: 1 })).toEqual({ answer: true });
    expect(parseSubmission("MULTIPLE_CHOICE", { selected: "a" })).toEqual({ selected: ["a"] });
    expect(parseSubmission("FIND_WRONG_LINE", { lines: "3, 7,x" })).toEqual({ lines: [3, 7] });
    expect(parseSubmission("CODE_COMPARISON", { choice: "z" })).toEqual({ choice: null });
  });
});

describe("publicQuestion", () => {
  it("non contiene mai la soluzione", () => {
    const data = { options: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }], correct: ["b"], multiple: false };
    const pq = publicQuestion(7, "MULTIPLE_CHOICE", data, renderQuestion("MULTIPLE_CHOICE", "Domanda", "Perché", data));
    const json = JSON.stringify(pq);
    expect(json).not.toContain("correct");
    expect(json).not.toContain("Perché");
    expect(pq.options!.map((o) => o.id).sort()).toEqual(["a", "b", "c"]);
    // L'ordine mescolato è deterministico per id.
    expect(publicQuestion(7, "MULTIPLE_CHOICE", data, renderQuestion("MULTIPLE_CHOICE", "D", "", data)).options).toEqual(pq.options);
  });
  it("vero/falso e confronto non espongono answer/correct", () => {
    const tf = { answer: true, statement: "S" };
    expect(JSON.stringify(publicQuestion(1, "TRUE_FALSE", tf, renderQuestion("TRUE_FALSE", "P", "", tf)))).not.toMatch(/answer/);
    const cc = { snippet_a: "a", snippet_b: "b", correct: "a" };
    const pq = publicQuestion(1, "CODE_COMPARISON", cc, renderQuestion("CODE_COMPARISON", "P", "", cc));
    expect(JSON.stringify(pq)).not.toMatch(/"correct"/);
    expect(pq.label_a).toBe("Versione A");
  });
});
