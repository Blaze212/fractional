# ADR 003: Portal Auth Approach

**Date:** 2026-05-31
**Status:** Accepted

## Context

The fractional portal needs gated access before any member-facing feature is usable. We need login, password reset, and protected routing.

## Decisions

### 1. Supabase Auth email/password only; no self-registration

**Decision:** `signInWithPassword` for login; `resetPasswordForEmail` for reset. No sign-up page — accounts are provisioned manually by the owner.

**Why:** Manual onboarding matches the current fractional-exec model (small, curated user base). Removing registration reduces the auth surface, eliminates spam/abuse vectors, and simplifies the UI.

### 2. PKCE flow explicitly configured

**Decision:** `createClient` is called with `{ auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }`.

**Why:** PKCE (Proof Key for Code Exchange) is the Supabase-recommended flow for browser SPAs. The CS repo calls `createClient` without auth options (implicit defaults); we set them explicitly to make the security posture clear and avoid future regressions if defaults change.

### 3. Enumeration-safe error messages

**Decision:** Login failures show "Invalid email or password." (not "User not found" or "Wrong password"). Reset requests always show the same confirmation regardless of whether the email exists.

**Why:** Distinct error messages for "no account" vs "wrong password" let an attacker enumerate valid emails. Generic messages prevent this.

### 4. `token_hash` + `verifyOtp` for password recovery

**Decision:** The reset email template uses `?token_hash={{ .TokenHash }}&type=recovery`. On load, `/update-password` calls `verifyOtp({ token_hash, type })` (or `exchangeCodeForSession(code)` as a fallback).

**Why:** `token_hash` keeps the token out of the URL fragment (more phishing-resistant than `#access_token=...`). This is Supabase's current recommendation. Signing out any existing session before `verifyOtp` prevents cross-account reset scenarios.

### 5. `onAuthStateChange` callback stays synchronous

**Decision:** The `AuthContext` does not await Supabase calls inside the `onAuthStateChange` callback; it uses `setTimeout(fn, 0)` to defer.

**Why:** Awaiting Supabase calls inside the callback causes a deadlock — the callback itself is part of the Supabase auth state machine. CS discovered this issue and uses the same workaround.

### 6. Bypass auth bootstrap on `/update-password`

**Decision:** The `AuthProvider` skips `getSession()` and `onAuthStateChange` subscription when `pathname === '/update-password'`.

**Why:** The recovery link flow (token_hash → verifyOtp) establishes its own session. Having the provider run its bootstrap at the same time creates a race condition.

### 7. Simplified AuthContext (no profile/access/flags)

**Decision:** `AuthContext` exposes only `session`, `user`, `loading`. No member profile, no feature flags, no access state.

**Why:** The fractional portal has a single user type (authenticated exec). There's no tiered access or admin system at this stage. Adding it prematurely would replicate CS complexity without value.

## Rejected Alternatives

- **Social / OAuth login:** Out of scope for manual-provisioning model.
- **Magic link:** Adds email deliverability dependency with no UX benefit for a known-user-base product.
- **Self-registration:** Incompatible with manual provisioning model; would require admin approval workflow.
