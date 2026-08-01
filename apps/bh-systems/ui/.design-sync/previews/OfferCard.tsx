import { OfferCard } from 'bh-systems-ui'

export const PhaseOne = () => (
  <OfferCard
    kicker="PHASE ONE"
    title="Reliability & Scale Audit"
    who="4-week fixed-fee sprint"
    description="Find where your AI fails quietly, then stop the worst of it inside a month."
    items={[
      'Map every AI workflow running in production',
      'Find the silent failure points: no retries, no idempotency, no monitoring',
      'Instrument your most business-critical workflow so failures surface',
      'Hand back a reliability scorecard and a hardening roadmap',
    ]}
  />
)

export const Ongoing = () => (
  <OfferCard
    kicker="ONGOING"
    title="I own reliability as you scale"
    who="Monthly retainer"
    description="Instrument one workflow and you find the rest are just as fragile."
    items={[
      'Harden the backlog of fragile workflows, one by one',
      'Build the deployment and observability layer you are missing',
      'Load-test the system before you push it to 10× the volume',
    ]}
  />
)
