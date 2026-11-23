import { describe, expect, it } from "vitest";
import {
  answerTexts,
  comparisonSwapped,
  grade,
  hasChoice,
  lineBlocks,
  parseSubmission,
  publicQuestion,
  questionSeed,
  renderQuestion,
  seededShuffle,
  tournamentCopy,
  validateQuestionData,
  ValidationError,
} from "../src/lib/questions";

// Un progetto di tre file, la riga errata nel terzo (che parte dalla riga 10).
const PROJECT = {
  language: "java",
  files: [
    { name: "web/OrderController.java", content: "class OrderController {\n  void list() {}\n}" },
    { name: "application.yml", content: "server:\n  port: 8080", language: "yaml" },
    { name: "data/OrderRepository.java", content: "a\nb\nc\nd", start_line: 10 },
  ],
  correct_lines: [{ file: "data/OrderRepository.java", line: 12 }],
};

describe("grade", () => {
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
    expect(grade("FIND_WRONG_LINE", data, { lines: ["3", 7] })).toEqual({
      correct: true,
      solution: {
        correct_keys: ["0:3", "0:7"],
        correct_lines: ["3", "7"],
        correct_block_keys: ["0:3", "0:7"],
        correct_blocks: ["3", "7"],
        chosen_keys: ["0:3", "0:7"],
        chosen_blocks: ["3", "7"],
        wrong_block_starts: [],
      },
    });
    expect(grade("FIND_WRONG_LINE", data, { lines: [3] }).correct).toBe(false);
    expect(grade("FIND_WRONG_LINE", data, { lines: ["x", 3, 7] }).correct).toBe(true);
    expect(grade("FIND_WRONG_LINE", data, { lines: ["0:3", "0:7"] }).correct).toBe(true);
  });

  it("riga errata in un progetto di più file", () => {
    expect(grade("FIND_WRONG_LINE", PROJECT, { lines: ["2:12"] }).correct).toBe(true);
    expect(grade("FIND_WRONG_LINE", PROJECT, { lines: ["2:12", "0:2"] }).correct).toBe(false);
    expect(grade("FIND_WRONG_LINE", PROJECT, { lines: [12] }).correct).toBe(false);
    expect(grade("FIND_WRONG_LINE", PROJECT, { lines: ["0:2"] }).solution).toEqual({
      correct_keys: ["2:12"],
      correct_lines: ["data/OrderRepository.java:12"],
      correct_block_keys: ["2:12"],
      correct_blocks: ["data/OrderRepository.java:12"],
      chosen_keys: ["0:2"],
      chosen_blocks: ["web/OrderController.java:2"],
      wrong_block_starts: ["0:2"],
    });
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
    validateQuestionData("FIND_WRONG_LINE", PROJECT);
    validateQuestionData("CODE_COMPARISON", { snippet_a: "x", files_b: [{ name: "b", content: "y" }], correct: "b" });
    validateQuestionData("CODE_COMPARISON", { snippet_a: "x", files_b: [{ name: "b.yml", content: "y", language: "yaml" }], correct: "b" });
  });
  it("progetti: file e righe errate devono tornare", () => {
    const file = "data/OrderRepository.java";
    bad("FIND_WRONG_LINE", { ...PROJECT, correct_lines: [12] });
    bad("FIND_WRONG_LINE", { ...PROJECT, correct_lines: [{ file: "manca.java", line: 1 }] });
    bad("FIND_WRONG_LINE", { ...PROJECT, correct_lines: [{ file, line: 9 }] });
    bad("FIND_WRONG_LINE", { ...PROJECT, correct_lines: [{ file, line: 14 }] });
    bad("FIND_WRONG_LINE", { ...PROJECT, correct_lines: [] });
    bad("FIND_WRONG_LINE", { ...PROJECT, files: [...PROJECT.files, { name: "application.yml", content: "x" }] });
    bad("FIND_WRONG_LINE", { ...PROJECT, files: [...PROJECT.files, { name: " spazi.txt", content: "x" }] });
    bad("FIND_WRONG_LINE", { ...PROJECT, files: [...PROJECT.files, { name: "vuoto.txt", content: "  " }] });
    bad("FIND_WRONG_LINE", { code: "a\nb", correct_lines: [true] });
  });
});

