/**
 * One-time patch: after editing submittal-template.docx in Word, Word renames
 * the placeholder image (company_logo_placeholder.png → image1.png) and updates
 * the name attributes in the header XML. This script restores the expected names
 * so injectLogo (docxLogo.ts) can find and replace the placeholder at export time.
 *
 * Run: pnpm patch-submittal-template
 */
import PizZip from 'pizzip'
import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const templatePath = resolve(ROOT, 'apps/portal/public/submittal-template.docx')

const PLACEHOLDER_NAME = 'company_logo_placeholder'
const PLACEHOLDER_MEDIA_PATH = `word/media/${PLACEHOLDER_NAME}.png`
const HEADER_RELS_PATHS = ['word/_rels/header1.xml.rels', 'word/_rels/header2.xml.rels']
const HEADER_PATHS = ['word/header1.xml', 'word/header2.xml']

const buf = readFileSync(templatePath)
const zip = new PizZip(buf)

// Find the actual image file in word/media/ and rename it to the expected name.
const mediaFiles = Object.keys(zip.files).filter((f) => f.startsWith('word/media/'))
console.log('Media files found:', mediaFiles)

// Rename any media file that is NOT already named correctly to the placeholder name.
// We expect exactly one image in word/media/.
const imagesToRename = mediaFiles.filter((f) => f !== PLACEHOLDER_MEDIA_PATH)
if (imagesToRename.length === 0) {
  console.log('Placeholder image already correctly named — checking header XML...')
} else if (imagesToRename.length > 1) {
  console.warn('Multiple non-placeholder images found; renaming the first one:', imagesToRename[0])
}

const oldImagePath = imagesToRename[0]
if (oldImagePath) {
  const oldName = oldImagePath.replace('word/media/', '')
  const imageBytes = zip.files[oldImagePath].asBinary()
  zip.remove(oldImagePath)
  zip.file(PLACEHOLDER_MEDIA_PATH, imageBytes, { binary: true })
  console.log(`Renamed ${oldImagePath} → ${PLACEHOLDER_MEDIA_PATH}`)

  // Fix header rels: update Target attribute to point to the new name.
  for (const relsPath of HEADER_RELS_PATHS) {
    const relsFile = zip.files[relsPath]
    if (!relsFile) continue
    const xml = relsFile.asText()
    const patched = xml.replaceAll(`media/${oldName}`, `media/${PLACEHOLDER_NAME}.png`)
    if (patched !== xml) {
      zip.file(relsPath, patched)
      console.log(`Patched ${relsPath}`)
    }
  }

  // Fix header XML: rename wp:docPr name and pic:cNvPr name attributes.
  for (const headerPath of HEADER_PATHS) {
    const headerFile = zip.files[headerPath]
    if (!headerFile) continue
    const xml = headerFile.asText()
    // Replace name="image1.png" (or whatever Word used) with name="company_logo_placeholder"
    // in both wp:docPr and pic:cNvPr elements that have the old name.
    const oldQuotedName = `name="${oldName}"`
    const newQuotedName = `name="${PLACEHOLDER_NAME}"`
    const patched = xml.replaceAll(oldQuotedName, newQuotedName)
    if (patched !== xml) {
      zip.file(headerPath, patched)
      console.log(`Patched ${headerPath}: replaced ${oldQuotedName} → ${newQuotedName}`)
    }
  }
}

const out = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' })
writeFileSync(templatePath, out)
console.log(`Template patched and written to ${templatePath}`)
