// Base dei componenti del pannello: guardia di accesso, chiamate autenticate,
// errori dei form, conferma delle eliminazioni.
import { admin, api, ApiError, config, flash, go, mix, notify, param, readJsonFile } from "../core.js";
import { helpers } from "../public.js";

/** Mostra il pannello solo con una sessione; senza, porta al login. */
export const adminGuard = () => ({
  ok: false,
  init() {
    if (!admin.token()) {
      go("admin/login/", { next: location.pathname.slice(config.base.length) + location.search });
      return;
    }
    const user = admin.user();
    if (user && user.must_change_password) {
      go("admin/primo-accesso/");
      return;
    }
    this.ok = true;
  },
});

/** Finestra di conferma: si apre con askDelete(etichetta, azione). */
export const confirmModal = () => ({
  open: false,
  busy: false,
  label: "",
  action: null,
  init() {
    window.addEventListener("sca-confirm", (e) => {
      this.label = e.detail.label;
      this.action = e.detail.action;
      this.open = true;
    });
  },
  async confirm() {
    if (!this.action) return;
    this.busy = true;
    try {
      await this.action();
      this.open = false;
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

    /** Messaggio e navigazione, come messages + redirect nella versione Django. */
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
