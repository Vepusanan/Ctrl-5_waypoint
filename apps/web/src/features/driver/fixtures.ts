// Driver data the Figma frames show and the API does not return yet (docs/IMPLEMENTATION.md,
// Driver backend gaps). Everything else on the driver screens comes from the API or the phone's
// own outbox. Screens read these through the functions below, so each one can be swapped for an
// API call without touching the screen.

// DR04a `2046:5550` "Call dispatcher" and DR08 `2106:10764` "Peliyagoda planning office".
export const DISPATCH_OFFICE = {
  name: 'Peliyagoda planning office',
  phone: '+94 11 555 0100',
} as const;

// DR08 "This week · 19 of 20 on time": one dot per stop, in delivery order.
export const WEEK_STOPS: readonly boolean[] = Array.from(
  { length: 20 },
  (_, index) => index !== 13,
);

export const telHref = (phone: string) => `tel:${phone.replace(/\s/g, '')}`;
