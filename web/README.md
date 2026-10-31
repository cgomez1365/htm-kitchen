# Hope Kitchen web (pilot)

The web version of Hope Kitchen: Next.js 15 + Supabase on Vercel, built the way FQC is.
The plan and the reasons are in `../docs/WEB_PLAN.md`. The database is `../supabase/migrations/` (0001–0007).

## What the pilot does

- **Sign-in.** Managers (Director, Inventory Manager) sign in with an emailed 6-digit code. A kitchen tablet is signed in once with its own email and password; after that a person taps their name and enters **their own PIN** (bcrypt, five wrong tries locks that person out for 15 minutes).
- **Scan.** IN, OUT (with a reason), RETURN, MOVE (between locations) and COUNT, by the device camera (ZXing, works in iPad Safari), a USB or Bluetooth scanner, or typing. A case barcode counts its whole pack. Every scan shows stock here and in total, and can be undone for 10 minutes by the person who made it.
- **Offline.** Every scan is saved on the device first (IndexedDB), with an id made on the device, then sent. With no signal it waits and sends on its own; the database answers a second send of the same scan as a duplicate, so nothing counts twice. A refusal is a verdict and is shown word for word.
- **Admin** (CEO 2026-10-30: "frictionless"). People: add a person and their PIN in one save (the app makes a PIN that is not 1234 or 1111), unlock a locked-out PIN with one tap, switch someone off (off every tablet at once). Tablets: add one and pair it by pointing its camera at the QR on the Director's screen, or typing the 8-character code; no tablet password is ever typed or seen. Locations and categories: add, rename, close; a new category suggests its SKU prefix. Directors see all four; an Inventory Manager sees Locations and Categories.
- **Items.** Search, filters and pages run in the database (50 rows a page). Each item shows its stock per location, its barcodes, its recent movements, and its label (QR + Code 128, `HK1:<SKU>`, printed from the browser).

## Rules (the database holds them, not this code)

Every write goes through a `SECURITY DEFINER` door in 0005; `movements` has no INSERT policy. Nothing is ever deleted
or edited in the ledger (0002). Stock is the sum of the ledger, kept by a trigger (0003). Each location is visible only
to managers and the tablets tied to it (0004). The over-draw rule (`shortfall_decision`) refuses for now: it is the
same open decision as `shortfallDecision` in the Mac app.

## Working here

```bash
npm ci
npm run test:sql      # every migration on a real Postgres (PGlite), as a Director, an Inventory Manager, a tablet + PIN, another tablet, a stranger and anon
npm run typecheck
npm run build
npm run dev:preview   # every screen with invented data and no sign-in, on http://127.0.0.1:3217 (preview PIN 1357)
```

### Local test, no Supabase project (CEO, 2026-10-29)

```bash
npm run local:db      # the real database on this Mac: migrations on PGlite, saved in web/.local-db, served like Supabase on :54321
npm run dev:local     # in a second window: the app against it, on http://127.0.0.1:3218
```

- Tablet: tab "Kitchen tablet", `ipad@hk.local` / `kitchen` (Main kitchen, Walk-in cooler, Dry storage) or `walkin-ipad@hk.local` / `kitchen` (Walk-in only). People: James Carter 1357 (chef), Lee Park 2468 (staff), Ana Ruiz 1122 (inventory).
- Manager: `director@hk.local` or `inventory@hk.local`. Codes are not emailed; they appear at http://127.0.0.1:54321/local and in the server window.
- `node tools/local-server.mjs --reset` starts over with a fresh seeded kitchen. Stopping the server is the way to test "no signal": scans wait on the device and send themselves within 30 s of it coming back.
- It is a test stand-in, not Supabase: it checks no token signatures and listens on 127.0.0.1 only. The rules are the real ones (every call runs as the signed-in user, so RLS and the doors decide).

`.env.local` (never committed; this repo is public) holds `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` (server only: making sign-ins and pairing tablets) and `SUPABASE_DB_URL`. See `.env.example`.
On Vercel, set the service key as a server environment variable, never with a `NEXT_PUBLIC_` name.

## Not built yet

Applying the migrations to the live project (needs the Supabase project), counts, requests, losses, reports
beyond pull records, and catalogue caching for a tablet that has never seen an item while offline.
