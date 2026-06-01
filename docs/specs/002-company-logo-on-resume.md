# Per-User Company Logo on Resume Export

**Status:** Draft
**Owner:** Barton Holdridge
**Last updated:** 2026-05-31

## Objective

Let each user configure and store a single **company logo** image, then embed
that logo into their exported resume `.docx` at the template's `{{%company_logo}}`
placeholder. This covers image upload/validation, persistent storage, a config
UI, and wiring the logo into the DOCX export. The export itself is ported from
the CareerSystems portal (`apps/portal/src/lib/resumeExport.ts`), which renders
the template client-side with **PizZip + Docxtemplater**.

## Non-goals

- Multiple images / image galleries per user — exactly one logo slot.
- Image editing (crop/rotate/filters) — upload as-is.
- Headshots or other template image fields — only `{{%company_logo}}`.
- Changing the resume content model (that's spec 001 / the parser).
- Server-side DOCX rendering — export stays client-side, matching CareerSystems.

## Business Rationale

Fractional execs present under a personal brand; a logo on the resume is a
recurring, per-user branding need. Storing it once and auto-embedding it on every
export removes manual document editing and keeps output consistent. Unlike the
parser (spec 001, deliberately stateless), the logo is durable configuration and
must persist.

## Architecture

### Components

1. **Storage** — Supabase Storage **private** bucket `resume-logos`.
   - Object path: `{userId}/logo.{ext}` (one object per user; upsert overwrites).
2. **Metadata table** — `public.user_resume_logo`:
   | column | type | notes |
   |---|---|---|
   | `user_id` | `uuid` PK | FK → `auth.users(id)` on delete cascade |
   | `storage_path` | `text` not null | e.g. `{userId}/logo.png` |
   | `mime_type` | `text` not null | `image/png` or `image/jpeg` |
   | `width_px` | `int` not null | natural pixel width (client-provided) |
   | `height_px` | `int` not null | natural pixel height (client-provided) |
   | `file_size` | `int` not null | bytes |
   | `updated_at` | `timestamptz` not null default `now()` | |
3. **Upload/manage endpoint** — edge function `resume-logo` (single
   responsibility: manage the per-user logo):
   - `POST` (multipart `file` + `width`/`height` fields) → validate, store to
     bucket, upsert row.
   - `GET` → return `{ logo: { signed_url, mime_type, width_px, height_px } | null }`
     (short-lived signed URL the browser uses at export time).
   - `DELETE` → remove storage object + row.
4. **Config UI** — an **inline logo uploader on the resume-templater page**
   (spec 004): upload, live preview, replace, remove. **No separate settings
   page.**
5. **Export integration** — port `resumeExport.ts` into the fractional portal
   and add the image module so `{{%company_logo}}` renders the user's logo.

### Export integration detail

`resumeExport.ts` today builds the doc as:

```ts
const zip = new PizZip(buffer)
const doc = new Docxtemplater(zip, {
  paragraphLoop: true,
  linebreaks: true,
  delimiters: { start: '{{', end: '}}' },
})
doc.render(renderData)
```

`renderData` is produced by a fractional `mapParsedProfileToRenderData()` that
maps the **spec 001 `ParsedProfile`** onto the template's merge fields (name,
headerLine, sponsorship constant, summary split into two paragraphs,
careerHighlights, selectedExperience with responsibilities+achievements,
otherExperience, education+certifications merged, skillsLine/toolsLine). Because
001's schema is now template-aligned, this mapping is mechanical — port CS's
`mapParsedResumeToRenderData` and adjust field names. The contact-hyperlink
XML-patching helper from CS's `resumeExport.ts` ports as-is.

To support `{{%company_logo}}` (docxtemplater image-module syntax):

- Add the image module (e.g. `docxtemplater-image-module` or an
  open equivalent) configured with the **same `{{ }}` delimiters**, a
  `getImage(tagValue)` returning the logo bytes (`ArrayBuffer`/`Uint8Array`),
  and `getSize()` returning render dimensions in px.
- Before export, the portal calls `GET resume-logo`, fetches the signed URL into
  an `ArrayBuffer`, and sets `renderData.company_logo` to that buffer.
- **No logo configured:** the tag must render to nothing rather than throw.
  Either (a) use a module variant supporting `nullGetImage`/null values, or
  (b) supply a 1×1 transparent PNG fallback. Decide at implementation
  (**open question**: confirm chosen module supports null cleanly).
- `getSize()` should cap to a fixed header width (e.g. 120px) preserving aspect
  ratio so large uploads don't blow out the layout.

### Auth model

- `resume-logo` registered in `config.toml` with `verify_jwt = false` (ES256
  rule); auth via shared `withAuth()`. All operations are scoped to the
  authenticated `userId`.
- Storage bucket is private; objects are reached only via short-lived signed URLs
  minted by the function for the requesting user's own object.
- If the portal uploads directly to Storage instead of through the function,
  bucket RLS must restrict the `{userId}/` prefix to the owner (see Risk table).
  Default plan: go **through the edge function** so validation is enforced
  server-side.

### Validation rules

- Accept `image/png`, `image/jpeg` only (raster — SVG/EMF not supported by the
  image module). Reject others with `400`.
- Max file size **2 MB**, enforced server-side from the byte length.
- **Dimensions are measured client-side** (`createImageBitmap` / `Image`) and
  sent with the upload — this avoids needing an image-decode lib in the Deno
  function. The server validates the provided `width`/`height` against a
  **2000×2000** cap and stores them for `getSize()` aspect-ratio math.
  (Dimensions only affect render sizing, not security, so trusting
  client-measured values is acceptable.)

