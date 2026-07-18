import { LogLine } from 'bh-systems-ui';

export const Warn = () => (
  <LogLine tag="warn">a sync fails and nobody notices until a customer emails</LogLine>
);

export const Stuck = () => (
  <LogLine tag="stuck">a member stalls on step two and quietly churns</LogLine>
);
