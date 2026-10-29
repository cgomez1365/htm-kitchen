# Hope Kitchen 0.2.0

A Mac app for running a kitchen, or a company with thousands of products, that has no digital inventory today.
- **Labels:** every product gets a SKU and a printed label (QR + Code 128).
- **Scanning:** a label, a maker's barcode, or a case barcode moves stock **in**, **out**, **back**, or **between locations**.
- **Counts:** cycle counts post the difference between the shelf and the system.
- **Records:** every movement is a permanent row with a name, a place, and a time.
- **Reports:** pull records, losses and the rest read straight from that ledger.

Built on the MacSense pattern: native Swift + a WKWebView interface, no HTTP server, no network.
Successor to the earlier Hope kitchen web portals (2026-05-08).

## Build, test, run

```bash
./build.sh --test                      # builds build/Hope Kitchen.app, then runs the self-test
open "build/Hope Kitchen.app"
```

- `--selftest` runs 72 checks in throwaway folders. They cover:
  - roles, the ledger, packs, transfers, counts, all 10 reports, import (preview, create, update), bulk edit, export, and backup;
  - an upgrade from a real 0.1.0 database;
  - printing a QR and a Code 128 label and reading them back with the camera's decoder (Vision).
- `--perftest N` builds N items with 20 movements each and times what people wait on (measured 2026-10-29 on this iMac):

| | 5,000 items / 100k ledger rows | 20,000 items / 400k ledger rows |
|---|---|---|
| Item search, one page | 2–16 ms | 4–65 ms |
| Barcode lookup | 0 ms | 1 ms |
| Dashboard | 90 ms | 364 ms |
| Usage report | 93 ms | 385 ms |
| Pull records, **all time** | 518 ms | 2.1 s (300k rows; the screen defaults to 30 days) |
| Start a count of every item | 24 ms | 90 ms |
| Recheck all stock against the ledger | 81 ms, 0 mismatches | 324 ms, 0 mismatches |

- `HOPE_KITCHEN_DATA=/some/folder` points the app at a test database.
- `--snapshot out.png --eval "<js>" [--appearance light|dark]` renders the real window to a PNG and quits. This is how an agent checks the UI. The self-test, load test and snapshots need to run outside the Bash sandbox, because Vision needs `~/Library/Caches` and the snapshots need the window server.
- The bundle is ad-hoc signed. Before handing it to Hope, sign it with a Developer ID and notarize it (not done).

## What it does

| Area | What it does |
|---|---|
| **Items & stock** | Search, sorting, filters and pages all run in the database. You see stock *here* and across all locations. Select items for bulk edits: category, min, par, price, supplier, spot, unit, deactivate, queue labels. |
| **SKUs & barcodes** | Category prefixes are managed in Settings (`PRO-0042`). An item can have any number of barcodes: our shelf label (`HK1:<SKU>`), the maker's UPC/EAN, and **case barcodes with a pack size** (one scan of a case of 40 = 40). A barcode can be retired but never deleted. |
| **Locations** | Each storage area, kitchen, site or van has its own stock. **Move** mode scans stock from one location to another as two linked rows. Undoing a move reverses both rows. |
| **Scan station** | IN, OUT (with a reason), RETURN, MOVE, COUNT. A camera, a USB/Bluetooth scanner, or a typed search all work. An unknown barcode can become a new item, or be attached to an existing one. |
| **Counts** | Choose a location and optionally one category. The count is blind by default. Scanning adds 1; typing sets the number. Posting records each difference as a count movement. Uncounted lines are either skipped or set to zero; you choose. |
| **Requests** | The kitchen asks, inventory fulfils from the current location (by scanning or by hand), and the kitchen confirms receipt. |
| **Losses** | Anyone reports a loss; a Director approves or denies it. Only approved losses take stock away, from the location where they were reported. |
| **Reports** | Pull records, loss report, receiving, usage by item, activity by person, stock valuation, reorder list by supplier, count variance, corrections & undos, item stock card (running balance). Each one filters by date range, location, category, person or reason, shows totals and a chart, prints, and exports **all** rows to CSV. |
| **Settings & data** | Locations, categories, CSV import (preview first; can update existing SKUs without touching stock), full export (12 CSVs), backup, and a stock check against the ledger. |

