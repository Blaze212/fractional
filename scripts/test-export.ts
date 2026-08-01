/**
 * Dev script: export a sample resume DOCX with a real logo for local iteration.
 * Run: pnpm test-export
 * Opens the resulting DOCX automatically.
 */
import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { mapParsedProfileToRenderData, exportResume } from '../apps/portal/src/lib/resumeExport.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const templateBuffer = readFileSync(resolve(ROOT, 'apps/portal/public/template.docx')).buffer
const logoBytes = new Uint8Array(readFileSync('/Users/barton/Downloads/alignedrecruitment.png'))
const logoDims = { widthPx: 1443, heightPx: 429 }

const profile = {
  name: 'Jane Smith',
  email: 'jane.smith@email.com',
  phone: '+1 (415) 555-0182',
  location: 'San Francisco, CA',
  linkedin_url: 'linkedin.com/in/janesmith',
  summary:
    'Strategy and Operations Leader with 15+ years of experience translating executive strategy into structured execution across global professional services and technology firms. Proven track record of establishing governance frameworks, driving cross-functional alignment, and building executive reporting systems to accelerate decisions and deliver measurable business outcomes.\n\nKnown for bridging the gap between strategic vision and operational reality — partnering with C-suite leaders to design the operating models, reporting cadences, and governance structures that make strategy stick.',
  career_highlights: [
    'Improved forecast accuracy 30% by rebuilding revenue forecasting logic, creating a single source of truth for pipeline management across a $2.8B global firm.',
    'Reduced overtime costs 20% and increased billable utilization 12% by building a real-time Resource Utilization Dashboard that eliminated reactive staffing decisions.',
    'Achieved 95% onboarding adoption across 5 regions and cut new-hire ramp time 50% by designing a global operational readiness program with structured change management.',
    'Increased sales productivity 15% by building a Sales Enablement Playbook adopted by 300+ professionals across a $4.2B North America org.',
    'Identified $500K+ in cost redundancies by orchestrating post-merger integration and consolidating performance reporting across newly merged entities.',
  ],
  selected_experience: [
    {
      company: 'Korn Ferry',
      title: 'Manager (Director Level Scope), Strategy & Operations',
      start_date: '2022-01',
      end_date: 'Present',
      responsibilities: [
        'Strategy & Operations lead at a $2.8B global professional services firm, partnering with executives across 200–300 professionals in 5 regions to drive planning and cross-functional execution.',
        'Own the operating cadence including OKR and KPI frameworks, quarterly business reviews, and annual planning cycles, ensuring a single source of truth for company-wide priorities.',
        'Partner with Data Science and Engineering teams to translate operational requirements into scalable systems, aligning technical roadmaps with performance objectives.',
      ],
      achievements: [
        'Improved forecast accuracy 30% by rebuilding revenue forecasting logic from the ground up, creating a single source of truth for pipeline management.',
        'Reduced overtime costs 20% and increased billable utilization 12% by building a real-time Resource Utilization Dashboard.',
      ],
    },
    {
      company: 'Gartner',
      title: 'Manager, Strategy & Operations',
      start_date: '2021-01',
      end_date: '2022-01',
      responsibilities: [
        'Served as strategic advisor to senior leadership at a $5.5B global technology firm, managing 10+ growth programs across a $4.2B North America revenue organization.',
        'Designed and enforced operating cadence, SOP governance, and decision frameworks across sales, services, and research functions.',
      ],
      achievements: [
        'Increased sales productivity 15% and account expansion conversion 15% by building a Sales Enablement Playbook with 90% adoption across 300+ professionals.',
        'Identified $500K+ in cost redundancies by orchestrating post-merger integration across newly merged entities.',
      ],
    },
    {
      company: 'Korn Ferry',
      title: 'Senior Operations Analyst',
      start_date: '2019-01',
      end_date: '2021-01',
      responsibilities: [
        'Delivered strategy and operations support to Director-level leadership, building data, reporting, and workforce analytics infrastructure.',
        'Analyzed business performance and developed financial models supporting annual planning, resource allocation, and organizational priority-setting.',
      ],
      achievements: [
        'Reduced manual reporting effort 30% by automating operational and revenue reporting, freeing leadership capacity for higher-leverage work.',
      ],
    },
  ],
  other_experience: [
    {
      company: 'Deloitte Consulting',
      title: 'Business Analyst',
      start_date: '2016-06',
      end_date: '2019-01',
    },
    {
      company: 'McKinsey & Company',
      title: 'Associate',
      start_date: '2014-08',
      end_date: '2016-05',
    },
  ],
  education: [{ institution: 'University of Michigan, Ross School of Business', degree: 'MBA' }],
  certifications: [{ provider: 'Project Management Institute', certification: 'PMP' }],
  skills: [
    'Strategy & Operations',
    'Operating Model Design',
    'OKR & KPI Frameworks',
    'Cross-Functional Alignment',
    'PMO & Governance',
    'Executive Advisory',
  ],
  tools: ['Tableau', 'Anaplan', 'Salesforce', 'Looker', 'Workday'],
  seniority_level: 'Director',
  functional_areas: ['Strategy', 'Operations', 'Finance'],
  industries: ['Professional Services', 'Technology'],
}

const renderData = mapParsedProfileToRenderData(profile, logoBytes)
const blob = await exportResume(templateBuffer as ArrayBuffer, renderData, logoDims)
const outPath = resolve(ROOT, 'test-export.docx')
writeFileSync(outPath, Buffer.from(await blob.arrayBuffer()))
console.log(`Written: ${outPath}`)
execSync(`open "${outPath}"`)
