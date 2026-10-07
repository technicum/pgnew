// The visitor-facing side of the Bookings, Events and Courses apps, on the
// creator's store subdomain (lib/storefront.js routes these here):
//
//   GET  /book                               booking page: every visible service
//   GET  /book/:slug[?month=|?date=]         month calendar, times on the picked day
//   POST /book/:slug                         book a slot → its booking page
//   GET  /book/:slug/booking/:token          confirmation, or the payment step
//   POST /book/:slug/booking/:token          action=pay (test mode) | cancel
//   (in Cashfree mode the GET is also the checkout and its ?cf=return)
//   GET  /book/:slug/booking/:token.ics      add-to-calendar file
//   GET  /event/:slug                        the event and its RSVP form
//   POST /event/:slug                        RSVP → confirmation (join link for online events)
//   GET  /course/:slug                       outline + enrol form
//   POST /course/:slug                       enrol → redirect to the student's link
//   GET  /course/:slug/learn/:token[/:id]    the lessons, for an enrolled student
//
// Plain form posts throughout — no JavaScript needed on any of these.
// Like payment pages and lead magnets, these stay live when the creator
// switches the app off in Explore apps; only hiding one takes it down.
const bookings = require('./bookings');
const events = require('./events');
const courses = require('./courses');
const kit = require('./appKit');
const { renderRichText } = require('./richText');
const { paymentMode, gatewayEnv, startGatewayCheckout, syncGatewayOrder } = require('./payments');
const { getOrder } = require('./orders');
const { listAddresses } = require('./customers');
const { feeFor } = require('./platform');

