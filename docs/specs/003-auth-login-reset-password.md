# Auth: Login & Password Reset

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-05-31

## Objective

Stand up authentication for the fractional portal: a **login page** and a
**password-reset flow** (request reset email + set new password) on Supabase
Auth (email/password). **No self-registration** — accounts are provisioned
manually by the owner. This also scaffolds the portal app shell (router +
auth context + protected routes) that specs 001/002 build on.

## Non-goals

- Self-service registration / sign-up page (owner creates users manually).
- Social / OAuth / magic-link / passwordless login.
- MFA / TOTP (possible later).
- Email template design beyond pointing the reset link at the right redirect.
- User/role management UI.

## Business Rationale

The portal needs gated access before any member-facing feature (resume tools,
logo config, export) is usable. Keeping it to login + reset — no registration —
matches the manual onboarding model and is the smallest auth surface that's still
secure.

## Supabase Auth best practices (the standard we build to)

These are the current Supabase-recommended patterns for an email/password SPA;
the implementation below conforms to them.

- **Client config:** `createClient(url, anonKey, { auth: { flowType: 'pkce',
  persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })`.
  **PKCE** is recommended for browser SPAs and makes the recovery link robust.
- **Login:** `supabase.auth.signInWithPassword({ email, password })`.
- **Reset request:** `supabase.auth.resetPasswordForEmail(email, { redirectTo })`
  where `redirectTo` points at the update-password route and is **allow-listed**
  in the Supabase dashboard (Auth → URL Configuration → Redirect URLs; Site URL
  set correctly).
- **Recovery → set password:** the reset email uses a **`token_hash`** link to
  `/update-password`. On load, call
  **`verifyOtp({ token_hash, type: 'recovery' })`** (or
  `exchangeCodeForSession(code)` for the PKCE `code` form) to establish a recovery
  session, then call `supabase.auth.updateUser({ password })`. Preferring
  `token_hash` + `verifyOtp` keeps tokens out of the URL fragment and is more
  robust than relying on the `PASSWORD_RECOVERY` event alone.
- **Session:** centralize in an auth provider using `getSession()` +
  `onAuthStateChange`; `autoRefreshToken` keeps it alive.
