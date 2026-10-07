// Server statico per provare il sito in locale come su GitHub Pages: serve
// _site sotto il prefisso del repository e risponde 404.html alle pagine
// mancanti.   PORT=8080 PATH_PREFIX=/secure-code-academy/ node serve.mjs
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("./_site/", import.meta.url).pathname;
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
};

async function file(path) {
  try {
    const s = await stat(path);
    if (s.isDirectory()) return file(join(path, "index.html"));
    return { path, body: await readFile(path) };
  } catch {
    return null;
  }
}

createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (pathname === "/" && prefix !== "/") {
    res.writeHead(302, { Location: prefix });
    return res.end();
  }
  const rel = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : null;
  const found = rel === null ? null : await file(join(root, normalize("/" + rel)));
  if (found) {
    res.writeHead(200, { "Content-Type": types[extname(found.path)] || "application/octet-stream" });
    return res.end(found.body);
  }
  const notFound = await file(join(root, "404.html"));
  res.writeHead(404, { "Content-Type": types[".html"] });
  res.end(notFound ? notFound.body : "Not found");
}).listen(port, () => console.log(`Sito su http://localhost:${port}${prefix}`));
