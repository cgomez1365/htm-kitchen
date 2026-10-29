import AppKit
import CoreImage
import Vision

/// Label codes are made on this Mac by Core Image: no web service, no font, works offline.
enum Codes {
    private static let context = CIContext()

    static func qrImage(_ text: String, scale: CGFloat = 12) -> CGImage? {
        guard let f = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        f.setValue(Data(text.utf8), forKey: "inputMessage")
        f.setValue("M", forKey: "inputCorrectionLevel")
        return render(f.outputImage, scale: scale)
    }

    /// Code 128 so a plain 1D barcode gun reads the same label as a QR scanner.
    static func code128Image(_ text: String, scale: CGFloat = 3) -> CGImage? {
        guard let f = CIFilter(name: "CICode128BarcodeGenerator"), let data = text.data(using: .ascii) else { return nil }
        f.setValue(data, forKey: "inputMessage")
        f.setValue(7.0, forKey: "inputQuietSpace")
        return render(f.outputImage, scale: scale)
    }

    private static func render(_ image: CIImage?, scale: CGFloat) -> CGImage? {
        guard let img = image?.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) else { return nil }
        return context.createCGImage(img, from: img.extent)
    }

    static func pngDataURL(_ image: CGImage?) -> String? {
        guard let image, let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { return nil }
        return "data:image/png;base64," + png.base64EncodedString()
    }

    static let symbologies: [VNBarcodeSymbology] = [.qr, .code128, .ean13, .ean8, .upce, .code39, .dataMatrix]

    /// The same decoder the camera uses, run on a still image. The self-test reads back what it printed.
    static func decode(_ image: CGImage) -> [String] {
        let req = VNDetectBarcodesRequest()
        req.symbologies = symbologies
        try? VNImageRequestHandler(cgImage: image, options: [:]).perform([req])
        return (req.results ?? []).compactMap { $0.payloadStringValue }
    }
}
