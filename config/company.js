// The business behind PageZaper: the one place its legal name, address and
// contact details live. server.js puts this on res.locals.company for every
// view (footer, legal pages, About, homepage JSON-LD) and lib/seo.js uses it
// for default meta text. Change the address or name here only.
// These must match the Meta Business verification / Udyam registration exactly.
// Last reviewed: 9 November 2026.
const address = {
  street: '58/3 City Court',
  locality: 'Zirakpur',
  region: 'Punjab',
  country: 'India',
  countryCode: 'IN',
  postalCode: '', // add the PIN code from the Udyam certificate if you want it shown
};

const company = {
  product: 'PageZaper',
  legalName: 'UNIO TECH SOLUTIONS',
  name: 'Unio Tech Solutions', // display form of the legal name
  type: 'Proprietorship',
  proprietor: 'Abhishek Bhardwaj',
  grievanceOfficer: 'Abhishek Bhardwaj',
  since: 2018,
  email: 'hello@pagezaper.com',
  url: 'https://pagezaper.com',
  address,
  addressLine: [address.street, address.locality, address.region + (address.postalCode ? ` ${address.postalCode}` : ''), address.country].join(', '),
};

module.exports = Object.freeze(company);
