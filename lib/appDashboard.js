// Dashboard side of the Bookings, Events and Courses apps — kept out of
// server.js so it's one line there:
//
//   installAppDashboards(app, { requireAuth, siteName });
//
// Unlike payment pages and lead magnets these pages are plain HTML forms:
// every POST does its change and redirects back (?ok= / ?error= carry the
// message), so there's no dashboard script to keep in step. The /dashboard
// middleware in server.js already sends anyone without the app to Explore
// apps, and every query below is scoped to the signed-in creator.
const bookings = require('./bookings');
const events = require('./events');
const courses = require('./courses');
const kit = require('./appKit');
const { paymentMode } = require('./payments');

const OK_MESSAGES = {
  paid: 'Marked paid — the booking is confirmed.',
  created: 'Created — fill in the details below.',
  saved: 'Saved.',
  deleted: 'Deleted.',
  cancelled: 'Cancelled.',
  added: 'Lesson added.',
  removed: 'Removed.',
};

function installAppDashboards(app, { requireAuth, siteName }) {
  // Flash message from the redirect, and date/time formatting for views.
  app.use(['/dashboard/bookings', '/dashboard/events', '/dashboard/courses'], (req, res, next) => {
    res.locals.flash = req.query.error
      ? { kind: 'error', text: String(req.query.error).slice(0, 200) }
      : OK_MESSAGES[req.query.ok] ? { kind: 'ok', text: OK_MESSAGES[req.query.ok] } : null;
    res.locals.fmt = { date: kit.formatDate, time: kit.formatTime };
    next();
  });

  const id = (value) => (/^\d+$/.test(String(value)) ? Number(value) : null);
  const back = (res, target, err) => {
    const [path, hash] = target.split('#');
    res.redirect(303, `${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(err.message)}${hash ? `#${hash}` : ''}`);
  };
  // Runs a POST handler; input errors go back to `fallback` as ?error=.
  const action = (fallback, fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return back(res, typeof fallback === 'function' ? fallback(req) : fallback, err);
      next(err);
    }
  };
  const render = (res, view, title, data) => res.render(view, { title: `${title} — ${siteName}`, user: res.req.session.user, ...data });

  // --- Bookings ---
  // Three tabs (partials/booking-tabs): Bookings (who's booked), Services,
  // Settings (the /book page, payment instructions, days off). Each gets
  // the booking settings for the tab bar's link to /book.
  const bookingTab = async (req, res, view, title, data) => {
    const settings = await bookings.getSettings(req.session.user.id);
    render(res, view, title, { bookingSettings: settings, paymentMode: paymentMode(), ...data });
  };

  app.get('/dashboard/bookings', requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.user.id;
      const [upcoming, past, services] = await Promise.all([
        bookings.listBookings(userId, { upcoming: true }),
        bookings.listBookings(userId, { upcoming: false }),
        bookings.listServices(userId),
      ]);
      await bookingTab(req, res, 'app-bookings', 'Bookings', { upcoming, past: past.slice(0, 30), hasServices: services.length > 0 });
    } catch (err) { next(err); }
  });
  app.post('/dashboard/bookings/:id/paid', requireAuth, action('/dashboard/bookings', async (req, res) => {
    await bookings.markBookingPaid(req.session.user.id, id(req.params.id));
    res.redirect(303, '/dashboard/bookings?ok=paid');
  }));
  app.post('/dashboard/bookings/:id/cancel', requireAuth, action('/dashboard/bookings', async (req, res) => {
    await bookings.cancelBooking(req.session.user.id, id(req.params.id));
    res.redirect(303, '/dashboard/bookings?ok=cancelled');
  }));

  app.get('/dashboard/bookings/services', requireAuth, async (req, res, next) => {
    try {
      await bookingTab(req, res, 'app-booking-services', 'Services', { services: await bookings.listServices(req.session.user.id) });
    } catch (err) { next(err); }
  });
  app.post('/dashboard/bookings/services', requireAuth, action('/dashboard/bookings/services', async (req, res) => {
    const newId = await bookings.createService(req.session.user.id, req.body || {});
    res.redirect(303, `/dashboard/bookings/services/${newId}?ok=created`);
  }));
  app.get('/dashboard/bookings/services/:id', requireAuth, async (req, res, next) => {
    try {
      const service = id(req.params.id) && await bookings.getService(req.session.user.id, id(req.params.id));
      if (!service) return res.redirect('/dashboard/bookings/services');
      await bookingTab(req, res, 'app-booking-service', service.title, {
        service,
        weekdays: bookings.WEEKDAYS,
        maxRanges: bookings.MAX_RANGES,
        maxQuestions: bookings.MAX_QUESTIONS,
        questionTypes: bookings.QUESTION_TYPES,
      });
    } catch (err) { next(err); }
  });
  app.post('/dashboard/bookings/services/:id', requireAuth, action((req) => `/dashboard/bookings/services/${req.params.id}`, async (req, res) => {
    await bookings.updateService(req.session.user.id, id(req.params.id), req.body || {});
    res.redirect(303, `/dashboard/bookings/services/${req.params.id}?ok=saved`);
  }));
  app.post('/dashboard/bookings/services/:id/delete', requireAuth, action('/dashboard/bookings/services', async (req, res) => {
    await bookings.deleteService(req.session.user.id, id(req.params.id));
    res.redirect(303, '/dashboard/bookings/services?ok=deleted');
  }));

  app.get('/dashboard/bookings/settings', requireAuth, async (req, res, next) => {
    try {
      const daysOff = await bookings.listDaysOff(req.session.user.id);
      await bookingTab(req, res, 'app-booking-settings', 'Booking settings', { daysOff, today: kit.nowLocal().date });
    } catch (err) { next(err); }
  });
  app.post('/dashboard/bookings/settings', requireAuth, action('/dashboard/bookings/settings', async (req, res) => {
    await bookings.saveSettings(req.session.user.id, req.body || {});
    res.redirect(303, '/dashboard/bookings/settings?ok=saved');
  }));
  app.post('/dashboard/bookings/days-off', requireAuth, action('/dashboard/bookings/settings#days-off', async (req, res) => {
    const body = req.body || {};
    await bookings.addDaysOff(req.session.user.id, { from: String(body.from || ''), to: String(body.to || ''), note: body.note });
    res.redirect(303, '/dashboard/bookings/settings?ok=saved#days-off');
  }));
  app.post('/dashboard/bookings/days-off/:id/delete', requireAuth, action('/dashboard/bookings/settings#days-off', async (req, res) => {
    await bookings.deleteDayOff(req.session.user.id, id(req.params.id));
    res.redirect(303, '/dashboard/bookings/settings?ok=removed#days-off');
  }));

  // --- Events ---
  app.get('/dashboard/events', requireAuth, async (req, res, next) => {
    try {
      const all = await events.listEvents(req.session.user.id);
      const today = kit.nowLocal().date;
      render(res, 'app-events', 'Events', {
        upcoming: all.filter((e) => e.date >= today).reverse(),
        past: all.filter((e) => e.date < today),
        defaultDate: kit.addDays(today, 7),
      });
    } catch (err) { next(err); }
  });
  app.post('/dashboard/events', requireAuth, action('/dashboard/events', async (req, res) => {
    const newId = await events.createEvent(req.session.user.id, req.body || {});
    res.redirect(303, `/dashboard/events/${newId}?ok=created`);
  }));
  app.get('/dashboard/events/:id', requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.user.id;
      const event = id(req.params.id) && await events.getEvent(userId, id(req.params.id));
      if (!event) return res.redirect('/dashboard/events');
      render(res, 'app-event-edit', event.title, { event, rsvps: await events.listRsvps(userId, event.id) });
    } catch (err) { next(err); }
  });
  app.post('/dashboard/events/:id', requireAuth, action((req) => `/dashboard/events/${req.params.id}`, async (req, res) => {
    await events.updateEvent(req.session.user.id, id(req.params.id), req.body || {});
    res.redirect(303, `/dashboard/events/${req.params.id}?ok=saved`);
  }));
  app.post('/dashboard/events/:id/delete', requireAuth, action('/dashboard/events', async (req, res) => {
    await events.deleteEvent(req.session.user.id, id(req.params.id));
    res.redirect(303, '/dashboard/events?ok=deleted');
  }));
  app.post('/dashboard/events/:id/rsvps/:rsvpId/cancel', requireAuth, action((req) => `/dashboard/events/${req.params.id}`, async (req, res) => {
    await events.cancelRsvp(req.session.user.id, id(req.params.rsvpId));
    res.redirect(303, `/dashboard/events/${req.params.id}?ok=cancelled#attendees`);
  }));

  // --- Courses ---
  app.get('/dashboard/courses', requireAuth, async (req, res, next) => {
    try {
      render(res, 'app-courses', 'Courses', { courses: await courses.listCourses(req.session.user.id) });
    } catch (err) { next(err); }
  });
  app.post('/dashboard/courses', requireAuth, action('/dashboard/courses', async (req, res) => {
    const newId = await courses.createCourse(req.session.user.id, req.body || {});
    res.redirect(303, `/dashboard/courses/${newId}?ok=created`);
  }));

  // Every /dashboard/courses/:id/... action first checks the course is theirs.
  const ownCourse = async (req) => {
    const course = id(req.params.id) && await courses.getCourse(req.session.user.id, id(req.params.id));
    if (!course) throw kit.inputError('That course doesn’t exist.');
    return course;
  };
  const coursePath = (req) => `/dashboard/courses/${req.params.id}`;

  app.get('/dashboard/courses/:id', requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.user.id;
      const course = id(req.params.id) && await courses.getCourse(userId, id(req.params.id));
      if (!course) return res.redirect('/dashboard/courses');
      const [lessons, students] = await Promise.all([courses.listLessons(course.id), courses.listStudents(userId, course.id)]);
      render(res, 'app-course-edit', course.title, { course, lessons, students, editing: id(req.query.lesson) });
    } catch (err) { next(err); }
  });
  app.post('/dashboard/courses/:id', requireAuth, action(coursePath, async (req, res) => {
    await courses.updateCourse(req.session.user.id, id(req.params.id), req.body || {});
    res.redirect(303, `${coursePath(req)}?ok=saved`);
  }));
  app.post('/dashboard/courses/:id/delete', requireAuth, action('/dashboard/courses', async (req, res) => {
    await courses.deleteCourse(req.session.user.id, id(req.params.id));
    res.redirect(303, '/dashboard/courses?ok=deleted');
  }));
  app.post('/dashboard/courses/:id/lessons', requireAuth, action(coursePath, async (req, res) => {
    const course = await ownCourse(req);
    await courses.addLesson(req.session.user.id, course.id, req.body || {});
    res.redirect(303, `${coursePath(req)}?ok=added#lessons`);
  }));
  app.post('/dashboard/courses/:id/lessons/:lessonId', requireAuth, action((req) => `${coursePath(req)}?lesson=${req.params.lessonId}`, async (req, res) => {
    const course = await ownCourse(req);
    await courses.updateLesson(req.session.user.id, course.id, id(req.params.lessonId), req.body || {});
    res.redirect(303, `${coursePath(req)}?ok=saved#lessons`);
  }));
  app.post('/dashboard/courses/:id/lessons/:lessonId/delete', requireAuth, action(coursePath, async (req, res) => {
    const course = await ownCourse(req);
    await courses.deleteLesson(req.session.user.id, course.id, id(req.params.lessonId));
    res.redirect(303, `${coursePath(req)}?ok=deleted#lessons`);
  }));
  app.post('/dashboard/courses/:id/lessons/:lessonId/move', requireAuth, action(coursePath, async (req, res) => {
    const course = await ownCourse(req);
    await courses.moveLesson(req.session.user.id, course.id, id(req.params.lessonId), req.body && req.body.dir === 'up' ? -1 : 1);
    res.redirect(303, `${coursePath(req)}#lessons`);
  }));
  app.post('/dashboard/courses/:id/students/:studentId/remove', requireAuth, action(coursePath, async (req, res) => {
    const course = await ownCourse(req);
    await courses.removeStudent(req.session.user.id, course.id, id(req.params.studentId));
    res.redirect(303, `${coursePath(req)}?ok=removed#students`);
  }));
}

module.exports = { installAppDashboards };
