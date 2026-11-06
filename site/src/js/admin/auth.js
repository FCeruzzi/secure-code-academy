// Pannello: accesso, primo accesso, dashboard, password, amministratori.
import { admin, api, formatDateTime, go, local, notify, param, safeNext } from "../core.js";
import { adminPage } from "./base.js";

/**
 * Il codice del dispositivo riconosciuto: dopo un accesso riuscito il Worker lo dà al
 * browser, e da qui il login non risente del blocco dell'account né della sospensione
 * per troppi tentativi altrui. Da solo non apre il pannello: serve sempre la password.
 */
const DEVICE_KEY = "sca_admin_device";

/** I campi di un form, tutti vuoti: anche le password partono da qui, senza valori nel codice. */
const blankForm = (...fields) => Object.fromEntries(fields.map((field) => [field, ""]));

/** Svuota i campi indicati (le password dopo l'invio). */
function clearFields(form, ...fields) {
  for (const field of fields) form[field] = "";
}

export const adminLogin = () =>
  adminPage({
    state: "ready",
    form: blankForm("username", "password"),
    loginError: "",
    init() {
      // Già dentro: si va direttamente alla pagina chiesta.
      if (admin.token()) go(safeNext(param("next")));
    },
    async submit() {
      this.busy = true;
      this.loginError = "";
      try {
        const res = await api("/api/admin/login", {
          method: "POST",
          json: { ...this.form, device: local.getItem(DEVICE_KEY) || "" },
        });
        if (res.device) local.setItem(DEVICE_KEY, res.device);
        admin.set(res.token, res.user);
        if (res.user.needs_setup) go("admin/primo-accesso/");
        else go(safeNext(param("next")));
      } catch (e) {
        this.loginError = e.message;
        clearFields(this.form, "password");
      } finally {
        this.busy = false;
      }
    },
  });

export const adminSetup = () =>
  adminPage({
    form: blankForm("new_password1", "new_password2"),
    async init() {
      if (!admin.token()) return go("admin/login/");
      await this.loadWith(async () => {
        const { user } = await this.call("/api/admin/me");
        admin.setUser(user);
        if (!user.needs_setup) return go("admin/");
      });
    },
    async submit() {
      const res = await this.submitForm("/api/admin/setup", "POST", this.form);
      if (!res) return;
      admin.setUser(res.user);
      this.done(res.message, "admin/");
    },
    async logout() {
      try {
        await this.call("/api/admin/logout", { method: "POST" });
      } catch {
        // già scaduta
      }
      admin.clear();
      go("/");
    },
  });

export const adminDashboard = () =>
  adminPage({
    counts: {},
    async init() {
      await this.loadWith(async () => {
        this.counts = (await this.call("/api/admin/dashboard")).counts;
      });
    },
  });

export const adminPassword = () =>
  adminPage({
    state: "ready",
    form: blankForm("old_password", "new_password1", "new_password2"),
    async submit() {
      const res = await this.submitForm("/api/admin/password", "POST", this.form);
      if (res) this.done(res.message, "admin/");
    },
  });

/** La password temporanea appena generata, mostrata una volta (temp-password.njk). */
const issuedBox = {
  issued: null,
  copied: false,
  formatDateTime,
  async copyIssued() {
    try {
      await navigator.clipboard.writeText(this.issued.temporary_password);
      this.copied = true;
    } catch {
      // Niente clipboard (http o permessi): resta selezionabile a mano.
    }
  },
};

export const adminAdmins = () =>
  adminPage({
    ...issuedBox,
    admins: [],
    available: [],
    me: null,
    // L'azione in attesa della password di conferma: { label, path, then }.
    pending: null,
    form: blankForm("confirm_password"),
    async init() {
      await this.loadWith(() => this.reload());
    },
    async reload() {
      const data = await this.call("/api/admin/admins");
      Object.assign(this, data);
    },
    ask(label, path, then) {
      this.issued = null;
      this.errors = {};
      clearFields(this.form, "confirm_password");
      this.pending = { label, path, then };
    },
    cancelPending() {
      this.pending = null;
      clearFields(this.form, "confirm_password");
      this.errors = {};
    },
    async confirmPending() {
      const { path, then } = this.pending;
      const res = await this.submitForm(path, "POST", { confirm_password: this.form.confirm_password });
      if (!res) return;
      this.cancelPending();
      await then(res);
      await this.reload();
    },
    resetPassword(a) {
      this.ask(
        `Generare una nuova password temporanea per ${a.username}? Le sue sessioni verranno chiuse.`,
        `/api/admin/admins/${a.id}/reset-password`,
        async (res) => {
          notify(res.message);
          this.copied = false;
          this.issued = res;
        },
      );
    },
    toggle(a) {
      this.ask(
        a.is_active ? `Disattivare ${a.username}? Le sue sessioni verranno chiuse.` : `Riattivare ${a.username}?`,
        `/api/admin/admins/${a.id}/toggle`,
        async (res) => notify(res.message),
      );
    },
  });

export const adminAdminCreate = () =>
  adminPage({
    ...issuedBox,
    available: [],
    form: blankForm("username", "confirm_password"),
    async init() {
      await this.loadWith(async () => {
        this.available = (await this.call("/api/admin/admins")).available;
        this.form.username = this.available[0] || "";
      });
    },
    async submit() {
      const res = await this.submitForm("/api/admin/admins", "POST", this.form);
      if (!res) return;
      clearFields(this.form, "confirm_password");
      notify(res.message);
      this.issued = res;
    },
  });

export const adminConsultantCreate = () =>
  adminPage({
    ...issuedBox,
    state: "ready",
    form: blankForm("username", "confirm_password"),
    async submit() {
      const res = await this.submitForm("/api/admin/consultants", "POST", this.form);
      if (!res) return;
      clearFields(this.form, "confirm_password");
      notify(res.message);
      this.issued = res;
    },
  });

const AUDIT_LABELS = {
  login: "Accesso",
  login_failed: "Accesso fallito",
  login_paused: "Accesso sospeso",
  setup_completed: "Primo accesso completato",
  password_changed: "Password cambiata",
  password_reset: "Password reimpostata",
  admin_created: "Account creato",
  consultant_created: "Consulente creato",
  admin_disabled: "Account disattivato",
  admin_enabled: "Account riattivato",
  bootstrap: "Account dal workflow",
};

export const adminAudit = () =>
  adminPage({
    entries: [],
    formatDateTime,
    actionLabel: (a) => AUDIT_LABELS[a] || a,
    actionClass: (a) =>
      a === "login_failed" || a === "login_paused" || a === "admin_disabled"
        ? "bg-rose-500/15 text-rose-300"
        : a === "login"
          ? "bg-slate-700 text-slate-300"
          : "bg-amber-500/15 text-amber-300",
    async init() {
      await this.loadWith(async () => {
        this.entries = (await this.call("/api/admin/audit")).entries;
      });
    },
  });
