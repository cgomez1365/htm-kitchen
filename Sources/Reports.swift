import Foundation

/// Reports read the ledger; none of them write. Each returns its columns, the rows, totals, and a breakdown for the bar.
struct ReportCol { let key: String, label: String, type: String }   // type: date text code qty money num

struct ReportResult {
    var title: String
    var columns: [ReportCol]
    var rows: [[String: Any]]
    var totals: [(String, Any)]
    var breakdown: [(String, Double)]
    var note: String?
}

extension Store {
    static let reportKinds: [(String, String)] = [
        ("pulls", "Pull records"), ("losses", "Loss report"), ("receiving", "Receiving"), ("usage", "Usage by item"),
        ("people", "Activity by person"), ("valuation", "Stock valuation"), ("reorder", "Reorder list"),
        ("variance", "Count variance"), ("corrections", "Corrections & undos"), ("stockcard", "Item stock card"),
    ]

    /// Movements whose 'undo' rows are folded back into the kind they reversed, so totals net out.
    private var effectiveKind: String { "(CASE WHEN m.kind = 'undo' THEN o.kind ELSE m.kind END)" }

    private func filters(_ a: [String: Any], time: String, item: String = "i", location: String? = "m.location_id",
                         person: String? = "m.person_id") -> (String, [Any?]) {
        var c: [String] = [], args: [Any?] = []
        if let from = str(a, "from") { c.append("\(time) >= ?"); args.append(from) }
        if let to = str(a, "to") { c.append("\(time) < ?"); args.append(to) }
        if let l = str(a, "locationId"), let location { c.append("\(location) = ?"); args.append(l) }
        if let cat = str(a, "category") { c.append("\(item).category = ?"); args.append(cat) }
        if let p = str(a, "personId"), let person { c.append("\(person) = ?"); args.append(p) }
        if let q = str(a, "q") { c.append("(\(item).name LIKE ? OR \(item).sku LIKE ?)"); args += ["%\(q)%", "%\(q)%"] }
        return (c.isEmpty ? "" : " AND " + c.joined(separator: " AND "), args)
    }