describe("parseSubmission", () => {
  it("normalizza i tipi e scarta il resto", () => {
    expect(parseSubmission("TRUE_FALSE", { answer: "true", extra: 1 })).toEqual({ answer: true });
    expect(parseSubmission("MULTIPLE_CHOICE", { selected: "a" })).toEqual({ selected: ["a"] });
    expect(parseSubmission("FIND_WRONG_LINE", { lines: "3, 7,x" })).toEqual({ lines: ["0:3", "0:7"] });
    expect(parseSubmission("FIND_WRONG_LINE", { lines: ["2:12", "0:1", "2:12"] })).toEqual({ lines: ["0:1", "2:12"] });
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

describe("ordine delle opzioni e correzione", () => {
  const data = {
    multiple: false,
    options: [
      { id: "a", text: "Query parametrizzate" },
      { id: "b", text: "Nascondere gli errori" },
      { id: "c", text: "Filtrare gli apici" },
      { id: "d", text: "Solo un WAF" },
    ],
    correct: ["a"],
  };
  const shown = (id: number) => publicQuestion(id, "MULTIPLE_CHOICE", data, renderQuestion("MULTIPLE_CHOICE", "?", "", data)).options!;

  it("la risposta giusta finisce in posizioni diverse e vale per contenuto, non per posizione", () => {
    const positions = new Set<number>();
    for (let id = 1; id <= 40; id++) {
      const opts = shown(id);
      const pos = opts.findIndex((o) => o.text === "Query parametrizzate");
      positions.add(pos);
      // Chi sceglie la risposta giusta, ovunque sia, invia il suo id: corretta.
      expect(grade("MULTIPLE_CHOICE", data, { selected: [opts[pos].id] }).correct).toBe(true);
      // Chi sceglie la prima mostrata è corretto solo se la prima è proprio lei.
      expect(grade("MULTIPLE_CHOICE", data, { selected: [opts[0].id] }).correct).toBe(pos === 0);
    }
    expect([...positions].sort()).toEqual([0, 1, 2, 3]);
  });

  it("stesso ordine a ogni visita", () => {
    expect(shown(7)).toEqual(shown(7));
    expect(shown(7).map((o) => o.id)).toEqual(["c", "b", "d", "a"]);
  });
});

describe("confronto di codice: etichette per posizione", () => {
  const data = { label_a: "Versione A", label_b: "Versione B", correct: "a", snippet_a: "x", snippet_b: "y" };
  it("il report usa l'etichetta del pannello in cui il codice era mostrato", () => {
    const swapped = Array.from({ length: 40 }, (_, i) => i + 1).find((id) => comparisonSwapped(id))!;
    const normal = Array.from({ length: 40 }, (_, i) => i + 1).find((id) => !comparisonSwapped(id))!;
    // Pannelli scambiati: il codice corretto (a) era a destra, sotto «Versione B».
    expect(answerTexts(swapped, "CODE_COMPARISON", data, { choice: "a" }, { correct: "a" })).toEqual(["Versione B", "Versione B"]);
    expect(answerTexts(normal, "CODE_COMPARISON", data, { choice: "b" }, { correct: "a" })).toEqual(["Versione B", "Versione A"]);
    const q = publicQuestion(swapped, "CODE_COMPARISON", data, renderQuestion("CODE_COMPARISON", "?", "", data));
    expect(q.cc_swap).toBe(true);
  });
});

describe("ordine diverso a ogni tentativo e per ogni giocatore", () => {
  const data = {
    multiple: false,
    options: [
      { id: "a", text: "Query parametrizzate" },
      { id: "b", text: "Nascondere gli errori" },
      { id: "c", text: "Filtrare gli apici" },
      { id: "d", text: "Solo un WAF" },
    ],
    correct: ["a"],
  };
  const render = renderQuestion("MULTIPLE_CHOICE", "?", "", data);

  it("senza seme resta l'ordine per id; con semi diversi cambia, la correzione no", () => {
    expect(questionSeed(7)).toBe(7);
    expect(publicQuestion(7, "MULTIPLE_CHOICE", data, render, questionSeed(7)).options).toEqual(publicQuestion(7, "MULTIPLE_CHOICE", data, render).options);
    const orders = new Set<string>();
    for (let attempt = 1; attempt <= 30; attempt++) {
      const opts = publicQuestion(7, "MULTIPLE_CHOICE", data, render, questionSeed(7, attempt)).options!;
      orders.add(opts.map((o) => o.id).join(""));
      const right = opts.find((o) => o.text === "Query parametrizzate")!;
      expect(grade("MULTIPLE_CHOICE", data, { selected: [right.id] }).correct).toBe(true);
    }
    expect(orders.size).toBeGreaterThan(5);
    // Stesso tentativo, stesso ordine (la pagina ricaricata non rimescola).
    expect(publicQuestion(7, "MULTIPLE_CHOICE", data, render, questionSeed(7, 42)).options).toEqual(
      publicQuestion(7, "MULTIPLE_CHOICE", data, render, questionSeed(7, 42)).options,
    );
  });

  it("l'ordine delle domande dipende dal seme ed è una permutazione", () => {
    const ids = Array.from({ length: 10 }, (_, i) => i + 1);
    const a = seededShuffle(ids, 1);
    const b = seededShuffle(ids, 2);
    expect([...a].sort((x, y) => x - y)).toEqual(ids);
    expect(a).not.toEqual(b);
    expect(seededShuffle(ids, 1)).toEqual(a);
    expect(ids).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });

  it("confronto di codice: lo scambio dei pannelli segue il giocatore, il report pure", () => {
    const cc = { label_a: "Versione A", label_b: "Versione B", correct: "a", snippet_a: "x", snippet_b: "y" };
    const ccRender = renderQuestion("CODE_COMPARISON", "?", "", cc);
    const swaps = new Set<boolean>();
    for (let player = 1; player <= 20; player++) {
      const seed = questionSeed(5, player);
      const q = publicQuestion(5, "CODE_COMPARISON", cc, ccRender, seed);
      swaps.add(Boolean(q.cc_swap));
      const correctLabel = q.cc_swap ? "Versione B" : "Versione A";
      expect(answerTexts(seed, "CODE_COMPARISON", cc, { choice: "a" }, { correct: "a" })).toEqual([correctLabel, correctLabel]);
    }
    expect(swaps).toEqual(new Set([true, false]));
  });
});

describe("riga errata: progetti di più file", () => {
  it("il render numera le righe per file, con le chiavi file:riga, e non contiene la soluzione", () => {
    const render = renderQuestion("FIND_WRONG_LINE", "Dove?", "Perché", PROJECT);
    const q = publicQuestion(3, "FIND_WRONG_LINE", PROJECT, render);
    expect(q.is_project).toBe(true);
    expect(q.code_files!.map((f) => f.name)).toEqual(["web/OrderController.java", "application.yml", "data/OrderRepository.java"]);
    expect(q.code_files![2].lines.map((l) => l.key)).toEqual(["2:10", "2:11", "2:12", "2:13"]);
    expect(JSON.stringify(q)).not.toMatch(/correct|Perché/);
  });

  it("le domande salvate prima dei progetti (render con solo code_lines) si mostrano lo stesso", () => {
    const data = { code: "a\nb", start_line: 5, correct_lines: [6] };
    const old = { prompt_html: "<p>?</p>", explanation_html: "", code_lines: [{ number: 5, html: "a" }, { number: 6, html: "b" }] };
    const q = publicQuestion(4, "FIND_WRONG_LINE", data, old);
    expect(q.is_project).toBe(false);
    expect(q.code_files).toEqual([{ index: 0, name: "codice", lines: [{ number: 5, html: "a", key: "0:5", block: "0:5-5" }, { number: 6, html: "b", key: "0:6", block: "0:6-6" }] }]);
    expect(grade("FIND_WRONG_LINE", data, { lines: ["0:6"] }).correct).toBe(true);
  });

  it("il report mostra file:riga", () => {
    const solution = grade("FIND_WRONG_LINE", PROJECT, { lines: ["0:2"] }).solution;
    expect(answerTexts(1, "FIND_WRONG_LINE", PROJECT, { lines: ["0:2"] }, solution)).toEqual([
      "riga/e web/OrderController.java:2",
      "riga/e data/OrderRepository.java:12",
    ]);
    expect(answerTexts(1, "FIND_WRONG_LINE", { code: "a\nb", correct_lines: [2] }, { lines: [2] }, { correct_lines: ["2"] })).toEqual([
      "riga/e 2",
      "riga/e 2",
    ]);
  });
});

describe("tournamentCopy: la copia che il torneo congela", () => {
  const RENDER = { prompt_html: "", explanation_html: "" };
  const MC = {
    multiple: false,
    options: [
      { id: "a", text: "Giusta" },
      { id: "b", text: "Due" },
      { id: "c", text: "Tre" },
      { id: "d", text: "Quattro" },
    ],
    correct: ["a"],
  };

  it("scelta multipla: ordine e id nuovi, la risposta giusta resta la stessa", () => {
    // rand finto sempre 0: il mescolamento sposta la prima opzione in fondo.
    const { data } = tournamentCopy("MULTIPLE_CHOICE", MC, RENDER, () => 0);
    expect(data.options.map((o: any) => o.id)).toEqual(["a", "b", "c", "d"]);
    expect(data.options.map((o: any) => o.text)).toEqual(["Due", "Tre", "Quattro", "Giusta"]);
    expect(data.correct).toEqual(["d"]);
    expect(grade("MULTIPLE_CHOICE", data, { selected: ["d"] }).correct).toBe(true);
    expect(grade("MULTIPLE_CHOICE", data, { selected: ["a"] }).correct).toBe(false);
    // L'originale non cambia.
    expect(MC.correct).toEqual(["a"]);
    expect(MC.options[0].text).toBe("Giusta");
  });

  it("con il generatore vero la giusta non sta sempre in «a»", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(tournamentCopy("MULTIPLE_CHOICE", MC, RENDER).data.correct[0]);
    expect(seen).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("confronto di codice: con rand 1 i codici si scambiano, le etichette no", () => {
    const CC = { language: "python", snippet_a: "A()", snippet_b: "B()", correct: "a", label_a: "Prima", label_b: "Dopo" };
    const render = { ...RENDER, files_a: [{ name: "", html: "A" }], files_b: [{ name: "", html: "B" }] };
    const swapped = tournamentCopy("CODE_COMPARISON", CC, render, () => 1);
    expect(swapped.data).toMatchObject({ snippet_a: "B()", snippet_b: "A()", correct: "b", label_a: "Prima", label_b: "Dopo" });
    expect(swapped.render.files_a).toEqual(render.files_b);
    expect(swapped.render.files_b).toEqual(render.files_a);
    expect(grade("CODE_COMPARISON", swapped.data, { choice: "b" }).correct).toBe(true);
    const kept = tournamentCopy("CODE_COMPARISON", CC, render, () => 0);
    expect(kept.data).toEqual(CC);
    expect(kept.render).toEqual(render);
  });

  it("confronto a progetto: si scambiano anche i file", () => {
    const CC = { language: "java", files_a: [{ name: "A.java", content: "a" }], files_b: [{ name: "B.java", content: "b" }], correct: "b" };
    const { data } = tournamentCopy("CODE_COMPARISON", CC, RENDER, () => 1);
    expect(data).toMatchObject({ files_a: CC.files_b, files_b: CC.files_a, correct: "a" });
    expect(data).not.toHaveProperty("snippet_a");
  });

  it("gli altri tipi restano come sono", () => {
    const tf = { answer: true, statement: "x" };
    expect(tournamentCopy("TRUE_FALSE", tf, RENDER, () => 0).data).toBe(tf);
    const fwl = { language: "python", code: "a\nb", correct_lines: [2] };
    expect(tournamentCopy("FIND_WRONG_LINE", fwl, RENDER, () => 0).data).toBe(fwl);
  });
});

// --- Riga errata a blocchi ------------------------------------------------------------------

// Un repository Spring come quelli della banca: la riga errata (15) sta nel metodo 13–16.
const BOOKING_REPO = `package com.acme.rooms.data;

import java.util.List;

@Repository
public class BookingRepository {
    private static final RowMapper<Booking> MAPPER = (rs, n) -> new Booking(
        rs.getLong("id"), rs.getString("guest"));
    private final JdbcTemplate jdbc;

    public BookingRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Transactional(readOnly = true)
    public List<Booking> findByGuest(String guest) {
        return jdbc.query("SELECT * FROM bookings WHERE guest = '" + guest + "' ORDER BY day", MAPPER);
    }

    public Optional<Booking> findById(long id) {
        return jdbc.query("SELECT * FROM bookings WHERE id = ?", MAPPER, id).stream().findFirst();
    }
}`;

const JAVA_PROJECT = {
  language: "java",
  files: [
    { name: "data/BookingRepository.java", content: BOOKING_REPO },
    { name: "config.json", content: '{\n  "debug": true,\n  "pool": 5\n}' },
  ],
  correct_lines: [{ file: "data/BookingRepository.java", line: 15 }],
};

describe("riga errata: un clic sceglie il blocco", () => {
  it("metodi Java con le loro annotazioni; fuori dai metodi la riga sola; i file di dati a righe", () => {
    const b = lineBlocks(JAVA_PROJECT);
    expect(b.get("0:15")).toEqual([0, 13, 16]);
    expect(b.get("0:13")).toEqual(b.get("0:16"));
    expect(b.get("0:19")).toEqual([0, 18, 20]);
    for (const n of [1, 5, 6, 7, 8, 9, 11, 21]) expect(b.get(`0:${n}`)).toEqual([0, n, n]);
    expect(b.get("1:1")).toEqual([1, 1, 1]);
    expect(b.get("1:2")).toEqual([1, 2, 2]);
  });

  it("JavaScript, C#, Python e Ruby", () => {
    const project = (name: string, content: string, language = "") => ({
      language,
      files: [{ name, content }, { name: "x.md", content: "x" }],
    });
    const js = lineBlocks(project("routes.js", "const cfg = {\n  secure: false,\n};\napp.get('/x', (req, res) => {\n  const q = `${req.query.id}`;\n  res.send(q);\n});"));
    expect(js.get("0:2")).toEqual([0, 1, 3]);
    expect(js.get("0:5")).toEqual([0, 4, 7]);
    const cs = lineBlocks(project("Svc.cs", "namespace Shop\n{\n    public class Svc\n    {\n        [HttpPost]\n        public IActionResult Pay(Order o)\n        {\n            return Ok();\n        }\n    }\n}"));
    expect(cs.get("0:8")).toEqual([0, 5, 9]);
    expect(cs.get("0:3")).toEqual([0, 3, 3]);
    const py = lineBlocks(project("app.py", "import os\n\nclass Api:\n    @route('/x')\n    def get(\n        self, a,\n    ):\n        return os.system(a)\n\ndef other():\n    pass"));
    expect(py.get("0:8")).toEqual([0, 4, 8]);
    expect(py.get("0:3")).toEqual([0, 3, 3]);
    expect(py.get("0:11")).toEqual([0, 10, 11]);
    const rb = lineBlocks(project("ctrl.rb", "class C\n  def show\n    User.where(params[:id])\n  end\nend"));
    expect(rb.get("0:3")).toEqual([0, 2, 4]);
  });

  it("il blocco più interno, al massimo il metodo, mai la classe", () => {
    const code = [
      "class Users {",
      "    public User get(long id) {",
      "        validate(id);",
      "        if (id < 0) {",
      "            throw new Bad(id);",
      "        }",
      "        return repo.find(id);",
      "    }",
      "    public void drop(long id) {",
      "        repo.delete(id);",
      "    }",
      "}",
    ].join("\n");
    const data = { language: "java", code, correct_lines: [5] };
    const b = lineBlocks(data);
    expect(b.get("0:5")).toEqual([0, 4, 6]);
    expect(b.get("0:3")).toEqual([0, 2, 8]);
    expect(b.get("0:1")).toEqual([0, 1, 1]);
    expect(grade("FIND_WRONG_LINE", data, { lines: ["0:4"] }).correct).toBe(true);
    expect(grade("FIND_WRONG_LINE", data, { lines: ["0:7"] }).correct).toBe(true);
    expect(grade("FIND_WRONG_LINE", data, { lines: ["0:10"] }).correct).toBe(false);
    const body = { ...data, correct_lines: [3] };
    expect(grade("FIND_WRONG_LINE", body, { lines: ["0:5"] }).correct).toBe(false);
    expect(grade("FIND_WRONG_LINE", body, { lines: ["0:7"] }).correct).toBe(true);
    const py = lineBlocks({
      language: "python",
      files: [
        { name: "app.py", content: "def get(a):\n    check(a)\n    if a:\n        return run(a)\n    return None\n" },
        { name: "x.md", content: "x" },
      ],
    });
    expect(py.get("0:4")).toEqual([0, 3, 4]);
    expect(py.get("0:2")).toEqual([0, 1, 5]);
  });

  it("un solo blocco di codice che è un solo metodo resta a righe", () => {
    const one = { language: "java", code: "void run(String id) {\n  db.exec(id);\n  log(id);\n}", correct_lines: [2] };
    expect(lineBlocks(one).get("0:2")).toEqual([0, 2, 2]);
    const two = { language: "java", code: "void a() {\n  x();\n}\nvoid b() {\n  y();\n}", correct_lines: [2] };
    expect(lineBlocks(two).get("0:2")).toEqual([0, 1, 3]);
  });

  it("correzione per blocco: scegliere tutto non funziona", () => {
    const g = (lines: string[]) => grade("FIND_WRONG_LINE", JAVA_PROJECT, { lines });
    expect(g(["0:15"]).correct).toBe(true);
    expect(g(["0:13"]).correct).toBe(true);
    expect(g(["0:14", "0:16"]).correct).toBe(true);
    expect(g(["0:19"]).correct).toBe(false);
    expect(g(["0:15", "0:19"]).correct).toBe(false);
    const every = [...Array.from({ length: 21 }, (_, i) => `0:${i + 1}`), "1:1", "1:2", "1:3", "1:4"];
    expect(g(every).correct).toBe(false);
    expect(g([]).correct).toBe(false);
    const solution = g(["0:19"]).solution;
    expect(solution.correct_lines).toEqual(["data/BookingRepository.java:15"]);
    expect(solution.correct_blocks).toEqual(["data/BookingRepository.java:13–16"]);
    expect(solution.chosen_blocks).toEqual(["data/BookingRepository.java:18–20"]);
    expect(solution.wrong_block_starts).toEqual(["0:18"]);
    expect(solution.correct_block_keys).toContain("0:14");
    expect(solution.chosen_keys).toEqual(["0:18", "0:19", "0:20"]);
  });

  it("la pagina riceve il blocco di ogni riga, e la soluzione resta sul server", () => {
    const render = renderQuestion("FIND_WRONG_LINE", "?", "", JAVA_PROJECT);
    const q = publicQuestion(1, "FIND_WRONG_LINE", JAVA_PROJECT, render);
    const blocks = Object.fromEntries(q.code_files!.flatMap((f) => f.lines.map((l) => [l.key, l.block])));
    expect(blocks["0:14"]).toBe("0:13-16");
    expect(blocks["0:9"]).toBe("0:9-9");
    expect(JSON.stringify(q)).not.toMatch(/correct_lines|"correct"/);
  });

  it("il report dice i blocchi scelti e il blocco della riga errata", () => {
    const sub = { lines: ["0:19"] };
    const { solution } = grade("FIND_WRONG_LINE", JAVA_PROJECT, sub);
    expect(answerTexts(1, "FIND_WRONG_LINE", JAVA_PROJECT, sub, solution)).toEqual([
      "riga/e data/BookingRepository.java:18–20",
      "riga/e data/BookingRepository.java:15 (nel blocco data/BookingRepository.java:13–16)",
    ]);
    // A righe (un solo metodo): niente «nel blocco».
    const one = { language: "java", code: "void run(String id) {\n  db.exec(id);\n  log(id);\n}", correct_lines: [2] };
    const s1 = grade("FIND_WRONG_LINE", one, { lines: ["0:3"] }).solution;
    expect(answerTexts(1, "FIND_WRONG_LINE", one, { lines: ["0:3"] }, s1)).toEqual(["riga/e 3", "riga/e 2"]);
  });
});

describe("hasChoice: si conferma solo una scelta vera", () => {
  it("per ogni tipo", () => {
    expect(hasChoice("TRUE_FALSE", { answer: false })).toBe(true);
    expect(hasChoice("TRUE_FALSE", { answer: "true" })).toBe(true);
    expect(hasChoice("TRUE_FALSE", {})).toBe(false);
    expect(hasChoice("TRUE_FALSE", { answer: "" })).toBe(false);
    expect(hasChoice("MULTIPLE_CHOICE", { selected: ["b"] })).toBe(true);
    expect(hasChoice("MULTIPLE_CHOICE", { selected: [] })).toBe(false);
    expect(hasChoice("FIND_WRONG_LINE", { lines: ["0:3"] })).toBe(true);
    expect(hasChoice("FIND_WRONG_LINE", { lines: ["x"] })).toBe(false);
    expect(hasChoice("CODE_COMPARISON", { choice: "b" })).toBe(true);
    expect(hasChoice("CODE_COMPARISON", { choice: null })).toBe(false);
    expect(hasChoice("ALTRO", { answer: true })).toBe(false);
    expect(hasChoice("TRUE_FALSE", null)).toBe(false);
  });
});
