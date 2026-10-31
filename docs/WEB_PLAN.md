# Hope Kitchen on the web — plan (2026-10-29)

Goal: the Mac app's inventory, on Supabase + Vercel, usable from any iPad, phone or computer, with one shared live
stock. Built the way FQC is built, because FQC already paid for most of the lessons.

## What we copy from FQC, and why

| FQC rule or habit | What it means here |
|---|---|
| **Stack:** Next.js 15 App Router · `@supabase/ssr` · Tailwind · Dexie · zod · `qrcode` | The same stack, so one person can work on both apps. |
| **R-05: Row Level Security is the boundary.** If a rule matters, it is in SQL. | Every stock rule moves into Postgres. **`movements` has no INSERT policy.** The only ways in are `SECURITY DEFINER` functions ("doors"), FQC's `record_guard_punch()` pattern: `record_move()`, `record_transfer()`, `record_count()`, `undo_move()`, `fulfil_request()`, `decide_loss()`, `post_count()`. A browser holding a session can't write a row the rules would refuse. |
| **R-13: records never disappear.** `refuse_record_deletion()` on every record table. | Already true in the Mac app. It becomes the same trigger function in Postgres, plus `audit_log` refusing UPDATE. |
| **R-12: who signs in.** Managers sign in with an emailed 6-digit code. Field staff never hold accounts. A site phone signs in once and asks "who is doing this?" | Director and Inventory Manager sign in with an emailed code. Each kitchen tablet is a **device account** (a password, signed in once). Chefs, staff and drivers tap their name and enter **their PIN** on the tablet. FQC only picks a name, but stock needs the PIN for accountability. PINs are bcrypt, with a throttle table no session can write (FQC 0033). |
| **A definer function that audits must answer a refusal as a row, never `raise`.** | `record_move()` returns `(id, duplicate, refused, reason, flag)`. A refused over-draw is still logged. |
| **Revoke every function `from public, anon`** and prove it with `has_function_privilege('anon', …)`. | Each migration's closing `select` proves its own doors are closed to `anon`. |
| **Views are `security_invoker`;** policies go through definer helpers (`my_role()`, `can_see_location()`). | Same. `stock` becomes a `security_invoker` view over `stock_levels`. |
| **PostgREST returns at most 1,000 rows.** Vercel functions cap at 4.5 MB / ~10 s. | Lists page with `.range()`. Reports are SQL functions that **aggregate in the database** and return one page. CSV exports are built in the browser from paged JSON, as FQC's export does. |
| **Dates are `America/Los_Angeles`.** | "Today", "this month" and report ranges use `facility_today()` / `FACILITY_TZ`, never UTC. |
| **Offline queue (Dexie).** A scan survives no signal, a force-quit, a dead battery. | Walk-in coolers and basements have no signal. Each scan gets a **client-made UUID** and waits in IndexedDB. `record_move()` is **idempotent on that id**, so a retry never counts twice. 503 means keep and retry; 400 means stop and show the reason. |
| **QR labels encode the origin they were printed from.** | Ours don't: they encode `HK1:<SKU>`, so a domain move never means reprinting. Keep it that way. |
| **Migrations:** forward-only and numbered, each ending in a proof `select` and a `schema_version()` bump. `npm run sql:apply` over a direct connection, **never the SQL Editor**. Back up before every apply. | Same tools, copied and renamed: `apply-sql`, `backup-db`, `restore-db`, `build-sql-parts`. |
| **Tests:** `test:sql` runs every migration on PGlite as real users trying to get around the rules. `test-rules.js` pins every shipped defect. Preview mode (`FQC_PREVIEW=1`) shows every screen with made-up data. | The Mac app's 72 self-test checks become `test:sql` cases, run as a chef, a tablet, an Inventory Manager and `anon`. |
| **Cost:** free tiers for the pilot; $45/month at go-live (Supabase Pro $25 + Vercel Pro $20). | The same numbers. One more Supabase project fits in the free tier (2 projects per organisation). |

