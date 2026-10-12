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
//   POST /event/:slug                        free: RSVP → confirmation (join link for online events);
//                                            paid: hold a seat → its ticket page
//   GET  /event/:slug/ticket/:token          a paid ticket: its checkout until paid, then the ticket
//   POST /event/:slug/ticket/:token          action=pay (test mode) | cancel
//   GET  /course/:slug                       outline + enrol form
//   POST /course/:slug                       enrol → redirect to the student's link
//   GET  /course/:slug/learn/:token[/:id]    the lessons, for an enrolled student — or, for a
//                                            paid course not paid yet, its checkout
//   POST /course/:slug/learn/:token[/:id]    action=done | undone (progress), quiz (submit answers), pay (test) | cancel
//   GET  /course/:slug/preview/:id           a free preview lesson
//   GET  /course/:slug/video/:id?k=          an uploaded lesson video, signed link only (lib/courseMedia.js)
//   GET  /course/:slug/file/:id?k=           a download's file, signed link only (lib/courseMedia.js)
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
const { formatINR } = require('./paymentPages');
const { getOrder, markOrderPaid, cancelOrder } = require('./orders');
const courseMedia = require('./courseMedia');
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
const TICKET_PATH = /^\/event\/([a-z0-9-]+)\/ticket\/([0-9a-f]{32})\/?$/;
const COURSE_PREVIEW_PATH = /^\/course\/([a-z0-9-]+)\/preview\/(\d+)\/?$/;
const COURSE_VIDEO_PATH = /^\/course\/([a-z0-9-]+)\/video\/(\d+)$/;
const COURSE_FILE_PATH = /^\/course\/([a-z0-9-]+)\/file\/(\d+)$/;
const COURSE_PLAY_PATH = /^\/course\/([a-z0-9-]+)\/learn\/([0-9a-f]{32})\/play$/;