### Env / config (Doppler-managed)

- `RESUME_LOGO_BUCKET` (default `resume-logos`)
- `RESUME_LOGO_MAX_MB` (default `2`)
- `RESUME_LOGO_SIGNED_URL_TTL_SECONDS` (default `120`)

### Dependencies

- Supabase Storage bucket + migration for `user_resume_logo` + RLS.
- `pizzip`, `docxtemplater`, and a `docxtemplater` **image module** in the portal
  (look up current versions when implementing).
- A fractional **portal app** to host the config UI and client-side export. If it
  doesn't exist yet, scaffolding it is a prerequisite (flag in planning).

**ADR:** file one in `docs/adr/` — new persisted feature + export-pipeline
change. Cover: storage-vs-DB-blob choice, through-function-vs-direct-upload,
image-module selection (licensing), and null-logo handling.

## Implementation Phases

### Phase 1 — Storage + metadata + `resume-logo` function

- Migration: `resume-logos` bucket, `user_resume_logo` table, RLS policies
  (owner-only select/insert/update/delete; storage policies on `{userId}/`).
- Edge function `resume-logo` with `POST` / `GET` / `DELETE`, `withAuth()`,
  child logger `{ userId }`, validation, signed-URL minting.
- `config.toml` entry with `verify_jwt = false`.
- Unit tests: validation, auth scoping, upsert/overwrite, delete, signed-URL
  response shape (storage + AI-free, mock the Supabase client via `Deps`).

### Phase 2 — Inline logo uploader (on the resume-templater page, spec 004)

- Logo uploader embedded in the resume-templater page (no separate settings
  page): upload (drag/drop + file picker), preview current logo, replace, remove;
  loading/empty/error states.
- Calls the `resume-logo` endpoints.
- Component tests for the UI states.

### Phase 3 — Export integration

- Port `resumeExport.ts` into the fractional portal.
- Add the image module with `{{ }}` delimiters; implement `getImage`/`getSize`
  with the header-width cap and null-logo handling.
- Fetch the logo (`GET resume-logo` → signed URL → `ArrayBuffer`) and set
  `renderData.company_logo` before `doc.render()`.
- Tests: render with a logo present (asset embedded), and with no logo
  configured (no throw, tag renders empty).

## Edge Cases & Risk

| Risk                                          | Likelihood | Impact | Mitigation                                                                           |
| --------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------ |
| No logo configured at export                  | H          | M      | Module handles null / transparent fallback; tag renders empty, export still succeeds |
| Oversized or huge-dimension upload            | M          | M      | Enforce size/dimension caps → `400`; `getSize()` caps render width                   |
| Unsupported format (SVG, GIF, HEIC)           | M          | M      | Allowlist PNG/JPEG only → `400`                                                      |
| User A reads/writes user B's logo             | L          | H      | All ops scoped to `userId` in-function; storage RLS on `{userId}/` prefix            |
| Signed URL leaks / long-lived                 | L          | M      | Short TTL (`~120s`), minted per-request for owner only                               |
| Image-module licensing (paid official module) | M          | M      | Evaluate open module; record choice in ADR                                           |
| Aspect-ratio distortion in header             | M          | L      | Preserve ratio in `getSize()`, cap width only                                        |
| Stale logo after replace (cache)              | L          | L      | Overwrite same path + bust via `updated_at`/fresh signed URL                         |

## Acceptance Criteria

- [ ] Migration creates `resume-logos` bucket + `user_resume_logo` table with
      owner-only RLS; verified locally.
- [ ] `POST resume-logo` with a valid PNG/JPEG (≤2MB) stores the object, upserts
      the row, returns `200`; oversized/wrong-type returns `400`.
- [ ] `GET resume-logo` returns a short-lived signed URL + metadata, or `null`
      when none configured.
- [ ] `DELETE resume-logo` removes both the object and the row.
- [ ] A user cannot read/write another user's logo (RLS + in-function scoping
      verified).
- [ ] Portal Settings UI can upload, preview, replace, and remove the logo with
      proper loading/empty/error states.
- [ ] Exported `.docx` embeds the configured logo at `{{%company_logo}}`; export
      with no logo configured succeeds with the tag rendered empty (no throw).
- [ ] Function registered in `config.toml` with `verify_jwt = false`.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format` pass.
- [ ] Unit/component tests written and passing for all three phases.
- [ ] ADR filed in `docs/adr/`.
- [ ] No hardcoded secrets.

## Resolved Decisions

1. **Image module — RESOLVED:** use the **free/open** docxtemplater image module
   (e.g. `open-docxtemplater-image-module` / `docxtemplater-image-module-free`),
   not the paid official one. Confirm it handles a null/absent image; if it does
   not, supply a 1×1 transparent PNG fallback so the tag renders empty.
2. **Upload path — RESOLVED:** **through the `resume-logo` edge function**
   (server-side validation), not direct-to-Storage from the browser.
3. **Render size — RESOLVED:** **~120px header width, aspect ratio preserved**
   via `getSize()`. (Fine-tune against the live template during Phase 3.)
4. **Portal app — RESOLVED:** the fractional portal is being established; auth
   (login + reset password) is specified in **spec 003**, which scaffolds the
   portal app this feature's config UI and export live in. 003 is a prerequisite
   for Phases 2–3 here.

## Open Questions

- None blocking. Verify the free image module's null handling during Phase 3
  (fallback noted above if unsupported).
