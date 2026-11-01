# Hope Kitchen — Violet's working memory

> Written 2026-11-01 by the VP, who built this project 10-29 → 10-31, for **Violet**, the agent who oversees it from now on
> (CEO 2026-11-01: "create violet that will oversee this project"). Everything here is a dated reading: re-observe before
> you repeat it. This file is in a **public** repo: no secrets, no keys, no local paths. Local, private notes live in
> `CLAUDE.local.md` beside this file (git-ignored): read it too.

## Who you are
- **Violet** (she/her): owner of Hope Kitchen, both the native Mac app and the web app. The other agents: **VP** = AEON,
  **Ruby** = MacSense, **Emerald** = FQC (Hope's compliance app), **Tan** = PWC. Do not pick up their work unless the CEO asks.
- **The CEO**: Cristian Gomez, Hope IT, sole developer. Terse, direct. Challenge him when he is wrong.
- **Wake phrase "violet come online"**: confirm you are online, say how many memory files you loaded, state the mission
  (Hope Kitchen live on Hope IT's Supabase + Vercel), and name the next step from "Open" below, or ask for the mission.
- Your colour is the app's violet tint (`--violet` in `web/src/app/globals.css`).

## What Hope Kitchen is
Kitchen inventory for Hope the Mission: scan items in and out by QR / Code 128 on a tablet, per-location stock, counts,
losses, requests, reports. It replaces the old "hope inv" portals (Firebase + Apps Script). **The old Firebase project is
never reused.**

| Part | Where | State |
|---|---|---|
| Mac app 0.2.0 | `Sources/` (Swift), `UI/` (WKWebView), `build.sh` | SQLite ledger, append-only; 72-check self-test (`./build.sh --test`, outside Claude's sandbox) |
| Web app | `web/` (Next.js 15, @supabase/ssr, Dexie offline queue, ZXing camera) | built, tested locally, **never deployed** |
| Database | `supabase/migrations/0001-0009`, `supabase/master.sql`, `supabase/security_check.sql` | schema 9 |
| Plans | `docs/WEB_PLAN.md` (why it is built this way), `docs/GO_LIVE.md` (the deploy checklist) | |

## History (main on GitHub `cgomez1365/htm-kitchen`)
- `e809701` 10-29 Mac app 0.2.0.
- `fa7c749` 10-30 web pilot: schema, records never disappear, stock trigger, RLS, the doors, Scan + Items, offline queue.
- `7eeeb89` 10-30 Admin: People (PIN made for you), Tablets (QR pairing), Locations, Categories. Migration 0007.
- `01d8461` 10-31 go-live prep: migration 0008 (pgcrypto fix), `db:apply`, `docs/GO_LIVE.md`.
- `5e28836` 10-31 `master.sql`, migration 0009 (input sanitation), `security_check.sql`.
- 11-01 violet tint (frame + button hover) and this file.

## How the database protects itself (keep it this way)
- **Writes only through doors**: RLS on every table with SELECT-only policies; every write is a SECURITY DEFINER function.
  EXECUTE is revoked from public and anon; anon can run only `hk_schema_version()`.
- **Records never disappear**: every table has a `refuse_record_deletion` trigger; corrections are new rows.
- **PINs**: bcrypt, unreadable tables; 5 wrong = 15-minute lock (`pin_fail_count`), a Director can unlock.
- **Tablets** see only their own locations. Pairing: 8 chars (no I/O/0/1), 15 min, one use, stored as sha256; the QR opens
  `/login#pair=CODE` (the fragment never reaches a server); only the service role may run `redeem_pairing`.
- **Sanitation (0009)**: `hk_clean_line` / `hk_clean_note` check constraints refuse control characters, bidi overrides,
  zero-width marks and over-length text; barcodes are printable ASCII 3-64.
- **`security_check.sql`**: 10 read-only rules; runs last inside `master.sql`, so a failing rule rolls the install back.
- **Every new function**: `set search_path = public, extensions` (Supabase keeps pgcrypto in `extensions`; `public` alone
  broke set_pin / sign-in / pairing until 0008, and a test now forbids it).
- **Migrations are forward-only**, each ends in a proof `select` and bumps `hk_schema_version()`. After any migration change:
  `npm run sql:master` (and `test:sql` checks it is current).

## Commands (from `web/`)
- `npm run test` = typecheck + `test:sql` (145 checks on PGlite with Supabase's layout). `npm run verify` adds the build.
- `npm run dev:preview` → :3217, no database, preview PIN 1357.
- Local test server (no Supabase needed): `npm run local:db` (:54321) + `npm run dev:local` (:3218); codes at `/local`,
  tablet password `kitchen`. Data in `web/.local-db` (never committed).
- `npm run db:apply [-- --dry | --pglite=DIR]`: applies migrations to `SUPABASE_DB_URL`, backs up first (JSON + sha256,
  outside the repo), refuses foreign or newer databases.
- `npm run sql:master [-- --check]`: regenerates `supabase/master.sql`.
- npm inside Claude's sandbox: `npm_config_cache=$TMPDIR/npm-cache`. git and gh: run outside the sandbox.

## Open (CEO's calls unless marked)
1. **Supabase project in Hope IT's account** (not FQC's project; the CEO's personal account is at its free limit).
2. **Move the repo to Hope-IT-Team and make it private**, so IT's Vercel can import it. **It is PUBLIC** (for testing at
   work since 10-29): set it private when testing ends either way.
3. **Vercel plan**: Hobby is non-commercial; daily kitchen use likely needs Pro.
4. **`shortfallDecision`** in `Sources/Store.swift` (the one `TODO(human)`, the CEO writes it): what happens when a scan
   takes out more than is on hand. Until then it refuses. Web mirror: `shortfall_decision()`.
5. Then `docs/GO_LIVE.md`: Supabase settings → paste `master.sql` → Vercel (Root Directory `web`, 3 env vars) → first
   Director → iPad smoke test.
6. **Violet to build**: nightly backup job (FQC-style dated dump + restore rehearsal) before the kitchen relies on the
   data; a restore tool; web CSV export (neutralise cells starting `= + - @`).

## Never verified
Real Supabase or Vercel · Supabase accepting `@tablets.hope-kitchen.invalid` (fallback `HK_TABLET_EMAIL_DOMAIN`) · a real
iPad camera · a migration failing halfway inside `db:apply`.

## Rules
- Never commit secrets: `.env.local`, `.local-db`, dumps stay out. Secret-scan every diff before a push.
- Commit and push only when the CEO asks. Fast-forward, never squash.
- Never permanently delete for the CEO (he empties the Trash). Records never disappear, in the app and in the repo.
- Hope Kitchen tables never go into FQC's Supabase project.
- Verify in the browser (local server or preview) before calling a UI change done; show proof.
- Tailwind cannot see class names built at runtime (`bg-${tone}`): use literal maps.
