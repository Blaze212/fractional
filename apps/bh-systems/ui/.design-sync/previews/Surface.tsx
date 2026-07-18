import { Surface, SectionHeading, Button } from 'bh-systems-ui';

export const Canvas = () => (
  <Surface>
    <SectionHeading
      eyebrow="bh-systems"
      title="The navy canvas, with blueprint texture and base type."
      description="Wrap any composition in Surface to inherit the theme."
    />
    <div style={{ marginTop: 28 }}>
      <Button variant="primary" arrow>Book a call</Button>
    </div>
  </Surface>
);
