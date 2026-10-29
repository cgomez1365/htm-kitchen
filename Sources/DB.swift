import Foundation
import SQLite3

/// A failure written for the person at the station, not for a developer (R-10).
struct AppError: Error, CustomStringConvertible {
    let message: String
    init(_ message: String) { self.message = message }
    var description: String { message }
}

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Thin SQLite wrapper. Rows come back as [String: Any] so they serialise straight to JSON for the UI.
final class DB {
    private var handle: OpaquePointer?
    let path: String

    init(path: String) throws {
        self.path = path
        if sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) != SQLITE_OK {
            throw AppError("Could not open the inventory database at \(path).")
        }
        try exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;")
    }

    deinit { sqlite3_close(handle) }

    private var lastError: String { String(cString: sqlite3_errmsg(handle)) }

    func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(handle, sql, nil, nil, &err) != SQLITE_OK {
            let msg = err.map { String(cString: $0) } ?? lastError
            sqlite3_free(err)
            throw AppError(msg)
        }
    }

    private func prepare(_ sql: String, _ args: [Any?]) throws -> OpaquePointer? {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK else { throw AppError(lastError) }
        for (i, arg) in args.enumerated() {
            let idx = Int32(i + 1)
            switch arg {
            case nil, is NSNull: sqlite3_bind_null(stmt, idx)
            case let v as Int: sqlite3_bind_int64(stmt, idx, Int64(v))
            case let v as Int64: sqlite3_bind_int64(stmt, idx, v)
            case let v as Bool: sqlite3_bind_int64(stmt, idx, v ? 1 : 0)
            case let v as Double: sqlite3_bind_double(stmt, idx, v)
            case let v as String: sqlite3_bind_text(stmt, idx, v, -1, SQLITE_TRANSIENT)
            default: sqlite3_bind_text(stmt, idx, "\(arg!)", -1, SQLITE_TRANSIENT)
            }
        }
        return stmt
    }

    @discardableResult
    func run(_ sql: String, _ args: [Any?] = []) throws -> Int {
        let stmt = try prepare(sql, args)
        defer { sqlite3_finalize(stmt) }
        let rc = sqlite3_step(stmt)
        guard rc == SQLITE_DONE || rc == SQLITE_ROW else { throw AppError(lastError) }
        return Int(sqlite3_changes(handle))
    }

    func query(_ sql: String, _ args: [Any?] = []) throws -> [[String: Any]] {
        let stmt = try prepare(sql, args)
        defer { sqlite3_finalize(stmt) }
        var rows: [[String: Any]] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw AppError(lastError) }
            var row: [String: Any] = [:]
            for c in 0..<sqlite3_column_count(stmt) {
                let name = String(cString: sqlite3_column_name(stmt, c))
                switch sqlite3_column_type(stmt, c) {
                case SQLITE_INTEGER: row[name] = Int(sqlite3_column_int64(stmt, c))
                case SQLITE_FLOAT: row[name] = sqlite3_column_double(stmt, c)
                case SQLITE_TEXT: row[name] = String(cString: sqlite3_column_text(stmt, c))
                default: row[name] = NSNull()
                }
            }
            rows.append(row)
        }
        return rows
    }

    func one(_ sql: String, _ args: [Any?] = []) throws -> [String: Any]? { try query(sql, args).first }

    func scalar(_ sql: String, _ args: [Any?] = []) throws -> Any? { try one(sql, args)?.values.first }

    func transaction<T>(_ body: () throws -> T) throws -> T {
        try exec("BEGIN IMMEDIATE")
        do { let r = try body(); try exec("COMMIT"); return r }
        catch { try? exec("ROLLBACK"); throw error }
    }

    /// Online copy with SQLite's backup API: safe while the app is writing.
    func backup(to dest: String) throws {
        var out: OpaquePointer?
        guard sqlite3_open(dest, &out) == SQLITE_OK else { throw AppError("Could not create the backup file at \(dest).") }
        defer { sqlite3_close(out) }
        guard let b = sqlite3_backup_init(out, "main", handle, "main") else { throw AppError("Backup could not start: \(lastError)") }
        sqlite3_backup_step(b, -1)
        if sqlite3_backup_finish(b) != SQLITE_OK { throw AppError("Backup did not finish: \(lastError)") }
    }
}
