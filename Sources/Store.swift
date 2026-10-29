import Foundation
import CryptoKit

/// Who may do what. The UI hides buttons; this is the rule that actually holds.
enum Perm {
    case view, itemsEdit, receive, issue, adjust, requestCreate, requestFulfil,
         lossReport, lossDecide, people, data, labels, reports

    var roles: Set<String> {
        switch self {
        case .view, .lossReport: return ["director", "inventory", "chef", "driver", "staff"]
        case .itemsEdit, .receive, .adjust, .requestFulfil, .data, .labels, .reports: return ["director", "inventory"]
        case .issue, .requestCreate: return ["director", "inventory", "chef", "staff"]
        case .lossDecide, .people: return ["director"]
        }
    }
}

struct Session {
    let id: String
    let name: String
    let role: String
    var lastSeen: Date
}

enum ShortfallDecision {
    case allow
    case flag(String)   // allowed, but the movement carries a visible flag for review
    case block(String)  // refused, with the reason shown at the station
}

let roleNames = ["director": "Director", "inventory": "Inventory Manager", "chef": "Chef", "driver": "Driver", "staff": "Staff"]
/// Seeds the categories table on first run; after that categories are managed in Settings.
let categoryPrefixes = ["Dry Goods": "DRY", "Produce": "PRD", "Proteins": "PRO", "Dairy": "DAI", "Frozen": "FRZ",
                        "Beverages": "BEV", "Bakery": "BAK", "Cleaning": "CLN", "Paper & Disposables": "PPR",
                        "Equipment": "EQP", "Donation": "DON", "Other": "OTH"]
let qrPrefix = "HK1:"

