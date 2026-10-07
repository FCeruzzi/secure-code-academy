import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */

// Colori composti dinamicamente nei template (messaggi, sezioni delle slide,
// classifica): la safelist li tiene nel CSS anche se non compaiono interi.
const dynamicColors = ["emerald", "rose", "amber", "sky", "slate", "violet", "orange"];
const safelist = [];
dynamicColors.forEach((c) => {
  ["10", "15", "20", "25"].forEach((o) => safelist.push(`bg-${c}-500/${o}`));
  safelist.push(`border-${c}-500/40`);
  ["200", "300", "400"].forEach((s) => safelist.push(`text-${c}-${s}`));
});

export default {
  content: ["./src/**/*.njk", "./src/js/**/*.js"],
  safelist,
  theme: { extend: {} },
  plugins: [typography],
};