**Data:** `~/Library/Application Support/HopeKitchen/kitchen.sqlite`. A daily copy goes to `backups/`. Those copies sit on the
same disk as the database, so copy them somewhere else every week.

**Rules the database enforces (triggers, not just the interface):**
- On hand = the sum of the movement ledger. `stock_levels` is kept current by a trigger on every insert, and **Check stock totals** recomputes it from the ledger.
- Movements and the audit trail can't be edited or deleted. An undo is a new, opposite row that names the original.
- Nothing is ever deleted (FQC R-13): people, items, barcodes, locations, requests, losses and counts are deactivated, retired or cancelled instead.
- Roles are checked in Swift on every call (see People → "What each role can do").
- PINs are salted and hashed. Five wrong PINs lock that person out for 60 s. The app signs out after 15 min with no activity.
- **Open decision:** `shortfallDecision` in `Sources/Store.swift`, the rule for taking out more than is on hand. Every OUT, MOVE and request fulfilment runs through it. It is a placeholder that always refuses until the CEO writes the rule.

## Files

| Piece | File |
|---|---|
| Schema v1 and its upgrade to v2 (locations, categories, codes, stock table, counts) | `Sources/Store.swift`, `Sources/Schema.swift` |
| Items, codes, movements, transfers, requests, losses, import, export | `Sources/Store.swift` |
| Cycle counts | `Sources/Counts.swift` |
| Reports | `Sources/Reports.swift` |
| QR / Code 128 generation and decoding | `Sources/Codes.swift` |
| Camera scanner window | `Sources/Scanner.swift` |
| Window, page ↔ Swift bridge, printing | `Sources/main.swift` |
| Self-test and load test | `Sources/Tests.swift` |
| Interface | `UI/index.html`, `UI/app.css`, `UI/app.js` |

## Old portal → new app

| Old page (2026-05-08) | Now |
|---|---|
| `index.html` | Overview |
| `Inv.html` (inventory, orders, losses, returns) | Items & stock · Scan station · Requests · Losses · Counts |
| `Chef.html` (orders, confirm receipt) | Requests · Scan station (Out) |
| `Director.html` (approvals, users, SKU presets, history) | Losses · People · Settings (categories) · Reports · Ledger |
| `migrator.html` (Sheets → Firestore) | Settings → Import items (CSV, preview first) |
| `Routing-portal.html`, `site-map.html` | **Partly:** sites and vans are locations now, and MOVE records stock going to them. Driver routes and signatures are not built. |
| `Signflow.html` | **Not ported:** a separate product, not inventory |
| `compliance-ee-portal.html`, `doc-upload.html`, `employee-profile.html` | **Not ported:** HR data belongs in FQC's Supabase with its RLS |

## Database decision

- **Now: SQLite on the Mac.** It has no account and no monthly cost, works offline, and handles 20k SKUs and 400k movements in well under a second for everyday screens (table above).
- **Start fresh rather than reuse the old portals' backend.**
- **Later, when phones or several buildings must share stock: Supabase.** It's the same vendor as FQC. The schema is built to move:
  - UUID ids;
  - an append-only ledger;
  - every row carries a person, a location and a time.

## Not built yet (next candidates)

- **Lot and expiry dates.** Needs stock per lot to be honest, so FEFO and expiry reports are a schema step (v3).
- **Purchase orders.** The reorder list exists; a PO could become an expected delivery that receiving checks against.
- **A phone or iPad scanner** sharing the same data. Needs the Supabase step.
- **Driver routes and signatures** (old Routing portal).