- **Security:**
  - **No user enumeration** — login failures and reset requests return generic
    messages ("Invalid email or password" / "If an account exists, you'll get an
    email").
  - Enable **leaked-password protection (HIBP)** and a **min length ≥ 8** in the
    dashboard; surface password-strength feedback on the update form.
  - **Rate limiting** — rely on Supabase's built-in email/auth rate limits.
  - HTTPS only; tokens live in `localStorage` (supabase-js default) — mitigate
    XSS with a strict **CSP**.

## Architecture

Mirror the CareerSystems portal structure (`apps/portal/src`), which already
implements this pattern — reuse it as the reference and close the gaps in §Gaps.

### Portal app shell (scaffold)

- Vite + React 18 + React Router + Tailwind. **Plain Tailwind components** — no
  shared `packages/ui` for this greenfield repo; build the few primitives
  (Button, Input) inline.
- **`lib/supabase.ts`** — `createClient(url, anonKey, { auth: { flowType:
  'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl:
  true } })`. **Improvement over CS:** the CS client passes **no auth options**
  (default flow); set these explicitly here. Env: `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`.
- **`contexts/AuthContext.tsx`** — provider exposing `session`, `user`,
  `loading`; reads initial `getSession()` and subscribes to
  `onAuthStateChange`. Two non-obvious patterns to **carry over from CS**:
  - **`onAuthStateChange` callback must stay synchronous.** Awaiting Supabase
    calls inside it deadlocks (`updateUser()` → `USER_UPDATED` →
    further-supabase-call → deadlock). CS defers follow-up work with
    `setTimeout(fn, 0)`. We have less follow-up work (no profile/access load — see
    Simplifications), but keep the rule.
  - **Bypass auth bootstrap on the update-password route** so the recovery link
    flow isn't disrupted by the provider's own session handling (CS gates on
    `pathname === '/auth/update-password'`).
- **`App.tsx`** — routes: `/login` (public), `/reset-password` (public, request
  form), `/update-password` (public; self-gates on the recovery link/session),
  `/resume-templater` protected (the default authenticated route; spec 004), with
  any other protected route → redirect to `/login` when unauthenticated. (CS names
  the auth routes `/auth` and `/auth/update-password`; either is fine — keep one
  consistent set.)
- **`main.tsx`** — `BrowserRouter` + (optional) Sentry, matching CS.
- **`components/ProtectedRoute`** — gates authenticated routes (port from CS).
- **`components/PasswordInput`** — password field with show/hide toggle; port
  CS's markup but back it with a plain Tailwind `<input>` (not `@cs/ui`).

### Simplifications vs CareerSystems

CS's `AuthContext` also loads member profile, access state, feature flags, and
admin status on every auth change. Fractional does **not** need any of that yet —
keep the provider to `session`/`user`/`loading` only. CS's `AuthPage` is a
three-mode form (signin/signup/forgot); fractional **drops `signup`** entirely.

### Pages

1. **Login (`/login`)** — email + password, submit → `signInWithPassword`;
   link to "Forgot password?". Redirect to **`/resume-templater`** on success and
   if already authenticated. **Improvement over CS:** show a **generic** error
   ("Invalid email or password") rather than surfacing raw `error.message`.
2. **Request reset (`/reset-password`)** — email field → `resetPasswordForEmail`
   with `redirectTo = <origin>/update-password`; always show the generic,
   enumeration-safe confirmation (CS already does: "If this email exists … we
   sent a reset link").
3. **Update password (`/update-password`)** — port CS's robust on-mount handling:
   read `token_hash`+`type` or `code` from the URL; **sign out any existing
   session first** (so the link's identity wins — prevents User A, logged in,
   completing a reset meant for User B), then `verifyOtp({ token_hash, type })`
   (preferred) or `exchangeCodeForSession(code)`; strip the params from the URL;
   fall back to an existing session if no link params (lets a signed-in user
   change their own password). New-password + confirm with strength feedback →
   `updateUser({ password })`; success → route to app. No recovery session
   (expired/used link) → clear "request a new link" CTA.

   The reset **email template must use the `token_hash` link** (e.g.
   `…/update-password?token_hash={{ .TokenHash }}&type=recovery`) so `verifyOtp`
   works and tokens aren't exposed in the URL fragment.

### Auth model / config

- No backend edge function needed — auth is entirely client → Supabase Auth.
- **Dashboard config (call out in ADR / runbook):** Site URL, Redirect URL
  allow-list (incl. `/update-password`), enable leaked-password protection,
  min-length, configure the reset email template.
- Env (build-time, not secret): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

**ADR:** file one in `docs/adr/` — establishes the portal app + auth approach
(PKCE, no registration, manual provisioning, enumeration-safe UX).

## Gaps vs CareerSystems (reviewed against the actual CS code)

What CS already does **well** and we should port verbatim:

- `UpdatePasswordPage` uses **`token_hash` + `verifyOtp`** (and `code` +
  `exchangeCodeForSession`) — the Supabase-recommended approach — plus
  **sign-out-before-verify**, URL-param stripping, and expired-link UX.
- `resetPasswordForEmail` request copy is **enumeration-safe**.
- `onAuthStateChange` **deadlock avoidance** via `setTimeout(fn, 0)`.
- `update-password` route **bypasses the auth bootstrap**.
- `PasswordInput` show/hide toggle; client-side password rules (≥8, letters,
  numbers); confirm-match check.

Concrete **improvements** to make in fractional (best practice ⇒ CS gap):

- **Set the auth flow explicitly.** CS calls `createClient(url, key)` with no
  options. Add `flowType: 'pkce'` + `persistSession`/`autoRefreshToken`/
  `detectSessionInUrl`.
- **Generic login error.** CS shows raw `error.message` on sign-in; use a generic
  message to avoid enumeration/leakage.
- **Leaked-password protection + min length.** Enable HIBP check and min length
  in the Supabase dashboard (CS relies only on client-side rules).
- **Custom SMTP for production.** Supabase's default email is rate-limited /
  best-effort; configure SMTP so reset emails are reliable.
- **Drop `signup`.** CS's `AuthPage` includes a sign-up mode; remove it (manual
  provisioning only).
- **Trim the provider.** Don't port CS's profile/access/feature-flag loading.

## Implementation Phases

### Phase 1 — Portal shell + Supabase client + AuthContext

- Scaffold Vite/React/Router/Tailwind portal app; `lib/supabase.ts` (PKCE),
  `AuthContext`, `ProtectedRoute`, route table.
- Tests: AuthContext state transitions (signed-out → signed-in → recovery),
  ProtectedRoute redirect.

### Phase 2 — Login + reset pages

- Login page, request-reset page, update-password page, `PasswordInput`.
- Tests: form validation, success/error states, enumeration-safe copy,
  recovery-session gating, expired-link handling (mock `supabase.auth`).

### Phase 3 — Hardening / config

- Document & apply dashboard config (redirect allow-list, Site URL, leaked-pw
  protection, min length, reset email template).

## Edge Cases & Risk

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| User enumeration via error copy/timing | M | M | Generic messages on login + reset |
| Reset `redirectTo` not allow-listed → broken link | M | H | Configure dashboard allow-list + Site URL; document in runbook |
| Recovery link expired / reused | M | M | Detect missing recovery session → "request a new link" |
| Credential stuffing / reset spam | M | M | Supabase built-in auth/email rate limits |
| Weak / breached passwords | M | M | Leaked-password protection + min length + strength UI |
| Token theft via XSS (localStorage) | L | H | Strict CSP, dependency hygiene, HTTPS |
| Stale session after password change | L | L | Sign out after `updateUser`, route to login |

## Acceptance Criteria

- [ ] Client uses **PKCE** flow with `persistSession`/`autoRefreshToken`/
      `detectSessionInUrl`.
- [ ] `/login` authenticates valid creds via `signInWithPassword` and redirects
      to the app; invalid creds show a generic error.
- [ ] Authenticated users hitting `/login` are redirected into the app;
      unauthenticated users on protected routes are redirected to `/login`.
- [ ] `/reset-password` sends a reset email via `resetPasswordForEmail` with the
      correct `redirectTo`, and always shows the generic confirmation.
- [ ] Recovery link lands on `/update-password`, which establishes a recovery
      session via `verifyOtp({ token_hash, type })` (or `exchangeCodeForSession`);
      `updateUser({ password })` sets the new password; expired/invalid link shows
      a recovery message.
- [ ] No registration route exists.
- [ ] Dashboard config applied: redirect allow-list, Site URL, leaked-password
      protection, min length, reset email template.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format` pass.
- [ ] Unit/component tests written and passing.
- [ ] ADR filed in `docs/adr/`.
- [ ] No hardcoded secrets (anon key is public; service role never in the client).

## Open Questions

1. **Route naming** — keep CS's `/auth` + `/auth/update-password`, or use
   `/login` + `/reset-password` + `/update-password`? (Cosmetic.)
