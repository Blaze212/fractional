/**
 * Debug script: replace all {{%company_logoN}} / {{%companyN}} placeholders in
 * debug_images.docx with colored icon variants so each slot is visually distinct.
 *
 * Placeholder → icon mapping:
 *   company_logo1 → icon1.png (red)     ← text placeholder, plain paragraph
 *   company_logo2 → icon2.png (blue)    ← text placeholder, plain paragraph
 *   company5      → icon5.png (purple)  ← text placeholder, inside anchored text box
 *   company_logo3 → icon3.png (green)   ← embedded image, alt-text path
 *   company_logo4 → icon4.png (orange)  ← embedded image, alt-text path
 *
 * Run: pnpm debug-images
 */
import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const ICONS_DIR = resolve(__dirname, 'debug-icons')
const PORTAL_REQUIRE = createRequire(resolve(ROOT, 'apps/portal/src/index.html'))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = PORTAL_REQUIRE('pizzip') as typeof import('pizzip')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Docxtemplater = PORTAL_REQUIRE('docxtemplater') as typeof import('docxtemplater')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ImageModule = PORTAL_REQUIRE('docxtemplater-image-module-free')

const ICON_MAP: Record<string, Buffer> = {
  company_logo1: readFileSync(resolve(ICONS_DIR, 'icon1.png')),
  company_logo2: readFileSync(resolve(ICONS_DIR, 'icon2.png')),
  company5: readFileSync(resolve(ICONS_DIR, 'icon5.png')),
  company_logo3: readFileSync(resolve(ICONS_DIR, 'icon3.png')),
  company_logo4: readFileSync(resolve(ICONS_DIR, 'icon4.png')),
}

// PNG IHDR: bytes 16-23 are width and height as big-endian uint32
function pngDimensions(buf: Buffer): { w: number; h: number } {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

const EMU_PER_PX = 914400 / 96

// Scan document XML for anchored drawings that contain a {{%tagName}} text run.
// Returns tagName → container cy in pixels so getSize can cap to it.
function containerHeightsByTag(docXml: string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const m of docXml.matchAll(/<w:drawing>([\s\S]*?)<\/w:drawing>/g)) {
    const drawing = m[1]
    const tagMatch = drawing.match(/\{\{%([^}]+)\}\}/)
    if (!tagMatch) continue
    const cyMatch = drawing.match(/<wp:extent[^>]*cy="(\d+)"/)
    if (cyMatch) {
      result[tagMatch[1]] = Math.round(parseInt(cyMatch[1], 10) / EMU_PER_PX)
    }
  }
  return result
}

function fitToHeight(w: number, h: number, maxH: number): [number, number] {
  if (h <= maxH) return [w, h]
  return [Math.round(w * (maxH / h)), maxH]
}

function tagNameFromPlaceholder(placeholder: string): string {
  return placeholder.replace(/^\{\{%/, '').replace(/\}\}$/, '')
}

// ── Path 2: replace embedded images whose descr alt-text matches {{%...}} ──

