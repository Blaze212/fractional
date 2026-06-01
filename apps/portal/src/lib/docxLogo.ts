import PizZip from 'pizzip'

// Must match what the prepare-template scripts write into the .docx templates.
const PLACEHOLDER_NAME = 'company_logo_placeholder'
const PLACEHOLDER_MEDIA_PATH = 'word/media/company_logo_placeholder.png'
const HEADER_PATHS = ['word/header1.xml', 'word/header2.xml']

// 1 inch = 914400 EMU; logo capped at 0.5 in height
const MAX_LOGO_HEIGHT_EMU = Math.round(0.5 * 914400)

export type LogoDimensions = { widthPx: number; heightPx: number }

export function logoEmu(dims: LogoDimensions): [number, number] {
  const cy = MAX_LOGO_HEIGHT_EMU
  const cx = Math.round(cy * (dims.widthPx / dims.heightPx))
  return [cx, cy]
}

// Replace the placeholder image bytes and update its extent in the header(s).
// The anchor positioning XML is already set correctly in the template.
export function injectLogo(zip: PizZip, logoBytes: Uint8Array, cx: number, cy: number): void {
  zip.file(PLACEHOLDER_MEDIA_PATH, logoBytes)

  for (const headerPath of HEADER_PATHS) {
    const headerXml = zip.files[headerPath]?.asText()
    if (!headerXml) continue

    const nameMarker = `name="${PLACEHOLDER_NAME}"`
    const markerIdx = headerXml.indexOf(nameMarker)
    if (markerIdx === -1) continue

    const drawingStart = headerXml.lastIndexOf('<w:drawing>', markerIdx)
    const drawingEnd = headerXml.indexOf('</w:drawing>', markerIdx) + '</w:drawing>'.length
    const drawing = headerXml.slice(drawingStart, drawingEnd)

    const updatedDrawing = drawing
      .replace(/(<wp:extent\s[^/]*?)cx="[^"]*"([^/]*?)cy="[^"]*"/g, `$1cx="${cx}"$2cy="${cy}"`)
      .replace(/(<a:ext\s[^/]*?)cx="[^"]*"([^/]*?)cy="[^"]*"/g, `$1cx="${cx}"$2cy="${cy}"`)

    zip.file(
      headerPath,
      headerXml.slice(0, drawingStart) + updatedDrawing + headerXml.slice(drawingEnd),
    )
  }
}
