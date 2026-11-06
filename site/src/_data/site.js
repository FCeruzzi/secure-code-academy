// Configurazione del build, letta dalle variabili d'ambiente (vedi
// .github/workflows/pages.yml): l'indirizzo dell'API e il prefisso del sito.
const api = (process.env.API_BASE || "http://127.0.0.1:8787").replace(/\/+$/, "");

// Da dove si possono incorporare le presentazioni (frame-src della CSP): per
// esempio "https://cdn.esempio.it https://drive.google.com". Di default
// qualunque host https.
const FRAME_TOKEN = /^(https:|https:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?)$/i;
const frameSrc = (process.env.FRAME_SRC || "https:").trim().split(/\s+/);
for (const t of frameSrc) {
  if (!FRAME_TOKEN.test(t)) throw new Error(`FRAME_SRC: "${t}" non è un'origine https valida.`);
}

export default {
  name: "Secure Code Academy",
  api,
  apiOrigin: new URL(api).origin,
  frameSrc: frameSrc.join(" "),
  // Aggiunto all'URL di CSS e JS: a ogni build il browser riscarica gli asset.
  version: Date.now().toString(36),
};
