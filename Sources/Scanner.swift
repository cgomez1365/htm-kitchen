import AppKit
import AVFoundation
import Vision

/// Camera scanning: a small floating window with the live picture; Vision reads QR and barcodes from it.
final class Scanner: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, NSWindowDelegate {
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "hopekitchen.scanner")
    private var panel: NSPanel?
    private var lastCode = "", lastAt = Date.distantPast, lastFrame = Date.distantPast
    var onCode: ((String) -> Void)?
    var onStop: (() -> Void)?

    var isRunning: Bool { session.isRunning }

    func start(completion: @escaping (String?) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: completion(open())
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { ok in
                DispatchQueue.main.async { completion(ok ? self.open() : "Camera access was declined. Turn it on in System Settings → Privacy & Security → Camera.") }
            }
        default: completion("Camera access is off. Turn it on in System Settings → Privacy & Security → Camera, then try again.")
        }
    }

    private func open() -> String? {
        if session.isRunning { panel?.makeKeyAndOrderFront(nil); return nil }
        guard let device = AVCaptureDevice.default(for: .video) else { return "No camera found. Plug in a USB scanner or camera." }
        guard let input = try? AVCaptureDeviceInput(device: device) else { return "The camera is in use by another app." }
        session.beginConfiguration()
        session.inputs.forEach { session.removeInput($0) }
        session.outputs.forEach { session.removeOutput($0) }
        session.sessionPreset = .high
        guard session.canAddInput(input) else { session.commitConfiguration(); return "The camera could not be opened." }
        session.addInput(input)
        let out = AVCaptureVideoDataOutput()
        out.alwaysDiscardsLateVideoFrames = true
        out.setSampleBufferDelegate(self, queue: queue)
        if session.canAddOutput(out) { session.addOutput(out) }
        session.commitConfiguration()

        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 440, height: 330),
                        styleMask: [.titled, .closable, .resizable, .utilityWindow], backing: .buffered, defer: false)
        p.title = "Scanner — hold the label up to the camera"
        p.isFloatingPanel = true
        p.level = .floating
        p.delegate = self
        let view = NSView()
        view.wantsLayer = true
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        view.layer = CALayer()
        view.layer?.addSublayer(preview)
        preview.frame = view.bounds
        p.contentView = view
        preview.frame = view.bounds
        if let screen = NSScreen.main?.visibleFrame {
            p.setFrameOrigin(NSPoint(x: screen.maxX - 460, y: screen.maxY - 350))
        }
        p.orderFront(nil)
        panel = p
        queue.async { self.session.startRunning() }
        return nil
    }

    func stop() {
        queue.async { if self.session.isRunning { self.session.stopRunning() } }
        panel?.delegate = nil
        panel?.close()
        panel = nil
        onStop?()
    }

    func windowWillClose(_ notification: Notification) {
        panel = nil
        queue.async { if self.session.isRunning { self.session.stopRunning() } }
        onStop?()
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard Date().timeIntervalSince(lastFrame) > 0.12, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastFrame = Date()
        let req = VNDetectBarcodesRequest()
        req.symbologies = Codes.symbologies
        try? VNImageRequestHandler(cvPixelBuffer: pixels, options: [:]).perform([req])
        guard let code = req.results?.compactMap({ $0.payloadStringValue }).first else { return }
        // The same label held in front of the camera is one scan, not twenty.
        if code == lastCode && Date().timeIntervalSince(lastAt) < 2.0 { return }
        lastCode = code
        lastAt = Date()
        DispatchQueue.main.async { NSSound(named: "Tink")?.play(); self.onCode?(code) }
    }
}
