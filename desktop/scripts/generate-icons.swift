import Cocoa

let desktopDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().path
let assetsDir = "\(desktopDir)/assets"
let iconsetDir = "\(assetsDir)/icon.iconset"

try? FileManager.default.createDirectory(atPath: assetsDir, withIntermediateDirectories: true)
try? FileManager.default.createDirectory(atPath: iconsetDir, withIntermediateDirectories: true)

let appIconSvg = """
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <!-- Background Squircle Gradient -->
    <linearGradient id="bgPlate" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#20293a" />
      <stop offset="35%" stop-color="#141a26" />
      <stop offset="100%" stop-color="#090c12" />
    </linearGradient>

    <!-- Squircle Border Highlight -->
    <linearGradient id="plateBorder" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.25" />
      <stop offset="25%" stop-color="#ffffff" stop-opacity="0.08" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.02" />
    </linearGradient>

    <!-- Main Loop Metal Gradient -->
    <linearGradient id="loopFrameGrad" x1="15%" y1="10%" x2="85%" y2="90%">
      <stop offset="0%" stop-color="#f8fafc" />
      <stop offset="20%" stop-color="#e2e8f0" />
      <stop offset="55%" stop-color="#94a3b8" />
      <stop offset="100%" stop-color="#475569" />
    </linearGradient>

    <!-- Main Loop Inner Bevel Highlight -->
    <linearGradient id="loopInnerBevel" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.0" />
    </linearGradient>

    <!-- Accent Node Gradient (Vibrant Royal Tech Blue) -->
    <linearGradient id="accentBlue" x1="15%" y1="10%" x2="85%" y2="90%">
      <stop offset="0%" stop-color="#60a5fa" />
      <stop offset="35%" stop-color="#3b82f6" />
      <stop offset="70%" stop-color="#2563eb" />
      <stop offset="100%" stop-color="#1d4ed8" />
    </linearGradient>

    <!-- Accent Top Bevel Highlight -->
    <linearGradient id="accentTopBevel" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.6" />
      <stop offset="60%" stop-color="#ffffff" stop-opacity="0.0" />
    </linearGradient>

    <!-- Ambient Blue Glow behind Accent Node -->
    <radialGradient id="ambientGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.32" />
      <stop offset="50%" stop-color="#2563eb" stop-opacity="0.12" />
      <stop offset="100%" stop-color="#1d4ed8" stop-opacity="0.0" />
    </radialGradient>

    <!-- Plate Multi-Layer Drop Shadow -->
    <filter id="shadowFilter" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="26" stdDeviation="30" flood-color="#000000" flood-opacity="0.45" />
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000000" flood-opacity="0.3" />
    </filter>

    <!-- Accent Block Drop Shadow -->
    <filter id="accentShadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#000000" flood-opacity="0.55" />
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000000" flood-opacity="0.35" />
      <feDropShadow dx="0" dy="0" stdDeviation="24" flood-color="#3b82f6" flood-opacity="0.35" />
    </filter>
  </defs>

  <!-- 1. Apple macOS Squircle Plate -->
  <g filter="url(#shadowFilter)">
    <rect x="104" y="104" width="816" height="816" rx="185" fill="url(#bgPlate)" />
  </g>
  <rect x="105" y="105" width="814" height="814" rx="184" fill="none" stroke="url(#plateBorder)" stroke-width="2" />

  <!-- Ambient Radial Glow in the lower-right area -->
  <circle cx="674" cy="674" r="260" fill="url(#ambientGlow)" />

  <!-- 2. Main Loop Square Body (The autoloop workspace frame) -->
  <g id="main-frame">
    <!-- Frame Drop Shadow -->
    <rect x="264" y="264" width="420" height="420" rx="106"
          fill="none"
          stroke="#000000"
          stroke-opacity="0.35"
          stroke-width="46"
          transform="translate(0, 10)" />

    <!-- Loop Frame Main Stroke -->
    <rect x="264" y="264" width="420" height="420" rx="106"
          fill="none"
          stroke="url(#loopFrameGrad)"
          stroke-width="44"
          stroke-linejoin="round" />

    <!-- Delicate Inner Bevel Highlight Line -->
    <rect x="286" y="286" width="376" height="376" rx="84"
          fill="none"
          stroke="url(#loopInnerBevel)"
          stroke-width="1.8" />
  </g>

  <!-- 3. Accent Block Separation Trench (Trench Cutout) -->
  <rect x="566" y="566" width="228" height="228" rx="68"
        fill="#141a26" />
  <rect x="567" y="567" width="226" height="226" rx="67"
        fill="none"
        stroke="#000000"
        stroke-opacity="0.4"
        stroke-width="2" />

  <!-- 4. Accent Action Node ("工作有进展，决策找你") -->
  <g filter="url(#accentShadow)">
    <rect x="586" y="586" width="188" height="188" rx="48"
          fill="url(#accentBlue)" />
    <!-- Top Highlight Bevel -->
    <rect x="587.5" y="587.5" width="185" height="185" rx="46.5"
          fill="none"
          stroke="url(#accentTopBevel)"
          stroke-width="2.5" />
  </g>
</svg>
"""

