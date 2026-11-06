// Server statico per provare il sito in locale come su GitHub Pages: serve
// _site sotto il prefisso del repository e risponde 404.html alle pagine
// mancanti.   PORT=8080 PATH_PREFIX=/secure-code-academy/ node serve.mjs
//
// L'URL non diventa mai un percorso su disco: all'avvio si legge l'elenco dei file
// di _site (e lo si rilegge dopo una build, alla prima pagina non trovata), e una
// richiesta può avere solo uno di quei file, scelto confrontando il nome. Ascolta
// solo su 127.0.0.1 e serve solo GET e HEAD.
import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./_site/", import.meta.url));
const prefix = process.env.PATH_PREFIX || "/secure-code-academy/";
const port = Number(process.env.PORT || 8080);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
};

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
};

/** Nome relativo a _site ("corso/index.html") → percorso su disco. */
let index = new Map();

async function scan(dir, into) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await scan(full, into);
    else if (entry.isFile() && types[extname(entry.name)]) into.set(relative(root, full).split(sep).join("/"), full);
  }
}

async function reindex() {
  const next = new Map();
  try {
    await scan(root, next);
  } catch {
    // _site non c'è ancora: npm run build
  }
  index = next;
}

/** Il file dell'elenco con quel nome (o la sua index.html), confrontando le stringhe. */
function lookup(rel) {
  const wanted = rel === "" || rel.endsWith("/") ? [`${rel}index.html`] : [rel, `${rel}/index.html`];
  for (const [name, full] of index) {
    if (wanted.includes(name)) return full;
  }
  return null;
}

function send(req, res, status, type, body) {
  res.writeHead(status, { ...securityHeaders, "Content-Type": type });
  res.end(req.method === "HEAD" ? undefined : body);
}

await reindex();

createServer(async (req, res) => {
  // HSTS su ogni risposta (200, 404, 405, redirect). Su http://localhost il browser lo ignora.
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { ...securityHeaders, Allow: "GET, HEAD" });
    return res.end();
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return send(req, res, 400, types[".txt"], "Richiesta non valida");
  }
  if (pathname === "/" && prefix !== "/") {
    res.writeHead(302, { ...securityHeaders, Location: prefix });
    return res.end();
  }
  const rel = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : null;
  let found = rel === null ? null : lookup(rel);
  if (!found && rel !== null) {
    await reindex();
    found = lookup(rel);
  }
  if (found) return send(req, res, 200, types[extname(found)], await readFile(found));
  const notFound = lookup("404.html");
  return send(req, res, 404, types[".html"], notFound ? await readFile(notFound) : "Pagina non trovata");
}).listen(port, "127.0.0.1", () => console.log(`Sito su http://localhost:${port}${prefix}`));
