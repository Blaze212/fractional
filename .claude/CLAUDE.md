## Project

CareerSystems - We build tools to aid jobseekers

## Stack

- Language and version: TypeScript 5.4+, Node.js 20+, React 18.3
- Framework: Vite (apps), Supabase Edge Functions (backend/serverless)
- Database: Supabase Postgres
- Key libraries: React Router, @supabase/supabase-js, Tailwind CSS, pnpm workspaces
- Deployed on Cloudflare Pages (apps) + Supabase (database/functions)
- Logger pino (use this over console.log). In edge functions, **always use the passed-in child logger** (e.g., `log = logger.child({ userId })`) rather than the root `logger` directly. Create the child logger at the start of each request handler with `{ userId }` and any other relevant context, then pass it down to sub-functions. The root `logger` should only be used at module scope or before the userId is known (e.g., startup errors).
- Always look up the latest package version when adding a new npm dependency/package
- All changes MUST be accompanied by unit tests

## Structure

- apps/portal — member portal app (Supabase auth + results/dashboard)
- packages/ui — shared UI primitives and Tailwind preset
- supabase/functions + supabase/migrations — edge functions and schema migrations
- tests/unit — unit test files for all packages and edge functions
- tests/integ — integration test files (add as test suites are introduced)
- tests/e2e — end-to-end test files (add as test suites are introduced)
- docs/adr — architectural decision records. Add a file here for changes that affect business logic, architecture, or introduce new features. Skip ADRs for trivial changes: adding tests, scripts, logging, small bug fixes, or refactors with no behavior change. See docs/architecture_decision_record.md for instructions.

## Commands

- Dev: `pnpm dev:portal` and `pnpm dev:diagnostic`
- Build: `pnpm build` (all) and `pnpm build:embed` (diagnostic embed)
- Test: no root test command is currently defined (run package-level tests when added)
- Format: `pnpm format` (write) or `pnpm format:check` (CI)
- Lint: `pnpm lint`

## Verification

After every change, run in this order:

1. `pnpm typecheck` — fix type errors (Node/Vite apps via tsc + edge functions via `deno check`; use `pnpm typecheck:functions` to check only edge functions)
2. Run package-level tests if present — fix failing tests
3. `pnpm format` — auto-format with Prettier (required before lint)
4. `pnpm lint` — fix lint errors

### Before pushing

