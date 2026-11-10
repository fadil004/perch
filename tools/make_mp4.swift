// swiftc -O make_mp4.swift -o make_mp4 ; ./make_mp4 out.mp4 thumb.png W H hue seconds
import AVFoundation
import CoreGraphics
import CoreVideo
import ImageIO
import UniformTypeIdentifiers
import Foundation

let a = CommandLine.arguments
guard a.count >= 7 else { print("usage"); exit(2) }
let outURL = URL(fileURLWithPath: a[1]), thumbURL = URL(fileURLWithPath: a[2])
let W = Int(a[3])!, H = Int(a[4])!, hue = Double(a[5])!, secs = Double(a[6])!
let fps = 24, frames = Int(secs * Double(fps))

func hsv(_ h: Double, _ s: Double, _ v: Double) -> CGColor {
    let hh = (h - floor(h)) * 6, i = Int(hh), f = hh - Double(i)
    let p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f))
    let c: (Double, Double, Double)
    switch i % 6 { case 0: c = (v, t, p); case 1: c = (q, v, p); case 2: c = (p, v, t); case 3: c = (p, q, v); case 4: c = (t, p, v); default: c = (v, p, q) }
    return CGColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
}

func draw(_ ctx: CGContext, _ w: Int, _ h: Int, _ t: Double) {
    let cs = CGColorSpaceCreateDeviceRGB()
    let g = CGGradient(colorsSpace: cs, colors: [hsv(hue, 0.55, 0.95), hsv(hue + 0.12, 0.7, 0.45), hsv(hue + 0.25, 0.6, 0.12)] as CFArray, locations: [0, 0.55, 1])!
    ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: CGFloat(h)), end: CGPoint(x: CGFloat(w), y: 0), options: [])
    let m = CGFloat(min(w, h))
    for k in 0..<3 {
        let ph = t * 2 * Double.pi + Double(k) * 2.1
        let cx = CGFloat(w) * CGFloat(0.5 + 0.3 * cos(ph)), cy = CGFloat(h) * CGFloat(0.5 + 0.28 * sin(ph * 1.3))
        let r = m * CGFloat(0.22 + 0.06 * Double(k))
        ctx.setFillColor(hsv(hue + 0.08 * Double(k) + 0.5, 0.35, 1).copy(alpha: 0.55)!)
        ctx.fillEllipse(in: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r))
    }
    // No UI drawn into the frames: the orbiting shapes alone make playback and seeking visible.
}

// thumbnail (long side 320)
do {
    let s = 320.0 / Double(max(W, H)), tw = Int(Double(W) * s), th = Int(Double(H) * s)
    let ctx = CGContext(data: nil, width: tw, height: th, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    draw(ctx, tw, th, 0.35)
    let dest = CGImageDestinationCreateWithURL(thumbURL as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    CGImageDestinationFinalize(dest)
}

try? FileManager.default.removeItem(at: outURL)
let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: W, AVVideoHeightKey: H, AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 1_500_000, AVVideoMaxKeyFrameIntervalKey: 12]])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)
for f in 0..<frames {
    while !input.isReadyForMoreMediaData { usleep(1000) }
    var pb: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
    let buf = pb!
    CVPixelBufferLockBaseAddress(buf, [])
    let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf), width: W, height: H, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buf), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue)!
    draw(ctx, W, H, Double(f) / Double(frames))
    CVPixelBufferUnlockBaseAddress(buf, [])
    adaptor.append(buf, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: CMTimeScale(fps)))
}
input.markAsFinished()
let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()
print(writer.status == .completed ? "ok" : "fail \(String(describing: writer.error))")