// A month of the booking calendar: weeks (Monday first) of day cells,
// each { date, day, open, past } or null for padding, plus prev/next month
// links when there's anything bookable that way.
function monthGrid(month, days, today, lastDay) {
  const first = `${month}-01`;
  const cells = Array((kit.weekday(first) + 6) % 7).fill(null);
  for (let d = first; d.slice(0, 7) === month; d = kit.addDays(d, 1)) {
    cells.push({ date: d, day: Number(d.slice(8)), open: !!days[d], past: d < today || d > lastDay, today: d === today });
  }
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const prev = kit.addDays(first, -1).slice(0, 7);
  const next = kit.addDays(first, 32).slice(0, 7);
  return {
    label: new Date(`${first}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }),
    weeks,
    prev: prev >= today.slice(0, 7) ? prev : null,
    next: next <= lastDay.slice(0, 7) ? next : null,
  };
}

const APP_PATH = /^\/(book|event|course)\/([a-z0-9-]+)(?:\/learn\/([0-9a-f]{32})(?:\/(\d+))?)?\/?$/;
const BOOKING_PATH = /^\/book\/([a-z0-9-]+)\/booking\/([0-9a-f]{32})(\.ics)?$/;

// Which app route this request is, or null if it isn't one.
function matchAppPath(req) {
  const isGet = req.method === 'GET' || req.method === 'HEAD';
  if (/^\/book\/?$/i.test(req.path)) return isGet ? { kind: 'book-list' } : null;
  const b = req.path.toLowerCase().match(BOOKING_PATH);
  if (b) {
    const [, slug, token, ics] = b;
    if (ics) return isGet ? { kind: 'booking-ics', slug, token } : null;
    return isGet || req.method === 'POST' ? { kind: 'booking', slug, token } : null;
  }
  const m = req.path.toLowerCase().match(APP_PATH);
  if (!m) return null;
  const [, kind, slug, token, lessonId] = m;
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (token) return kind === 'course' && isRead ? { kind: 'learn', slug, token, lessonId: lessonId ? Number(lessonId) : null } : null;
  return isRead || req.method === 'POST' ? { kind, slug } : null;
}

// A description in the rich text format, as one plain line for a card.
function plainSummary(text, max = 150) {
  const plain = String(text || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s+|^[-*]\s+|^\d+\.\s+/gm, '')
    .replace(/\*\*?([^*]+)\*\*?/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : plain;
}

function themeFor(owner) {
  return { accent_color: /^#[0-9a-f]{6}$/i.test(owner.accent_color) ? owner.accent_color : '#1261ef' };
}

async function handleAppRequest(req, res, owner, match, { siteName }) {
  const theme = themeFor(owner);
  const notFound = (what) => res.status(404).render('error', {
    title: `Not found — ${siteName}`,
    heading: 'This link isn’t live',
    message: `This ${what} doesn’t exist, or the creator has taken it down.`,
  });
  const done = (data) => res.render('app-done', { title: `${data.heading} — ${owner.name}`, owner, theme, ...data });

  // --- Bookings ---
  // The booking page: every visible service on one link, for a link in bio.
  if (match.kind === 'book-list') {
    const [settings, services, fee] = await Promise.all([bookings.getSettings(owner.id), bookings.listPublicServices(owner.id), feeFor(req)]);
    services.forEach((s) => bookings.applyFee(s, fee.pct));
    if (!settings.listing_visible) return notFound('booking page');
    return res.render('app-booking-list', {
      title: `${settings.headline || `Book time with ${owner.name}`} — ${owner.name}`,
      owner, theme, settings,
      introHtml: renderRichText(settings.intro || ''),
      services: services.map((s) => ({ ...s, summary: plainSummary(s.description) })),
    });
  }

  if (match.kind === 'book') {
    const [service, settings] = await Promise.all([bookings.getPublicService(owner.id, match.slug), bookings.getSettings(owner.id)]);
    if (!service) return notFound('booking page');
    // Photo and cover fall back to the ones in Bookings → Settings.
    service.photo_url = service.photo_url || settings.photo_url;
    service.cover_url = service.cover_url || settings.cover_url;
    const body = req.body || {};
    // A visitor signed in on this store (lib/customerAccount.js): their
    // name and email — and the phone on their default saved address — are
    // filled in for them.
    const customer = req.session.customer || null;
    // PageZaper's fee for this visitor (marketplace or direct) sets what's
    // paid online — shown on the page and charged when they book.
    const fee = await feeFor(req);
    bookings.applyFee(service, fee.pct);
    const page = async (status, error, values = {}) => {
      const days = await bookings.openSlots(service);
      const dates = Object.keys(days);
      const wanted = String(values.date || req.query.date || '');
      const date = days[wanted] ? wanted : null;
      // The month on show: the picked day's, else ?month=, else the first
      // month with an open day.
      const today = kit.nowLocal(settings.timezone).date;
      const lastDay = kit.addDays(today, service.days_ahead - 1);
      const askedMonth = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
      let month = (date || '').slice(0, 7) || askedMonth || (dates[0] || today).slice(0, 7);
      if (month < today.slice(0, 7)) month = today.slice(0, 7);
      if (month > lastDay.slice(0, 7)) month = lastDay.slice(0, 7);
      res.status(status).render('app-booking', {
        title: `${service.title} — ${owner.name}`,
        owner, theme, service, error, values,
        listingUrl: settings.listing_visible ? '/book' : null,
        descriptionHtml: renderRichText(service.description),
        calendar: monthGrid(month, days, today, lastDay),
        hasSlots: dates.length > 0,
        date,
        dateLabel: date ? kit.formatDate(date, { long: true }) : '',
        // utc lets the page show each time on the visitor's own clock too.
        slots: date ? days[date].map((t) => ({ time: t, label: kit.formatTime(t), utc: kit.zonedToUtc(date, t, settings.timezone) })) : [],
        timezone: settings.timezone,
        tzName: kit.tzLabel(settings.timezone),
        customer,
      });
    };
    if (req.method !== 'POST') {
      if (!customer) return page(200, null);
      const [address] = await listAddresses(customer.id);
      return page(200, null, { name: customer.name, email: customer.email, phone: (address && address.phone) || '' });
    }

    const { person, error } = kit.readPerson(body);
    const { answers, error: answerError } = bookings.readAnswers(service, body);
    const values = {
      ...person, date: String(body.date || ''), start: String(body.start || ''), note: kit.cleanText(body.note, 500),
      answers: Object.fromEntries(answers.map((a) => [a.id, a.value])),
      attend: body.attend === 'online' || body.attend === 'in_person' ? body.attend : '',
    };
    if (!kit.isValidDate(values.date) || !kit.TIME_RE.test(values.start)) return page(400, 'Pick a day and a time first.', values);
    if (error || answerError) return page(400, error || answerError, values);
    let token;
    try {
      token = await bookings.createBooking(service, { date: values.date, start: values.start, person, note: values.note, answers, attend: values.attend, fee });
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return page(409, err.message, values);
      throw err;
    }
    return res.redirect(303, `/book/${service.slug}/booking/${token}`);
  }

  // A booking's own page: confirmation, or (paid, unpaid) the checkout step.
  if (match.kind === 'booking' || match.kind === 'booking-ics') {
    const [booking, settings] = await Promise.all([bookings.getBookingByToken(owner.id, match.token), bookings.getSettings(owner.id)]);
    if (!booking) return notFound('booking');
    if (match.kind === 'booking-ics') {
      res.set('Content-Type', 'text/calendar; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="booking-${booking.date}.ics"`);
      return res.send(bookings.icsFile(booking, owner.name, req.hostname));
    }
    const self = `/book/${match.slug}/booking/${booking.token}`;
    if (req.method === 'POST') {
      const what = req.body && req.body.action;
      if (what === 'pay') await bookings.payTestBooking(booking);
      else if (what === 'cancel') await bookings.abandonBooking(booking);
      return res.redirect(303, self);
    }
    // Cashfree: a pending booking's page is its checkout (and the return_url).
    const mode = paymentMode();
    let gateway = null;
    let gatewayError = null;
    if (mode === 'cashfree' && booking.status === 'pending' && booking.order_id) {
      const order = await getOrder(owner.id, booking.order_id);
      if (order && order.status === 'pending') {
        if (await syncGatewayOrder(order)) return res.redirect(303, self);
        try {
          const session = await startGatewayCheckout(order, `${req.protocol}://${req.get('host')}${self}?cf=return`);
          if (session.paid) return res.redirect(303, self);
          gateway = { sessionId: session.sessionId, env: gatewayEnv(), auto: req.query.cf !== 'return' };
        } catch (err) {
          console.error('Starting Cashfree checkout failed for booking order', order.id, err.message, err.cashfree || '');
          gatewayError = 'We couldn’t reach the payment gateway just now. Please try again in a minute.';
        }
      }
    }
    return res.render('app-booking-status', {
      title: `${booking.service_title} — ${owner.name}`,
      owner, theme, booking, self,
      bookAgain: `/book/${match.slug}`,
      when: `${kit.formatDate(booking.date, { long: true })}, ${kit.formatTime(booking.start_time)} – ${kit.formatTime(booking.end_time)}`,
      googleUrl: bookings.googleCalendarUrl(booking, owner.name),
      tzName: kit.tzLabel(booking.timezone),
      paymentMode: mode,
      gateway, gatewayError,
      retry: req.query.cf === 'return',
      paymentNote: settings.payment_note,
      holdMinutes: bookings.HOLD_MINUTES,
      listingUrl: settings.listing_visible ? '/book' : null,
    });
  }

  // --- Events ---
  if (match.kind === 'event') {
    const event = await events.getPublicEvent(owner.id, match.slug);
    if (!event) return notFound('event');
    const when = `${kit.formatDate(event.date, { long: true })}, ${kit.formatTime(event.start_time)}${event.end_time ? ` – ${kit.formatTime(event.end_time)}` : ''} (IST)`;
    const page = (status, error, values = {}) => res.status(status).render('app-event', {
      title: `${event.title} — ${owner.name}`,
      owner, theme, event, error, values, when,
      descriptionHtml: renderRichText(event.description),
      ended: events.hasEnded(event),
      seatsLeft: events.seatsLeft(event),
    });
    if (req.method !== 'POST') return page(200, null);

    const { person, error } = kit.readPerson(req.body);
    if (error) return page(400, error, person);
    let result;
    try {
      result = await events.rsvp(event, person);
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return page(409, err.message, person);
      throw err;
    }
    if (!result.already) {
      await kit.addToAudience(owner.id, person, { source: 'event', sourceId: event.id, sourceName: event.title, note: `RSVP: ${event.title}` });
    }
    const link = event.mode === 'online' && /^https?:\/\//i.test(event.location) ? event.location : null;
    return done({
      heading: result.already ? 'You’re already registered' : 'You’re registered',
      lead: event.title,
      facts: [
        ['When', when],
        event.mode === 'venue' && event.location && ['Where', event.location],
        event.mode === 'online' && event.location && !link && ['How to join', event.location],
      ].filter(Boolean),
      action: link ? { href: link, label: 'Join link' } : null,
      note: link ? 'Save this page — the join link is here when it’s time.' : `See you there! Questions? Get in touch with ${owner.name}.`,
    });
  }

  // --- Courses ---
  const course = await courses.getPublicCourse(owner.id, match.slug);
  if (!course) return notFound('course');

  if (match.kind === 'learn') {
    const student = await courses.getStudentByToken(course.id, match.token);
    if (!student) return notFound('course link');
    const lessons = await courses.listLessons(course.id);
    const index = match.lessonId ? lessons.findIndex((l) => l.id === match.lessonId) : 0;
    if (match.lessonId && index < 0) return notFound('lesson');
    const lesson = lessons[index] || null;
    const base = `/course/${course.slug}/learn/${student.token}`;
    return res.render('app-course-learn', {
      title: `${lesson ? lesson.title : course.title} — ${course.title}`,
      owner, theme, course, student, lessons, lesson, base,
      lessonHtml: lesson ? renderRichText(lesson.body || '') : '',
      embedUrl: lesson && lesson.video_url ? courses.videoEmbedUrl(lesson.video_url) : null,
      prev: index > 0 ? lessons[index - 1] : null,
      next: lesson && index < lessons.length - 1 ? lessons[index + 1] : null,
    });
  }

  const lessons = await courses.listLessons(course.id);
  const page = (status, error, values = {}) => res.status(status).render('app-course', {
    title: `${course.title} — ${owner.name}`,
    owner, theme, course, lessons, error, values,
    descriptionHtml: renderRichText(course.description),
  });
  if (req.method !== 'POST') return page(200, null);

  const { person, error } = kit.readPerson(req.body);
  if (error) return page(400, error, person);
  const { token, already } = await courses.enrol(course, person);
  if (!already) {
    await kit.addToAudience(owner.id, person, { source: 'course', sourceId: course.id, sourceName: course.title, note: `Enrolled: ${course.title}` });
  }
  return res.redirect(303, `/course/${course.slug}/learn/${token}`);
}

module.exports = { matchAppPath, handleAppRequest };
