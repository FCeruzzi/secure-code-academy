// Sito statico per GitHub Pages: le pagine sono gusci HTML che leggono i dati
// dall'API del Worker Cloudflare (vedi ../worker) e li mostrano con Alpine.
import { HtmlBasePlugin } from "@11ty/eleventy";

export default function (eleventyConfig) {
  // Su GitHub Pages un sito di progetto vive sotto /<repository>/: il plugin
  // aggiunge il prefisso a ogni link assoluto (href, src, action).
  eleventyConfig.addPlugin(HtmlBasePlugin);
  eleventyConfig.addPassthroughCopy({ "src/static": "assets" });
  eleventyConfig.addWatchTarget("src/js");
  eleventyConfig.addWatchTarget("src/css");
  return {
    dir: { input: "src", includes: "_includes", data: "_data", output: "_site" },
    pathPrefix: process.env.PATH_PREFIX || "/secure-code-academy/",
    htmlTemplateEngine: "njk",
    templateFormats: ["njk"],
  };
}
