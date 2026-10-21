// Business-type presets for onboarding (lib/onboarding.js) — the only place
// business types differ. The flow reads these and nothing else: adding a
// type is adding one object here.
//
//   key, label        PDZ_users.business_type and what step 2 shows
//   hours             false skips step 5 (weekly hours)
//   attend            where the booking services happen (lib/bookings.js ATTEND)
//   exampleName       placeholder for the business name (step 3)
//   offerTitle / offerSubtitle   step 4's heading
//   items             step 4's rows: { key, name, kind, minutes?, price? }
//                     kind: 'service' (a booking service) | 'download' |
//                     'course' | 'event' (a store block finished later)
//   customRows        empty "add your own" rows step 4 starts with
//   primaryCta        the booking block's title on the store
//   accent            the starting accent colour (step 6 can change it)
//   apps              dashboard apps switched on (lib/apps.js; unknown ids are skipped)
//   nextSteps         step 7's checklist
//   layout            the store layout this type should use (stored for later)
const PRESETS = [
  {
    key: 'salon',
    label: 'Salon / Spa',
    description: 'Hair, skin, nails, grooming, spa',
    hours: true,
    attend: 'in_person',
    exampleName: 'Glamour Unisex Salon',
    offerTitle: 'Your services',
    offerSubtitle: 'We’ve added common ones. Enter your prices and untick what you don’t offer.',
    items: [
      { key: 'haircut', name: 'Haircut', kind: 'service', minutes: 30, category: 'Hair' },
      { key: 'hair-spa', name: 'Hair spa', kind: 'service', minutes: 60, category: 'Hair' },
      { key: 'global-colour', name: 'Global colour', kind: 'service', minutes: 90, category: 'Hair' },
      { key: 'cleanup', name: 'Cleanup', kind: 'service', minutes: 30, category: 'Skin' },
      { key: 'facial', name: 'Facial', kind: 'service', minutes: 60, category: 'Skin' },
      { key: 'beard-trim', name: 'Beard trim', kind: 'service', minutes: 15, category: 'Grooming' },
    ],
    customRows: 1,
    primaryCta: 'Book an appointment',
    accent: '#8b3fd6',
    apps: ['bookings', 'staff', 'reminders', 'loyalty', 'coupons', 'orders'],
    nextSteps: ['Add your logo and cover photo', 'Add your staff', 'Make a test booking'],
    layout: 'business',
  },
  {
    key: 'clinic',
    label: 'Clinic / Doctor',
    description: 'Doctors, dentists, physios, therapists',
    hours: true,
    attend: 'in_person',
    exampleName: 'Sharma Dental Clinic',
    offerTitle: 'Your consultations',
    offerSubtitle: 'We’ve added common ones. Enter your fees and untick what you don’t offer.',
    items: [
      { key: 'consultation', name: 'General consultation', kind: 'service', minutes: 15 },
      { key: 'follow-up', name: 'Follow-up visit', kind: 'service', minutes: 10 },
      { key: 'check-up', name: 'Health check-up', kind: 'service', minutes: 30 },
      { key: 'online-consultation', name: 'Online consultation', kind: 'service', minutes: 15, attend: 'online' },
    ],
    customRows: 1,
    primaryCta: 'Book a consultation',
    accent: '#0f8b6c',
    apps: ['bookings', 'reminders'],
    nextSteps: ['Add your clinic photo', 'Add your qualifications to your bio', 'Make a test booking'],
    layout: 'business',
  },
  {
    key: 'coach',
    label: 'Coach / Tutor',
    description: 'Classes, tuition, fitness, music, coaching',
    hours: true,
    attend: 'either',
    exampleName: 'Bright Minds Tuition',
    offerTitle: 'Your classes',
    offerSubtitle: 'We’ve added common ones. Enter your fees and untick what you don’t offer.',
    items: [
      { key: 'demo-class', name: 'Free demo class', kind: 'service', minutes: 45, price: '0' },
      { key: 'monthly-batch', name: 'Monthly batch (Mon–Fri)', kind: 'service', minutes: 60 },
      { key: 'doubt-session', name: '1:1 doubt session', kind: 'service', minutes: 30 },
    ],
    customRows: 1,
    primaryCta: 'Book a free demo',
    accent: '#2451c9',
    apps: ['bookings', 'courses'],
    nextSteps: ['Add your photo and a short intro', 'Share your page with students', 'Make a test booking'],
    layout: 'business',
  },
  {
    key: 'creator',
    label: 'Creator',
    description: 'Sell calls, PDFs, courses and workshops',
    hours: false,
    attend: 'online',
    exampleName: 'Meera Creates',
    offerTitle: 'What will you sell first?',
    offerSubtitle: 'Tick what you want to start with. You can finish the details later.',
    items: [
      { key: 'call', name: '1:1 call', kind: 'service', minutes: 30 },
      { key: 'pdf', name: 'Digital product (PDF)', kind: 'download' },
      { key: 'course', name: 'Online course', kind: 'course' },
      { key: 'workshop', name: 'Live workshop', kind: 'event' },
    ],
    customRows: 0,
    primaryCta: 'Book a 1:1 call',
    accent: '#ff6b4a',
    apps: ['bookings', 'payment-pages', 'courses', 'events'],
    nextSteps: ['Add your photo and bio', 'Upload your PDF', 'Share your link in your Instagram bio'],
    layout: 'links',
  },
  {
    key: 'consult',
    label: 'Consultant',
    description: 'CA, lawyer, designer, any expert advice',
    hours: true,
    attend: 'online',
    exampleName: 'Mehta Tax Advisors',
    offerTitle: 'Your sessions',
    offerSubtitle: 'We’ve added common ones. Enter your fees and untick what you don’t offer.',
    items: [
      { key: 'discovery', name: 'Discovery call', kind: 'service', minutes: 15, price: '0' },
      { key: 'consultation', name: 'Consultation', kind: 'service', minutes: 30 },
      { key: 'deep-dive', name: 'Deep-dive session', kind: 'service', minutes: 60 },
    ],
    customRows: 1,
    primaryCta: 'Book a call',
    accent: '#12181f',
    apps: ['bookings', 'payment-pages'],
    nextSteps: ['Add your photo and experience to your bio', 'Add a testimonial', 'Make a test booking'],
    layout: 'business',
  },
  {
    key: 'other',
    label: 'Something else',
    description: 'Any other business that takes bookings',
    hours: true,
    attend: 'in_person',
    exampleName: 'Your Business Name',
    offerTitle: 'What do you offer?',
    offerSubtitle: 'Add what people can book with you. You can add more later.',
    items: [],
    customRows: 2,
    primaryCta: 'Book now',
    accent: '#2451c9',
    apps: ['bookings'],
    nextSteps: ['Add your logo and cover photo', 'Add more services', 'Make a test booking'],
    layout: 'business',
  },
];

const PRESET_BY_KEY = new Map(PRESETS.map((p) => [p.key, p]));
const DEFAULT_TYPE = 'creator';

function presetFor(key) {
  return PRESET_BY_KEY.get(key) || PRESET_BY_KEY.get(DEFAULT_TYPE);
}

module.exports = { PRESETS, PRESET_BY_KEY, DEFAULT_TYPE, presetFor };
