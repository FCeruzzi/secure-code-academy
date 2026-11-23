// Base dei componenti del pannello: guardia di accesso, chiamate autenticate,
// errori dei form, conferma delle eliminazioni.
import { admin, api, ApiError, currentAdminPath, flash, go, isConsultant, mix, notify, param, readJsonFile } from "../core.js";
import { helpers } from "../public.js";

/** Mostra il pannello solo con una sessione; senza, porta al login. */
// Le sezioni (navActive) che un consulente può aprire; le altre lo riportano alla dashboard.
const CONSULTANT_SECTIONS = new Set(["dashboard", "corsi", "domande", "password"]);

export const adminGuard = () => ({
  ok: false,
  consultant: false,
  init() {
    // Uscita da un'altra scheda con la stessa sessione.
    window.addEventListener("sca-logout", () => go("admin/login/"));
    if (!admin.token()) {
      go("admin/login/", { next: currentAdminPath() });
      return;
    }
    const user = admin.user();
    if (user && user.needs_setup) {
      go("admin/primo-accesso/");
      return;
    }
    this.consultant = isConsultant();
    if (this.consultant && !CONSULTANT_SECTIONS.has(this.$el.dataset.section || "")) {
      go("admin/");
      return;
    }
    this.ok = true;
  },
});

/** Finestra di conferma: si apre con askDelete(etichetta, azione). */
// È un dialog: il focus entra su «Annulla» (la scelta che non fa danni), Tab non ne esce e
// alla chiusura torna sul pulsante che l'ha aperta.
export const confirmModal = () => ({
  open: false,
  busy: false,
  label: "",
  action: null,
  opener: null,
  init() {
    window.addEventListener("sca-confirm", (e) => {
      this.label = e.detail.label;
      this.action = e.detail.action;
      this.opener = document.activeElement;
      this.open = true;
      this.$nextTick(() => this.$refs.cancel?.focus());
    });
  },
  close() {
    if (!this.open) return;
    this.open = false;
    const back = this.opener;
    this.opener = null;
    if (back?.isConnected) this.$nextTick(() => back.focus());
  },
  trap(event) {
    const items = Array.from(this.$refs.box.querySelectorAll("button:not([disabled])"));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  },
  async confirm() {
    if (!this.action) return;
    this.busy = true;
    try {
      await this.action();
      this.close();
    } finally {
      this.busy = false;
    }
  },
});

export function askDelete(label, action) {
  window.dispatchEvent(new CustomEvent("sca-confirm", { detail: { label, action } }));
}

/** Base di una pagina del pannello. */
export function adminPage(def) {
  return mix(helpers, {
    state: "loading",
    error: "",
    busy: false,
    errors: {},
    form: {},
    fileError: "",
    consultant: isConsultant(),
    param,

    /** Chiamata autenticata all'API del pannello. */
    call(path, opts = {}) {
      if (!admin.token()) {
        // Nessuna sessione: ci pensa adminGuard a portare al login.
        return Promise.reject(new ApiError(401, {}));
      }
      return api(path, { ...opts, auth: true });
    },

    /** Caricamento iniziale: 404 → pagina non trovata, altro → errore. */
    async loadWith(fn) {
      try {
        await fn();
        this.state = "ready";
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) this.state = "notfound";
        else if (e instanceof ApiError && (e.status === 401 || (e.status === 403 && e.data.setup_required))) return;
        else {
          this.error = e.message;
          this.state = "error";
        }
      }
    },

    /**
     * Invio di un form: gli errori per campo finiscono in `errors`, gli altri in
     * un messaggio. Restituisce la risposta, o null se l'invio non è riuscito.
     */
    async submitForm(path, method, payload) {
      this.busy = true;
      this.errors = {};
      try {
        return await this.call(path, { method, json: payload });
      } catch (e) {
        if (e instanceof ApiError && e.data && e.data.errors) this.errors = e.data.errors;
        else if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return null;
        else notify(e.message, "error");
        return null;
      } finally {
        this.busy = false;
      }
    },

    /** Un'azione (POST/DELETE) con messaggio di esito; poi ricarica o naviga. */
    async action(path, { method = "POST", json, then } = {}) {
      try {
        const res = await this.call(path, { method, json });
        if (then) await then(res);
        return res;
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) notify(e.message, "error");
        return null;
      }
    },

    /** Messaggio da mostrare nella pagina successiva, poi navigazione. */
    done(message, path, params, level = "success") {
      flash(message, level);
      go(path, params);
    },

    notify,
    askDelete,

    async readFile() {
      this.fileError = "";
      try {
        return await readJsonFile(this.$refs.file?.files?.[0]);
      } catch (e) {
        this.fileError = e.message;
        return null;
      }
    },
  }, def);
}
