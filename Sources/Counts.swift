import Foundation

/// Cycle counts: freeze a list of what the system expects at one location, count the shelves (by scan or by hand),
/// then post the differences as count movements. Anyone who can scan may count; posting needs an Inventory Manager.
extension Store {
    func countsList() throws -> Any {
        try db.query("""
            SELECT c.*, l.name AS location_name, p.name AS started_by_name, s.name AS submitted_by_name,
              (SELECT COUNT(*) FROM count_lines cl WHERE cl.count_id = c.id) AS lines,
              (SELECT COUNT(*) FROM count_lines cl WHERE cl.count_id = c.id AND cl.counted IS NOT NULL) AS counted,
              (SELECT COUNT(*) FROM count_lines cl WHERE cl.count_id = c.id AND cl.applied IS NOT NULL AND cl.applied <> 0) AS changed
            FROM counts c JOIN locations l ON l.id = c.location_id JOIN people p ON p.id = c.started_by
            LEFT JOIN people s ON s.id = c.submitted_by ORDER BY c.started_at DESC LIMIT 100
            """)
    }

    func countStart(_ a: [String: Any]) throws -> Any {
        let me = try require(.adjust)
        let loc = try location(a)
        let category = str(a, "category")
        if try db.one("SELECT id FROM counts WHERE status = 'open' AND location_id = ? AND COALESCE(category, '') = ?", [loc, category ?? ""]) != nil {
            throw AppError("A count for this location\(category.map { " and \($0)" } ?? "") is already open. Finish or cancel it first.")
        }
        return try db.transaction {
            let n = ((try db.scalar("SELECT COUNT(*) FROM counts") as? Int) ?? 0) + 1
            let id = uuid(), number = String(format: "CNT-%05d", n)
            try db.run("INSERT INTO counts(id, number, location_id, category, status, note, started_by, started_at) VALUES (?,?,?,?,?,?,?,?)",
                       [id, number, loc, category, "open", str(a, "note"), me.id, nowISO()])
            // Every active item in scope, plus anything with stock recorded here even if it has since been deactivated.
            var sql = """
                INSERT INTO count_lines(id, count_id, item_id, expected)
                SELECT lower(hex(randomblob(16))), ?, i.id, COALESCE(sl.on_hand, 0) FROM items i
                LEFT JOIN stock_levels sl ON sl.item_id = i.id AND sl.location_id = ?
                WHERE (i.active = 1 OR COALESCE(sl.on_hand, 0) <> 0)
                """
            var args: [Any?] = [id, loc]
            if let category { sql += " AND i.category = ?"; args.append(category) }
            if (a["onlyStocked"] as? Bool) == true { sql += " AND COALESCE(sl.on_hand, 0) <> 0" }
            let lines = try db.run(sql, args)
            guard lines > 0 else { throw AppError("Nothing to count there yet.") }
            try audit("count_started", "counts", id, ["number": number, "lines": lines])
            return ["id": id, "number": number, "lines": lines]
        }
    }

    func countGet(_ id: String) throws -> Any {
        guard var c = try db.one("""
            SELECT c.*, l.name AS location_name, p.name AS started_by_name FROM counts c
            JOIN locations l ON l.id = c.location_id JOIN people p ON p.id = c.started_by WHERE c.id = ?
            """, [id]) else { throw AppError("Count not found.") }
        c["lines"] = try db.query("""
            SELECT cl.*, i.sku, i.name, i.unit, i.price, i.category, i.location AS spot, p.name AS counted_by_name,
              COALESCE(sl.on_hand, 0) AS now_on_hand
            FROM count_lines cl JOIN items i ON i.id = cl.item_id LEFT JOIN people p ON p.id = cl.counted_by
            LEFT JOIN stock_levels sl ON sl.item_id = cl.item_id AND sl.location_id = ?
            WHERE cl.count_id = ? ORDER BY COALESCE(i.location, 'zzz'), i.category, i.name
            """, [c["location_id"] as? String ?? "", id])
        return c
    }

