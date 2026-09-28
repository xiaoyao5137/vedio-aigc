import Foundation
import Vision
import ImageIO

// Offline detection only. Coordinates are normalized to the input front panel,
// with top-left origin, so the server can derive an upper-face identity crop.
do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "face-anchor", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected one local front-panel image"]) }
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw NSError(domain: "face-anchor", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot decode front panel"]) }
    let request = VNDetectFaceLandmarksRequest()
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    let faces: [[String: Any]] = (request.results ?? []).map { face in
        let box = face.boundingBox
        func points(_ region: VNFaceLandmarkRegion2D?) -> [[String: Double]] {
            guard let region = region else { return [] }
            return region.normalizedPoints.map { point in
                ["x": Double(box.minX + CGFloat(point.x) * box.width), "y": Double(1 - (box.minY + CGFloat(point.y) * box.height))]
            }
        }
        return ["confidence": Double(face.confidence), "yaw": face.yaw?.doubleValue ?? 0,
            "bounds": ["x": Double(box.minX), "y": Double(1 - box.maxY), "width": Double(box.width), "height": Double(box.height)],
            "leftEye": points(face.landmarks?.leftEye), "rightEye": points(face.landmarks?.rightEye),
            "leftEyebrow": points(face.landmarks?.leftEyebrow), "rightEyebrow": points(face.landmarks?.rightEyebrow), "nose": points(face.landmarks?.nose)]
    }
    let result: [String: Any] = ["detector": "macos-vision-landmarks-v1", "faces": faces]
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
} catch {
    fputs("FACIAL_IDENTITY_ANCHOR_UNAVAILABLE: \(error.localizedDescription)\n", stderr)
    exit(1)
}
