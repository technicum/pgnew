// The visitor-facing side of the Bookings, Events and Courses apps, on the
// creator's store subdomain (lib/storefront.js routes these here):
//
//   GET  /book/:slug[?date=]                 open days and times for a service
//   POST /book/:slug                         book a slot → confirmation
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

const APP_PATH = /^\/(book|event|course)\/([a-z0-9-]+)(?:\/learn\/([0-9a-f]{32})(?:\/(\d+))?)?\/?$/;

// Which app route this request is, or null if it isn't one.
function matchAppPath(req) {
  const m = req.path.toLowerCase().match(APP_PATH);
  if (!m) return null;
  const [, kind, slug, token, lessonId] = m;
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (token) return kind === 'course' && isRead ? { kind: 'learn', slug, token, lessonId: lessonId ? Number(lessonId) : null } : null;
  return isRead || req.method === 'POST' ? { kind, slug } : null;
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
  if (match.kind === 'book') {
    const service = await bookings.getPublicService(owner.id, match.slug);
    if (!service) return notFound('booking page');
    const body = req.body || {};
    const page = async (status, error, values = {}) => {
      const days = await bookings.openSlots(service);
      const dates = Object.keys(days);
      const wanted = String(values.date || req.query.date || '');
      const date = days[wanted] ? wanted : dates[0] || null;
      res.status(status).render('app-booking', {
        title: `${service.title} — ${owner.name}`,
        owner, theme, service, error, values,
        descriptionHtml: renderRichText(service.description),
        days: dates.map((d) => ({ date: d, label: kit.formatDate(d), count: days[d].length })),
        date,
        dateLabel: date ? kit.formatDate(date, { long: true }) : '',
        slots: date ? days[date].map((t) => ({ time: t, label: kit.formatTime(t) })) : [],
      });
    };
    if (req.method !== 'POST') return page(200, null);

    const { person, error } = kit.readPerson(body);
    const values = { ...person, date: String(body.date || ''), start: String(body.start || ''), note: kit.cleanText(body.note, 500) };
    if (!kit.isValidDate(values.date) || !kit.TIME_RE.test(values.start)) return page(400, 'Pick a day and a time first.', values);
    if (error) return page(400, error, values);
    let booking;
    try {
      booking = await bookings.createBooking(service, { date: values.date, start: values.start, person, note: values.note });
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return page(409, err.message, values);
      throw err;
    }
    await kit.addToAudience(owner.id, person, {
      source: 'booking', sourceId: service.id, sourceName: service.title,
      note: `Booked: ${service.title} on ${values.date} ${values.start}`,
    });
    return done({
      heading: 'You’re booked',
      lead: `${service.title} with ${owner.name}`,
      facts: [
        ['When', `${kit.formatDate(booking.date, { long: true })}, ${kit.formatTime(booking.start_time)} – ${kit.formatTime(booking.end_time)} (IST)`],
        service.location && ['Where', service.location],
        ['Booked for', `${person.name} · ${person.email}`],
      ].filter(Boolean),
      note: `Need to change it? Get in touch with ${owner.name}.`,
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
