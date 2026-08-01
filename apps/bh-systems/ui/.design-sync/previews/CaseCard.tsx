import { CaseCard } from 'bh-systems-ui'

export const TurboClaim = () => (
  <CaseCard
    company="TurboClaim"
    kind="AI · Fractional"
    outcome={
      <>
        Multi-minute AI jobs went from flaky to a <b>95% success rate</b>, on a pipeline handling{' '}
        <b>$100M+</b> in claims.
      </>
    }
  >
    Built and operated an AI-powered claims platform as the sole technical decision-maker. The AI
    jobs ran for minutes and used to fail silently, so I moved them onto durable Temporal
    orchestration with retries, idempotency, and recovery.
  </CaseCard>
)

export const AmazonAWS = () => (
  <CaseCard
    company="Amazon AWS"
    kind="Cloud · Scale"
    outcome={
      <>
        Held <b>99.9%+ availability</b> and upgraded 2,500 hosts with <b>zero downtime</b>.
      </>
    }
  >
    Built and maintained the AWS SSO Control Plane service, spanning 30+ regions and 2,500+ hosts,
    with staged rollouts and safeguards.
  </CaseCard>
)
