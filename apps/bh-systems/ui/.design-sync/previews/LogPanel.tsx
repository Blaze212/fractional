import { LogPanel, LogLine } from 'bh-systems-ui'

export const ProductionLog = () => (
  <LogPanel label="production.log">
    <p>
      You have already built the AI. It works, you shipped it. But you have watched it do strange
      things in production:
    </p>
    <LogLine tag="warn">a screen quietly passes over good candidates</LogLine>
    <LogLine tag="warn">a sync fails and nobody notices until a customer emails</LogLine>
    <LogLine tag="warn">a job hangs for two minutes and you are not sure why</LogLine>
    <p style={{ marginTop: 16 }}>
      The hard part is making it run reliably without you watching it.{' '}
      <b>That is the gap I fill.</b>
    </p>
  </LogPanel>
)
