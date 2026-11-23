# Secure Code Academy

Piattaforma web di e-learning sulla **scrittura di codice sicuro**: microcorsi con teoria
interattiva, quiz e tornei live a cui ci si unisce tramite link.

```
browser ──► GitHub Pages            pagine statiche (Eleventy + Tailwind + Alpine.js)
   │
   └─ fetch ─► Cloudflare Worker     API JSON (TypeScript, Hono)
                 ├─ D1               database SQLite: contenuti, utenti, sessioni, tornei
                 └─ Durable Objects  un'istanza per torneo live, più una per l'hash delle password
```

## Funzionalità

- **Corsi** con presentazione (slide in PDF da un link, sfogliabili nel sito), laboratorio e
  risorse esterne.
- **Teoria** in Markdown (testo, immagini, codice evidenziato), divisa in microcorsi.
- **Quiz** con 4 tipi di domanda: Vero/Falso, scelta multipla, «individua la riga errata»,
  confronto tra due versioni di codice. Il codice si legge come in un IDE, con i file in un menu a
  lato; nel confronto **Sync** fa scorrere insieme le due versioni e **Full screen** le apre a tutta
  finestra.
- **Tornei** live: link e PIN di iscrizione dati dall'organizzatore, nome e avatar, le stesse
  domande a tempo per tutti, soluzione dopo ogni domanda, più round, monitor e report per
  l'organizzatore. Ogni risposta si invia con **Conferma risposta**, sempre in basso a sinistra, e
  da lì non cambia più; quanti hanno già confermato si vede sotto la domanda. La classifica in
  diretta è una barra laterale a scomparsa, che si può fissare con 📌.

## Sicurezza

Come segnalare un problema e come provare il progetto in locale: [SECURITY.md](SECURITY.md).

## Formato JSON di import

Corso completo (quello prodotto da *Esporta*):

```jsonc
{
  "version": "1.0", "kind": "course",
  "course": { "slug": "...", "title": "...", "description": "...", "icon": "🛡️", "is_published": true,
              "lab_url": "https://...",
              "presentations": [{ "title": "...", "url": "https://.../slide.pdf", "page_count": 12 }],
              "resources": [{ "title": "...", "url": "https://..." }] },
  "microcourses": [ /* bundle dei microcorsi, come sotto */ ]
}
```

Microcorso:

```jsonc
{
  "version": "1.0",
  "microcourse": { "course_slug": "...", "course_title": "...", "slug": "...", "title": "...",
                   "summary": "...", "is_published": true, "order": 1 },
  "images": [ { "ref_key": "schema", "alt_text": "...", "url": "https://cdn.esempio.it/img/schema.png" } ],
  "slides": [ { "order": 1, "section": "ATTACK", "title": "...", "body_markdown": "..." } ],
  "quiz": { "title": "...", "questions": [
    { "qtype": "TRUE_FALSE",      "prompt": "...", "explanation": "...", "data": { "statement": "...", "answer": true } },
    { "qtype": "MULTIPLE_CHOICE", "data": { "multiple": true, "options": [{"id":"a","text":"..."}], "correct": ["a"] } },
    { "qtype": "FIND_WRONG_LINE", "data": { "language": "python", "code": "r1\nr2", "correct_lines": [2], "start_line": 1 } },
    { "qtype": "FIND_WRONG_LINE", "data": { "language": "java",
      "files": [ { "name": "web/OrderController.java", "content": "..." },
                 { "name": "application.yml", "content": "...", "language": "yaml" } ],
      "correct_lines": [ { "file": "web/OrderController.java", "line": 14 } ] } },
    { "qtype": "CODE_COMPARISON", "data": { "language": "python", "snippet_a": "...", "snippet_b": "...", "correct": "a" } }
  ] }
}
```

«Individua la riga errata» accetta un blocco di codice (`code`, con `correct_lines` numerate da
`start_line`) oppure un piccolo progetto: `files` (nome, contenuto, linguaggio e prima riga
facoltativi) e `correct_lines` come `{ "file": nome, "line": numero }`. Il giocatore apre i file dal
menu a lato e clicca la riga: si seleziona il blocco tra `{` e `}` che la contiene, al massimo il
metodo (nei file di dati e di configurazione, e fuori dai blocchi, la sola riga). La risposta è
giusta se il blocco scelto contiene la riga errata. Anche i file del «Confronto di codice» possono avere un `language`
proprio, utile per i progetti misti (Java con YAML, HTML, SQL…).

Slide, domande e spiegazioni sono in Markdown: l'HTML scritto a mano compare come testo. Le immagini si
richiamano nelle slide con `![alt](img:chiave)`. Esempi minimi completi in `worker/test/fixtures/`.