function injectAltTextImages(zip: InstanceType<typeof PizZip>): void {
  const RELS_PATH = 'word/_rels/document.xml.rels'
  const DOC_PATH = 'word/document.xml'

  const relsXml = zip.files[RELS_PATH]?.asText()
  let docXml = zip.files[DOC_PATH]?.asText()
  if (!relsXml || !docXml) return

  const rIdToMedia: Record<string, string> = {}
  for (const m of relsXml.matchAll(/Id="(rId\d+)"[^>]*Target="(media\/[^"]+)"/g)) {
    rIdToMedia[m[1]] = `word/${m[2]}`
  }

  const drawings = [...docXml.matchAll(/<w:drawing>([\s\S]*?)<\/w:drawing>/g)]
  const resolved = new Set<string>()

  for (const drawingMatch of drawings) {
    const drawingXml = drawingMatch[1]
    const descrMatch = drawingXml.match(/descr="(\{\{%[^"]+\}\})"/)
    if (!descrMatch) continue

    const placeholder = descrMatch[1]
    const tagName = tagNameFromPlaceholder(placeholder)
    const iconBytes = ICON_MAP[tagName]
    if (!iconBytes) {
      console.warn(`  No icon mapped for ${placeholder}`)
      continue
    }

    console.log(`  Found embedded image placeholder: ${placeholder}`)

    const rIdMatch = drawingXml.match(/r:embed="(rId\d+)"/)
    if (!rIdMatch) {
      console.warn(`    No r:embed found for ${placeholder}`)
      continue
    }
    const rId = rIdMatch[1]
    const mediaPath = rIdToMedia[rId]
    if (!mediaPath) {
      console.warn(`    No media path for ${rId}`)
      continue
    }

    const { w: iconW, h: iconH } = pngDimensions(iconBytes)
    console.log(`    rId=${rId}  media=${mediaPath}  icon=${iconW}×${iconH}`)
    zip.file(mediaPath, iconBytes)

    // Preserve original cy, recompute cx to match this icon's aspect ratio
    const cyMatch = drawingXml.match(/<wp:extent[^>]*cy="(\d+)"/)
    if (cyMatch) {
      const cy = parseInt(cyMatch[1], 10)
      const cx = Math.round(cy * (iconW / iconH))
      const origFull = drawingMatch[0]
      const updated = origFull
        .replace(/(<wp:extent\b[^>]*?)cx="[^"]*"/g, `$1cx="${cx}"`)
        .replace(/(<a:ext\b[^>]*?)cx="[^"]*"/g, `$1cx="${cx}"`)
        .replace(/descr="\{\{%[^"]+\}\}"/g, `descr="${tagName}"`)
      docXml = docXml.replace(origFull, updated)
    }
    resolved.add(placeholder)
  }

  zip.file(DOC_PATH, docXml)
  console.log(`  Resolved: ${[...resolved].join(', ')}`)
}

// ── Path 1: text-based {{%...}} via docxtemplater-image-module-free ──

const docxBytes = readFileSync(resolve(ROOT, 'debug_images.docx'))
const zip = new PizZip(docxBytes)

// Pre-scan before docxtemplater modifies the zip
const containerHeights = containerHeightsByTag(zip.files['word/document.xml']!.asText())
console.log('Container heights by tag (px):', containerHeights)

console.log('→ Path 2: replacing embedded images by alt-text descr...')
injectAltTextImages(zip)

console.log('→ Path 1: replacing text placeholders via docxtemplater image module...')
const imageModule = new ImageModule({
  centered: false,
  fileType: 'docx',
  getImage(_tagValue: string, tagName: string) {
    const bytes = ICON_MAP[tagName]
    if (!bytes) throw new Error(`No icon mapped for tag: ${tagName}`)
    return bytes
  },
  getSize(img: Buffer, _tagValue: string, tagName: string) {
    const { w, h } = pngDimensions(img)
    const maxH = containerHeights[tagName]
    const [fw, fh] = maxH ? fitToHeight(w, h, maxH) : [w, h]
    console.log(
      `  ${tagName}: native ${w}×${h}${maxH ? ` → capped to ${fw}×${fh} (box height ${maxH}px)` : ' (no container, using native size)'}`,
    )
    return [fw, fh]
  },
})

const doc = new Docxtemplater(zip, {
  modules: [imageModule],
  paragraphLoop: true,
  linebreaks: true,
  delimiters: { start: '{{', end: '}}' },
})

doc.render({
  company_logo1: 'icon1.png',
  company_logo2: 'icon2.png',
  company5: 'icon5.png',
})

const out = doc.getZip().generate({ type: 'nodebuffer' }) as Buffer
const outPath = resolve(ROOT, 'debug_images_out.docx')
writeFileSync(outPath, out)
console.log(`\nWritten: ${outPath}`)
execSync(`open "${outPath}"`)
