// Impacchetta il JavaScript del sito (Alpine e i componenti) in un solo file.
import { build } from "esbuild";

await build({
  entryPoints: ["src/js/app.js"],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020"],
  outfile: "_site/assets/app.js",
  legalComments: "none",
});
