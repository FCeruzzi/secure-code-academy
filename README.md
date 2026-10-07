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

- **Due ruoli**
  - **Amministratori**
  - **Utenti**: nessun login. Navigano i corsi, leggono la teoria, rispondono ai quiz con
    riscontro immediato; i risultati restano nel browser.
- **Teoria** in Markdown (testo, immagini per link, codice evidenziato), divisa in microcorsi.
- **Presentazioni**: 
- **Quiz** con 4 tipi di domanda: Vero/Falso, scelta multipla, «individua la riga errata»,
  confronto tra due versioni di codice. 
- **Tornei** live: link unico, nome e avatar, domande a tempo uguali per tutti, reveal della
  risposta, più round, classifica in diretta, monitor e report per l'organizzatore.
- **Import/export JSON** di corsi, microcorsi e banca domande.

## Struttura

| Cartella | Contenuto |
| --- | --- |
| `worker/` | API: `src/` (route, librerie, Durable Object dei tornei), `migrations/` (schema D1), `test/` (vitest nel runtime Workers), `scripts/` (account admin, configurazione CI) |
| `site/` | Sito statico: `src/` (pagine Nunjucks, layout, componenti Alpine in `src/js/`, CSS) |
| `.github/workflows/` | `worker.yml` (test + deploy del Worker), `pages.yml` (build + GitHub Pages), `admin.yml` (creazione degli account, avvio manuale) |

## Note di progettazione

### API e database

Markdown ed evidenziazione del codice (markdown-it + highlight.js, `worker/src/lib/render.ts`)
si calcolano al salvataggio e si salvano già in HTML: le letture pubbliche non fanno lavoro di
CPU. Il Markdown non accetta HTML grezzo, che appare come testo.


### Tornei

Ogni torneo è un **Durable Object**, che serializza le richieste: le transizioni (reveal, domanda
successiva, fine round) non possono sovrapporsi. Le scadenze le fa scattare un *alarm* del
Durable Object, anche senza nessuno sulla pagina. I giocatori sono riconosciuti da un token
salvato nel browser; il bonus velocità conta dall'ultima modifica della risposta.

### Routing statico

GitHub Pages non ha route dinamiche: le pagine usano parametri, per esempio
`corso/?c=sql-injection` o `t/?k=<token>` per i tornei, e leggono i dati dall'API dopo il
caricamento. Le notifiche email del pannello finiscono nel log del Worker (`npx wrangler tail`).

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
    { "qtype": "CODE_COMPARISON", "data": { "language": "python", "snippet_a": "...", "snippet_b": "...", "correct": "a" } }
  ] }
}
```

Le immagini si referenziano nelle slide con `![alt](img:chiave)`. Esempi minimi completi in
`worker/test/fixtures/`.
