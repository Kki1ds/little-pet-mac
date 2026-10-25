import AVFoundation
import CoreVideo
import Foundation
import VideoToolbox

enum EncoderError: Error, CustomStringConvertible {
    case invalidArguments
    case cannotCreatePixelBuffer
    case emptyInput
    case partialFrame(Int)
    case writerFailed(String)

    var description: String {
        switch self {
        case .invalidArguments:
            return "usage: hevc-alpha-encoder <output.mov> <width> <height> <fps> [quality alphaQuality]"
        case .cannotCreatePixelBuffer:
            return "failed to create a BGRA pixel buffer"
        case .emptyInput:
            return "stdin did not contain any complete BGRA frames"
        case .partialFrame(let bytes):
            return "stdin ended with a partial BGRA frame (\(bytes) bytes)"
        case .writerFailed(let message):
            return "HEVC-alpha writer failed: \(message)"
        }
    }
}

func readFrame(from handle: FileHandle, size: Int) throws -> Data? {
    var frame = Data()
    frame.reserveCapacity(size)

    while frame.count < size {
        let chunk = handle.readData(ofLength: size - frame.count)
        if chunk.isEmpty {
            if frame.isEmpty { return nil }
            throw EncoderError.partialFrame(frame.count)
        }
        frame.append(chunk)
    }
    return frame
}

func waitUntilReady(_ input: AVAssetWriterInput, writer: AVAssetWriter) throws {
    while !input.isReadyForMoreMediaData {
        if writer.status == .failed || writer.status == .cancelled {
            throw EncoderError.writerFailed(writer.error?.localizedDescription ?? "unknown error")
        }
        Thread.sleep(forTimeInterval: 0.001)
    }
}

func encode() throws {
    let args = CommandLine.arguments
    guard args.count == 5 || args.count == 7,
          let width = Int(CommandLine.arguments[2]), width > 0,
          let height = Int(CommandLine.arguments[3]), height > 0,
          let fps = Int32(CommandLine.arguments[4]), fps > 0 else {
        throw EncoderError.invalidArguments
    }
    // Lossy alpha shows up as speckles along the character's edges, so keep it high.
    let quality = args.count == 7 ? Double(args[5]) ?? 0.75 : 0.75
    let alphaQuality = args.count == 7 ? Double(args[6]) ?? 0.75 : 0.75

    let outputURL = URL(fileURLWithPath: CommandLine.arguments[1])
    try? FileManager.default.removeItem(at: outputURL)

    let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
    // moov atom first: the pet host serves files without Range support.
    writer.shouldOptimizeForNetworkUse = true
    let compression: [String: Any] = [
        AVVideoQualityKey: quality,
        kVTCompressionPropertyKey_TargetQualityForAlpha as String: alphaQuality,
    ]
    let settings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.hevcWithAlpha,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: compression,
        // The encoder always converts to YUV with BT.709, so the matrix tag must say 709
        // (a 601 tag turned everything blue). Transfer sRGB matches how Chromium shows the
        // untagged webm clips (a 709 transfer tag looked too bright). Measured on the Mac.
        AVVideoColorPropertiesKey: [
            AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
            AVVideoTransferFunctionKey: "IEC_sRGB",
            AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
        ],
    ]
    guard writer.canApply(outputSettings: settings, forMediaType: .video) else {
        throw EncoderError.writerFailed("this Mac cannot encode HEVC with alpha")
    }

    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    let attributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:],
    ]
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
        assetWriterInput: input,
        sourcePixelBufferAttributes: attributes
    )

    guard writer.canAdd(input) else {
        throw EncoderError.writerFailed("could not add video input")
    }
    writer.add(input)
    guard writer.startWriting() else {
        throw EncoderError.writerFailed(writer.error?.localizedDescription ?? "could not start writer")
    }
    writer.startSession(atSourceTime: .zero)

    let packedBytesPerRow = width * 4
    let frameSize = packedBytesPerRow * height
    var frameIndex: Int64 = 0

    while let frame = try readFrame(from: .standardInput, size: frameSize) {
        try waitUntilReady(input, writer: writer)

        guard let pool = adaptor.pixelBufferPool else {
            throw EncoderError.cannotCreatePixelBuffer
        }
        var maybeBuffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &maybeBuffer) == kCVReturnSuccess,
              let pixelBuffer = maybeBuffer else {
            throw EncoderError.cannotCreatePixelBuffer
        }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        guard let destination = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
            throw EncoderError.cannotCreatePixelBuffer
        }
        let destinationBytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        frame.withUnsafeBytes { sourceBytes in
            guard let source = sourceBytes.baseAddress else { return }
            for row in 0..<height {
                memcpy(
                    destination.advanced(by: row * destinationBytesPerRow),
                    source.advanced(by: row * packedBytesPerRow),
                    packedBytesPerRow
                )
            }
        }
        CVPixelBufferUnlockBaseAddress(pixelBuffer, [])

        let timestamp = CMTime(value: frameIndex, timescale: fps)
        guard adaptor.append(pixelBuffer, withPresentationTime: timestamp) else {
            throw EncoderError.writerFailed(writer.error?.localizedDescription ?? "could not append frame")
        }
        frameIndex += 1
    }

    guard frameIndex > 0 else { throw EncoderError.emptyInput }
    input.markAsFinished()

    let semaphore = DispatchSemaphore(value: 0)
    writer.finishWriting { semaphore.signal() }
    semaphore.wait()

    guard writer.status == .completed else {
        throw EncoderError.writerFailed(writer.error?.localizedDescription ?? "unknown error")
    }
    FileHandle.standardError.write(Data("encoded \(frameIndex) frames to \(outputURL.path)\n".utf8))
}

do {
    try encode()
} catch {
    FileHandle.standardError.write(Data("hevc-alpha-encoder: \(error)\n".utf8))
    exit(1)
}

