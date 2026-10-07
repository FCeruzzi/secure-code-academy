import { describe, expect, it } from "vitest";
import { highlightCode, highlightLines, renderMarkdown } from "../src/lib/render";

describe("renderMarkdown", () => {
  it("rende Markdown con codice evidenziato in div.codehilite", () => {
    const html = renderMarkdown("Testo **grassetto**\n\n```python\nprint('x')\n```");
    expect(html).toContain("<strong>grassetto</strong>");
    expect(html).toContain('<div class="codehilite"><pre><code class="language-python">');
    expect(html).toContain("hljs-");
  });
  it("linguaggi con nomi riservati: testo semplice, niente eccezioni", () => {
    for (const lang of ["constructor", "__proto__", "toString"]) {
      expect(() => renderMarkdown("```" + lang + "\nx = 1\n```")).not.toThrow();
    }
  });
  it("mostra l'HTML grezzo come testo", () => {
    const html = renderMarkdown("Payload: <script>alert(1)</script> e <img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });
  it("scarta i link con schemi pericolosi", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("href");
    expect(renderMarkdown("[x](data:text/html;base64,AAA)")).not.toContain("href");
    expect(renderMarkdown("[x](https://owasp.org)")).toContain('href="https://owasp.org"');
    expect(renderMarkdown("[x](/relativo)")).toContain('href="/relativo"');
  });
  it("sostituisce img:chiave con il link dell'immagine", () => {
    const html = renderMarkdown("![schema](img:schema)", { schema: "https://cdn.example/s.png" });
    expect(html).toContain('<img src="https://cdn.example/s.png" alt="schema">');
  });
  it("toglie lo stile di allineamento delle tabelle, come bleach", () => {
    expect(renderMarkdown("| a |\n|:-:|\n| b |")).not.toContain("style");
  });
});

describe("evidenziazione", () => {
  it("una riga HTML per riga di codice, &nbsp; per le vuote", () => {
    const lines = highlightLines("int a = 1;\n\n  \nreturn a;", "java");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe("&nbsp;");
    expect(lines[2]).toBe("&nbsp;");
  });
  it("linguaggio sconosciuto: testo con escape", () => {
    expect(highlightCode("<b>", "boh")).toBe("&lt;b&gt;");
    expect(highlightCode("<b>", "text")).toBe("&lt;b&gt;");
  });
});
