import Foundation

/// Schema versions. A fresh database is created at v1 and migrated forward, so the upgrade path is the one every install runs.
extension Store {
    static var migrationTarget = 2   // the self-test lowers this to build a v1 database, then upgrades it

    func schemaVersion() -> Int { Int((try? db.scalar("SELECT value FROM meta WHERE key = 'schema'")) as? String ?? "1") ?? 1 }

    func migrateForward() throws {
        if schemaVersion() < 2 && Store.migrationTarget >= 2 { try migrateV2() }
    }

    /// v2: stock per location, managed categories, many codes per item (packs), a maintained stock table, cycle counts.
    private func migrateV2() throws {
        try db.exec("PRAGMA foreign_keys = OFF")
        defer { try? db.exec("PRAGMA foreign_keys = ON") }
        try db.transaction {
            try db.exec("""
            CREATE TABLE locations(
              id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
              kind TEXT NOT NULL DEFAULT 'storage' CHECK(kind IN ('storage','kitchen','site','vehicle')),
              active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
            CREATE TABLE categories(
              name TEXT PRIMARY KEY COLLATE NOCASE, prefix TEXT NOT NULL UNIQUE CHECK(length(prefix) BETWEEN 2 AND 5),
              active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
            CREATE TABLE item_codes(
              code TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), pack_qty REAL NOT NULL DEFAULT 1 CHECK(pack_qty > 0),
              label TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, created_by TEXT);
            CREATE INDEX item_codes_item ON item_codes(item_id);
            CREATE TABLE stock_levels(
              item_id TEXT NOT NULL, location_id TEXT NOT NULL, on_hand REAL NOT NULL DEFAULT 0, last_at TEXT,
              PRIMARY KEY(item_id, location_id)) WITHOUT ROWID;
            CREATE TABLE counts(
              id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, location_id TEXT NOT NULL REFERENCES locations(id), category TEXT,
              status TEXT NOT NULL CHECK(status IN ('open','submitted','cancelled')), note TEXT,
              started_by TEXT NOT NULL REFERENCES people(id), started_at TEXT NOT NULL, submitted_by TEXT, submitted_at TEXT);
            CREATE TABLE count_lines(
              id TEXT PRIMARY KEY, count_id TEXT NOT NULL REFERENCES counts(id), item_id TEXT NOT NULL REFERENCES items(id),
              expected REAL NOT NULL, counted REAL, counted_by TEXT, counted_at TEXT, applied REAL,
              UNIQUE(count_id, item_id));
            ALTER TABLE losses ADD COLUMN location_id TEXT;
            ALTER TABLE requests ADD COLUMN location_id TEXT;
            ALTER TABLE items ADD COLUMN updated_at TEXT;
            CREATE INDEX IF NOT EXISTS items_category ON items(category, name);
            CREATE INDEX IF NOT EXISTS items_name ON items(name);
            """)
            try db.run("INSERT INTO locations(id, name, kind, created_at) VALUES ('main', 'Main kitchen', 'kitchen', ?)", [nowISO()])
            for (name, prefix) in categoryPrefixes {
                try db.run("INSERT INTO categories(name, prefix, created_at) VALUES (?,?,?)", [name, prefix, nowISO()])
            }
            // Categories typed into v1 items that aren't in the default list keep working.
            for row in try db.query("SELECT DISTINCT category FROM items WHERE category NOT IN (SELECT name FROM categories)") {
                let name = row["category"] as? String ?? "Other"
                let base = String(name.uppercased().filter(\.isLetter).prefix(3)).padding(toLength: 3, withPad: "X", startingAt: 0)
                try db.run("INSERT OR IGNORE INTO categories(name, prefix, created_at) VALUES (?,?,?)", [name, base, nowISO()])
            }
            try db.run("""
                INSERT INTO item_codes(code, item_id, pack_qty, label, created_at)
                SELECT barcode, id, 1, 'Maker barcode', created_at FROM items WHERE barcode IS NOT NULL AND barcode <> ''
                """)

            // Movements gain a location and the 'transfer' kind. SQLite can't change a CHECK, so the table is rebuilt.
            try db.exec("""
            DROP VIEW IF EXISTS stock;
            CREATE TABLE movements_v2(
              id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), location_id TEXT NOT NULL REFERENCES locations(id),
              qty REAL NOT NULL,
              kind TEXT NOT NULL CHECK(kind IN ('receive','issue','return','loss','adjust','count','undo','transfer')),
              reason TEXT, note TEXT, ref TEXT, reverses TEXT REFERENCES movements(id),
              person_id TEXT NOT NULL REFERENCES people(id), flag TEXT, created_at TEXT NOT NULL);
            INSERT INTO movements_v2(id, item_id, location_id, qty, kind, reason, note, ref, reverses, person_id, flag, created_at)
              SELECT id, item_id, 'main', qty, kind, reason, note, ref, reverses, person_id, flag, created_at FROM movements;
            DROP TABLE movements;
            ALTER TABLE movements_v2 RENAME TO movements;
            CREATE INDEX movements_item ON movements(item_id, created_at);
            CREATE INDEX movements_time ON movements(created_at);
            CREATE INDEX movements_kind_time ON movements(kind, created_at);
            CREATE INDEX movements_person_time ON movements(person_id, created_at);
            CREATE INDEX movements_location ON movements(location_id, item_id);
            CREATE UNIQUE INDEX movements_one_undo ON movements(reverses) WHERE reverses IS NOT NULL;
            UPDATE losses SET location_id = 'main' WHERE location_id IS NULL;
            UPDATE requests SET location_id = 'main' WHERE location_id IS NULL;
            INSERT INTO stock_levels(item_id, location_id, on_hand, last_at)
              SELECT item_id, location_id, TOTAL(qty), MAX(created_at) FROM movements GROUP BY item_id, location_id;
            CREATE TRIGGER movements_no_update BEFORE UPDATE ON movements
              BEGIN SELECT RAISE(ABORT, 'This record is permanent. Record a correction instead.'); END;
            CREATE TRIGGER movements_no_delete BEFORE DELETE ON movements
              BEGIN SELECT RAISE(ABORT, 'Records are never deleted. Deactivate or cancel instead.'); END;
            CREATE TRIGGER movements_keep_stock AFTER INSERT ON movements BEGIN
              INSERT INTO stock_levels(item_id, location_id, on_hand, last_at) VALUES (NEW.item_id, NEW.location_id, NEW.qty, NEW.created_at)
              ON CONFLICT(item_id, location_id) DO UPDATE SET on_hand = on_hand + excluded.on_hand, last_at = excluded.last_at;
            END;
            CREATE TRIGGER stock_levels_no_delete BEFORE DELETE ON stock_levels
              BEGIN SELECT RAISE(ABORT, 'Stock comes only from movements.'); END;
            CREATE TRIGGER counts_no_delete BEFORE DELETE ON counts
              BEGIN SELECT RAISE(ABORT, 'Records are never deleted. Deactivate or cancel instead.'); END;
            CREATE TRIGGER count_lines_no_delete BEFORE DELETE ON count_lines
              BEGIN SELECT RAISE(ABORT, 'Records are never deleted. Deactivate or cancel instead.'); END;
            CREATE TRIGGER item_codes_no_delete BEFORE DELETE ON item_codes
              BEGIN SELECT RAISE(ABORT, 'Records are never deleted. Deactivate or cancel instead.'); END;
            CREATE TRIGGER locations_no_delete BEFORE DELETE ON locations
              BEGIN SELECT RAISE(ABORT, 'Records are never deleted. Deactivate or cancel instead.'); END;
            CREATE VIEW stock AS
              SELECT i.*,
                COALESCE((SELECT TOTAL(s.on_hand) FROM stock_levels s WHERE s.item_id = i.id), 0) AS on_hand,
                (SELECT MAX(s.last_at) FROM stock_levels s WHERE s.item_id = i.id) AS last_moved,
                (SELECT group_concat(c.code, ' ') FROM item_codes c WHERE c.item_id = i.id AND c.active = 1) AS codes
              FROM items i;
            UPDATE meta SET value = '2' WHERE key = 'schema';
            INSERT OR IGNORE INTO meta(key, value) VALUES ('defaultLocation', 'main');
            """)
            let bad = try db.query("PRAGMA foreign_key_check")
            if !bad.isEmpty { throw AppError("The upgrade found \(bad.count) broken links and stopped. Nothing was changed.") }
        }
    }

    /// Recomputes every stock level from the ledger and lists any place the maintained table disagrees.
    func verifyStock() throws -> [[String: Any]] {
        try db.query("""
            WITH truth AS (SELECT item_id, location_id, TOTAL(qty) AS q FROM movements GROUP BY item_id, location_id)
            SELECT i.sku, i.name, l.name AS location, t.q AS ledger, COALESCE(s.on_hand, 0) AS cached
            FROM truth t JOIN items i ON i.id = t.item_id JOIN locations l ON l.id = t.location_id
            LEFT JOIN stock_levels s ON s.item_id = t.item_id AND s.location_id = t.location_id
            WHERE ABS(t.q - COALESCE(s.on_hand, 0)) > 1e-9
            """)
    }
}