    func buildReport(_ a: [String: Any]) throws -> ReportResult {
        let kind = try need(a, "kind", "Report")
        func col(_ k: String, _ l: String, _ t: String = "text") -> ReportCol { ReportCol(key: k, label: l, type: t) }
        func sum(_ rows: [[String: Any]], _ k: String) -> Double { rows.reduce(0) { $0 + dbl($1[k]) } }
        func group(_ rows: [[String: Any]], by k: String, value v: String) -> [(String, Double)] {
            var g: [String: Double] = [:]
            for r in rows {
                let label = (r[k] == nil || r[k] is NSNull) ? "—" : "\(r[k]!)"
                g[label, default: 0] += dbl(r[v])
            }
            return g.sorted { abs($0.value) > abs($1.value) }.prefix(10).map { ($0.key, $0.value) }
        }

        switch kind {
        case "pulls":
            let (w, args) = filters(a, time: "m.created_at")
            var sql = """
                SELECT m.created_at, i.sku, i.name, i.category, -m.qty AS qty, i.unit, ROUND(-m.qty * i.price, 2) AS cost,
                  m.reason, m.ref, p.name AS person, l.name AS location, m.flag
                FROM movements m JOIN items i ON i.id = m.item_id JOIN people p ON p.id = m.person_id JOIN locations l ON l.id = m.location_id
                WHERE m.kind = 'issue' AND NOT EXISTS (SELECT 1 FROM movements u WHERE u.reverses = m.id)\(w)
                """
            var args2 = args
            if let r = str(a, "reason") { sql += " AND m.reason = ?"; args2.append(r) }
            let rows = try db.query(sql + " ORDER BY m.created_at DESC", args2)
            return ReportResult(title: "Pull records",
                columns: [col("created_at", "When", "date"), col("sku", "SKU", "code"), col("name", "Item"), col("qty", "Qty", "qty"), col("unit", "Unit"),
                          col("cost", "Cost", "money"), col("reason", "Reason"), col("ref", "Ref", "code"), col("person", "Pulled by"), col("location", "From"), col("flag", "Flag")],
                rows: rows,
                totals: [("Pulls", rows.count), ("Cost", sum(rows, "cost")), ("Items", Set(rows.compactMap { $0["sku"] as? String }).count),
                         ("People", Set(rows.compactMap { $0["person"] as? String }).count)],
                breakdown: group(rows, by: str(a, "groupBy") ?? "reason", value: "cost"),
                note: "Undone pulls are left out. Every pull is a ledger row with a name and a time.")

        case "losses":
            let (w, args) = filters(a, time: "l.created_at", location: "l.location_id", person: "l.reported_by")
            var sql = """
                SELECT l.created_at, i.sku, i.name, i.category, l.qty, i.unit, ROUND(l.qty * i.price, 2) AS cost, l.reason, l.note,
                  l.status, p.name AS reported_by, d.name AS decided_by, l.decided_at, loc.name AS location
                FROM losses l JOIN items i ON i.id = l.item_id JOIN people p ON p.id = l.reported_by
                LEFT JOIN people d ON d.id = l.decided_by LEFT JOIN locations loc ON loc.id = l.location_id WHERE 1=1\(w)
                """
            var args2 = args
            if let st = str(a, "status") { sql += " AND l.status = ?"; args2.append(st) }
            if let r = str(a, "reason") { sql += " AND l.reason = ?"; args2.append(r) }
            let rows = try db.query(sql + " ORDER BY l.created_at DESC", args2)
            let approved = rows.filter { ($0["status"] as? String) == "approved" }
            return ReportResult(title: "Loss report",
                columns: [col("created_at", "Reported", "date"), col("sku", "SKU", "code"), col("name", "Item"), col("qty", "Qty", "qty"), col("unit", "Unit"),
                          col("cost", "Cost", "money"), col("reason", "Reason"), col("note", "What happened"), col("status", "Status"),
                          col("reported_by", "Reported by"), col("decided_by", "Decided by"), col("location", "Location")],
                rows: rows,
                totals: [("Reports", rows.count), ("Approved cost", sum(approved, "cost")),
                         ("Pending cost", sum(rows.filter { ($0["status"] as? String) == "pending" }, "cost")),
                         ("Denied", rows.filter { ($0["status"] as? String) == "denied" }.count)],
                breakdown: group(approved, by: str(a, "groupBy") ?? "reason", value: "cost"),
                note: "Cost uses each item's current price. Only approved losses leave stock.")

        case "receiving":
            let (w, args) = filters(a, time: "m.created_at")
            let rows = try db.query("""
                SELECT m.created_at, i.sku, i.name, i.category, m.qty, i.unit, ROUND(m.qty * i.price, 2) AS cost, i.supplier,
                  m.ref, m.note, p.name AS person, l.name AS location
                FROM movements m JOIN items i ON i.id = m.item_id JOIN people p ON p.id = m.person_id JOIN locations l ON l.id = m.location_id
                WHERE m.kind = 'receive' AND NOT EXISTS (SELECT 1 FROM movements u WHERE u.reverses = m.id)\(w) ORDER BY m.created_at DESC
                """, args)
            return ReportResult(title: "Receiving",
                columns: [col("created_at", "When", "date"), col("sku", "SKU", "code"), col("name", "Item"), col("qty", "Qty", "qty"), col("unit", "Unit"),
                          col("cost", "Value", "money"), col("supplier", "Supplier"), col("ref", "PO / ref", "code"), col("person", "Received by"), col("location", "Into")],
                rows: rows, totals: [("Deliveries", rows.count), ("Value", sum(rows, "cost"))],
                breakdown: group(rows, by: "supplier", value: "cost"), note: nil)

        case "usage":
            let (w, args) = filters(a, time: "m.created_at")
            let ek = effectiveKind
            let rows = try db.query("""
                SELECT i.sku, i.name, i.category, i.unit,
                  TOTAL(CASE WHEN \(ek) = 'receive' THEN m.qty END) AS received,
                  -TOTAL(CASE WHEN \(ek) = 'issue' THEN m.qty END) AS pulled,
                  TOTAL(CASE WHEN \(ek) = 'return' THEN m.qty END) AS returned,
                  -TOTAL(CASE WHEN \(ek) = 'loss' THEN m.qty END) AS lost,
                  TOTAL(CASE WHEN \(ek) IN ('count','adjust') THEN m.qty END) AS corrected,
                  ROUND(-TOTAL(CASE WHEN \(ek) = 'issue' THEN m.qty END) * i.price, 2) AS pulled_cost,
                  ROUND(-TOTAL(CASE WHEN \(ek) = 'loss' THEN m.qty END) * i.price, 2) AS lost_cost
                FROM movements m JOIN items i ON i.id = m.item_id LEFT JOIN movements o ON o.id = m.reverses
                WHERE \(ek) <> 'transfer'\(w) GROUP BY i.id ORDER BY pulled_cost DESC, i.name
                """, args)
            return ReportResult(title: "Usage by item",
                columns: [col("sku", "SKU", "code"), col("name", "Item"), col("unit", "Unit"), col("received", "In", "qty"), col("pulled", "Pulled", "qty"),
                          col("returned", "Returned", "qty"), col("lost", "Lost", "qty"), col("corrected", "Count fixes", "qty"),
                          col("pulled_cost", "Pulled $", "money"), col("lost_cost", "Lost $", "money")],
                rows: rows, totals: [("Items moved", rows.count), ("Pulled $", sum(rows, "pulled_cost")), ("Lost $", sum(rows, "lost_cost"))],
                breakdown: group(rows, by: "category", value: "pulled_cost"),
                note: "Undos are netted against what they reversed. Transfers between locations are left out.")

        case "people":
            let (w, args) = filters(a, time: "m.created_at")
            let ek = effectiveKind
            let rows = try db.query("""
                SELECT p.name AS person, p.role,
                  COUNT(CASE WHEN m.kind = 'issue' THEN 1 END) AS pulls,
                  ROUND(-TOTAL(CASE WHEN \(ek) = 'issue' THEN m.qty * i.price END), 2) AS pulled_cost,
                  COUNT(CASE WHEN m.kind = 'receive' THEN 1 END) AS receipts,
                  COUNT(CASE WHEN m.kind IN ('count','adjust') THEN 1 END) AS corrections,
                  ROUND(TOTAL(CASE WHEN \(ek) IN ('count','adjust') THEN m.qty * i.price END), 2) AS correction_value,
                  COUNT(CASE WHEN m.kind = 'undo' THEN 1 END) AS undos,
                  COUNT(CASE WHEN m.flag IS NOT NULL THEN 1 END) AS flagged,
                  MAX(m.created_at) AS last_seen
                FROM movements m JOIN items i ON i.id = m.item_id JOIN people p ON p.id = m.person_id
                LEFT JOIN movements o ON o.id = m.reverses WHERE 1=1\(w) GROUP BY p.id ORDER BY pulled_cost DESC
                """, args)
            return ReportResult(title: "Activity by person",
                columns: [col("person", "Person"), col("role", "Role"), col("pulls", "Pulls", "num"), col("pulled_cost", "Pulled $", "money"),
                          col("receipts", "Receipts", "num"), col("corrections", "Count fixes", "num"), col("correction_value", "Fix value", "money"),
                          col("undos", "Undos", "num"), col("flagged", "Flagged", "num"), col("last_seen", "Last scan", "date")],
                rows: rows, totals: [("People", rows.count), ("Pulled $", sum(rows, "pulled_cost")), ("Flagged", Int(sum(rows, "flagged")))],
                breakdown: group(rows, by: "person", value: "pulled_cost"),
                note: "Many undos or flags from one person is worth a conversation, not a conclusion.")

        case "valuation":
            var w = "", args: [Any?] = []
            if let cat = str(a, "category") { w += " AND i.category = ?"; args.append(cat) }
            if let l = str(a, "locationId") { w += " AND s.location_id = ?"; args.append(l) }
            let rows = try db.query("""
                SELECT i.category, l.name AS location, COUNT(DISTINCT i.id) AS items,
                  ROUND(TOTAL(MAX(s.on_hand, 0) * i.price), 2) AS value,
                  COUNT(CASE WHEN s.on_hand < 0 THEN 1 END) AS negative
                FROM stock_levels s JOIN items i ON i.id = s.item_id JOIN locations l ON l.id = s.location_id
                WHERE i.active = 1 AND s.on_hand <> 0\(w) GROUP BY i.category, l.id ORDER BY value DESC
                """, args)
            return ReportResult(title: "Stock valuation (now)",
                columns: [col("category", "Category"), col("location", "Location"), col("items", "Items", "num"), col("value", "Value", "money"),
                          col("negative", "Below zero", "num")],
                rows: rows, totals: [("Value", sum(rows, "value")), ("Lines", rows.count)],
                breakdown: group(rows, by: str(a, "groupBy") == "location" ? "location" : "category", value: "value"),
                note: "Current on-hand × current price. Negative stock counts as 0 and is listed so it gets counted.")

        case "reorder":
            var w = "", args: [Any?] = []
            if let cat = str(a, "category") { w += " AND category = ?"; args.append(cat) }
            if let sup = str(a, "supplier") { w += " AND supplier = ?"; args.append(sup) }
            let rows = try db.query("""
                SELECT supplier, sku, name, category, unit, on_hand, min_level, par_level, order_qty, ROUND(order_qty * price, 2) AS est_cost FROM (
                  SELECT COALESCE(NULLIF(supplier, ''), '(no supplier)') AS supplier, sku, name, category, unit, on_hand, min_level, par_level, price,
                    MAX((CASE WHEN par_level > 0 THEN par_level ELSE min_level * 2 END) - on_hand, 0) AS order_qty
                  FROM stock WHERE active = 1 AND min_level > 0 AND on_hand <= min_level\(w))
                ORDER BY supplier, category, name
                """, args)
            return ReportResult(title: "Reorder list",
                columns: [col("supplier", "Supplier"), col("sku", "SKU", "code"), col("name", "Item"), col("on_hand", "On hand", "qty"),
                          col("min_level", "Min", "qty"), col("par_level", "Par", "qty"), col("order_qty", "Order", "qty"), col("unit", "Unit"),
                          col("est_cost", "Est. cost", "money")],
                rows: rows, totals: [("Items", rows.count), ("Est. cost", sum(rows, "est_cost")), ("Suppliers", Set(rows.compactMap { $0["supplier"] as? String }).count)],
                breakdown: group(rows, by: "supplier", value: "est_cost"),
                note: "Order brings each item back to par (or twice its minimum when no par is set).")

        case "variance":
            let (w, args) = filters(a, time: "c.submitted_at", location: "c.location_id", person: "cl.counted_by")
            let rows = try db.query("""
                SELECT c.number, c.submitted_at, loc.name AS location, i.sku, i.name, i.unit, cl.expected, cl.counted, cl.applied AS variance,
                  ROUND(cl.applied * i.price, 2) AS variance_cost, p.name AS counted_by
                FROM count_lines cl JOIN counts c ON c.id = cl.count_id JOIN items i ON i.id = cl.item_id
                JOIN locations loc ON loc.id = c.location_id LEFT JOIN people p ON p.id = cl.counted_by
                WHERE c.status = 'submitted' AND cl.applied IS NOT NULL AND cl.applied <> 0\(w) ORDER BY ABS(cl.applied * i.price) DESC
                """, args)
            return ReportResult(title: "Count variance",
                columns: [col("number", "Count", "code"), col("submitted_at", "Posted", "date"), col("location", "Location"), col("sku", "SKU", "code"),
                          col("name", "Item"), col("expected", "Expected", "qty"), col("counted", "Counted", "qty"), col("variance", "Difference", "qty"),
                          col("unit", "Unit"), col("variance_cost", "Value", "money"), col("counted_by", "Counted by")],
                rows: rows,
                totals: [("Lines off", rows.count), ("Net value", sum(rows, "variance_cost")),
                         ("Shrink", sum(rows.filter { dbl($0["variance_cost"]) < 0 }, "variance_cost"))],
                breakdown: group(rows, by: "location", value: "variance_cost"),
                note: "Expected is what the system showed when the count started; the posted difference uses stock at the moment of posting.")

        case "corrections":
            let (w, args) = filters(a, time: "m.created_at")
            let rows = try db.query("""
                SELECT m.created_at, m.kind, i.sku, i.name, m.qty, i.unit, ROUND(m.qty * i.price, 2) AS value, m.reason, m.note, m.ref,
                  p.name AS person, l.name AS location, o.kind AS reversed_kind
                FROM movements m JOIN items i ON i.id = m.item_id JOIN people p ON p.id = m.person_id JOIN locations l ON l.id = m.location_id
                LEFT JOIN movements o ON o.id = m.reverses
                WHERE m.kind IN ('count','adjust','undo') AND COALESCE(m.reason, '') NOT IN ('Opening count', 'Imported opening stock')\(w)
                ORDER BY m.created_at DESC
                """, args)
            return ReportResult(title: "Corrections & undos",
                columns: [col("created_at", "When", "date"), col("kind", "Type"), col("reversed_kind", "Undid"), col("sku", "SKU", "code"), col("name", "Item"),
                          col("qty", "Qty", "qty"), col("unit", "Unit"), col("value", "Value", "money"), col("reason", "Reason"), col("note", "Note"),
                          col("person", "By"), col("location", "Location")],
                rows: rows, totals: [("Corrections", rows.count), ("Net value", sum(rows, "value"))],
                breakdown: group(rows, by: "person", value: "value"), note: nil)

        case "stockcard":
            let itemId = try need(a, "itemId", "Item")
            let it = try item(itemId)
            var w = "", args: [Any?] = [itemId]
            if let l = str(a, "locationId") { w = " AND m.location_id = ?"; args.append(l) }
            var rows = try db.query("""
                SELECT m.created_at, m.kind, m.qty, SUM(m.qty) OVER (ORDER BY m.created_at, m.rowid) AS balance,
                  l.name AS location, m.reason, m.ref, m.note, p.name AS person, m.flag
                FROM movements m JOIN people p ON p.id = m.person_id JOIN locations l ON l.id = m.location_id
                WHERE m.item_id = ?\(w) ORDER BY m.created_at, m.rowid
                """, args)
            if let from = str(a, "from") { rows = rows.filter { ($0["created_at"] as? String ?? "") >= from } }
            if let to = str(a, "to") { rows = rows.filter { ($0["created_at"] as? String ?? "") < to } }
            return ReportResult(title: "Stock card — \(it["name"] ?? "") (\(it["sku"] ?? ""))",
                columns: [col("created_at", "When", "date"), col("kind", "Type"), col("qty", "Change", "qty"), col("balance", "Balance", "qty"),
                          col("location", "Location"), col("reason", "Reason"), col("ref", "Ref", "code"), col("person", "By"), col("flag", "Flag")],
                rows: rows.reversed(), totals: [("Movements", rows.count), ("Balance now", dbl(it["on_hand"]))], breakdown: [],
                note: "Balance runs over every location unless one is picked.")

        default:
            throw AppError("Unknown report \(kind).")
        }
    }

