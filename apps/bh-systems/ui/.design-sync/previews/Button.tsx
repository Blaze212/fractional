import { Button } from 'bh-systems-ui'

export const Primary = () => (
  <Button variant="primary" arrow>
    Book a 30-min call
  </Button>
)

export const Ghost = () => <Button variant="ghost">See the work</Button>

export const AsLink = () => (
  <Button variant="primary" href="https://example.com" external arrow>
    Book a call
  </Button>
)