let symbolSvg = """
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="symFrameGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#94a3b8" />
      <stop offset="100%" stop-color="#475569" />
    </linearGradient>
    <linearGradient id="symAccentGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4c8dff" />
      <stop offset="100%" stop-color="#255bb7" />
    </linearGradient>
  </defs>
  <!-- Main Loop Frame -->
  <rect x="56" y="56" width="320" height="320" rx="80"
        fill="none" stroke="url(#symFrameGrad)" stroke-width="36" />
  <!-- Trench Cutout -->
  <rect x="272" y="272" width="184" height="184" rx="52"
        fill="#ffffff" />
  <!-- Accent Block -->
  <rect x="290" y="290" width="148" height="148" rx="38"
        fill="url(#symAccentGrad)" />
</svg>
"""

try! appIconSvg.write(toFile: "\(assetsDir)/icon.svg", atomically: true, encoding: .utf8)
try! symbolSvg.write(toFile: "\(assetsDir)/icon-symbol.svg", atomically: true, encoding: .utf8)

guard let svgData = appIconSvg.data(using: .utf8),
      let image = NSImage(data: svgData) else {
  print("Failed to load SVG into NSImage")
  exit(1)
}

func renderPNG(image: NSImage, size: Int, outPath: String) {
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: size,
    pixelsHigh: size,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  )!
  rep.size = NSSize(width: size, height: size)

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  image.draw(in: NSRect(x: 0, y: 0, width: size, height: size),
             from: .zero,
             operation: .copy,
             fraction: 1.0)
  NSGraphicsContext.restoreGraphicsState()

  if let pngData = rep.representation(using: .png, properties: [:]) {
    try? pngData.write(to: URL(fileURLWithPath: outPath))
  }
}

let directSizes = [1024, 512, 256, 128, 64, 32, 16]
for s in directSizes {
  renderPNG(image: image, size: s, outPath: "\(assetsDir)/icon_\(s)x\(s).png")
}
try? FileManager.default.removeItem(atPath: "\(assetsDir)/icon.png")
try? FileManager.default.copyItem(atPath: "\(assetsDir)/icon_1024x1024.png", toPath: "\(assetsDir)/icon.png")

let iconsetMap: [(String, Int)] = [
  ("icon_16x16.png", 16),
  ("icon_16x16@2x.png", 32),
  ("icon_32x32.png", 32),
  ("icon_32x32@2x.png", 64),
  ("icon_128x128.png", 128),
  ("icon_128x128@2x.png", 256),
  ("icon_256x256.png", 256),
  ("icon_256x256@2x.png", 512),
  ("icon_512x512.png", 512),
  ("icon_512x512@2x.png", 1024)
]

for (filename, size) in iconsetMap {
  renderPNG(image: image, size: size, outPath: "\(iconsetDir)/\(filename)")
}

print("Icon assets and iconset rendered successfully.")
