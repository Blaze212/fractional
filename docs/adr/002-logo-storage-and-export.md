# ADR 002: Logo Storage, Edge Function, and DOCX Export

**Date:** 2026-05-31
**Status:** Accepted

## Context

Fractional executives want a personal logo on every resume export. We need durable per-user logo storage, a management endpoint, and integration with the client-side DOCX export pipeline.

## Decisions

### 1. Supabase Storage private bucket (not DB blob)

**Decision:** Store logo images as objects in a private Supabase Storage bucket (`resume-logos`), with metadata (path, dimensions, mime type) in a `public.user_resume_logo` table.

**Why:** Supabase Storage is designed for binary assets; DB blobs require base64 encoding, larger rows, and slower queries. The bucket + metadata split is the standard pattern. The bucket is private: objects are only reachable via short-lived signed URLs minted by the function, so no direct public access.

### 2. Upload through the edge function (not direct-to-Storage)

**Decision:** All uploads go through the `resume-logo` edge function, which validates MIME type, file size, and dimensions server-side before writing to storage.

**Why:** Direct browser-to-Storage uploads would require bucket policies to enforce validation, which is harder to maintain and test than explicit server-side code. Routing through the function gives a single enforcement point.

**Trade-off:** Slightly higher latency (upload goes through the function's memory); acceptable given the small file size cap (2 MB).

### 3. Free/open image module for DOCX embedding

**Decision:** Use `docxtemplater-image-module-free` (the community open-source variant) to render `{{%company_logo}}` in the DOCX template.

**Why:** The official paid `docxtemplater` image module requires a license. The free module has the same API and supports the `{{ }}` delimiters we use. For the null-logo case, we supply a 1×1 transparent PNG fallback so the tag renders to nothing rather than throwing.

**Trade-off:** The free module has fewer guarantees around edge cases; test the null-logo path (spec 004 acceptance criterion).

### 4. Client-side DOCX render (not server-side)

**Decision:** Port CareerSystems `resumeExport.ts` into the portal; all DOCX rendering runs in the browser with PizZip + Docxtemplater.

**Why:** Matches the existing CS approach. Server-side rendering would require a Node/Deno-capable environment that handles complex DOCX XML, which is not currently available in the edge function runtime.

### 5. Logo render dimensions cap at 120px header width, aspect-ratio-preserved

**Decision:** `getSize()` in the image module caps at 120px wide, preserving the natural aspect ratio.

**Why:** The template's header section is ~6–7cm wide; 120px renders as roughly 2cm — visible branding without overwhelming the layout. Clients measure natural dimensions on upload; we trust them for rendering size only (not security).

### 6. Object path: `{userId}/logo.{ext}` (upsert overwrites)

**Decision:** One object per user at a fixed path. Uploading a new logo overwrites the old one in place.

**Why:** Eliminates orphaned objects and simplifies signed URL generation. The `updated_at` timestamp in the metadata row provides freshness signal.

## Rejected Alternatives

- **DB blob storage:** Row size issues, slower reads, no CDN caching benefit.
- **Direct-to-Storage upload from browser:** Loses server-side validation; harder to test.
- **Paid official image module:** Cost and license overhead for a project in early development.
- **Server-side DOCX rendering:** Adds infrastructure complexity; client-side is sufficient.
