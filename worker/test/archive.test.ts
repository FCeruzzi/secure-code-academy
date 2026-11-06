import { describe, expect, it } from "vitest";
import { ArchiveError, MAX_ARCHIVE_BYTES, parseArchive } from "../src/tournament/archive";

const file = (extra: Record<string, unknown> = {}, tournament: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: "secure-code-academy/tournament",
    version: 1,
    tournament: { title: "Torneo", ...tournament },
    questions: [],
    participants: [],
    answers: [],
    ...extra,
  });

const mc = (key: number, ids = ["a", "b", "c"]) => ({
  key,
  round: 1,
  order: key,
  qtype: "MULTIPLE_CHOICE",
  prompt: "Quale?",
  data: { options: ids.map((id) => ({ id, text: id.toUpperCase() })), correct: [ids[0]] },
});

describe("parseArchive", () => {
  it("impostazioni mancanti o fuori dai limiti di oggi: i valori di sempre, portati dentro i limiti", () => {
    const a = parseArchive(file({}, { reveal_seconds: 5, start_delay_seconds: 600 }));
    expect(a.tournament).toMatchObject({
      title: "Torneo",
      status: "CLOSED",
      num_rounds: 1,
      per_question_seconds: 60,
      reveal_seconds: 10,
      start_delay_seconds: 60,
      points_correct: 100,
      time_bonus: false,
      pool_size: null,
      round_mix: null,
      courses: [],
    });
  });

  it("risposte coerenti e normalizzate come quelle dei giocatori", () => {
    const a = parseArchive(
      file({
        questions: [mc(1)],
        participants: [{ key: 4, display_name: " Ada​ ", avatar_key: "owl" }],
        answers: [{ participant: 4, question: 1, submitted: { selected: "a", extra: "x" }, is_correct: false, timed_out: false, points: 120 }],
      }),
    );
    expect(a.participants[0]).toMatchObject({ key: 4, display_name: "Ada", avatar_key: "owl" });
    // Sbagliata ⇒ 0 punti; la risposta tiene solo i campi del tipo.
    expect(a.answers[0]).toMatchObject({ submitted: { selected: ["a"] }, is_correct: false, points: 0 });
    // Il timeout ha risposta vuota, e resta vuota.
    const timeout = parseArchive(
      file({
        questions: [{ key: 1, round: 1, order: 1, qtype: "TRUE_FALSE", prompt: "?", data: { statement: "S", answer: false } }],
        participants: [{ key: 1, display_name: "A" }],
        answers: [{ participant: 1, question: 1, submitted: {}, is_correct: true, timed_out: true, points: 50 }],
      }),
    );
    expect(timeout.answers[0]).toMatchObject({ submitted: {}, is_correct: false, timed_out: true, points: 0 });
  });

  it("rifiuta chiavi doppie, posizioni doppie e opzioni con lo stesso id", () => {
    expect(() => parseArchive(file({ questions: [mc(1), { ...mc(1), order: 2 }] }))).toThrow(/chiave 1/);
    expect(() => parseArchive(file({ questions: [mc(1), { ...mc(2), order: 1 }] }))).toThrow(/posizione 1/);
    expect(() => parseArchive(file({ questions: [mc(1, ["a", "a"])] }))).toThrow(/stesso id/);
    expect(() =>
      parseArchive(
        file({
          questions: [mc(1), mc(2)],
          participants: [{ key: 1, display_name: "A" }],
          answers: [
            { participant: 1, question: 1, submitted: { selected: ["a"] } },
            { participant: 1, question: 1, submitted: {} },
          ],
        }),
      ),
    ).toThrow(/già una risposta/);
  });

  it("file che non sono un backup, troppo grandi o con valori assurdi", () => {
    expect(() => parseArchive("[]")).toThrow(ArchiveError);
    expect(() => parseArchive("{")).toThrow(/JSON valido/);
    expect(() => parseArchive(" ".repeat(MAX_ARCHIVE_BYTES + 1))).toThrow(/troppo grande/);
    expect(() => parseArchive(file({}, { num_rounds: 0 }))).toThrow(/numero di round/);
    expect(() => parseArchive(file({}, { started_at: "ieri" }))).toThrow(/Torneo, inizio/);
    expect(() => parseArchive(file({}, { round_mix: { ALTRO: 1 } }))).toThrow(/sconosciuto/);
    expect(() => parseArchive(file({ questions: [{ ...mc(1), qtype: "ALTRO" }] }))).toThrow(/sconosciuto/);
    expect(() => parseArchive(file({ questions: [{ ...mc(1), prompt: "x".repeat(20_001) }] }))).toThrow(/troppo lungo/);
  });
});
