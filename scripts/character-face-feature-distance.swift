import Foundation
import Vision
import ImageIO

// Compare the front-panel faces of two horizontal three-view sheets. The
// result is diagnostic evidence, not a historical or artistic judgment.
func frontFace(_ file: String) throws -> (CGImage, [String: Double]) {
    let url = URL(fileURLWithPath: file)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          image.width >= 192, image.height >= 64,
          Double(image.width) / Double(image.height) >= 1.5 else {
        throw NSError(domain: "face-feature", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid horizontal three-view sheet"])
    }
    let panelWidth = image.width / 3
    guard let panel = image.cropping(to: CGRect(x: 0, y: 0, width: panelWidth, height: image.height)) else {
        throw NSError(domain: "face-feature", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot crop front panel"])
    }
    let detection = VNDetectFaceLandmarksRequest()
    try VNImageRequestHandler(cgImage: panel, options: [:]).perform([detection])
    guard let faces = detection.results, faces.count == 1, let face = faces.first,
          face.confidence >= 0.7, abs(face.yaw?.doubleValue ?? 0) <= 0.3 else {
        throw NSError(domain: "face-feature", code: 3, userInfo: [NSLocalizedDescriptionKey: "No unique reliable front face"])
    }
    let box = face.boundingBox
    let fw = Double(panel.width), fh = Double(panel.height)
    let x = Double(box.minX) * fw, y = (1 - Double(box.maxY)) * fh
    let w = Double(box.width) * fw, h = Double(box.height) * fh
    // Hairline through chin, with a narrow surround; keep costume out.
    let left = max(0, Int(floor(x - 0.38 * w)))
    let top = max(0, Int(floor(y - 0.55 * h)))
    let right = min(panel.width, Int(ceil(x + 1.38 * w)))
    let bottom = min(panel.height, Int(ceil(y + 1.12 * h)))
    guard right - left >= 64, bottom - top >= 64,
          let crop = panel.cropping(to: CGRect(x: left, y: top, width: right - left, height: bottom - top)) else {
        throw NSError(domain: "face-feature", code: 4, userInfo: [NSLocalizedDescriptionKey: "Front face crop too small"])
    }
    return (crop, ["confidence": Double(face.confidence), "x": Double(left), "y": Double(top), "width": Double(right - left), "height": Double(bottom - top)])
}

do {
    guard CommandLine.arguments.count == 3 else {
        throw NSError(domain: "face-feature", code: 5, userInfo: [NSLocalizedDescriptionKey: "Expected two local image paths"])
    }
    let (source, sourceBounds) = try frontFace(CommandLine.arguments[1])
    let (target, targetBounds) = try frontFace(CommandLine.arguments[2])
    let sourceRequest = VNGenerateImageFeaturePrintRequest()
    let targetRequest = VNGenerateImageFeaturePrintRequest()
    try VNImageRequestHandler(cgImage: source, options: [:]).perform([sourceRequest])
    try VNImageRequestHandler(cgImage: target, options: [:]).perform([targetRequest])
    guard let a = sourceRequest.results?.first, let b = targetRequest.results?.first else {
        throw NSError(domain: "face-feature", code: 6, userInfo: [NSLocalizedDescriptionKey: "Cannot compute face feature print"])
    }
    var distance: Float = 0
    try a.computeDistance(&distance, to: b)
    let value: [String: Any] = ["detector": "macos-vision-image-feature-v1", "distance": Double(distance), "sourceFace": sourceBounds, "targetFace": targetBounds]
    let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: bytes, encoding: .utf8)!)
} catch {
    fputs("FACIAL_IDENTITY_COMPARISON_UNAVAILABLE: \(error.localizedDescription)\n", stderr)
    exit(1)
}
