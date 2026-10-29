import AppKit
import WebKit

let appVersion = "0.2.0"

/// Data lives in Application Support unless HOPE_KITCHEN_DATA points at a test folder.
func dataDirectory() -> URL {
    if let custom = ProcessInfo.processInfo.environment["HOPE_KITCHEN_DATA"], !custom.isEmpty {
        return URL(fileURLWithPath: custom, isDirectory: true)
    }
    return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("HopeKitchen", isDirectory: true)
}

func uiDirectory() -> URL {
    if let r = Bundle.main.resourceURL?.appendingPathComponent("UI"), FileManager.default.fileExists(atPath: r.appendingPathComponent("index.html").path) {
        return r
    }
    // Running the bare binary from the repo: use ./UI next to Sources.
    return URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("../UI").standardized
}

func exportsFolder() -> URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Hope Kitchen Exports")
}

/// The page talks to the app only through this handler (no HTTP server, after MacSense v2).
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    let store: Store
    let scanner = Scanner()
    weak var webView: WKWebView?

    init(store: Store) {
        self.store = store
        super.init()
        scanner.onCode = { [weak self] code in self?.push("scan", ["code": code]) }
        scanner.onStop = { [weak self] in self?.push("scannerStopped", [:]) }
    }

    func push(_ event: String, _ data: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: data), let s = String(data: json, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.HK && HK.native(\(jsString(event)), \(s))")
    }

    private func jsString(_ s: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [s])
        return String(data: data ?? Data(), encoding: .utf8).map { String($0.dropFirst().dropLast()) } ?? "\"\""
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
            replyHandler(nil, "Bad message from the page."); return
        }
        let args = body["args"] as? [String: Any] ?? [:]
        do {
            switch method {
            case "codes":
                let text = args["text"] as? String ?? ""
                replyHandler(["qr": Codes.pngDataURL(Codes.qrImage(text)) ?? "",
                              "code128": Codes.pngDataURL(Codes.code128Image(text)) ?? ""], nil)
            case "scanner.start":
                scanner.start { err in replyHandler(["running": err == nil], err) }
            case "scanner.stop":
                scanner.stop(); replyHandler(["running": false], nil)
            case "print":
                printPage(); replyHandler(["ok": true], nil)
            case "export":
                let dir = try store.exportAll(to: exportsFolder())
                NSWorkspace.shared.activateFileViewerSelecting([dir])
                replyHandler(["folder": dir.path], nil)
            case "backup":
                let file = try store.backupNow()
                NSWorkspace.shared.activateFileViewerSelecting([file])
                replyHandler(["file": file.path], nil)
            case "reports.export":
                let file = try store.exportReport(args, to: exportsFolder())
                NSWorkspace.shared.activateFileViewerSelecting([file])
                replyHandler(["file": file.path], nil)
            case "items.template":
                let url = exportsFolder().appendingPathComponent("HopeKitchen_items_template.csv")
                try FileManager.default.createDirectory(at: exportsFolder(), withIntermediateDirectories: true)
                try "SKU,Name,Category,Unit,Stock,MinLevel,ParLevel,Price,Supplier,Location,Barcode\n,Roma Tomatoes,Produce,lbs,50,20,40,1.20,Local farm,Walk-in A,\n"
                    .write(to: url, atomically: true, encoding: .utf8)
                NSWorkspace.shared.activateFileViewerSelecting([url])
                replyHandler(["file": url.path], nil)
            case "about":
                replyHandler(["version": appVersion, "dataPath": store.db.path, "schema": store.schemaVersion()], nil)
            default:
                let result = try store.handle(method, args)
                replyHandler(result, nil)
            }
        } catch let e as AppError {
            replyHandler(nil, e.message)
        } catch {
            replyHandler(nil, "Something went wrong: \(error.localizedDescription)")
        }
    }

    private func printPage() {
        guard let web = webView, let window = web.window else { return }
        let info = NSPrintInfo.shared.copy() as! NSPrintInfo
        info.topMargin = 18; info.bottomMargin = 18; info.leftMargin = 18; info.rightMargin = 18
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        let op = web.printOperation(with: info)
        op.view?.frame = web.bounds
        op.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var bridge: Bridge!
    var store: Store!
    var snapshotPath: String?
    var evalScript: String?
    var forcedAppearance: NSAppearance?

    func applicationDidFinishLaunching(_ notification: Notification) {
        do { store = try Store(dataDir: dataDirectory()) } catch {
            let alert = NSAlert()
            alert.messageText = "Hope Kitchen can't open its data"
            alert.informativeText = "\(error)"
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        store.dailyBackupIfDue()
        bridge = Bridge(store: store)

        let config = WKWebViewConfiguration()
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "hk")
        if snapshotPath != nil {
            // A hidden window does not tick CSS animations; snapshots show the end state instead.
            let css = "*,*::before,*::after{animation:none!important;transition:none!important}"
            config.userContentController.addUserScript(WKUserScript(
                source: "document.head.appendChild(Object.assign(document.createElement('style'),{textContent:'\(css)'}))",
                injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        bridge.webView = web

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Hope Kitchen"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 980, height: 640)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("HopeKitchenMain")
        window.appearance = forcedAppearance
        if let forcedAppearance { NSApp.appearance = forcedAppearance; web.appearance = forcedAppearance }
        if snapshotPath == nil { window.makeKeyAndOrderFront(nil) } else {
            // Nearly invisible but on screen, so CSS animations and timers run as they do for a person.
            window.alphaValue = 0.02
            window.orderFrontRegardless()
        }
        buildMenu()

        let ui = uiDirectory()
        web.loadFileURL(ui.appendingPathComponent("index.html"), allowingReadAccessTo: ui)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // --snapshot PATH [--eval JS]: render the real window to a PNG and quit (how agents check the UI).
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let path = snapshotPath else { return }
        window.setFrame(NSRect(x: 0, y: 0, width: 1280, height: 820), display: true)
        let run = { (done: @escaping () -> Void) in
            if let js = self.evalScript {
                webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
                    if case .failure(let e) = r { FileHandle.standardError.write("eval failed: \(e)\n".data(using: .utf8)!) }
                    if case .success(let v) = r { print("eval: \(v)") }
                    done()
                }
            } else { done() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            run {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                    webView.takeSnapshot(with: nil) { img, err in
                        if let img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                           let png = rep.representation(using: .png, properties: [:]) {
                            try? png.write(to: URL(fileURLWithPath: path))
                            print("snapshot: \(path)")
                        } else {
                            FileHandle.standardError.write("snapshot failed: \(String(describing: err))\n".data(using: .utf8)!)
                        }
                        NSApp.terminate(nil)
                    }
                }
            }
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.runModal(); completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = parameters.allowsMultipleSelection
        p.allowedContentTypes = [.commaSeparatedText, .plainText]
        completionHandler(p.runModal() == .OK ? p.urls : nil)
    }

    private func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Hope Kitchen", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Hope Kitchen", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Hope Kitchen", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        NSApp.mainMenu = main
    }
}

// MARK: - Command line


let args = CommandLine.arguments
if args.contains("--selftest") { exit(selfTest()) }
if let i = args.firstIndex(of: "--perftest") { exit(perfTest(items: i + 1 < args.count ? Int(args[i + 1]) ?? 5000 : 5000)) }
if args.contains("--version") { print("Hope Kitchen \(appVersion)"); exit(0) }

let app = NSApplication.shared
let delegate = AppDelegate()
if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count { delegate.snapshotPath = args[i + 1] }
if let i = args.firstIndex(of: "--eval"), i + 1 < args.count { delegate.evalScript = args[i + 1] }
if let i = args.firstIndex(of: "--appearance"), i + 1 < args.count {
    delegate.forcedAppearance = NSAppearance(named: args[i + 1] == "light" ? .aqua : .darkAqua)
}
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
