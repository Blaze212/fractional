/**
 * One-time script: builds the agency candidate-submittal .docx master shell
 * (spec 005). Per-firm uniqueness comes from the per-user logo + merge fields,
 * so there is exactly ONE template. The logo lives in the header as an anchored
 * placeholder named "company_logo_placeholder"; at export time only the image
 * bytes + extent are swapped (see apps/portal/src/lib/docxLogo.ts).
 *
 * Run: pnpm prepare-submittal-template
 */
import PizZip from 'pizzip'
import { writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const destPath = resolve(ROOT, 'apps/portal/public/submittal-template.docx')

const PLACEHOLDER_NAME = 'company_logo_placeholder'
const LOGO_RID = 'rIdLogo1'
const HEADER_RID = 'rIdHdr1'
// 0.5 inch placeholder (square); width is corrected at export time.
const PLACEHOLDER_EMU = 457200

// 1×1 transparent PNG
const TRANSPARENT_PNG = (() => {
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
})()

const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'

function logoDrawing(): string {
  return (
    `<w:drawing>` +
    `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251659264"` +
    ` behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/>` +
    `<wp:positionH relativeFrom="margin"><wp:align>right</wp:align></wp:positionH>` +
    `<wp:positionV relativeFrom="topMargin"><wp:posOffset>0</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${PLACEHOLDER_EMU}" cy="${PLACEHOLDER_EMU}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:wrapNone/>` +
    `<wp:docPr id="101" name="${PLACEHOLDER_NAME}" descr="${PLACEHOLDER_NAME}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="101" name="${PLACEHOLDER_NAME}" descr="${PLACEHOLDER_NAME}"/>` +
    `<pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${LOGO_RID}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr bwMode="auto">` +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${PLACEHOLDER_EMU}" cy="${PLACEHOLDER_EMU}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln>` +
    `</pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic>` +
    `</wp:anchor></w:drawing>`
  )
}

function run(text: string, opts: { bold?: boolean; size?: number } = {}): string {
  const rPr =
    opts.bold || opts.size
      ? `<w:rPr>${opts.bold ? '<w:b/>' : ''}${opts.size ? `<w:sz w:val="${opts.size}"/>` : ''}</w:rPr>`
      : ''
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`
}

function para(
  text: string,
  opts: { bold?: boolean; size?: number; spaceBefore?: boolean } = {},
): string {
  const pPr = opts.spaceBefore ? `<w:pPr><w:spacing w:before="240"/></w:pPr>` : ''
  return `<w:p>${pPr}${run(text, opts)}</w:p>`
}

// A paragraph that only carries a Docxtemplater section/loop tag; removed at render.
function tagPara(tag: string): string {
  return `<w:p>${run(tag)}</w:p>`
}

function bulletPara(text: string): string {
  return `<w:p><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr>${run('•\t' + text)}</w:p>`
}

const body =
  para('Candidate Submittal', { bold: true, size: 36 }) +
  // Client / Role block
  para('Client: {{client_name}}', { bold: true, size: 28, spaceBefore: true }) +
  para('Role: {{role_title}}', { bold: true, size: 24 }) +
  para('{{#show_req_id}}Req ID: {{req_id}}{{/show_req_id}}') +
  para('{{#show_location}}Location: {{location}}{{/show_location}}') +
  para('{{#show_hiring_manager}}Hiring Manager: {{hiring_manager}}{{/show_hiring_manager}}') +
  // Candidate snapshot
  para('Candidate Snapshot', { bold: true, size: 28, spaceBefore: true }) +
  para('{{candidate_name}}', { bold: true }) +
  para('{{candidate_seniority}}') +
  para('{{candidate_titles}}') +
  // Fit summary
  para('{{fit_summary}}', { spaceBefore: true }) +
  // Why this candidate
  para('Why {{candidate_name}} for {{client_name}}', { bold: true, size: 28, spaceBefore: true }) +
  tagPara('{{#fit_bullets}}') +
  bulletPara('{{text}}') +
  tagPara('{{/fit_bullets}}') +
  // Key qualifications
  para('Key Qualifications', { bold: true, size: 28, spaceBefore: true }) +
  tagPara('{{#key_qualifications}}') +
  bulletPara('{{text}}') +
  tagPara('{{/key_qualifications}}') +
  // Recent experience
  para('Recent Experience', { bold: true, size: 28, spaceBefore: true }) +
  tagPara('{{#recent_experience}}') +
  bulletPara('{{company}} — {{title}}  ({{dates}})') +
  tagPara('{{/recent_experience}}') +
  // Comp & logistics
  tagPara('{{#show_comp_logistics}}') +
  para('Compensation &amp; Logistics', { bold: true, size: 28, spaceBefore: true }) +
  para('{{comp_logistics}}') +
  tagPara('{{/show_comp_logistics}}') +
  // Recruiter notes
  tagPara('{{#show_recruiter_notes}}') +
  para('Recruiter Notes', { bold: true, size: 28, spaceBefore: true }) +
  para('{{recruiter_notes}}') +
  tagPara('{{/show_recruiter_notes}}')

const sectPr =
  `<w:sectPr>` +
  `<w:headerReference w:type="default" r:id="${HEADER_RID}"/>` +
  `<w:pgSz w:w="12240" w:h="15840"/>` +
  `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>` +
  `</w:sectPr>`

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture'

const documentXml =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}">` +
  `<w:body>${body}${sectPr}</w:body></w:document>`

const headerXml =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:hdr xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}">` +
  `<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r>${logoDrawing()}</w:r></w:p>` +
  `</w:hdr>`

const contentTypes =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Default Extension="png" ContentType="image/png"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` +
  `</Types>`

const rootRels =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`

const documentRels =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="${HEADER_RID}" Type="${R_NS}/header" Target="header1.xml"/>` +
  `</Relationships>`

const headerRels =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="${LOGO_RID}" Type="${R_NS}/image" Target="media/${PLACEHOLDER_NAME}.png"/>` +
  `</Relationships>`

const zip = new PizZip()
zip.file('[Content_Types].xml', contentTypes)
zip.file('_rels/.rels', rootRels)
zip.file('word/document.xml', documentXml)
zip.file('word/_rels/document.xml.rels', documentRels)
zip.file('word/header1.xml', headerXml)
zip.file('word/_rels/header1.xml.rels', headerRels)
zip.file(`word/media/${PLACEHOLDER_NAME}.png`, TRANSPARENT_PNG)

const out = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' })
writeFileSync(destPath, out)
console.log(`Submittal template written to ${destPath}`)