    func runReport(_ a: [String: Any]) throws -> Any {
        let r = try buildReport(a)
        let limit = min(Int(num(a, "limit") ?? 500), 5000)
        return ["title": r.title, "note": r.note ?? NSNull(), "count": r.rows.count, "truncated": r.rows.count > limit,
                "columns": r.columns.map { ["key": $0.key, "label": $0.label, "type": $0.type] },
                "rows": Array(r.rows.prefix(limit)),
                "totals": r.totals.map { ["label": $0.0, "value": $0.1] },
                "breakdown": r.breakdown.map { ["label": $0.0, "value": $0.1] }]
    }

    /// The whole report (not just what fits on screen) as a CSV next to the other exports.
    func exportReport(_ a: [String: Any], to folder: URL) throws -> URL {
        try require(.reports)
        let r = try buildReport(a)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = (str(a, "kind") ?? "report") + "_" + DateFormatter.fileStamp.string(from: Date()) + ".csv"
        let url = folder.appendingPathComponent(name)
        var out = r.columns.map { CSV.escape($0.label) }.joined(separator: ",") + "\n"
        for row in r.rows { out += r.columns.map { CSV.escape(row[$0.key]) }.joined(separator: ",") + "\n" }
        out += "\n" + r.totals.map { CSV.escape($0.0) + "," + CSV.escape($0.1) }.joined(separator: "\n") + "\n"
        try out.write(to: url, atomically: true, encoding: .utf8)
        try audit("report_exported", nil, nil, ["kind": str(a, "kind") ?? "", "rows": r.rows.count, "file": name])
        return url
    }
}
