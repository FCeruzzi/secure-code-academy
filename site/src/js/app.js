// Punto d'ingresso del JavaScript del sito: registra i componenti e avvia Alpine.
import Alpine from "alpinejs";
import * as adminPages from "./admin/index.js";
import { safeUrl } from "./core.js";
import {
  coursePage,
  courseListPage,
  flashMessages,
  homePage,
  microcoursePage,
  navBar,
  presentationPage,
  quizPlayPage,
  quizResultsPage,
  quizStartPage,
  slidePage,
  tournamentPage,
} from "./public.js";

const components = {
  navBar,
  flashMessages,
  homePage,
  courseListPage,
  coursePage,
  microcoursePage,
  slidePage,
  presentationPage,
  quizStartPage,
  quizPlayPage,
  quizResultsPage,
  tournamentPage,
  ...adminPages,
};

for (const [name, factory] of Object.entries(components)) {
  if (typeof factory === "function") Alpine.data(name, factory);
}

// $safeUrl(x) nei template, per ogni :href/:src che viene dai dati.
Alpine.magic("safeUrl", () => safeUrl);

window.Alpine = Alpine;
Alpine.start();
