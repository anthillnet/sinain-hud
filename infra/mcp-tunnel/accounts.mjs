// Account store for the optional ChatGPT-only identity layer.
// Holds ONLY email + the account↔device map + waitlist flag — never any user content.
// Small atomic JSON store (SQLite is a drop-in later). See
// docs/DESIGN-CHATGPT-ACCOUNTS.md.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { newAccountId } from "./lib.mjs";

export class AccountStore {
  constructor(path) {
    this.path = path;
    this.data = { accounts: {}, devicesByAccount: {}, accountByDevice: {} };
    if (existsSync(path)) {
      try { this.data = { accounts: {}, devicesByAccount: {}, accountByDevice: {}, ...JSON.parse(readFileSync(path, "utf8")) }; }
      catch { /* start fresh on corruption */ }
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
  }

  _persist() {
    const tmp = join(dirname(this.path), `.accounts.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path); // atomic
  }

  /** Resolve the account for an IdP subject, creating it on first login. */
  upsertByIdpSub(idpSub, email) {
    for (const [id, a] of Object.entries(this.data.accounts)) {
      if (a.idpSub === idpSub) {
        if (email && a.email !== email) { a.email = email; this._persist(); }
        return id;
      }
    }
    const id = newAccountId();
    this.data.accounts[id] = { email: email || "", idpSub, created: nowIso() };
    this.data.devicesByAccount[id] = [];
    this._persist();
    return id;
  }

  getAccount(accountId) {
    return this.data.accounts[accountId] || null;
  }

  markWaitlisted(accountId) {
    const account = this.data.accounts[accountId];
    if (!account) throw new Error("unknown account");
    if (Object.hasOwn(account, "waitlisted")) return;
    account.waitlisted = true;
    account.waitlistedAt = nowIso();
    this._persist();
  }

  /** Link a device handle to an account (idempotent). A handle belongs to one
   *  account; re-linking moves it. */
  linkDevice(accountId, handle) {
    if (!this.data.accounts[accountId]) throw new Error("unknown account");
    const prev = this.data.accountByDevice[handle];
    if (prev && prev !== accountId) {
      this.data.devicesByAccount[prev] = (this.data.devicesByAccount[prev] || []).filter((h) => h !== handle);
    }
    this.data.accountByDevice[handle] = accountId;
    const list = this.data.devicesByAccount[accountId] || (this.data.devicesByAccount[accountId] = []);
    if (!list.includes(handle)) list.push(handle);
    this._persist();
  }

  unlinkDevice(handle) {
    const acct = this.data.accountByDevice[handle];
    if (!acct) return;
    delete this.data.accountByDevice[handle];
    this.data.devicesByAccount[acct] = (this.data.devicesByAccount[acct] || []).filter((h) => h !== handle);
    this._persist();
  }

  devicesFor(accountId) {
    return this.data.devicesByAccount[accountId] || [];
  }

  accountForDevice(handle) {
    return this.data.accountByDevice[handle] || null;
  }

  /** Seed a fixed demo account → fixture device for OpenAI review. Idempotent. */
  ensureDemo(idpSub, email, fixtureHandle) {
    const id = this.upsertByIdpSub(idpSub, email);
    this.linkDevice(id, fixtureHandle);
    return id;
  }
}

function nowIso() {
  // Date.now()/new Date() are fine in services (only workflow scripts forbid them).
  return new Date().toISOString();
}
