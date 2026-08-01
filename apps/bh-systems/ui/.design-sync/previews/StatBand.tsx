import { StatBand } from 'bh-systems-ui'

export const CredibilityBand = () => (
  <StatBand
    items={[
      { value: '99.9%+', label: 'uptime across 2,500 hosts and 30+ AWS regions' },
      { value: '$100M+', label: 'in insurance claims processed by AI pipelines I built' },
      { value: '10×', label: 'concurrent workflow throughput after re-architecting' },
      { value: '600%', label: 'control-plane TPS increase after clearing bottlenecks' },
      { value: '0', label: 'downtime on security upgrades across 2,500 hosts' },
      { value: '10+', label: 'years shipping production software' },
    ]}
  />
)