A Husky `pre-push` hook runs `pnpm format:check && pnpm lint` and will block the push if either fails — so format/lint are enforced automatically. The hook does **not** run tests. **Always run `pnpm test` and confirm it passes before pushing** (a green suite is required; the push hook won't catch test failures, but CI will).

## Conventions

- Treat `supabase/migrations/` as the schema source of truth; keep edge functions under `supabase/functions/`.
- For setup and environment workflow, see docs/onboarding.md
- Openai's 'gpt-5.4' and 'gpt-5.4-mini' are the leading reasoning models available
- Prefer the OpenAI Responses API over Chat Completions for new AI integrations and refactors. Use Chat Completions only when there is a documented blocker.
- For new Supabase Edge Functions, use domain-specific env loaders and shared client factories.
- Delivery machinery comes from the `bh-delivery` plugin, not from this repo: `Skill: bh-delivery:gated-spec-delivery` to compile a spec, `Skill: bh-delivery:workflow` to execute it, `Skill: bh-delivery:spec-writer` to author one. Every `scripts/*.sh` below is a three-line shim onto the installed kit.
- `.claude/delivery-profile.yaml` is the source of truth for this repo's verify commands, CI check name, model tiers and red-tier rules. Change a verify command or a risk rule there, never in a prompt or a compiled yaml. Validate it with `node "$(scripts/kit-root.sh)/scripts/profile.mjs" validate .claude/delivery-profile.yaml`.
- **After completing any coding task**: run the verification order above, then commit, push, open a PR, and request a Copilot review.

## Edge Function Auth

This project uses Supabase's **asymmetric JWT signing keys** (ES256). The legacy `verify_jwt = true` flag in `config.toml` only works with the old symmetric (HS256) keys and will cause every user request to fail with `{code: 401, message: "Invalid JWT"}` before the function code runs.

**Rules:**

- All functions in `supabase/config.toml` MUST have `verify_jwt = false`.
- Never change any `[functions.*]` entry to `verify_jwt = true` — it will break prod on the next CI deploy.
- Auth is handled inside each function via `withAuth()` in `_shared/auth.ts`, which calls `supabase.auth.getUser(token)` and correctly validates ES256 tokens.
- Internal functions (`job-matcher-run`, `job-matcher-cron`) use `isServiceRoleBearer()` for server-to-server auth.
- Webhooks (`webhook-skool`) use a shared secret header (`X-Skool-Secret`), not a JWT.
- Fuctions should have ONE responsibilty
- Pay special attention do backawards incompatible changes. CALL THESE OUT. When required suggest implementhing these standalone and not coupling with a feature launch
- NEVER use 'unknown' type. You must explicitly ask for my permission to use unknown types!

## Edge Function Module Isolation — Deno.serve Side-Effect Rule

Every edge function file that contains `Deno.serve()` **registers an HTTP handler as a module-level side effect**. If another function imports from that file (e.g. to reuse a pure helper), `Deno.serve()` fires inside the importing isolate on cold start, which can intercept the very first request before the host function's own handler is ready.

**Symptom:** On cold start, a service-role dispatch to function A fails with `invalid claim: missing sub claim` (403). The error stack points to a _different_ function's file (e.g. `resume-rewrite.ts`) even though the request was routed to function A. Subsequent warm requests succeed.

**Rule:** Never import from a file that contains `Deno.serve()`. If a function file has shared logic that other functions need, extract that logic into a separate file with no `Deno.serve()` call, and import from there instead.

## Don't

- Don't hardcode secrets or commit `.env` files — use Doppler-managed environment variables.
- Don't bypass shared packages with one-off duplicate UI/diagnostic logic — add to `packages/` and consume via workspace imports.
- Don't set `verify_jwt = true` in `supabase/config.toml` for any function — see Edge Function Auth above.
- **Never run `supabase db push`** — migrations are deployed exclusively via CI on push to main. Running it locally will push unapplied branch migrations directly to production.

## Overnight / Automated Session Bootstrap

The sandbox runs **Ubuntu 22 aarch64 (ARM64 Linux)**. The bootstrap script is `scripts/bootstrap-sandbox.sh`. Key known issues and workarounds:

### Running the bootstrap script

The script defaults to a hardcoded session path. Always override with the actual workspace path:

```bash
WORKSPACE=/sessions/<session-id>/mnt/workspace source scripts/bootstrap-sandbox.sh
```

### Tool binaries (`scripts/bin/`)

Pre-built binaries must be **Linux arm64 (ELF aarch64)** — not macOS (Mach-O) and not x86-64. Verify with `file scripts/bin/<binary>` before use. Required binaries:

- `deno` — Linux arm64 build from https://github.com/denoland/deno/releases (`deno-aarch64-unknown-linux-gnu.zip`)
- `gh` — Linux arm64 build from https://github.com/cli/cli/releases (`gh_*_linux_arm64.tar.gz`)
- `pnpm` / `pnpm.js` — shell wrapper + CJS bundle (no architecture dependency, but see pnpm note below)

### pnpm CJS/ESM issue

`scripts/bin/pnpm.js` is a CommonJS bundle. Because the workspace root has `"type": "module"` in `package.json`, Node.js treats `.js` files as ESM and the bundle fails. Fix: copy it to `/tmp/pnpm.cjs` and invoke it from outside the workspace root, then put a wrapper on `PATH`:

```bash
cp scripts/bin/pnpm.js /tmp/pnpm.cjs
printf '#!/bin/sh\nexec node /tmp/pnpm.cjs "$@"\n' > /tmp/pnpm
chmod +x /tmp/pnpm
export PATH="/sessions/<session-id>/mnt/workspace/scripts/bin:/tmp:$PATH"
```

### Git lock-file workaround

The workspace is a Docker bind-mount where `unlink` is not permitted (git lock cleanup fails). Copy `.git` to `/tmp` and use `GIT_DIR`/`GIT_WORK_TREE`:

```bash
SESSION_ID=<session-id>
WORKSPACE=/sessions/$SESSION_ID/mnt/workspace
mkdir -p /tmp/git-$SESSION_ID
cp -r $WORKSPACE/.git /tmp/git-$SESSION_ID/repo
export GIT_DIR=/tmp/git-$SESSION_ID/repo
export GIT_WORK_TREE=$WORKSPACE
rm -f $GIT_DIR/index.lock   # clear any stale lock before first use
```

### node_modules architecture

`node_modules` must be installed on the same OS/architecture as the sandbox (Linux arm64). If installed on macOS or x86-64, optional native packages like `@rollup/rollup-linux-arm64-gnu` will be absent and `vitest` / Vite builds will fail at startup. Re-run `pnpm install` inside the sandbox to fix.
