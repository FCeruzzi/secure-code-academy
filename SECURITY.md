# Sicurezza

## Segnalare una vulnerabilità

Se trovi un problema di sicurezza **non aprire una issue pubblica**: usa la segnalazione
privata di GitHub, dalla scheda **Security → Report a vulnerability** di questo repository.
Scrivi:

- cosa hai trovato e dove (file, rotta dell'API, pagina);
- come riprodurlo, su una copia in locale;
- che cosa permette a chi lo sfrutta.

La segnalazione resta privata finché il problema non è corretto.

## Prove solo in locale

Il sito pubblicato e la sua API servono corsi e tornei veri. Non fare prove lì: niente
tentativi di accesso, iscrizioni automatiche ai tornei o test di carico. Avvia la tua copia:

```sh
# API (Worker + D1 locale)
cd worker
cp .dev.vars.example .dev.vars          # username degli amministratori, origine del sito
npm ci
npx wrangler d1 migrations apply sca --local
ADMIN_USERNAMES=admin ADMIN_PASSWORD='<una password temporanea>' npm run admin:sql
npx wrangler d1 execute sca --local --file admin.sql
npm run dev                             # http://127.0.0.1:8787

# Sito
cd site
npm ci
npm run build && npm run serve          # http://localhost:8080/secure-code-academy/
```

## Cosa rientra

- **Worker** (`worker/`): autenticazione del pannello, permessi di amministratori e
  consulenti, API pubbliche e dei tornei, import dei contenuti.
- **Sito** (`site/`): XSS, redirect, gestione di token e codici nel browser.
- **Workflow** (`.github/workflows/`).

Non rientrano gli attacchi di forza bruta o di carico contro il sito pubblicato,
l'ingegneria sociale e i problemi dei servizi esterni (GitHub Pages, Cloudflare).

## Scelte note

- Il codice con cui un giocatore rientra nel suo torneo e quello del dispositivo riconosciuto
  restano nel browser (`localStorage`): il primo vale solo per quel torneo, il secondo non apre
  il pannello senza la password.
- Il link di un torneo e il banner della home sono pubblici: per iscriversi serve il PIN che dà
  l'organizzatore.
