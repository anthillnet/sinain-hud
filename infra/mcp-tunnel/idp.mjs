// OIDC adapter — the AS federates human login to a managed IdP (Auth0/WorkOS/
// Stytch/Clerk; any OIDC provider). `IDP_MODE=stub` swaps in a local fake login
// so the account flow is testable end-to-end with no IdP credentials.
// See docs/DESIGN-CHATGPT-ACCOUNTS.md.

const enc = encodeURIComponent;

export class Idp {
  constructor({ mode, issuer, clientId, clientSecret, asIssuer }) {
    this.mode = mode || "stub";
    this.issuer = (issuer || "").replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.asIssuer = (asIssuer || "").replace(/\/$/, "");
    this._meta = null;
  }

  get isStub() { return this.mode === "stub"; }

  /** Where to send the browser to authenticate. `callbackUrl` is our /idp/callback. */
  async authorizeUrl(state, callbackUrl) {
    if (this.isStub) {
      // Local fake login page served by the AS (/idp-stub/login).
      return `${this.asIssuer}/idp-stub/login?state=${enc(state)}&cb=${enc(callbackUrl)}`;
    }
    const m = await this._discover();
    const p = new URLSearchParams({
      response_type: "code", client_id: this.clientId, redirect_uri: callbackUrl,
      scope: "openid email", state,
    });
    return `${m.authorization_endpoint}?${p}`;
  }

  /** Exchange the IdP's code for the user's identity → { idpSub, email }. */
  async exchange(code, callbackUrl) {
    if (this.isStub) {
      // code shape: "stub:" + base64url(email)
      if (!code?.startsWith("stub:")) throw new Error("bad stub code");
      const email = Buffer.from(code.slice(5), "base64url").toString("utf8");
      if (!email) throw new Error("stub: empty email");
      return { idpSub: `stub|${email}`, email };
    }
    const m = await this._discover();
    const res = await fetch(m.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: callbackUrl,
        client_id: this.clientId, client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`IdP token exchange ${res.status}: ${await res.text()}`);
    const tok = await res.json();
    // id_token came from the token endpoint over TLS (confidential client) — decode
    // its claims. (A jwks signature check is a hardening follow-up.)
    const claims = decodeJwtPayload(tok.id_token);
    let email = claims?.email;
    const idpSub = claims?.sub;
    if (!email && m.userinfo_endpoint && tok.access_token) {
      const ui = await fetch(m.userinfo_endpoint, { headers: { authorization: `Bearer ${tok.access_token}` } });
      if (ui.ok) email = (await ui.json())?.email;
    }
    if (!idpSub) throw new Error("IdP returned no subject");
    return { idpSub, email: email || "" };
  }

  async _discover() {
    if (this._meta) return this._meta;
    const res = await fetch(`${this.issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery ${res.status}`);
    this._meta = await res.json();
    return this._meta;
  }
}

function decodeJwtPayload(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64url").toString()); }
  catch { return null; }
}