## Data model (Mac v2 → Postgres)

The tables and their meanings carry over, with these changes:

- **ids:** uuid ids, `timestamptz` times, and `numeric(12,3)` quantities instead of REAL, so 0.1 + 0.2 never drifts in a total.
- **People:** `staff` (managers and tablet users; `auth.users` only for the code sign-in), `staff_pins` (hash only, no policies), `devices` (tablet accounts, each tied to locations).
- **Who can see which location:** `staff_locations`, replacing the Mac app's one global location list.
- **`stock_levels`:** kept by an `AFTER INSERT` trigger on `movements`. `verify_stock()` recomputes it from the ledger.
- **Undo:** `movements.reverses` with a unique index (one undo per movement).
- **Over-draw rule:** `shortfall_decision()` in SQL replaces `shortfallDecision` in Swift. **This is the decision still open in the Mac app.** It moves here, and whoever writes it writes it once, in SQL.

Roles: `director` > `inventory` > `chef` / `staff` / `driver`. The Mac app's permission table becomes `at_least()` / `has_perm()` in SQL, and a rule check compares it with the TypeScript copy (FQC's `LADDER` trap).

## Screens (phone and iPad first, same order as the Mac app)

| Screen | Who | Notes |
|---|---|---|
| Scan | tablet users, managers | Camera scanning in Safari needs a JS decoder (`@zxing/browser`), because Safari has no `BarcodeDetector`. USB and Bluetooth scanners type into the page as they do now. IN / OUT / RETURN / MOVE / COUNT. |
| Items & stock | everyone (edit: managers) | Paged search, the "here / all locations" columns, bulk edit, pack barcodes. |
| Counts | tablet users count; managers start and post | Blind by default; scan adds 1. |
| Requests · Losses | as in the Mac app | Approvals by Director only, in SQL. |
| Reports | managers | The 10 reports as SQL functions returning totals, a breakdown, and one page of rows. CSV built in the browser from all pages. |
| Labels | managers | `qrcode` for the QR; `bwip-js` or `JsBarcode` for Code 128. Printed from the browser. |
| Admin | Director | People, PINs, tablets, locations, categories, import (preview first), export everything, backups. |

## Order of work

1. **Repo and project.** Create the repo, copy FQC's tooling, a Supabase project and a Vercel project. Turn on preview mode.
2. **Migrations 0001–0006:** schema, refusal triggers, stock trigger, roles and helpers, doors, reports. Write `test:sql` cases for each as they're built.
3. **Scan + Items + offline queue.** This is the pilot: one kitchen, one iPad.
4. Counts, Requests, Losses.
5. Reports, Labels, Admin, import from the Mac app (read its SQLite file, or its CSV export).
6. Go live: Pro tiers, nightly backup job, reprint nothing (labels are origin-free).

The pilot (steps 1–3) is the first milestone you can put in front of a kitchen.

## The Mac app after this

It stays as an **offline station and a reference**, not a second source of truth. When the web version is live, the Mac
app's data is imported once (`movements` with their original ids and times, people without PINs), and the Mac app is
retired or kept read-only. Running both against separate databases would mean two stock counts again.

## Decisions (owner, 2026-10-29)

1. **Repo:** inside `htm-kitchen`, as `web/` (Next.js; Vercel's root directory) and `supabase/` (migrations) beside the Mac app.
   The repo is **public** for now, so nothing secret is ever committed. `.env.local` stays on the machine, and the
   service-role key and database URL live only there and in Vercel.
2. **Supabase:** a **new project of its own**, separate from FQC. Staff are entered once more, or imported.
3. **Tablet sign-in:** **name + the person's own PIN**. PINs are bcrypt in a table with no policies, and wrong guesses
   are throttled in a table no session can write.
4. Still open: the over-draw rule (`shortfall_decision`).
