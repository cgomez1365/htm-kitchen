import Foundation

/// --selftest: exercises the store, the v1 → v2 upgrade, and a printed label, in throwaway data folders.
func selfTest() -> Int32 {
    var failures = 0
    func check(_ ok: Bool, _ what: String) { print(ok ? "  ok   \(what)" : "  FAIL \(what)"); if !ok { failures += 1 } }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("hk-selftest-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }

    do {
        let s = try Store(dataDir: root.appendingPathComponent("fresh"))
        func call(_ m: String, _ a: [String: Any] = [:]) throws -> [String: Any] { try s.handle(m, a) as? [String: Any] ?? [:] }
        func list(_ m: String, _ a: [String: Any] = [:]) throws -> [[String: Any]] { try s.handle(m, a) as? [[String: Any]] ?? [] }
        func fails(_ m: String, _ a: [String: Any]) -> String? { do { _ = try s.handle(m, a); return nil } catch { return "\(error)" } }
        func onHand(_ id: String) throws -> Double { s.dbl(try call("items.get", ["id": id])["on_hand"]) }
        func level(_ id: String, _ loc: String) throws -> Double {
            let levels = try call("items.get", ["id": id])["levels"] as? [[String: Any]] ?? []
            return s.dbl(levels.first { $0["id"] as? String == loc }?["on_hand"])
        }

        print("Basics")
        check(s.schemaVersion() == 2, "a fresh database is created at v1 and upgraded to v2")
        check((try call("status"))["setupNeeded"] as? Bool == true, "fresh database asks for setup")
        _ = try call("setup", ["name": "Test Director", "pin": "2468"])
        check((try call("status"))["session"] != nil, "setup signs the first Director in")

        let salt = try call("items.save", ["name": "Kosher Salt", "category": "Dry Goods", "unit": "boxes", "min_level": 5, "price": 12.5, "opening": 12])
        let saltId = salt["id"] as? String ?? ""
        check(salt["sku"] as? String == "DRY-0001", "first Dry Goods SKU is DRY-0001")
        check(s.dbl(salt["on_hand"]) == 12, "opening count sets on hand to 12")
        let oil = try call("items.save", ["name": "Olive Oil", "category": "Dry Goods", "unit": "gallons", "min_level": 4, "barcode": "0123456789012"])
        check(oil["sku"] as? String == "DRY-0002", "SKUs count up per category")
        check(fails("items.save", ["name": "X", "category": "Nope", "unit": "pcs"]) != nil, "an unknown category is refused")

        print("Codes and packs")
        check((try call("lookup", ["code": "HK1:DRY-0001"]))["found"] as? Bool == true, "QR payload HK1:SKU resolves")
        check((try call("lookup", ["code": "0123456789012"]))["found"] as? Bool == true, "maker barcode resolves")
        check((try call("lookup", ["code": "nothing"]))["found"] as? Bool == false, "unknown code says not found")
        _ = try call("codes.add", ["itemId": saltId, "code": "10012345000017", "packQty": 24, "label": "Case of 24"])
        check(s.dbl((try call("lookup", ["code": "10012345000017"]))["packQty"]) == 24, "a case barcode reports a pack of 24")
        check(fails("codes.add", ["itemId": oil["id"] ?? "", "code": "10012345000017"]) != nil, "one barcode can't belong to two items")
        _ = try call("codes.setActive", ["code": "10012345000017", "active": false])
        check((try call("lookup", ["code": "10012345000017"]))["retired"] as? Bool == true, "a retired barcode no longer resolves")

        print("Movements")
        let out = try call("move", ["itemId": saltId, "kind": "issue", "qty": 3])
        check(s.dbl((out["item"] as? [String: Any])?["on_hand"]) == 9, "scan out 3 leaves 9")
        let undo = try call("undo", ["id": out["movementId"] as? String ?? ""])
        check(s.dbl((undo["item"] as? [String: Any])?["on_hand"]) == 12, "undo restores 12 with a new row")
        check(fails("undo", ["id": out["movementId"] as? String ?? ""]) != nil, "a movement can be undone only once")
        let cnt = try call("count", ["itemId": saltId, "counted": 10])
        check(s.dbl(cnt["delta"]) == -2, "shelf count of 10 records −2")

        print("Locations")
        let dry = (try call("locations.save", ["name": "Dry storage", "kind": "storage"]))["id"] as? String ?? ""
        let trf = try call("transfer", ["itemId": saltId, "qty": 4, "from": "main", "to": dry])
        check(try onHand(saltId) == 10 && level(saltId, "main") == 6 && level(saltId, dry) == 4, "transfer 4 to Dry storage: 6 + 4, total still 10")
        check(fails("locations.save", ["id": dry, "name": "Dry storage", "active": false]) != nil, "a location holding stock can't be closed")
        _ = try call("undo", ["id": trf["movementId"] as? String ?? ""])
        check(try level(saltId, "main") == 10 && level(saltId, dry) == 0, "undoing a transfer reverses both ends")

        print("Permanence")
        check((try? s.db.run("DELETE FROM movements")) == nil, "movements cannot be deleted")
        check((try? s.db.run("UPDATE movements SET qty = 99")) == nil, "movements cannot be edited")
        check((try? s.db.run("DELETE FROM items")) == nil, "items cannot be deleted")
        check((try? s.db.run("DELETE FROM stock_levels")) == nil, "stock levels cannot be deleted")

        print("Requests and losses")
        let req = try call("requests.create", ["lines": [["itemId": saltId, "qty": 4]], "note": "Lunch prep"])
        let line = ((try list("requests.list")).first?["lines"] as? [[String: Any]])?.first
        _ = try call("requests.fulfil", ["id": req["id"] ?? "", "lines": [["lineId": line?["id"] ?? "", "qty": 4]]])
        check(try onHand(saltId) == 6, "fulfilling a request issues 4")
        let loss = try call("losses.report", ["itemId": saltId, "qty": 1, "reason": "spoiled"])
        check(try onHand(saltId) == 6, "a reported loss waits for approval")
        _ = try call("losses.decide", ["id": loss["id"] ?? "", "approve": true])
        check(try onHand(saltId) == 5, "an approved loss leaves stock")

        print("Import and bulk")
        let csv = "SKU,Name,Category,Unit,Stock,MinLevel,Price\nPRO-0100,\"Chicken, thighs\",Proteins,lbs,40,10,2.5\n,Roma Tomatoes,produce,lbs,50,20,\"$1.20\"\n"
        let dryRun = try call("import.items", ["csv": csv, "dryRun": true])
        let previewFound = (try call("lookup", ["code": "PRO-0100"]))["found"] as? Bool
        check(dryRun["created"] as? Int == 2 && previewFound == false, "import preview writes nothing")
        let imp = try call("import.items", ["csv": csv])
        check(imp["created"] as? Int == 2, "CSV import makes 2 items (quoted comma and $ kept)")
        check((try call("lookup", ["code": "PRD-0001"]))["found"] as? Bool == true, "imported row without SKU gets PRD-0001")
        let upd = try call("import.items", ["csv": "SKU,Name,Price\nPRO-0100,Chicken thighs,2.75\n", "update": true])
        let chicken = (try call("lookup", ["code": "PRO-0100"]))["item"] as? [String: Any] ?? [:]
        check(upd["updated"] as? Int == 1 && s.dbl(chicken["price"]) == 2.75 && s.dbl(chicken["on_hand"]) == 40, "update import changes price, not stock")
        let found = try call("items.search", ["q": "roma"])
        check(found["total"] as? Int == 1, "search finds Roma by name")
        let page = try call("items.search", ["limit": 2, "offset": 0, "sort": "sku"])
        check((page["rows"] as? [[String: Any]])?.count == 2 && (page["total"] as? Int ?? 0) == 4, "search pages: 2 of 4")
        let bulk = try call("items.bulk", ["ids": [saltId, chicken["id"] ?? ""], "set": ["min_level": 7]])
        check(bulk["changed"] as? Int == 2, "bulk edit changes 2 items")

        print("Cycle count")
        let c = try call("counts.start", ["locationId": "main", "category": "Dry Goods"])
        check(c["lines"] as? Int == 2, "a Dry Goods count lists both Dry Goods items")
        _ = try call("counts.set", ["id": c["id"] ?? "", "itemId": saltId, "counted": 3])
        _ = try call("counts.set", ["id": c["id"] ?? "", "itemId": oil["id"] ?? "", "add": 1])
        _ = try call("counts.set", ["id": c["id"] ?? "", "itemId": oil["id"] ?? "", "add": 1])
        let posted = try call("counts.submit", ["id": c["id"] ?? ""])
        let saltNow = try onHand(saltId), oilNow = try onHand(oil["id"] as? String ?? "")
        check(posted["changed"] as? Int == 2 && saltNow == 3 && oilNow == 2, "posting the count sets salt to 3 and oil to 2")
        check(fails("counts.set", ["id": c["id"] ?? "", "itemId": saltId, "counted": 1]) != nil, "a posted count is closed")

        print("Reports")
        func report(_ kind: String, _ extra: [String: Any] = [:]) throws -> [String: Any] { try call("reports.run", ["kind": kind].merging(extra) { $1 }) }
        func total(_ r: [String: Any], _ label: String) -> Double { s.dbl((r["totals"] as? [[String: Any]])?.first { $0["label"] as? String == label }?["value"]) }
        let pulls = try report("pulls")
        check(pulls["count"] as? Int == 1 && total(pulls, "Cost") == 50, "pull records: 1 pull (the undone one is left out), $50")
        check(total(try report("losses"), "Approved cost") == 12.5, "loss report: $12.50 approved")
        let usage = try report("usage")
        let saltUsage = (usage["rows"] as? [[String: Any]])?.first { $0["sku"] as? String == "DRY-0001" } ?? [:]
        check(s.dbl(saltUsage["pulled"]) == 4 && s.dbl(saltUsage["lost"]) == 1, "usage nets the undo: salt pulled 4, lost 1")
        check((try report("variance"))["count"] as? Int == 2, "variance lists the 2 lines that changed")
        check((try report("reorder"))["count"] as? Int ?? 0 >= 1, "reorder lists items at or under minimum")
        let card = try report("stockcard", ["itemId": saltId])
        check(s.dbl((card["rows"] as? [[String: Any]])?.first?["balance"]) == 3, "stock card's running balance ends at on hand")
        for k in ["receiving", "people", "valuation", "corrections"] { check((try? report(k)) != nil, "\(k) report runs") }
        check(((try call("stock.verify"))["mismatches"] as? [Any])?.isEmpty == true, "maintained stock matches the ledger exactly")

        print("Roles")
        _ = try call("people.save", ["name": "Test Chef", "role": "chef", "pin": "1357"])
        let roster = try list("people.roster")
        let chefId = roster.first { $0["name"] as? String == "Test Chef" }?["id"] as? String ?? ""
        _ = try call("signOut")
        check(fails("signIn", ["personId": chefId, "pin": "0000"]) != nil, "wrong PIN is refused")
        _ = try call("signIn", ["personId": chefId, "pin": "1357"])
        check(fails("items.save", ["name": "X", "unit": "pcs"]) != nil, "a Chef cannot create items")
        check(fails("move", ["itemId": saltId, "kind": "receive", "qty": 1]) != nil, "a Chef cannot receive stock")
        check(fails("losses.decide", ["id": loss["id"] ?? "", "approve": true]) != nil, "a Chef cannot approve losses")
        check(fails("reports.run", ["kind": "pulls"]) != nil, "a Chef cannot open reports")
        check(fails("counts.start", ["locationId": "main"]) != nil, "a Chef cannot start a count")

        _ = try call("signOut")
        let dirId = roster.first { $0["name"] as? String == "Test Director" }?["id"] as? String ?? ""
        _ = try call("signIn", ["personId": dirId, "pin": "2468"])
        let export = try s.exportAll(to: root)
        let movesCSV = (try? String(contentsOf: export.appendingPathComponent("movements.csv"), encoding: .utf8)) ?? ""
        check(movesCSV.hasPrefix("created_at,sku,name,kind,qty,unit,location"), "export writes movements.csv with locations")
        check(FileManager.default.fileExists(atPath: export.appendingPathComponent("stock_by_location.csv").path), "export writes stock by location")
        check(!movesCSV.contains("pin_hash"), "export never contains PIN hashes")
        let rep = try s.exportReport(["kind": "pulls"], to: root)
        check(((try? String(contentsOf: rep, encoding: .utf8)) ?? "").hasPrefix("When,SKU,Item"), "a report exports to CSV")
        check(FileManager.default.fileExists(atPath: try s.backupNow().path), "backup file is written")
    } catch {
        print("  FAIL unexpected error: \(error)"); failures += 1
    }

    print("Upgrade from 0.1.0")
    do {
        let dir = root.appendingPathComponent("v1")
        Store.migrationTarget = 1
        do {
            let v1 = try Store(dataDir: dir)
            let t = nowISO()
            try v1.db.run("INSERT INTO people(id, name, role, pin_salt, pin_hash, created_at) VALUES ('p1','Old Director','director','s','h',?)", [t])
            try v1.db.run("INSERT INTO items(id, sku, name, category, unit, barcode, created_at) VALUES ('i1','DRY-0001','Salt','Dry Goods','boxes','777',?)", [t])
            try v1.db.run("INSERT INTO items(id, sku, name, category, unit, created_at) VALUES ('i2','SPC-0001','Paprika','Spices','jars',?)", [t])
            for (id, q, k) in [("m1", 10.0, "count"), ("m2", -3.0, "issue"), ("m3", 5.0, "receive")] {
                try v1.db.run("INSERT INTO movements(id, item_id, qty, kind, person_id, created_at) VALUES (?,'i1',?,?,'p1',?)", [id, q, k, t])
            }
            try v1.db.run("INSERT INTO movements(id, item_id, qty, kind, reverses, person_id, created_at) VALUES ('m4','i1',3,'undo','m2','p1',?)", [t])
            check(v1.schemaVersion() == 1, "built a 0.1.0 database")
        }
        Store.migrationTarget = 2
        let v2 = try Store(dataDir: dir)
        check(v2.schemaVersion() == 2, "it upgrades to v2 on open")
        check(v2.dbl(try v2.db.scalar("SELECT on_hand FROM stock WHERE id = 'i1'")) == 15, "stock survives the upgrade (10 − 3 + 5 + 3 = 15)")
        check((try v2.db.scalar("SELECT COUNT(*) FROM movements WHERE location_id = 'main'") as? Int) == 4, "old movements land in Main kitchen")
        check((try v2.db.one("SELECT item_id FROM item_codes WHERE code = '777'"))?["item_id"] as? String == "i1", "the old barcode moves to the codes list")
        check((try v2.db.one("SELECT prefix FROM categories WHERE name = 'Spices'"))?["prefix"] as? String == "SPI", "an unlisted v1 category gets its own prefix")
        check(try v2.verifyStock().isEmpty, "maintained stock matches the ledger after the upgrade")
        check((try? v2.db.run("DELETE FROM movements")) == nil, "the rebuilt ledger still refuses deletes")
        check((try? v2.db.run("UPDATE movements SET qty = 1")) == nil, "the rebuilt ledger still refuses edits")
    } catch {
        Store.migrationTarget = 2
        print("  FAIL upgrade error: \(error)"); failures += 1
    }

    print("Labels")
    for text in ["HK1:DRY-0001", "HK1:PRO-0042"] {
        check((Codes.qrImage(text).map(Codes.decode) ?? []).contains(text), "QR label for \(text) reads back")
        check((Codes.code128Image(text).map(Codes.decode) ?? []).contains(text), "Code 128 label for \(text) reads back")
    }
    print(failures == 0 ? "selftest: all passed" : "selftest: \(failures) failed")
    return failures == 0 ? 0 : 1
}

/// --perftest N: N items with 20 movements each across 3 locations, then times what people wait on.
func perfTest(items n: Int) -> Int32 {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("hk-perf-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    func ms(_ start: Date) -> String { String(format: "%6.0f ms", Date().timeIntervalSince(start) * 1000) }
    do {
        let s = try Store(dataDir: dir)
        _ = try s.handle("setup", ["name": "Perf Director", "pin": "2468"])
        let me = s.session!.id
        let b = try s.handle("locations.save", ["name": "Dry storage"]) as? [String: Any] ?? [:]
        let c = try s.handle("locations.save", ["name": "Walk-in"]) as? [String: Any] ?? [:]
        let locs = ["main", b["id"] as? String ?? "main", c["id"] as? String ?? "main"]
        let cats = Array(categoryPrefixes.keys).sorted()
        var t = Date()
        try s.db.transaction {
            for i in 0..<n {
                let cat = cats[i % cats.count], id = "item-\(i)"
                try s.db.run("INSERT INTO items(id, sku, name, category, unit, min_level, par_level, price, supplier, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                             [id, "\(categoryPrefixes[cat]!)-\(String(format: "%05d", i))", "Product \(i) \(cat)", cat, "units",
                              Double(i % 20), Double(i % 20) * 2, Double(i % 50) + 0.99, "Supplier \(i % 25)", nowISO()])
                try s.db.run("INSERT INTO item_codes(code, item_id, pack_qty, created_at) VALUES (?,?,1,?)", [String(format: "0%011d", i), id, nowISO()])
                for j in 0..<20 {
                    let kind = j == 0 ? "count" : (j % 4 == 0 ? "receive" : "issue")
                    let q = kind == "count" ? 100.0 : (kind == "receive" ? 10.0 : -Double(1 + j % 3))
                    try s.insertMovement(item: id, location: locs[j % 3], qty: q, kind: kind, reason: kind == "issue" ? "Kitchen use" : nil,
                                         note: nil, ref: nil, person: me, flag: nil)
                }
            }
        }
        print("seeded \(n) items, \(n * 20) movements          \(ms(t))")
        func time(_ label: String, _ m: String, _ a: [String: Any]) throws {
            t = Date(); let r = try s.handle(m, a); _ = r
            print(label.padding(toLength: 40, withPad: " ", startingAt: 0) + ms(t))
        }
        try time("items.search first page (by category)", "items.search", ["limit": 50])
        try time("items.search 'product 42' sorted by value", "items.search", ["q": "product 42", "sort": "value", "dir": "desc"])
        try time("items.search needs-attention filter", "items.search", ["state": "attention"])
        try time("items.search at one location", "items.search", ["locationId": locs[1], "sort": "here", "onlyHere": true])
        try time("lookup by maker barcode", "lookup", ["code": String(format: "0%011d", n / 2)])
        try time("dashboard", "dashboard", [:])
        try time("report: pull records (all time)", "reports.run", ["kind": "pulls"])
        try time("report: usage by item", "reports.run", ["kind": "usage"])
        try time("report: activity by person", "reports.run", ["kind": "people"])
        try time("report: valuation", "reports.run", ["kind": "valuation"])
        try time("report: reorder", "reports.run", ["kind": "reorder"])
        try time("start a count of every item at Main", "counts.start", ["locationId": "main"])
        t = Date()
        let bad = try s.verifyStock()
        print("verify stock against \(n * 20) ledger rows".padding(toLength: 40, withPad: " ", startingAt: 0) + ms(t) + "  (\(bad.count) mismatches)")
        return bad.isEmpty ? 0 : 1
    } catch {
        print("perftest failed: \(error)")
        return 1
    }
}
