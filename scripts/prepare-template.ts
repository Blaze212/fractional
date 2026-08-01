/**
 * One-time script: adds an anchored logo placeholder image to the resume template header.
 * The placeholder is positioned top-right. At export time, only the image bytes + extent
 * are swapped — the anchor positioning is preserved from this template.
 *
 * Run: pnpm prepare-template
 */
import PizZip from 'pizzip'
import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const PLACEHOLDER_NAME = 'company_logo_placeholder'
const PLACEHOLDER_RID = 'rIdLogo1'
const HEADERS = [
  { xml: 'word/header1.xml', rels: 'word/_rels/header1.xml.rels' },
  { xml: 'word/header2.xml', rels: 'word/_rels/header2.xml.rels' },
]
const MEDIA_PATH = `word/media/${PLACEHOLDER_NAME}.png`

// 1×1 transparent PNG
const TRANSPARENT_PNG = (() => {
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
})()

// 0.5 inch placeholder (square); width will be corrected at export time
const PLACEHOLDER_CX = 457200 // EMU
const PLACEHOLDER_CY = 457200 // EMU

function anchorXml(rId: string, name: string, cx: number, cy: number): string {
  return (
    `<w:drawing>` +
    `<wp:anchor distT="0" distB="0" distL="0" distR="0"` +
    ` simplePos="0" relativeHeight="251659264" behindDoc="0"` +
    ` locked="0" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/>` +
    `<wp:positionH relativeFrom="margin"><wp:align>right</wp:align></wp:positionH>` +
    `<wp:positionV relativeFrom="topMargin"><wp:posOffset>0</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:wrapNone/>` +
    `<wp:docPr id="101" name="${name}" descr="${name}"/>` +
    `<wp:cNvGraphicFramePr>` +
    `<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>` +
    `</wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr>` +
    `<pic:cNvPr id="101" name="${name}" descr="${name}"/>` +
    `<pic:cNvPicPr><a:picLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr>` +
    `</pic:nvPicPr>` +
    `<pic:blipFill>` +
    `<a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="${rId}"/>` +
    `<a:stretch xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:fillRect/></a:stretch>` +
    `</pic:blipFill>` +
    `<pic:spPr bwMode="auto">` +
    `<a:xfrm xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:noFill xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>` +
    `<a:ln xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:noFill/></a:ln>` +
    `</pic:spPr>` +
    `</pic:pic>` +
    `</a:graphicData>` +
    `</a:graphic>` +
    `</wp:anchor>` +
    `</w:drawing>`
  )
}

const srcPath = resolve(ROOT, 'apps/portal/public/fractional_resume_template_logo.docx')
const destPath = resolve(ROOT, 'apps/portal/public/template.docx')

const buf = readFileSync(srcPath)
const zip = new PizZip(buf)

// 1. Add transparent placeholder image
zip.file(MEDIA_PATH, TRANSPARENT_PNG)

const relsEntry =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="${PLACEHOLDER_RID}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${PLACEHOLDER_NAME}.png"/>` +
  `</Relationships>`

const drawing = anchorXml(PLACEHOLDER_RID, PLACEHOLDER_NAME, PLACEHOLDER_CX, PLACEHOLDER_CY)
const logoparagraph =
  `<w:p><w:pPr><w:jc w:val="right"/><w:rPr/></w:pPr><w:r><w:rPr/>` + drawing + `</w:r></w:p>`

for (const { xml: headerPath, rels: relsPath } of HEADERS) {
  // 2. Create/replace header rels file
  zip.file(relsPath, relsEntry)

  // 3. Add anchored drawing — replace {{%company_logo}} tag if present, otherwise append
  const headerXml = zip.files[headerPath].asText()
  const tagIdx = headerXml.indexOf('{{%company_logo}}')
  let newHeaderXml: string
  if (tagIdx !== -1) {
    const pStart = headerXml.lastIndexOf('<w:p ', tagIdx)
    const pEnd = headerXml.indexOf('</w:p>', tagIdx) + '</w:p>'.length
    newHeaderXml = headerXml.slice(0, pStart) + logoparagraph + headerXml.slice(pEnd)
  } else {
    // Insert before closing </w:hdr>
    newHeaderXml = headerXml.replace('</w:hdr>', logoparagraph + '</w:hdr>')
  }
  zip.file(headerPath, newHeaderXml)
}

// 4. Register PNG content type if not already present
const ctXml = zip.files['[Content_Types].xml'].asText()
if (!ctXml.includes('image/png')) {
  const patched = ctXml.replace(
    '</Types>',
    '<Default Extension="png" ContentType="image/png"/></Types>',
  )
  zip.file('[Content_Types].xml', patched)
}

const out = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' })
writeFileSync(destPath, out)
console.log(`Template written to ${destPath}`)
