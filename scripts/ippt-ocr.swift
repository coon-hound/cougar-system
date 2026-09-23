import Foundation
import Vision
import ImageIO
// Usage: ocr img1 img2 ... -> one JSON line per image {file, items:[{text, conf, x, y, w, h}]}
// Coordinates are normalized to [0,1], origin top-left.
for path in CommandLine.arguments.dropFirst() {
  let url = URL(fileURLWithPath: path)
  guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
        let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    FileHandle.standardError.write("cannot load \(path)\n".data(using: .utf8)!); exit(2)
  }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false
  do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req]) }
  catch { FileHandle.standardError.write("vision failed \(path): \(error)\n".data(using: .utf8)!); exit(3) }
  var items: [[String: Any]] = []
  for o in req.results ?? [] {
    guard let c = o.topCandidates(1).first else { continue }
    let b = o.boundingBox
    items.append(["text": c.string, "conf": Double(c.confidence), "x": Double(b.minX), "y": Double(1 - b.maxY), "w": Double(b.width), "h": Double(b.height)])
  }
  let obj: [String: Any] = ["file": url.lastPathComponent, "items": items]
  print(String(data: try! JSONSerialization.data(withJSONObject: obj), encoding: .utf8)!)
}