    /// counted sets the number; add adds to it (one scan = one more on the shelf). An item not on the sheet is added.
    func countSet(_ a: [String: Any]) throws -> Any {
        let me = try require(.issue)
        let id = try need(a, "id", "Count"), itemId = try need(a, "itemId", "Item")
        guard let c = try db.one("SELECT * FROM counts WHERE id = ?", [id]) else { throw AppError("Count not found.") }
        guard (c["status"] as? String) == "open" else { throw AppError("This count is closed.") }
        let loc = c["location_id"] as? String ?? defaultLocation
        if try db.one("SELECT id FROM count_lines WHERE count_id = ? AND item_id = ?", [id, itemId]) == nil {
            try db.run("INSERT INTO count_lines(id, count_id, item_id, expected) VALUES (?,?,?,?)", [uuid(), id, itemId, try onHand(itemId, at: loc)])
        }
        if let add = num(a, "add") {
            try db.run("UPDATE count_lines SET counted = MAX(COALESCE(counted, 0) + ?, 0), counted_by = ?, counted_at = ? WHERE count_id = ? AND item_id = ?",
                       [add, me.id, nowISO(), id, itemId])
        } else if a["counted"] is NSNull || str(a, "counted") == nil {
            try db.run("UPDATE count_lines SET counted = NULL, counted_by = NULL, counted_at = NULL WHERE count_id = ? AND item_id = ?", [id, itemId])
        } else {
            guard let v = num(a, "counted"), v >= 0 else { throw AppError("A count is 0 or more.") }
            try db.run("UPDATE count_lines SET counted = ?, counted_by = ?, counted_at = ? WHERE count_id = ? AND item_id = ?",
                       [v, me.id, nowISO(), id, itemId])
        }
        return try db.one("""
            SELECT cl.*, i.sku, i.name, i.unit FROM count_lines cl JOIN items i ON i.id = cl.item_id WHERE cl.count_id = ? AND cl.item_id = ?
            """, [id, itemId]) ?? [:]
    }

    /// Posts each counted line against stock as it stands now (scans during the count are respected).
    func countSubmit(_ a: [String: Any]) throws -> Any {
        let me = try require(.adjust)
        let id = try need(a, "id", "Count")
        let zeroUncounted = (a["zeroUncounted"] as? Bool) ?? false
        guard let c = try db.one("SELECT * FROM counts WHERE id = ?", [id]) else { throw AppError("Count not found.") }
        guard (c["status"] as? String) == "open" else { throw AppError("This count is already closed.") }
        let loc = c["location_id"] as? String ?? defaultLocation, number = c["number"] as? String ?? ""
        return try db.transaction {
            var changed = 0, value = 0.0, posted = 0
            for l in try db.query("SELECT cl.*, i.price FROM count_lines cl JOIN items i ON i.id = cl.item_id WHERE cl.count_id = ?", [id]) {
                let counted: Double
                if l["counted"] is NSNull { guard zeroUncounted else { continue }; counted = 0 } else { counted = dbl(l["counted"]) }
                let itemId = l["item_id"] as? String ?? ""
                let delta = counted - (try onHand(itemId, at: loc))
                if delta != 0 {
                    try insertMovement(item: itemId, location: loc, qty: delta, kind: "count", reason: "Cycle count", note: nil,
                                       ref: number, person: me.id, flag: nil)
                    changed += 1
                    value += delta * dbl(l["price"])
                }
                try db.run("UPDATE count_lines SET applied = ?, counted = COALESCE(counted, ?) WHERE id = ?", [delta, counted, l["id"]])
                posted += 1
            }
            try db.run("UPDATE counts SET status = 'submitted', submitted_by = ?, submitted_at = ? WHERE id = ?", [me.id, nowISO(), id])
            try audit("count_submitted", "counts", id, ["number": number, "posted": posted, "changed": changed, "value": value])
            return ["posted": posted, "changed": changed, "value": value, "number": number]
        }
    }

    func countCancel(_ a: [String: Any]) throws -> Any {
        try require(.adjust)
        let id = try need(a, "id", "Count")
        guard try db.run("UPDATE counts SET status = 'cancelled' WHERE id = ? AND status = 'open'", [id]) == 1 else {
            throw AppError("Only an open count can be cancelled.")
        }
        try audit("count_cancelled", "counts", id)
        return ["status": "cancelled"]
    }
}