func fmtQty(_ v: Double) -> String {
    v == v.rounded() ? String(Int(v)) : String(format: "%.2f", v).replacingOccurrences(of: #"\.?0+$"#, with: "", options: .regularExpression)
}

func nowISO() -> String { ISO8601DateFormatter.withFractions.string(from: Date()) }

final class Store {
    let db: DB
    let dataDir: URL
    var session: Session?
    private var failedPins: [String: (count: Int, until: Date)] = [:]
    static let idleLimit: TimeInterval = 15 * 60

    init(dataDir: URL) throws {
        self.dataDir = dataDir
        try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        db = try DB(path: dataDir.appendingPathComponent("kitchen.sqlite").path)
        try createV1()
        try migrateForward()
    }

    // MARK: - Schema v1 (every database starts here; Schema.swift moves it forward)

    private func createV1() throws {
        try db.exec("""
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS people(
          id TEXT PRIMARY KEY, name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('director','inventory','chef','driver','staff')),
          pin_salt TEXT NOT NULL, pin_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL, created_by TEXT);
        CREATE TABLE IF NOT EXISTS items(
          id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL,
          min_level REAL NOT NULL DEFAULT 0, par_level REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0,
          supplier TEXT, location TEXT, barcode TEXT, active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL, created_by TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS items_barcode ON items(barcode) WHERE barcode IS NOT NULL AND barcode <> '';
        CREATE TABLE IF NOT EXISTS movements(
          id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), qty REAL NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('receive','issue','return','loss','adjust','count','undo')),
          reason TEXT, note TEXT, ref TEXT, reverses TEXT REFERENCES movements(id),
          person_id TEXT NOT NULL REFERENCES people(id), flag TEXT, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS movements_item ON movements(item_id, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS movements_one_undo ON movements(reverses) WHERE reverses IS NOT NULL;
        CREATE TABLE IF NOT EXISTS requests(
          id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, requested_by TEXT NOT NULL REFERENCES people(id),
          status TEXT NOT NULL CHECK(status IN ('pending','partial','fulfilled','received','denied','cancelled')),
          note TEXT, needed_by TEXT, decided_by TEXT, decided_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS request_lines(
          id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), item_id TEXT NOT NULL REFERENCES items(id),
          qty_requested REAL NOT NULL CHECK(qty_requested > 0), qty_fulfilled REAL NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS losses(
          id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), qty REAL NOT NULL CHECK(qty > 0),
          reason TEXT NOT NULL CHECK(reason IN ('spoiled','damaged','broken','expired','other')), note TEXT,
          reported_by TEXT NOT NULL REFERENCES people(id), status TEXT NOT NULL CHECK(status IN ('pending','approved','denied')),
          decided_by TEXT, decided_note TEXT, decided_at TEXT, movement_id TEXT, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit(
          id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, person_id TEXT, action TEXT NOT NULL,
          entity TEXT, entity_id TEXT, detail TEXT);
        CREATE VIEW IF NOT EXISTS stock AS
          SELECT i.*, COALESCE((SELECT SUM(m.qty) FROM movements m WHERE m.item_id = i.id), 0) AS on_hand FROM items i;
        """)
        // Nothing is ever deleted (FQC R-13). Ledgers are also never edited.
        for t in ["movements", "audit"] {
            try db.exec("CREATE TRIGGER IF NOT EXISTS \(t)_no_update BEFORE UPDATE ON \(t) BEGIN SELECT RAISE(ABORT, 'This record is permanent. Record a correction instead.'); END;")
        }
        for t in ["people", "items", "movements", "requests", "request_lines", "losses", "audit"] {
            try db.exec("CREATE TRIGGER IF NOT EXISTS \(t)_no_delete BEFORE DELETE ON \(t) BEGIN SELECT RAISE(ABORT, 'Records are never deleted. Deactivate or cancel instead.'); END;")
        }
        try db.run("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', '1')")
    }

    // MARK: - Helpers

    func uuid() -> String { UUID().uuidString.lowercased() }

    func str(_ a: [String: Any], _ k: String) -> String? {
        guard let v = a[k], !(v is NSNull) else { return nil }
        let s = "\(v)".trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? nil : s
    }

    func need(_ a: [String: Any], _ k: String, _ label: String) throws -> String {
        guard let s = str(a, k) else { throw AppError("\(label) is required.") }
        return s
    }

    func num(_ a: [String: Any], _ k: String) -> Double? {
        if let d = a[k] as? Double { return d }
        if let i = a[k] as? Int { return Double(i) }
        if let s = str(a, k) { return Double(s) }
        return nil
    }

    func dbl(_ v: Any?) -> Double { (v as? Double) ?? Double(v as? Int ?? 0) }

    func audit(_ action: String, _ entity: String?, _ entityId: String?, _ detail: [String: Any] = [:]) throws {
        let json = (try? JSONSerialization.data(withJSONObject: detail)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        try db.run("INSERT INTO audit(at, person_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)",
                   [nowISO(), session?.id, action, entity, entityId, json])
    }

    @discardableResult
    func require(_ perm: Perm) throws -> Session {
        guard var s = session else { throw AppError("Sign in first.") }
        if Date().timeIntervalSince(s.lastSeen) > Store.idleLimit {
            session = nil
            throw AppError("Signed out after 15 minutes without activity. Sign in again.")
        }
        guard perm.roles.contains(s.role) else {
            throw AppError("\(roleNames[s.role] ?? s.role) accounts can't do that. Ask a Director or Inventory Manager.")
        }
        s.lastSeen = Date()
        session = s
        return s
    }

    private func hashPin(_ pin: String, salt: String) -> String {
        var data = Data((salt + pin).utf8)
        for _ in 0..<20_000 { data = Data(SHA256.hash(data: data)) }
        return data.map { String(format: "%02x", $0) }.joined()
    }

    private func checkPinShape(_ pin: String) throws {
        guard pin.count >= 4, pin.count <= 8, pin.allSatisfy(\.isNumber) else { throw AppError("A PIN is 4 to 8 digits.") }
    }

    var defaultLocation: String { (try? db.scalar("SELECT value FROM meta WHERE key = 'defaultLocation'") as? String) ?? "main" }

    func location(_ a: [String: Any], _ key: String = "locationId") throws -> String {
        let id = str(a, key) ?? defaultLocation
        guard let l = try db.one("SELECT active FROM locations WHERE id = ?", [id]) else { throw AppError("That location doesn't exist.") }
        guard (l["active"] as? Int) == 1 else { throw AppError("That location is closed.") }
        return id
    }

    // MARK: - Dispatch

    func handle(_ method: String, _ a: [String: Any]) throws -> Any {
        switch method {
        case "status": return try status()
        case "setup": return try setup(a)
        case "people.roster": return try db.query("SELECT id, name, role FROM people WHERE active = 1 ORDER BY name")
        case "signIn": return try signIn(a)
        case "signOut":
            if session != nil { try audit("sign_out", "people", session?.id) }
            session = nil
            return ["ok": true]
        case "dashboard": try require(.view); return try dashboard(a)
        case "items.search": try require(.view); return try itemsSearch(a)
        case "items.get": try require(.view); return try itemDetail(need(a, "id", "Item"))
        case "items.save": return try itemSave(a)
        case "items.bulk": return try itemsBulk(a)
        case "items.nextSku": try require(.view); return ["sku": try nextSku(category: str(a, "category") ?? "Other")]
        case "codes.add": return try codeAdd(a)
        case "codes.setActive": return try codeSetActive(a)
        case "lookup": try require(.view); return try lookup(need(a, "code", "Code"))
        case "move": return try move(a)
        case "transfer": return try transfer(a)
        case "count": return try count(a)
        case "undo": return try undo(need(a, "id", "Movement"))
        case "ledger": try require(.view); return try ledger(a)
        case "requests.list": try require(.view); return try requestsList(a)
        case "requests.create": return try requestCreate(a)
        case "requests.fulfil": return try requestFulfil(a)
        case "requests.decide": return try requestDecide(a)
        case "losses.list": try require(.view); return try lossesList(a)
        case "losses.report": return try lossReport(a)
        case "losses.decide": return try lossDecide(a)
        case "people.list": try require(.people); return try db.query("SELECT id, name, role, active, created_at FROM people ORDER BY active DESC, name")
        case "people.save": return try personSave(a)
        case "locations.list": try require(.view); return try db.query("SELECT * FROM locations ORDER BY active DESC, CASE id WHEN 'main' THEN 0 ELSE 1 END, name")
        case "locations.save": return try locationSave(a)
        case "categories.list": try require(.view); return try db.query("SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category = c.name AND i.active = 1) AS items FROM categories c ORDER BY c.name")
        case "categories.save": return try categorySave(a)
        case "import.items": return try importItems(a)
        case "counts.list": try require(.view); return try countsList()
        case "counts.start": return try countStart(a)
        case "counts.get": try require(.view); return try countGet(need(a, "id", "Count"))
        case "counts.set": return try countSet(a)
        case "counts.submit": return try countSubmit(a)
        case "counts.cancel": return try countCancel(a)
        case "reports.run": try require(.reports); return try runReport(a)
        case "stock.verify": try require(.data); return ["mismatches": try verifyStock()]
        default: throw AppError("Unknown action \(method).")
        }
    }

    // MARK: - Session

    private func status() throws -> [String: Any] {
        let people = (try db.scalar("SELECT COUNT(*) FROM people") as? Int) ?? 0
        var s: [String: Any] = ["setupNeeded": people == 0, "dataPath": db.path, "roles": roleNames, "qrPrefix": qrPrefix,
                                "schema": schemaVersion(), "defaultLocation": defaultLocation,
                                "categories": try db.query("SELECT name, prefix FROM categories WHERE active = 1 ORDER BY name").compactMap { $0["name"] },
                                "locations": try db.query("SELECT id, name, kind FROM locations WHERE active = 1 ORDER BY CASE id WHEN 'main' THEN 0 ELSE 1 END, name")]
        if let cur = session, Date().timeIntervalSince(cur.lastSeen) <= Store.idleLimit {
            s["session"] = ["id": cur.id, "name": cur.name, "role": cur.role, "roleName": roleNames[cur.role] ?? cur.role]
        } else {
            session = nil
        }
        return s
    }

    private func setup(_ a: [String: Any]) throws -> Any {
        let people = (try db.scalar("SELECT COUNT(*) FROM people") as? Int) ?? 0
        guard people == 0 else { throw AppError("Setup is already done. A Director adds people from the People page.") }
        let name = try need(a, "name", "Your name")
        let pin = try need(a, "pin", "PIN")
        try checkPinShape(pin)
        let id = uuid(), salt = uuid()
        try db.run("INSERT INTO people(id, name, role, pin_salt, pin_hash, created_at) VALUES (?,?,?,?,?,?)",
                   [id, name, "director", salt, hashPin(pin, salt: salt), nowISO()])
        session = Session(id: id, name: name, role: "director", lastSeen: Date())
        try audit("setup_first_director", "people", id, ["name": name])
        return try status()
    }

    private func signIn(_ a: [String: Any]) throws -> Any {
        let id = try need(a, "personId", "Person")
        let pin = try need(a, "pin", "PIN")
        if let f = failedPins[id], f.count >= 5, f.until > Date() {
            throw AppError("Too many wrong PINs. Try again in \(Int(f.until.timeIntervalSinceNow) + 1) seconds.")
        }
        guard let p = try db.one("SELECT * FROM people WHERE id = ? AND active = 1", [id]),
              let salt = p["pin_salt"] as? String, let hash = p["pin_hash"] as? String else {
            throw AppError("That person isn't active.")
        }
        guard hashPin(pin, salt: salt) == hash else {
            let n = (failedPins[id]?.count ?? 0) + 1
            failedPins[id] = (n, Date().addingTimeInterval(60))
            session = nil
            try audit("sign_in_failed", "people", id)
            throw AppError(n >= 5 ? "Wrong PIN. Locked for 60 seconds." : "Wrong PIN.")
        }
        failedPins[id] = nil
        session = Session(id: id, name: p["name"] as? String ?? "", role: p["role"] as? String ?? "staff", lastSeen: Date())
        try audit("sign_in", "people", id)
        return try status()
    }

    private func personSave(_ a: [String: Any]) throws -> Any {
        let me = try require(.people)
        let name = try need(a, "name", "Name")
        let role = try need(a, "role", "Role")
        guard roleNames[role] != nil else { throw AppError("Pick a role.") }
        let active = (a["active"] as? Bool) ?? true
        if let id = str(a, "id") {
            if id == me.id && (role != "director" || !active) {
                throw AppError("You can't remove your own Director access. Another Director has to.")
            }
            try db.run("UPDATE people SET name = ?, role = ?, active = ? WHERE id = ?", [name, role, active, id])
            if let pin = str(a, "pin") {
                try checkPinShape(pin)
                let salt = uuid()
                try db.run("UPDATE people SET pin_salt = ?, pin_hash = ? WHERE id = ?", [salt, hashPin(pin, salt: salt), id])
            }
            try audit("person_updated", "people", id, ["name": name, "role": role, "active": active, "pinChanged": str(a, "pin") != nil])
            return ["id": id]
        }
        let pin = try need(a, "pin", "PIN")
        try checkPinShape(pin)
        let id = uuid(), salt = uuid()
        try db.run("INSERT INTO people(id, name, role, pin_salt, pin_hash, created_at, created_by) VALUES (?,?,?,?,?,?,?)",
                   [id, name, role, salt, hashPin(pin, salt: salt), nowISO(), me.id])
        try audit("person_added", "people", id, ["name": name, "role": role])
        return ["id": id]
    }

    // MARK: - Locations and categories

    private func locationSave(_ a: [String: Any]) throws -> Any {
        try require(.itemsEdit)
        let name = try need(a, "name", "Location name")
        let kind = str(a, "kind") ?? "storage"
        guard ["storage", "kitchen", "site", "vehicle"].contains(kind) else { throw AppError("Pick a location type.") }
        let active = (a["active"] as? Bool) ?? true
        if let id = str(a, "id") {
            if !active {
                if id == defaultLocation { throw AppError("The main location can't be closed.") }
                let left = dbl(try db.scalar("SELECT TOTAL(ABS(on_hand)) FROM stock_levels WHERE location_id = ?", [id]))
                if left > 0 { throw AppError("Stock is still recorded there. Transfer or count it to zero before closing.") }
            }
            try db.run("UPDATE locations SET name = ?, kind = ?, active = ? WHERE id = ?", [name, kind, active, id])
            try audit("location_updated", "locations", id, ["name": name, "active": active])
            return ["id": id]
        }
        if try db.one("SELECT id FROM locations WHERE name = ?", [name]) != nil { throw AppError("\(name) already exists.") }
        let id = uuid()
        try db.run("INSERT INTO locations(id, name, kind, created_at) VALUES (?,?,?,?)", [id, name, kind, nowISO()])
        try audit("location_added", "locations", id, ["name": name])
        return ["id": id]
    }

    private func categorySave(_ a: [String: Any]) throws -> Any {
        try require(.itemsEdit)
        let name = try need(a, "name", "Category name")
        let prefix = try need(a, "prefix", "SKU prefix").uppercased()
        guard (2...5).contains(prefix.count), prefix.allSatisfy({ $0.isLetter && $0.isASCII }) else { throw AppError("A SKU prefix is 2 to 5 letters.") }
        let active = (a["active"] as? Bool) ?? true
        if let other = try db.one("SELECT name FROM categories WHERE prefix = ? AND name <> ?", [prefix, name]) {
            throw AppError("\(prefix) is already used by \(other["name"] ?? "another category").")
        }
        if try db.one("SELECT name FROM categories WHERE name = ?", [name]) != nil {
            try db.run("UPDATE categories SET prefix = ?, active = ? WHERE name = ?", [prefix, active, name])
        } else {
            try db.run("INSERT INTO categories(name, prefix, created_at) VALUES (?,?,?)", [name, prefix, nowISO()])
        }
        try audit("category_saved", "categories", name, ["prefix": prefix, "active": active])
        return ["name": name]
    }

    // MARK: - Items

    static let sortColumns = ["name": "s.name", "sku": "s.sku", "category": "s.category, s.name", "on_hand": "s.on_hand",
                              "value": "(MAX(s.on_hand, 0) * s.price)", "last_moved": "s.last_moved", "min_level": "s.min_level",
                              "here": "here"]

    /// Paged search for catalogues of thousands: filter and sort in SQL, send one page to the screen.
    private func itemsSearch(_ a: [String: Any]) throws -> Any {
        var conds = ["1=1"], args: [Any?] = []
        let state = str(a, "state") ?? "active"
        switch state {
        case "inactive": conds.append("s.active = 0")
        case "all": break
        case "low": conds.append("s.active = 1 AND s.min_level > 0 AND s.on_hand <= s.min_level AND s.on_hand > 0")
        case "out": conds.append("s.active = 1 AND s.on_hand <= 0")
        case "attention": conds.append("s.active = 1 AND (s.on_hand <= 0 OR (s.min_level > 0 AND s.on_hand <= s.min_level))")
        default: conds.append("s.active = 1")
        }
        if let q = str(a, "q") {
            for word in q.split(separator: " ").prefix(5) {
                conds.append("(s.name LIKE ? OR s.sku LIKE ? OR s.codes LIKE ? OR s.supplier LIKE ?)")
                let like = "%\(word)%"
                args += [like, like, like, like]
            }
        }
        if let c = str(a, "category") { conds.append("s.category = ?"); args.append(c) }
        if let sup = str(a, "supplier") { conds.append("s.supplier = ?"); args.append(sup) }
        let loc = str(a, "locationId")
        var hereSQL = "NULL"
        if let loc {
            hereSQL = "COALESCE((SELECT on_hand FROM stock_levels sl WHERE sl.item_id = s.id AND sl.location_id = ?), 0)"
            if (a["onlyHere"] as? Bool) == true { conds.append("EXISTS (SELECT 1 FROM stock_levels sl WHERE sl.item_id = s.id AND sl.location_id = ? AND sl.on_hand <> 0)") }
        }
        let whereSQL = conds.joined(separator: " AND ")
        var whereArgs = args
        if loc != nil && (a["onlyHere"] as? Bool) == true { whereArgs.append(loc) }
        let total = (try db.scalar("SELECT COUNT(*) FROM stock s WHERE \(whereSQL)", whereArgs) as? Int) ?? 0
        let sortKey = str(a, "sort") ?? "category"
        let order = Store.sortColumns[sortKey] ?? Store.sortColumns["category"]!
        let dir = str(a, "dir") == "desc" ? "DESC" : "ASC"
        let limit = min(Int(num(a, "limit") ?? 50), 1000), offset = max(Int(num(a, "offset") ?? 0), 0)
        let rows = try db.query("""
            SELECT s.*, \(hereSQL) AS here FROM stock s WHERE \(whereSQL)
            ORDER BY \(order) \(dir), s.name LIMIT ? OFFSET ?
            """, (loc != nil ? [loc] : []) + whereArgs + [limit, offset])
        return ["rows": rows, "total": total, "offset": offset, "limit": limit]
    }

    func item(_ id: String) throws -> [String: Any] {
        guard let it = try db.one("SELECT * FROM stock WHERE id = ?", [id]) else { throw AppError("That item no longer exists.") }
        return it
    }

    private func itemDetail(_ id: String) throws -> [String: Any] {
        var it = try item(id)
        it["levels"] = try db.query("""
            SELECT l.id, l.name, l.kind, COALESCE(s.on_hand, 0) AS on_hand, s.last_at FROM locations l
            LEFT JOIN stock_levels s ON s.location_id = l.id AND s.item_id = ?
            WHERE l.active = 1 OR COALESCE(s.on_hand, 0) <> 0 ORDER BY CASE l.id WHEN 'main' THEN 0 ELSE 1 END, l.name
            """, [id])
        it["codeList"] = try db.query("SELECT * FROM item_codes WHERE item_id = ? ORDER BY active DESC, pack_qty, created_at", [id])
        let since = ISO8601DateFormatter.withFractions.string(from: Date().addingTimeInterval(-30 * 86400))
        it["pulled30"] = -dbl(try db.scalar("""
            SELECT TOTAL(m.qty) FROM movements m LEFT JOIN movements o ON o.id = m.reverses
            WHERE m.item_id = ? AND m.created_at >= ? AND (CASE WHEN m.kind = 'undo' THEN o.kind ELSE m.kind END) = 'issue'
            """, [id, since]))
        return it
    }

    func nextSku(category: String) throws -> String {
        let prefix = (try db.one("SELECT prefix FROM categories WHERE name = ?", [category])?["prefix"] as? String) ?? "OTH"
        let n = (try db.scalar("""
            SELECT MAX(CAST(substr(sku, length(?) + 2) AS INTEGER)) FROM items WHERE sku LIKE ? AND substr(sku, length(?) + 2) GLOB '[0-9]*'
            """, [prefix, prefix + "-%", prefix]) as? Int) ?? 0
        return String(format: "%@-%04d", prefix, n + 1)
    }

    private func categoryExists(_ name: String) throws -> Bool { try db.one("SELECT name FROM categories WHERE name = ?", [name]) != nil }

    private func itemSave(_ a: [String: Any]) throws -> Any {
        let me = try require(.itemsEdit)
        let name = try need(a, "name", "Item name")
        let category = str(a, "category") ?? "Other"
        guard try categoryExists(category) else { throw AppError("Category \(category) doesn't exist. Add it in Settings first.") }
        let unit = try need(a, "unit", "Unit")
        let minL = num(a, "min_level") ?? 0, par = num(a, "par_level") ?? 0, price = num(a, "price") ?? 0
        guard minL >= 0, par >= 0, price >= 0 else { throw AppError("Levels and price can't be negative.") }
        let fields: [Any?] = [name, category, unit, minL, par, price, str(a, "supplier"), str(a, "location")]
        return try db.transaction {
            if let id = str(a, "id") {
                let active = (a["active"] as? Bool) ?? true
                try db.run("""
                    UPDATE items SET name=?, category=?, unit=?, min_level=?, par_level=?, price=?, supplier=?, location=?, active=?, updated_at=?
                    WHERE id=?
                    """, fields + [active, nowISO(), id])
                try audit("item_updated", "items", id, ["name": name, "active": active, "price": price])
                return try itemDetail(id)
            }
            var sku = try str(a, "sku")?.uppercased() ?? nextSku(category: category)
            if sku.hasPrefix(qrPrefix) { sku.removeFirst(qrPrefix.count) }
            if try db.one("SELECT id FROM items WHERE sku = ?", [sku]) != nil { throw AppError("SKU \(sku) is already used.") }
            let id = uuid()
            try db.run("""
                INSERT INTO items(id, sku, name, category, unit, min_level, par_level, price, supplier, location, created_at, created_by)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """, [id, sku] + fields + [nowISO(), me.id])
            try audit("item_created", "items", id, ["sku": sku, "name": name])
            if let code = str(a, "barcode") { try addCode(code, item: id, pack: 1, label: "Maker barcode", by: me.id) }
            if let opening = num(a, "opening"), opening > 0 {
                try insertMovement(item: id, location: try location(a), qty: opening, kind: "count", reason: "Opening count",
                                   note: nil, ref: nil, person: me.id, flag: nil)
            }
            return try itemDetail(id)
        }
    }

    /// One change applied to many items at once (category, levels, supplier, storage spot, active).
    private func itemsBulk(_ a: [String: Any]) throws -> Any {
        try require(.itemsEdit)
        guard let ids = a["ids"] as? [String], !ids.isEmpty else { throw AppError("Select at least one item.") }
        guard let set = a["set"] as? [String: Any], !set.isEmpty else { throw AppError("Choose what to change.") }
        var sets: [String] = [], args: [Any?] = []
        for (k, v) in set {
            switch k {
            case "category":
                let c = "\(v)"; guard try categoryExists(c) else { throw AppError("Category \(c) doesn't exist.") }
                sets.append("category = ?"); args.append(c)
            case "min_level", "par_level", "price":
                guard let d = num(set, k), d >= 0 else { throw AppError("Enter a number of 0 or more.") }
                sets.append("\(k) = ?"); args.append(d)
            case "supplier", "location", "unit": sets.append("\(k) = ?"); args.append(str(set, k))
            case "active": sets.append("active = ?"); args.append((v as? Bool) ?? true)
            default: throw AppError("\(k) can't be changed in bulk.")
            }
        }
        sets.append("updated_at = ?"); args.append(nowISO())
        let changed = try db.transaction { () -> Int in
            var n = 0
            for chunk in stride(from: 0, to: ids.count, by: 400).map({ Array(ids[$0..<min($0 + 400, ids.count)]) }) {
                n += try db.run("UPDATE items SET \(sets.joined(separator: ", ")) WHERE id IN (\(chunk.map { _ in "?" }.joined(separator: ",")))",
                                args + chunk.map { $0 as Any? })
            }
            try audit("items_bulk_update", "items", nil, ["count": n, "set": set])
            return n
        }
        return ["changed": changed]
    }

    func addCode(_ raw: String, item: String, pack: Double, label: String?, by person: String) throws {
        var code = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if code.uppercased().hasPrefix(qrPrefix) { throw AppError("That is one of our own labels. Scan the maker's barcode instead.") }
        code = code.replacingOccurrences(of: "\n", with: "")
        guard !code.isEmpty else { throw AppError("Scan or type a barcode.") }
        guard pack > 0 else { throw AppError("A pack holds more than 0.") }
        if let other = try db.one("SELECT c.item_id, i.name FROM item_codes c JOIN items i ON i.id = c.item_id WHERE c.code = ?", [code]) {
            throw AppError("That barcode already belongs to \(other["name"] ?? "another item").")
        }
        if try db.one("SELECT id FROM items WHERE sku = ? COLLATE NOCASE", [code]) != nil { throw AppError("That code is already a SKU.") }
        try db.run("INSERT INTO item_codes(code, item_id, pack_qty, label, created_at, created_by) VALUES (?,?,?,?,?,?)",
                   [code, item, pack, label, nowISO(), person])
        try audit("code_added", "item_codes", code, ["item": item, "pack": pack])
    }

    private func codeAdd(_ a: [String: Any]) throws -> Any {
        let me = try require(.itemsEdit)
        let itemId = try need(a, "itemId", "Item")
        try addCode(try need(a, "code", "Barcode"), item: itemId, pack: num(a, "packQty") ?? 1, label: str(a, "label"), by: me.id)
        return try itemDetail(itemId)
    }

    private func codeSetActive(_ a: [String: Any]) throws -> Any {
        try require(.itemsEdit)
        let code = try need(a, "code", "Barcode")
        let active = (a["active"] as? Bool) ?? false
        guard let row = try db.one("SELECT item_id FROM item_codes WHERE code = ?", [code]) else { throw AppError("Barcode not found.") }
        try db.run("UPDATE item_codes SET active = ? WHERE code = ?", [active, code])
        try audit(active ? "code_reactivated" : "code_retired", "item_codes", code)
        return try itemDetail(row["item_id"] as? String ?? "")
    }

    /// Resolves whatever a scanner produced: our QR (HK1:SKU), a SKU, or a maker barcode (which may be a case of N).
    private func lookup(_ raw: String) throws -> Any {
        var code = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if code.uppercased().hasPrefix(qrPrefix) { code = String(code.dropFirst(qrPrefix.count)) }
        if let it = try db.one("SELECT * FROM stock WHERE sku = ? COLLATE NOCASE", [code]) {
            return ["found": true, "item": it, "packQty": 1, "via": "sku"]
        }
        if let c = try db.one("SELECT * FROM item_codes WHERE code = ?", [code]) {
            guard (c["active"] as? Int) == 1 else { return ["found": false, "code": code, "retired": true] }
            return ["found": true, "item": try item(c["item_id"] as? String ?? ""), "packQty": dbl(c["pack_qty"]),
                    "packLabel": c["label"] ?? NSNull(), "via": "code"]
        }
        return ["found": false, "code": code]
    }

    // MARK: - Movements

    @discardableResult
    func insertMovement(item: String, location: String, qty: Double, kind: String, reason: String?, note: String?, ref: String?,
                        person: String, flag: String?, reverses: String? = nil) throws -> String {
        let id = uuid()
        try db.run("""
            INSERT INTO movements(id, item_id, location_id, qty, kind, reason, note, ref, reverses, person_id, flag, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """, [id, item, location, qty, kind, reason, note, ref, reverses, person, flag, nowISO()])
        return id
    }

    func onHand(_ itemId: String, at location: String) throws -> Double {
        dbl(try db.scalar("SELECT on_hand FROM stock_levels WHERE item_id = ? AND location_id = ?", [itemId, location]))
    }

    /// Decides what happens when someone takes out more than the system says is on the shelf.
    func shortfallDecision(onHand: Double, requested: Double, role: String, kind: String) -> ShortfallDecision {
        // TODO(human): decide the rule for taking out more than is on hand.
        return .block("Only \(fmtQty(onHand)) on hand, so \(fmtQty(requested)) can't come out. Count the shelf first.")
    }

    /// Runs the shortfall rule for anything that takes stock out of one location.
    func checkShortfall(item: String, location: String, taking: Double, role: String, kind: String) throws -> String? {
        let have = try onHand(item, at: location)
        guard have - taking < 0 else { return nil }
        switch shortfallDecision(onHand: have, requested: taking, role: role, kind: kind) {
        case .allow: return nil
        case .flag(let why): return why
        case .block(let why): throw AppError(why)
        }
    }

    /// One scan = one movement. kind: receive (+), issue (−), return (+), adjust (±).
    private func move(_ a: [String: Any]) throws -> Any {
        let kind = try need(a, "kind", "Movement type")
        guard ["receive", "issue", "return", "adjust"].contains(kind) else { throw AppError("Unknown movement type \(kind).") }
        let perm: Perm = ["receive": .receive, "issue": .issue, "return": .issue][kind] ?? .adjust
        let me = try require(perm)
        let itemId = try need(a, "itemId", "Item")
        let loc = try location(a)
        guard let qty = num(a, "qty"), qty != 0, qty.isFinite else { throw AppError("Enter a quantity.") }
        if kind != "adjust" && qty < 0 { throw AppError("Enter the quantity as a positive number.") }
        let it = try item(itemId)
        guard (it["active"] as? Int) == 1 else { throw AppError("\(it["name"] ?? "This item") is deactivated.") }
        let delta = kind == "issue" ? -qty : qty
        if kind == "adjust" && str(a, "note") == nil { throw AppError("An adjustment needs a note saying why.") }

        return try db.transaction {
            let flag = delta < 0 ? try checkShortfall(item: itemId, location: loc, taking: -delta, role: me.role, kind: kind) : nil
            let id = try insertMovement(item: itemId, location: loc, qty: delta, kind: kind, reason: str(a, "reason"),
                                        note: str(a, "note"), ref: str(a, "ref"), person: me.id, flag: flag)
            try audit("stock_\(kind)", "movements", id, ["sku": it["sku"] ?? "", "qty": delta, "location": loc])
            var out = try item(itemId)
            out["here"] = try onHand(itemId, at: loc)
            return ["movementId": id, "item": out, "flag": flag ?? NSNull()]
        }
    }

    /// Moves stock between two locations: two linked rows, so totals never change and both ends are on record.
    private func transfer(_ a: [String: Any]) throws -> Any {
        let me = try require(.issue)
        let itemId = try need(a, "itemId", "Item")
        let from = try location(a, "from"), to = try location(a, "to")
        guard from != to else { throw AppError("Pick two different locations.") }
        guard let qty = num(a, "qty"), qty > 0 else { throw AppError("Enter how much is moving.") }
        let names = Dictionary(uniqueKeysWithValues: try db.query("SELECT id, name FROM locations WHERE id IN (?, ?)", [from, to])
            .map { ($0["id"] as? String ?? "", $0["name"] as? String ?? "") })
        return try db.transaction {
            let flag = try checkShortfall(item: itemId, location: from, taking: qty, role: me.role, kind: "transfer")
            let ref = "TRF-" + uuid().prefix(8).uppercased()
            let outId = try insertMovement(item: itemId, location: from, qty: -qty, kind: "transfer", reason: "To \(names[to] ?? "")",
                                           note: str(a, "note"), ref: ref, person: me.id, flag: flag)
            try insertMovement(item: itemId, location: to, qty: qty, kind: "transfer", reason: "From \(names[from] ?? "")",
                               note: str(a, "note"), ref: ref, person: me.id, flag: nil)
            try audit("stock_transfer", "movements", outId, ["ref": ref, "qty": qty, "from": from, "to": to])
            var out = try item(itemId)
            out["here"] = try onHand(itemId, at: from)
            return ["movementId": outId, "ref": ref, "item": out, "flag": flag ?? NSNull(), "arrived": try onHand(itemId, at: to)]
        }
    }

    /// A single shelf count at one location: records the difference between the shelf and the system.
    private func count(_ a: [String: Any]) throws -> Any {
        let me = try require(.adjust)
        let itemId = try need(a, "itemId", "Item")
        let loc = try location(a)
        guard let counted = num(a, "counted"), counted >= 0 else { throw AppError("Enter what is on the shelf (0 or more).") }
        return try db.transaction {
            let delta = counted - (try onHand(itemId, at: loc))
            var id: Any = NSNull()
            if delta != 0 {
                id = try insertMovement(item: itemId, location: loc, qty: delta, kind: "count", reason: "Shelf count",
                                        note: str(a, "note"), ref: nil, person: me.id, flag: nil)
            }
            try audit("stock_count", "items", itemId, ["counted": counted, "delta": delta, "location": loc])
            var out = try item(itemId)
            out["here"] = try onHand(itemId, at: loc)
            return ["movementId": id, "delta": delta, "item": out]
        }
    }

    /// Undo never erases: it records the opposite movement, linked to the original. A transfer is undone as a pair.
    private func undo(_ movementId: String) throws -> Any {
        let me = try require(.issue)
        guard let m = try db.one("SELECT * FROM movements WHERE id = ?", [movementId]) else { throw AppError("Movement not found.") }
        guard (m["kind"] as? String) != "undo" else { throw AppError("An undo can't be undone. Scan the item again instead.") }
        if try db.one("SELECT id FROM movements WHERE reverses = ?", [movementId]) != nil { throw AppError("Already undone.") }
        let mine = (m["person_id"] as? String) == me.id
        let age = ISO8601DateFormatter.withFractions.date(from: m["created_at"] as? String ?? "").map { Date().timeIntervalSince($0) } ?? .infinity
        guard (mine && age < 600) || ["director", "inventory"].contains(me.role) else {
            throw AppError("You can undo your own scans for 10 minutes. After that, ask an Inventory Manager.")
        }
        var targets = [m]
        if (m["kind"] as? String) == "transfer", let ref = m["ref"] as? String {
            targets = try db.query("SELECT * FROM movements WHERE ref = ? AND kind = 'transfer' AND id NOT IN (SELECT reverses FROM movements WHERE reverses IS NOT NULL)", [ref])
        }
        let itemId = m["item_id"] as? String ?? ""
        return try db.transaction {
            var first = ""
            for t in targets {
                let id = try insertMovement(item: t["item_id"] as? String ?? "", location: t["location_id"] as? String ?? defaultLocation,
                                            qty: -dbl(t["qty"]), kind: "undo", reason: "Undo", note: nil, ref: t["ref"] as? String,
                                            person: me.id, flag: nil, reverses: t["id"] as? String)
                if first.isEmpty { first = id }
                try audit("stock_undo", "movements", id, ["reverses": t["id"] ?? ""])
            }
            return ["movementId": first, "item": try item(itemId)]
        }
    }

    func ledger(_ a: [String: Any]) throws -> Any {
        var sql = """
            SELECT m.*, i.sku, i.name AS item_name, i.unit, p.name AS person_name, l.name AS location_name,
                   (SELECT u.id FROM movements u WHERE u.reverses = m.id) AS undone_by
            FROM movements m JOIN items i ON i.id = m.item_id JOIN people p ON p.id = m.person_id
            JOIN locations l ON l.id = m.location_id WHERE 1=1
            """
        var args: [Any?] = []
        for (k, col) in [("itemId", "m.item_id"), ("personId", "m.person_id"), ("kind", "m.kind"), ("locationId", "m.location_id"), ("ref", "m.ref")] {
            if let v = str(a, k) { sql += " AND \(col) = ?"; args.append(v) }
        }
        if let from = str(a, "from") { sql += " AND m.created_at >= ?"; args.append(from) }
        if let to = str(a, "to") { sql += " AND m.created_at < ?"; args.append(to) }
        sql += " ORDER BY m.created_at DESC LIMIT ? OFFSET ?"
        args += [Int(num(a, "limit") ?? 300), Int(num(a, "offset") ?? 0)]
        return try db.query(sql, args)
    }

    // MARK: - Dashboard

    private func dashboard(_ a: [String: Any]) throws -> Any {
        let since = ISO8601DateFormatter.withFractions.string(from: Calendar.current.startOfDay(for: Date()))
        func int(_ sql: String, _ args: [Any?] = []) throws -> Int { (try db.scalar(sql, args) as? Int) ?? 0 }
        let lowWhere = "active = 1 AND (on_hand <= 0 OR (min_level > 0 AND on_hand <= min_level))"
        let low = try db.query("SELECT * FROM stock WHERE \(lowWhere) AND min_level > 0 ORDER BY (on_hand / min_level), name LIMIT 12")
        let pulledToday = try db.one("""
            SELECT COUNT(*) AS n, TOTAL(-m.qty * i.price) AS cost FROM movements m JOIN items i ON i.id = m.item_id
            WHERE m.kind = 'issue' AND m.created_at >= ? AND NOT EXISTS (SELECT 1 FROM movements u WHERE u.reverses = m.id)
            """, [since]) ?? [:]
        return [
            "items": try int("SELECT COUNT(*) FROM items WHERE active = 1"),
            "lowCount": try int("SELECT COUNT(*) FROM stock WHERE \(lowWhere)"),
            "low": low,
            "value": dbl(try db.scalar("SELECT TOTAL(MAX(on_hand, 0) * price) FROM stock WHERE active = 1")),
            "pendingRequests": try int("SELECT COUNT(*) FROM requests WHERE status IN ('pending','partial')"),
            "pendingLosses": try int("SELECT COUNT(*) FROM losses WHERE status = 'pending'"),
            "openCounts": try int("SELECT COUNT(*) FROM counts WHERE status = 'open'"),
            "movesToday": try int("SELECT COUNT(*) FROM movements WHERE created_at >= ?", [since]),
            "pullsToday": pulledToday["n"] ?? 0, "pullCostToday": dbl(pulledToday["cost"]),
            "flagged": try int("SELECT COUNT(*) FROM movements WHERE flag IS NOT NULL AND created_at >= ?", [since]),
            "recent": try ledger(["limit": 12])
        ]
    }

    // MARK: - Requests (chef orders → inventory fulfils by scanning or by hand)

    private func requestsList(_ a: [String: Any]) throws -> Any {
        var sql = "SELECT r.*, p.name AS requested_by_name, d.name AS decided_by_name FROM requests r JOIN people p ON p.id = r.requested_by LEFT JOIN people d ON d.id = r.decided_by"
        var args: [Any?] = []
        if let st = str(a, "status") {
            let list = st.split(separator: ",").map(String.init)
            sql += " WHERE r.status IN (\(list.map { _ in "?" }.joined(separator: ",")))"
            args += list
        }
        sql += " ORDER BY r.created_at DESC LIMIT 200"
        return try db.query(sql, args).map { r -> [String: Any] in
            var r = r
            r["lines"] = (try? db.query("""
                SELECT l.*, s.sku, s.name, s.unit, s.on_hand, COALESCE(sl.on_hand, 0) AS here FROM request_lines l JOIN stock s ON s.id = l.item_id
                LEFT JOIN stock_levels sl ON sl.item_id = l.item_id AND sl.location_id = ?
                WHERE l.request_id = ?
                """, [str(a, "locationId") ?? defaultLocation, r["id"] as? String ?? ""])) ?? []
            return r
        }
    }

    private func requestCreate(_ a: [String: Any]) throws -> Any {
        let me = try require(.requestCreate)
        guard let lines = a["lines"] as? [[String: Any]], !lines.isEmpty else { throw AppError("Add at least one item to the request.") }
        return try db.transaction {
            let n = ((try db.scalar("SELECT COUNT(*) FROM requests") as? Int) ?? 0) + 1
            let number = String(format: "REQ-%05d", n)
            let id = uuid(), t = nowISO()
            try db.run("INSERT INTO requests(id, number, requested_by, status, note, needed_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                       [id, number, me.id, "pending", str(a, "note"), str(a, "neededBy"), t, t])
            for l in lines {
                guard let itemId = l["itemId"] as? String, let q = num(l, "qty"), q > 0 else { throw AppError("Each line needs an item and a quantity above 0.") }
                try db.run("INSERT INTO request_lines(id, request_id, item_id, qty_requested) VALUES (?,?,?,?)", [uuid(), id, itemId, q])
            }
            try audit("request_created", "requests", id, ["number": number, "lines": lines.count])
            return ["id": id, "number": number]
        }
    }

    /// Fulfilling issues stock out of one location, one movement per line, tagged with the request number.
    private func requestFulfil(_ a: [String: Any]) throws -> Any {
        let me = try require(.requestFulfil)
        let id = try need(a, "id", "Request")
        let loc = try location(a)
        guard let r = try db.one("SELECT * FROM requests WHERE id = ?", [id]) else { throw AppError("Request not found.") }
        guard ["pending", "partial"].contains(r["status"] as? String ?? "") else { throw AppError("This request is already \(r["status"] ?? "closed").") }
        let given = (a["lines"] as? [[String: Any]]) ?? []
        return try db.transaction {
            for g in given {
                guard let lineId = g["lineId"] as? String, let q = num(g, "qty"), q > 0 else { continue }
                guard let line = try db.one("SELECT * FROM request_lines WHERE id = ? AND request_id = ?", [lineId, id]) else { continue }
                let itemId = line["item_id"] as? String ?? ""
                let flag = try checkShortfall(item: itemId, location: loc, taking: q, role: me.role, kind: "issue")
                try insertMovement(item: itemId, location: loc, qty: -q, kind: "issue", reason: "Request", note: nil,
                                   ref: r["number"] as? String, person: me.id, flag: flag)
                try db.run("UPDATE request_lines SET qty_fulfilled = qty_fulfilled + ? WHERE id = ?", [q, lineId])
            }
            let open = (try db.scalar("SELECT COUNT(*) FROM request_lines WHERE request_id = ? AND qty_fulfilled < qty_requested", [id]) as? Int) ?? 0
            let status = open == 0 ? "fulfilled" : "partial"
            try db.run("UPDATE requests SET status = ?, decided_by = ?, location_id = ?, updated_at = ? WHERE id = ?", [status, me.id, loc, nowISO(), id])
            try audit("request_\(status)", "requests", id, ["number": r["number"] ?? ""])
            return ["status": status]
        }
    }

    /// deny / cancel / received. The requester may cancel a pending request or confirm receipt.
    private func requestDecide(_ a: [String: Any]) throws -> Any {
        let id = try need(a, "id", "Request")
        let action = try need(a, "action", "Action")
        guard let r = try db.one("SELECT * FROM requests WHERE id = ?", [id]) else { throw AppError("Request not found.") }
        let status = r["status"] as? String ?? ""
        let me = try require(.view)
        let isRequester = (r["requested_by"] as? String) == me.id
        let next: String
        switch action {
        case "deny":
            try require(.requestFulfil)
            guard ["pending", "partial"].contains(status) else { throw AppError("Only open requests can be denied.") }
            guard str(a, "note") != nil else { throw AppError("Say why the request is denied.") }
            next = "denied"
        case "cancel":
            guard isRequester || me.role == "director" else { throw AppError("Only the person who asked, or a Director, can cancel.") }
            guard status == "pending" else { throw AppError("Only a request nothing was sent for can be cancelled.") }
            next = "cancelled"
        case "received":
            guard isRequester || ["director", "chef"].contains(me.role) else { throw AppError("The kitchen confirms receipt.") }
            guard ["fulfilled", "partial"].contains(status) else { throw AppError("Nothing has been sent for this request yet.") }
            next = "received"
        default: throw AppError("Unknown action \(action).")
        }
        try db.run("UPDATE requests SET status = ?, decided_note = COALESCE(?, decided_note), updated_at = ? WHERE id = ?",
                   [next, str(a, "note"), nowISO(), id])
        try audit("request_\(next)", "requests", id, ["note": str(a, "note") ?? ""])
        return ["status": next]
    }

    // MARK: - Losses (report → Director approves → stock leaves that location)

    private func lossesList(_ a: [String: Any]) throws -> Any {
        var sql = """
            SELECT l.*, i.sku, i.name AS item_name, i.unit, i.price, p.name AS reported_by_name, d.name AS decided_by_name, loc.name AS location_name
            FROM losses l JOIN items i ON i.id = l.item_id JOIN people p ON p.id = l.reported_by LEFT JOIN people d ON d.id = l.decided_by
            LEFT JOIN locations loc ON loc.id = l.location_id
            """
        var args: [Any?] = []
        if let st = str(a, "status") { sql += " WHERE l.status = ?"; args.append(st) }
        return try db.query(sql + " ORDER BY l.created_at DESC LIMIT ?", args + [Int(num(a, "limit") ?? 300)])
    }

    private func lossReport(_ a: [String: Any]) throws -> Any {
        let me = try require(.lossReport)
        let itemId = try need(a, "itemId", "Item")
        let loc = try location(a)
        guard let qty = num(a, "qty"), qty > 0 else { throw AppError("Enter how much was lost.") }
        let reason = try need(a, "reason", "Reason")
        if reason == "other" && str(a, "note") == nil { throw AppError("Say what happened.") }
        _ = try item(itemId)
        let id = uuid()
        try db.run("INSERT INTO losses(id, item_id, qty, reason, note, reported_by, status, location_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                   [id, itemId, qty, reason, str(a, "note"), me.id, "pending", loc, nowISO()])
        try audit("loss_reported", "losses", id, ["qty": qty, "reason": reason])
        return ["id": id]
    }

    private func lossDecide(_ a: [String: Any]) throws -> Any {
        let me = try require(.lossDecide)
        let id = try need(a, "id", "Loss report")
        let approve = (a["approve"] as? Bool) ?? false
        guard let l = try db.one("SELECT * FROM losses WHERE id = ?", [id]) else { throw AppError("Loss report not found.") }
        guard (l["status"] as? String) == "pending" else { throw AppError("This report was already decided.") }
        if !approve && str(a, "note") == nil { throw AppError("Say why the loss is denied.") }
        return try db.transaction {
            var movement: Any = NSNull()
            if approve {
                let qty = dbl(l["qty"]), itemId = l["item_id"] as? String ?? ""
                let loc = l["location_id"] as? String ?? defaultLocation
                let short = try onHand(itemId, at: loc) - qty < 0
                movement = try insertMovement(item: itemId, location: loc, qty: -qty, kind: "loss", reason: l["reason"] as? String,
                                              note: l["note"] as? String, ref: id, person: me.id,
                                              flag: short ? "Loss is larger than recorded stock" : nil)
            }
            try db.run("UPDATE losses SET status = ?, decided_by = ?, decided_note = ?, decided_at = ?, movement_id = ? WHERE id = ?",
                       [approve ? "approved" : "denied", me.id, str(a, "note"), nowISO(), movement, id])
            try audit(approve ? "loss_approved" : "loss_denied", "losses", id)
            return ["status": approve ? "approved" : "denied"]
        }
    }

    // MARK: - Import (create new SKUs, or update existing ones; preview first)

    private func importItems(_ a: [String: Any]) throws -> Any {
        let me = try require(.data)
        let rows = CSV.parse(try need(a, "csv", "CSV text"))
        let dryRun = (a["dryRun"] as? Bool) ?? false
        let updateExisting = (a["update"] as? Bool) ?? false
        guard let header = rows.first?.map({ $0.lowercased().replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "_", with: "") }) else {
            throw AppError("The file is empty.")
        }
        func col(_ names: String...) -> Int? { names.lazy.compactMap { header.firstIndex(of: $0) }.first }
        guard let nameCol = col("name", "itemname", "item", "description") else { throw AppError("The CSV needs a Name column.") }
        let skuCol = col("sku"), catCol = col("category"), unitCol = col("unit", "uom"), stockCol = col("stock", "onhand", "qty", "quantity")
        let minCol = col("minlevel", "min", "minimum"), parCol = col("parlevel", "par"), priceCol = col("price", "cost", "unitcost")
        let supCol = col("supplier", "vendor"), locCol = col("location", "storage", "bin"), bcCol = col("barcode", "upc", "ean")
        let cats = Dictionary(uniqueKeysWithValues: try db.query("SELECT name FROM categories").compactMap { r -> (String, String)? in
            guard let n = r["name"] as? String else { return nil }; return (n.lowercased(), n) })
        var created = 0, updated = 0, skipped: [String] = [], preview: [[String: Any]] = []
        let loc = try location(a)

        let work = {
            for (n, r) in rows.dropFirst().enumerated() {
                func v(_ c: Int?) -> String? { c.flatMap { $0 < r.count ? r[$0].trimmingCharacters(in: .whitespaces) : nil }.flatMap { $0.isEmpty ? nil : $0 } }
                func d(_ c: Int?) -> Double? { v(c).flatMap { Double($0.replacingOccurrences(of: "$", with: "").replacingOccurrences(of: ",", with: "")) } }
                guard let name = v(nameCol) else { continue }
                let rowNo = n + 2
                let category = v(catCol).flatMap { cats[$0.lowercased()] } ?? "Other"
                if let raw = v(catCol), cats[raw.lowercased()] == nil, preview.count < 200 {
                    skipped.append("Row \(rowNo): category \(raw) is unknown, filed under Other")
                }
                if let sku = v(skuCol)?.uppercased(), let existing = try self.db.one("SELECT id FROM items WHERE sku = ?", [sku]) {
                    guard updateExisting else { skipped.append("Row \(rowNo): \(sku) already exists"); continue }
                    var sets: [String] = ["name = ?"], args: [Any?] = [name]
                    if v(catCol) != nil { sets.append("category = ?"); args.append(category) }
                    for (c, field) in [(unitCol, "unit"), (supCol, "supplier"), (locCol, "location")] where v(c) != nil { sets.append("\(field) = ?"); args.append(v(c)) }
                    for (c, field) in [(minCol, "min_level"), (parCol, "par_level"), (priceCol, "price")] where d(c) != nil { sets.append("\(field) = ?"); args.append(d(c)) }
                    sets.append("updated_at = ?"); args.append(nowISO())
                    if !dryRun { try self.db.run("UPDATE items SET \(sets.joined(separator: ", ")) WHERE id = ?", args + [existing["id"]]) }
                    updated += 1
                    if preview.count < 25 { preview.append(["row": rowNo, "action": "update", "sku": sku, "name": name]) }
                    continue
                }
                let sku = try v(skuCol)?.uppercased() ?? self.nextSku(category: category)
                if let bc = v(bcCol), try self.db.one("SELECT code FROM item_codes WHERE code = ?", [bc]) != nil {
                    skipped.append("Row \(rowNo): barcode \(bc) already belongs to another item"); continue
                }
                if preview.count < 25 { preview.append(["row": rowNo, "action": "create", "sku": sku, "name": name, "category": category, "stock": d(stockCol) ?? 0]) }
                created += 1
                if dryRun { continue }
                let id = self.uuid()
                try self.db.run("""
                    INSERT INTO items(id, sku, name, category, unit, min_level, par_level, price, supplier, location, created_at, created_by)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                    """, [id, sku, name, category, v(unitCol) ?? "units", d(minCol) ?? 0, d(parCol) ?? 0, d(priceCol) ?? 0,
                          v(supCol), v(locCol), nowISO(), me.id])
                if let bc = v(bcCol) { try self.addCode(bc, item: id, pack: 1, label: "Maker barcode", by: me.id) }
                if let s = d(stockCol), s != 0 {
                    try self.insertMovement(item: id, location: loc, qty: s, kind: "count", reason: "Imported opening stock",
                                            note: nil, ref: nil, person: me.id, flag: nil)
                }
            }
        }
        if dryRun { try work() } else {
            try db.transaction {
                try work()
                try audit("items_imported", "items", nil, ["created": created, "updated": updated, "skipped": skipped.count])
            }
        }
        return ["created": created, "updated": updated, "skipped": Array(skipped.prefix(200)), "skippedCount": skipped.count,
                "preview": preview, "dryRun": dryRun]
    }

    // MARK: - Export (every table, any time, as CSV + README — after FQC's "every process exports")

    func exportAll(to folder: URL) throws -> URL {
        try require(.data)
        let stamp = DateFormatter.fileStamp.string(from: Date())
        let dir = folder.appendingPathComponent("HopeKitchen_\(stamp)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let sets: [(String, String)] = [
            ("items_stock", "SELECT sku, name, category, unit, on_hand, min_level, par_level, price, ROUND(MAX(on_hand, 0)*price, 2) AS value, supplier, location, codes, active FROM stock ORDER BY category, name"),
            ("stock_by_location", "SELECT i.sku, i.name, l.name AS location, s.on_hand, i.unit, s.last_at FROM stock_levels s JOIN items i ON i.id=s.item_id JOIN locations l ON l.id=s.location_id ORDER BY i.sku, l.name"),
            ("barcodes", "SELECT c.code, i.sku, i.name, c.pack_qty, c.label, c.active FROM item_codes c JOIN items i ON i.id=c.item_id ORDER BY i.sku"),
            ("movements", "SELECT m.created_at, i.sku, i.name, m.kind, m.qty, i.unit, l.name AS location, m.reason, m.note, m.ref, m.flag, p.name AS person, m.reverses, m.id FROM movements m JOIN items i ON i.id=m.item_id JOIN people p ON p.id=m.person_id JOIN locations l ON l.id=m.location_id ORDER BY m.created_at"),
            ("requests", "SELECT r.number, r.status, p.name AS requested_by, r.note, r.decided_note, r.created_at, r.updated_at FROM requests r JOIN people p ON p.id=r.requested_by ORDER BY r.created_at"),
            ("request_lines", "SELECT r.number, i.sku, i.name, l.qty_requested, l.qty_fulfilled FROM request_lines l JOIN requests r ON r.id=l.request_id JOIN items i ON i.id=l.item_id ORDER BY r.created_at"),
            ("losses", "SELECT l.created_at, i.sku, i.name, l.qty, l.reason, l.note, l.status, p.name AS reported_by, d.name AS decided_by, l.decided_note, l.decided_at FROM losses l JOIN items i ON i.id=l.item_id JOIN people p ON p.id=l.reported_by LEFT JOIN people d ON d.id=l.decided_by ORDER BY l.created_at"),
            ("counts", "SELECT c.number, loc.name AS location, c.category, c.status, i.sku, i.name, cl.expected, cl.counted, cl.applied, cp.name AS counted_by, cl.counted_at FROM count_lines cl JOIN counts c ON c.id=cl.count_id JOIN items i ON i.id=cl.item_id JOIN locations loc ON loc.id=c.location_id LEFT JOIN people cp ON cp.id=cl.counted_by ORDER BY c.started_at"),
            ("locations", "SELECT name, kind, active, created_at FROM locations ORDER BY name"),
            ("categories", "SELECT name, prefix, active FROM categories ORDER BY name"),
            ("people", "SELECT name, role, active, created_at FROM people ORDER BY name"),
            ("audit", "SELECT a.at, p.name AS person, a.action, a.entity, a.entity_id, a.detail FROM audit a LEFT JOIN people p ON p.id=a.person_id ORDER BY a.id")
        ]
        var readme = "Hope Kitchen export — \(stamp)\nDatabase: \(db.path)\n\n"
        for (name, sql) in sets {
            let rows = try db.query(sql)
            try CSV.write(rows: rows, columns: CSV.columns(of: sql), to: dir.appendingPathComponent("\(name).csv"))
            readme += "\(name).csv — \(rows.count) rows\n"
        }
        readme += "\nMovements are append-only: an undo is a new row whose 'reverses' names the original. PINs are never exported.\n"
        try readme.write(to: dir.appendingPathComponent("README.txt"), atomically: true, encoding: .utf8)
        try audit("exported", nil, nil, ["folder": dir.path])
        return dir
    }

    func backupNow() throws -> URL {
        let dir = dataDir.appendingPathComponent("backups")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent("kitchen_\(DateFormatter.fileStamp.string(from: Date())).sqlite")
        try db.backup(to: dest.path)
        try audit("backup", nil, nil, ["file": dest.lastPathComponent])
        return dest
    }

    /// Once a day, on launch: a copy that does not depend on anyone remembering.
    func dailyBackupIfDue() {
        let key = "lastBackupDay", today = DateFormatter.day.string(from: Date())
        let last = (try? db.scalar("SELECT value FROM meta WHERE key = ?", [key])) as? String
        guard last != today else { return }
        let dir = dataDir.appendingPathComponent("backups")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if (try? db.backup(to: dir.appendingPathComponent("kitchen_daily_\(today).sqlite").path)) != nil {
            try? db.run("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", [key, today])
        }
    }
}

extension ISO8601DateFormatter {
    static let withFractions: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

extension DateFormatter {
    static let fileStamp: DateFormatter = { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd_HHmmss"; return f }()
    static let day: DateFormatter = { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f }()
}

enum CSV {
    static func parse(_ text: String) -> [[String]] {
        var rows: [[String]] = [], row: [String] = [], field = "", quoted = false
        var it = Array(text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\u{FEFF}", with: "")).makeIterator()
        var pending: Character? = nil
        while let c = pending ?? it.next() {
            pending = nil
            if quoted {
                if c == "\"" {
                    if let n = it.next() { if n == "\"" { field.append("\"") } else { quoted = false; pending = n } } else { quoted = false }
                } else { field.append(c) }
            } else if c == "\"" { quoted = true }
            else if c == "," { row.append(field); field = "" }
            else if c == "\n" { row.append(field); rows.append(row); row = []; field = "" }
            else { field.append(c) }
        }
        if !field.isEmpty || !row.isEmpty { row.append(field); rows.append(row) }
        return rows.filter { !($0.count == 1 && $0[0].isEmpty) }
    }

    static func escape(_ v: Any?) -> String {
        let s: String
        switch v { case nil, is NSNull: s = ""; case let d as Double: s = fmtQty(d); default: s = "\(v!)" }
        return s.contains(where: { ",\"\n".contains($0) }) ? "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\"" : s
    }

    /// Column order from the SELECT list, so files read left-to-right the way the query was written.
    static func columns(of sql: String) -> [String] {
        guard let sel = sql.range(of: "SELECT "), let from = sql.range(of: " FROM ", range: sel.upperBound..<sql.endIndex) else { return [] }
        var cols: [String] = [], depth = 0, cur = ""
        for ch in sql[sel.upperBound..<from.lowerBound] {
            if ch == "(" { depth += 1 } else if ch == ")" { depth -= 1 }
            if ch == "," && depth == 0 { cols.append(cur); cur = "" } else { cur.append(ch) }
        }
        cols.append(cur)
        return cols.map { c in
            let t = c.trimmingCharacters(in: .whitespaces)
            if let r = t.range(of: " AS ", options: .caseInsensitive) { return String(t[r.upperBound...]) }
            return String(t.split(separator: ".").last ?? Substring(t))
        }
    }

    static func write(rows: [[String: Any]], columns: [String], to url: URL) throws {
        var out = columns.joined(separator: ",") + "\n"
        for r in rows { out += columns.map { escape(r[$0]) }.joined(separator: ",") + "\n" }
        try out.write(to: url, atomically: true, encoding: .utf8)
    }
}