// The browser's course device id (lib/courses.js lockDevice): a random
// cookie on the store's host, made on first visit, kept two years.
const DEVICE_COOKIE = 'pz_dev';
function deviceId(req, res) {
  const found = String(req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === DEVICE_COOKIE);
  if (found && /^[0-9a-f]{32}$/.test(found[1])) return found[1];
  if (!res) return '';
  const fresh = require('crypto').randomBytes(16).toString('hex');
  res.cookie(DEVICE_COOKIE, fresh, { maxAge: 2 * 365 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax' });
  return fresh;
}

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
  const lower = req.path.toLowerCase();
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  const ticket = lower.match(TICKET_PATH);
  if (ticket) return isRead || req.method === 'POST' ? { kind: 'ticket', slug: ticket[1], token: ticket[2] } : null;
  const preview = lower.match(COURSE_PREVIEW_PATH);
  if (preview) return isRead ? { kind: 'preview', slug: preview[1], lessonId: Number(preview[2]) } : null;
  const video = lower.match(COURSE_VIDEO_PATH);
  if (video) return isRead ? { kind: 'course-video', slug: video[1], lessonId: Number(video[2]) } : null;
  const play = lower.match(COURSE_PLAY_PATH);
  if (play) return req.method === 'POST' ? { kind: 'course-play', slug: play[1], token: play[2] } : null;
  const file = lower.match(COURSE_FILE_PATH);
  if (file) return isRead ? { kind: 'course-file', slug: file[1], lessonId: Number(file[2]) } : null;
  const m = lower.match(APP_PATH);
  if (!m) return null;
  const [, kind, slug, token, lessonId] = m;
  // The learn page also takes POSTs: paying (test mode), cancelling, and
  // marking a lesson done.
  if (token) return kind === 'course' && (isRead || req.method === 'POST') ? { kind: 'learn', slug, token, lessonId: lessonId ? Number(lessonId) : null } : null;
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
  if (match.kind === 'event' || match.kind === 'ticket') {
    // A ticket's page still opens if the creator has since hidden the event.
    const event = await events.getPublicEvent(owner.id, match.slug, { any: match.kind === 'ticket' });
    if (!event) return notFound('event');
    const when = `${kit.formatDate(event.date, { long: true })}, ${kit.formatTime(event.start_time)}${event.end_time ? ` – ${kit.formatTime(event.end_time)}` : ''} (IST)`;
    const link = event.mode === 'online' && /^https?:\/\//i.test(event.location) ? event.location : null;
    // The confirmation: the join link for an online event, the address for one at a venue.
    const registered = (heading, extra = [], note = '') => done({
      heading,
      lead: event.title,
      facts: [
        ['When', when],
        event.mode === 'venue' && event.location && ['Where', event.location],
        event.mode === 'online' && event.location && !link && ['How to join', event.location],
        ...extra,
      ].filter(Boolean),
      action: link ? { href: link, label: 'Join link' } : null,
      note: note || (link ? 'Save this page — the join link is here when it’s time.' : `See you there! Questions? Get in touch with ${owner.name}.`),
    });

    if (match.kind === 'ticket') return eventTicket(req, res, { owner, theme, event, when, notFound, registered, token: match.token });

    const customer = req.session.customer || null;
    const page = (status, error, values = {}) => res.status(status).render('app-event', {
      title: `${event.title} — ${owner.name}`,
      owner, theme, event, error, values, when,
      descriptionHtml: renderRichText(event.description),
      ended: events.hasEnded(event),
      seatsLeft: events.seatsLeft(event),
    });
    if (req.method !== 'POST') return page(200, null, customer ? { name: customer.name, email: customer.email } : {});

    const { person, error } = kit.readPerson(req.body);
    if (error) return page(400, error, person);
    // A paid ticket: held while they pay, on its own page.
    if (event.price) {
      let started;
      try {
        started = await events.startPaidTicket(event, person, await feeFor(req));
      } catch (err) {
        if (err.code === 'INVALID_INPUT') return page(409, err.message, person);
        throw err;
      }
      if (started.already) {
        return page(409, `${person.email} already has a ticket. Open the ticket link you saved — or ask ${owner.name} to send it again.`, person);
      }
      return res.redirect(303, `/event/${event.slug}/ticket/${started.token}`);
    }
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
    return registered(result.already ? 'You’re already registered' : 'You’re registered');
  }

  // --- Courses ---
  const course = await courses.getPublicCourse(owner.id, match.slug);
  if (!course) return notFound('course');

  const [lessons, moduleRows] = await Promise.all([courses.listLessons(course.id), courses.listModules(course.id)]);
  // The outline, without modules that have nothing in them yet.
  const modules = courses.groupModules(lessons, moduleRows).filter((m) => m.lessons.length);
  const coursePage = `/course/${course.slug}`;
  // How a lesson's video plays: an uploaded file in our player, through a
  // short-lived link signed for `who` (a student's id, 0 for a free
  // preview — lib/courseMedia.js); else an embeddable YouTube / Vimeo
  // link; else just a link out.
  const videoFor = (lesson, who) => {
    if (!lesson) return null;
    if (lesson.video_file) return { kind: 'file', src: `${coursePage}/video/${lesson.id}?k=${courseMedia.videoToken(lesson.id, who)}` };
    if (!lesson.video_url) return null;
    const embed = courses.videoEmbedUrl(lesson.video_url);
    return embed ? { kind: 'embed', src: embed } : { kind: 'link', src: lesson.video_url };
  };
  // The lesson view, for a student (`student`, their completed lessons) or
  // a free preview (student null).
  // A quiz shows its questions (`attempt`: the student's last submission,
  // with their answers — unless they asked to retake it); a download, its
  // file's signed link.
  const lessonView = (lesson, index, { student, done, base, attempt = null }) => res.render('app-course-learn', {
    title: `${lesson ? lesson.title : course.title} — ${course.title}`,
    owner, theme, course, student, lessons, lesson, base, done, modules, attempt,
    lessonHtml: lesson ? renderRichText(lesson.body || '') : '',
    video: lesson && lesson.kind === 'lesson' ? videoFor(lesson, student ? student.id : 0) : null,
    download: lesson && lesson.kind === 'file' && lesson.file_name
      ? { href: `${coursePage}/file/${lesson.id}?k=${courseMedia.fileToken(lesson.id, student ? student.id : 0)}`, name: lesson.file_label, size: courseMedia.sizeLabel(lesson.file_size) }
      : null,
    // Over the video: the name, then email · phone (public/js/course-player.js).
    watermark: student ? [student.name, [student.email, student.phone].filter(Boolean).join(' · ')].filter(Boolean).join('\n') : '',
    playUrl: student ? `${base}/play` : '',
    prev: student && index > 0 ? lessons[index - 1] : null,
    next: student && lesson && index < lessons.length - 1 ? lessons[index + 1] : null,
    progress: student && lessons.length ? Math.round((lessons.filter((l) => done.has(l.id)).length * 100) / lessons.length) : 0,
    coursePage,
  });

  // --- a lesson's uploaded video, for the player only ---
  if (match.kind === 'course-video') {
    const lesson = lessons.find((l) => l.id === match.lessonId);
    const key = lesson && lesson.video_file && courseMedia.checkVideoToken(lesson.id, req.query.k);
    if (!key) return res.status(403).end();
    if (key.who === 0) {
      // A preview link only ever opens a lesson that's (still) a preview.
      if (!lesson.preview) return res.status(403).end();
    } else {
      // A student removed (or not paid) loses access even mid-hour, and
      // the link plays only on their own devices.
      const student = await courses.getStudentById(course.id, key.who);
      if (!student || student.status !== 'active') return res.status(403).end();
      if (!(await courses.isStudentDevice(student.id, deviceId(req)))) return res.status(403).end();
    }
    return courseMedia.sendVideo(req, res, lesson.video_file);
  }

  // --- a download's file, through its signed link ---
  if (match.kind === 'course-file') {
    const item = lessons.find((l) => l.id === match.lessonId);
    const key = item && item.kind === 'file' && item.file_name && courseMedia.checkFileToken(item.id, req.query.k);
    if (!key) return res.status(403).type('text').send('This download link has expired — open it again from the course.');
    if (key.who === 0) {
      if (!item.preview) return res.status(403).end();
    } else {
      const student = await courses.getStudentById(course.id, key.who);
      if (!student || student.status !== 'active') return res.status(403).end();
      if (!(await courses.isStudentDevice(student.id, deviceId(req)))) return res.status(403).type('text').send('Open the download from your course on your own device.');
    }
    return courseMedia.sendCourseFile(res, item.file_name, item.file_label);
  }

  // --- one video at a time: the player's heartbeat (public/js/course-player.js) ---
  if (match.kind === 'course-play') {
    const student = await courses.getStudentByToken(course.id, match.token);
    if (!student || student.status !== 'active') return res.status(403).json({ ok: false });
    const ok = await courses.claimPlayback(student, deviceId(req), !!(req.body && req.body.start));
    return res.json(ok ? { ok: true } : { ok: false, message: 'This course started playing on another of your devices, so it paused here.' });
  }

  // --- a free preview lesson, open to anyone ---
  if (match.kind === 'preview') {
    const index = lessons.findIndex((l) => l.id === match.lessonId);
    if (index < 0 || !lessons[index].preview) return notFound('preview');
    return lessonView(lessons[index], index, { student: null, done: new Set(), base: null });
  }

  if (match.kind === 'learn') {
    const student = await courses.getStudentByToken(course.id, match.token);
    if (!student) return notFound('course link');
    const base = `${coursePage}/learn/${student.token}`;

    // Paid course, not paid yet: this page is the checkout.
    if (student.status !== 'active') return coursePayment(req, res, { owner, theme, course, student, base, notFound });

    // Their link, on their own devices only (lib/courses.js lockDevice).
    if (!(await courses.lockDevice(student, deviceId(req, res), { ua: req.get('user-agent'), ip: req.ip }))) {
      return res.status(403).render('app-course-locked', {
        title: `${course.title} — ${owner.name}`, owner, theme, course, maxDevices: courses.MAX_DEVICES,
      });
    }

    const index = match.lessonId ? lessons.findIndex((l) => l.id === match.lessonId) : 0;
    if (match.lessonId && index < 0) return notFound('lesson');
    const lesson = lessons[index] || null;
    if (req.method === 'POST') {
      const what = req.body && req.body.action;
      // A quiz: graded, kept, and marked complete — back to it for the score.
      if (lesson && lesson.kind === 'quiz' && what === 'quiz') {
        await courses.saveQuizAttempt(student, lesson, courses.gradeQuiz(lesson, req.body));
        return res.redirect(303, `${base}/${lesson.id}#result`);
      }
      // "Mark complete" (and on to the next item) / "Mark not done".
      if (lesson && (what === 'done' || what === 'undone')) await courses.setLessonDone(student, lesson.id, what === 'done');
      const next = what === 'done' && index < lessons.length - 1 ? lessons[index + 1] : lesson;
      return res.redirect(303, next ? `${base}/${next.id}` : base);
    }
    const attempt = lesson && lesson.kind === 'quiz' && req.query.retake === undefined
      ? await courses.lastQuizAttempt(student.id, lesson.id) : null;
    return lessonView(lesson, index, { student, done: await courses.completedLessons(student.id), base, attempt });
  }

  // --- the course page + enrolling ---
  const customer = req.session.customer || null;
  const page = (status, error, values = {}) => res.status(status).render('app-course', {
    title: `${course.title} — ${owner.name}`,
    owner, theme, course, lessons, error, values, customer, modules,
    counts: courses.countKinds(lessons),
    videoCount: lessons.filter((l) => l.kind === 'lesson' && (l.video_file || l.video_url)).length,
    descriptionHtml: renderRichText(course.description),
  });
  if (req.method !== 'POST') {
    return page(200, null, customer ? { name: customer.name, email: customer.email } : {});
  }

  const { person, error } = kit.readPerson(req.body);
  if (error) return page(400, error, person);
  if (!course.price) {
    const { token, already } = await courses.enrol(course, person);
    if (!already) {
      await kit.addToAudience(owner.id, person, { source: 'course', sourceId: course.id, sourceName: course.title, note: `Enrolled: ${course.title}` });
    }
    return res.redirect(303, `${coursePage}/learn/${token}`);
  }
  const result = await courses.startPaidEnrolment(course, person, await feeFor(req));
  if (result.active) {
    return page(409, `${person.email} already has this course. Open the link you saved when you enrolled — or ask ${owner.name} to send it again.`, person);
  }
  return res.redirect(303, `${coursePage}/learn/${result.token}`);
}

// A paid course's enrolment waiting for payment — the same three modes as
// a booking (lib/payments.js): test button, Cashfree checkout (this page is
// also its return_url), or "pay the creator, they'll confirm".
async function coursePayment(req, res, { owner, theme, course, student, base, notFound }) {
  const order = student.order_id ? await getOrder(owner.id, student.order_id) : null;
  if (!order) return notFound('course link');
  const mode = paymentMode();
  if (req.method === 'POST') {
    const what = req.body && req.body.action;
    if (what === 'pay' && mode === 'test' && order.status === 'pending') {
      await markOrderPaid(owner.id, order.id, { provider: 'test' });
    } else if (what === 'cancel' && order.status === 'pending') {
      await cancelOrder(owner.id, order.id);
      return res.redirect(303, `/course/${course.slug}`);
    }
    return res.redirect(303, base);
  }
  let gateway = null;
  let gatewayError = null;
  if (mode === 'cashfree' && order.status === 'pending') {
    if (await syncGatewayOrder(order)) return res.redirect(303, base);
    try {
      const session = await startGatewayCheckout(order, `${req.protocol}://${req.get('host')}${base}?cf=return`);
      if (session.paid) return res.redirect(303, base);
      gateway = { sessionId: session.sessionId, env: gatewayEnv(), auto: req.query.cf !== 'return' };
    } catch (err) {
      console.error('Starting Cashfree checkout failed for course order', order.id, err.message, err.cashfree || '');
      gatewayError = 'We couldn’t reach the payment gateway just now. Please try again in a minute.';
    }
  }
  return res.render('app-course-pay', {
    title: `Pay for ${course.title} — ${owner.name}`,
    owner, theme, course, student, order, base, gateway, gatewayError,
    paymentMode: mode,
    retry: req.query.cf === 'return',
    cancelled: order.status === 'cancelled',
    amountLabel: course.priceLabel,
  });
}

// A paid event ticket's own link: the ticket once paid; until then its
// checkout — the same three modes as a course (lib/payments.js): test
// button, Cashfree checkout (this page is also its return_url), or "pay
// the creator, they'll confirm".
async function eventTicket(req, res, { owner, theme, event, when, notFound, registered, token }) {
  const ticket = await events.getTicket(event.id, token);
  if (!ticket) return notFound('ticket');
  const base = `/event/${event.slug}/ticket/${ticket.token}`;
  const amountLabel = formatINR(ticket.amount || event.price);
  if (ticket.status === 'going') {
    return registered('You’re in — here’s your ticket', [
      ['Name', `${ticket.name} · ${ticket.email}`],
      ticket.amount && ['Paid', amountLabel],
    ], `Bookmark this page — it’s your ticket${event.mode === 'online' ? ' and has the join link' : ''}.`);
  }
  const order = ticket.order_id ? await getOrder(owner.id, ticket.order_id) : null;
  const mode = paymentMode();
  if (req.method === 'POST') {
    const what = req.body && req.body.action;
    if (order && order.status === 'pending' && what === 'pay' && mode === 'test') {
      await markOrderPaid(owner.id, order.id, { provider: 'test' });
    } else if (order && order.status === 'pending' && what === 'cancel') {
      await cancelOrder(owner.id, order.id);
      return res.redirect(303, `/event/${event.slug}`);
    }
    return res.redirect(303, base);
  }
  const cancelled = ticket.status === 'cancelled' || !order || order.status !== 'pending';
  let gateway = null;
  let gatewayError = null;
  if (!cancelled && mode === 'cashfree') {
    if (await syncGatewayOrder(order)) return res.redirect(303, base);
    try {
      const session = await startGatewayCheckout(order, `${req.protocol}://${req.get('host')}${base}?cf=return`);
      if (session.paid) return res.redirect(303, base);
      gateway = { sessionId: session.sessionId, env: gatewayEnv(), auto: req.query.cf !== 'return' };
    } catch (err) {
      console.error('Starting Cashfree checkout failed for event order', order.id, err.message, err.cashfree || '');
      gatewayError = 'We couldn’t reach the payment gateway just now. Please try again in a minute.';
    }
  }
  return res.render('app-event-pay', {
    title: `Ticket for ${event.title} — ${owner.name}`,
    owner, theme, event, ticket, base, when, gateway, gatewayError, cancelled, amountLabel,
    paymentMode: mode,
    retry: req.query.cf === 'return',
    holdMinutes: events.HOLD_MINUTES,
  });
}

module.exports = { matchAppPath, handleAppRequest };
