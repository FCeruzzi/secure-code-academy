// Pannello: accesso, primo accesso, dashboard, password, amministratori.
// Porta apps/accounts/views.py.
import { admin, api, formatDateTime, go, notify, param } from "../core.js";
import { adminPage } from "./base.js";

/** Solo percorsi interni al pannello: niente redirect verso altri siti. */
function safeNext(next) {
  return /^admin\/[A-Za-z0-9/_\-?=&%.]*$/.test(next || "") ? next : "admin/";
}

export const adminLogin = () =>
  adminPage({
    state: "ready",
    form: { username: "", password: "" },
    loginError: "",
    init() {
      // Già dentro: come redirect_authenticated_user.
      if (admin.token()) go(safeNext(param("next")));
    },
    async submit() {
      this.busy = true;
      this.loginError = "";
      try {
        const res = await api("/api/admin/login", { method: "POST", json: this.form });
        admin.set(res.token, res.user);
        if (res.user.must_change_password) go("admin/primo-accesso/");
        else go(safeNext(param("next")));
      } catch (e) {
        this.loginError = e.message;
        this.form.password = "";
      } finally {
        this.busy = false;
      }
    },
  });

export const adminSetup = () =>
  adminPage({
    form: { email: "", new_password1: "", new_password2: "" },
    async init() {
      if (!admin.token()) return go("admin/login/");
      await this.loadWith(async () => {
        const { user } = await this.call("/api/admin/me");
        admin.setUser(user);
        if (!user.must_change_password) return go("admin/");
        this.form.email = user.email || "";
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
    form: { old_password: "", new_password1: "", new_password2: "" },
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
    form: { confirm_password: "" },
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
      this.form.confirm_password = "";
      this.pending = { label, path, then };
    },
    cancelPending() {
      this.pending = null;
      this.form.confirm_password = "";
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
    form: { username: "", confirm_password: "" },
    async init() {
      await this.loadWith(async () => {
        this.available = (await this.call("/api/admin/admins")).available;
        this.form.username = this.available[0] || "";
      });
    },
    async submit() {
      const res = await this.submitForm("/api/admin/admins", "POST", this.form);
      if (!res) return;
      this.form.confirm_password = "";
      notify(res.message);
      this.issued = res;
    },
  });

export const adminAdminEdit = () =>
  adminPage({
    target: null,
    form: { email: "" },
    async init() {
      const id = param("id");
      if (!/^\d+$/.test(id)) return (this.state = "notfound");
      await this.loadWith(async () => {
        this.target = (await this.call(`/api/admin/admins/${id}`)).admin;
        this.form.email = this.target.email || "";
      });
    },
    async submit() {
      const res = await this.submitForm(`/api/admin/admins/${this.target.id}`, "PUT", this.form);
      if (res) this.done(res.message, "admin/amministratori/", {}, res.level || "success");
    },
  });

const AUDIT_LABELS = {
  login: "Accesso",
  login_failed: "Accesso fallito",
  setup_completed: "Primo accesso completato",
  password_changed: "Password cambiata",
  password_reset: "Password reimpostata",
  admin_created: "Account creato",
  admin_disabled: "Account disattivato",
  admin_enabled: "Account riattivato",
  email_changed: "Email cambiata",
  bootstrap: "Account dal workflow",
};

export const adminAudit = () =>
  adminPage({
    entries: [],
    formatDateTime,
    actionLabel: (a) => AUDIT_LABELS[a] || a,
    actionClass: (a) =>
      a === "login_failed" || a === "admin_disabled"
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
