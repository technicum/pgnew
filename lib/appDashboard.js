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
const courseMedia = require('./courseMedia');
const kit = require('./appKit');
const { paymentMode } = require('./payments');
const { findUserById } = require('./users');
const { abandonedView } = require('./abandoned');

const OK_MESSAGES = {
  paid: 'Marked paid — the booking is confirmed.',
  created: 'Created — fill in the details below.',
  saved: 'Saved.',
  draft: 'New event — fill it in, then Save & publish. It stays hidden until then.',
  published: 'Published — your page is live.',
  deleted: 'Deleted.',
  cancelled: 'Cancelled.',
  added: 'Added — fill in the details below.',
  'module-added': 'Module added.',
  'devices-reset': 'Devices reset — their link works on the next devices they open it on.',
  removed: 'Removed.',
};

function installAppDashboards(app, { requireAuth, siteName }) {
  // Flash message from the redirect, and date/time formatting for views.
  app.use(['/dashboard/bookings', '/dashboard/events', '/dashboard/courses'], (req, res, next) => {
    res.locals.flash = req.query.error
      ? { kind: 'error', text: String(req.query.error).slice(0, 200) }
      : OK_MESSAGES[req.query.ok] ? { kind: 'ok', text: OK_MESSAGES[req.query.ok] } : null;
    res.locals.fmt = { date: kit.formatDate, time: kit.formatTime, hours: bookings.hoursSummary, tz: kit.tzLabel };
    if (!req.session.user) return next();
    // The store's accent, for the editors' live preview (public/js/ax-preview.js).
    return findUserById(req.session.user.id).then((me) => {
      res.locals.storeTheme = { accent_color: me && me.accent_color };
      next();
    }, next);
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
  // Four tabs (partials/booking-tabs): Booking page (the services on
  // /book), Upcoming bookings (who's booked), Abandoned (booked a paid
  // session, didn't pay the advance — lib/abandoned.js), Settings (how
  // /book looks, payments, days off). Each gets the booking settings for
  // the link to /book and the counts for its tabs.
  const bookingTab = async (req, res, view, title, data) => {
    const userId = req.session.user.id;
    const [settings, upcomingCount, ab] = await Promise.all([
      bookings.getSettings(userId), bookings.countUpcoming(userId), data.ab ? null : abandonedView(userId, { kind: 'booking' }),
    ]);
    const abandonedCount = (data.ab || ab).waiting;
    render(res, view, title, { bookingSettings: settings, upcomingCount, abandonedCount, paymentMode: paymentMode(), ...data });
  };

  // Booking page tab
  app.get('/dashboard/bookings', requireAuth, async (req, res, next) => {
    try {
      await bookingTab(req, res, 'app-booking-page', 'Booking page', { services: await bookings.listServices(req.session.user.id) });
    } catch (err) { next(err); }
  });
  app.post('/dashboard/bookings/page', requireAuth, action('/dashboard/bookings/settings/page', async (req, res) => {
    await bookings.saveSettings(req.session.user.id, 'page', req.body || {});
    res.redirect(303, '/dashboard/bookings/settings/page?ok=saved');
  }));
  // The services list used to be its own tab.
  app.get('/dashboard/bookings/services', requireAuth, (req, res) => res.redirect(301, '/dashboard/bookings#services'));
  app.post('/dashboard/bookings/services', requireAuth, action('/dashboard/bookings#services', async (req, res) => {
    const newId = await bookings.createService(req.session.user.id, req.body || {});
    res.redirect(303, `/dashboard/bookings/services/${newId}?ok=created`);
  }));
  app.get('/dashboard/bookings/services/:id', requireAuth, async (req, res, next) => {
    try {
      const service = id(req.params.id) && await bookings.getService(req.session.user.id, id(req.params.id));
      if (!service) return res.redirect('/dashboard/bookings#services');
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
  app.post('/dashboard/bookings/services/:id/delete', requireAuth, action('/dashboard/bookings#services', async (req, res) => {
    await bookings.deleteService(req.session.user.id, id(req.params.id));
    res.redirect(303, '/dashboard/bookings?ok=deleted#services');
  }));

  // Upcoming bookings tab
  app.get('/dashboard/bookings/abandoned', requireAuth, async (req, res, next) => {
    try {
      await bookingTab(req, res, 'app-booking-abandoned', 'Abandoned bookings', { ab: await abandonedView(req.session.user.id, { kind: 'booking' }) });
    } catch (err) { next(err); }
  });
  app.get('/dashboard/bookings/upcoming', requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.user.id;
      const [upcoming, past, services] = await Promise.all([
        bookings.listBookings(userId, { upcoming: true }),
        bookings.listBookings(userId, { upcoming: false }),
        bookings.listServices(userId),
      ]);
      await bookingTab(req, res, 'app-bookings', 'Upcoming bookings', { upcoming, past: past.slice(0, 30), hasServices: services.length > 0 });
    } catch (err) { next(err); }
  });
  app.post('/dashboard/bookings/:id/paid', requireAuth, action('/dashboard/bookings/upcoming', async (req, res) => {
    await bookings.markBookingPaid(req.session.user.id, id(req.params.id));
    res.redirect(303, '/dashboard/bookings/upcoming?ok=paid');
  }));
  app.post('/dashboard/bookings/:id/cancel', requireAuth, action('/dashboard/bookings/upcoming', async (req, res) => {
    await bookings.cancelBooking(req.session.user.id, id(req.params.id));
    res.redirect(303, '/dashboard/bookings/upcoming?ok=cancelled');
  }));

  // Settings tab
  // Settings sub-tabs: /settings is Availability; /settings/page and
  // /settings/payments the others.
  const SETTINGS_SECTIONS = new Set(['availability', 'page', 'payments']);
  app.get(['/dashboard/bookings/settings', '/dashboard/bookings/settings/:section'], requireAuth, async (req, res, next) => {
    try {
      const section = req.params.section || 'availability';
      if (!SETTINGS_SECTIONS.has(section)) return res.redirect('/dashboard/bookings/settings');
      const daysOff = section === 'availability' ? await bookings.listDaysOff(req.session.user.id) : [];
      await bookingTab(req, res, 'app-booking-settings', 'Booking settings', {
        section, daysOff, today: await bookings.todayFor(req.session.user.id), weekdays: bookings.WEEKDAYS, maxRanges: bookings.MAX_RANGES,
        timezones: section === 'availability' ? kit.timezoneOptions() : [],
        timezoneAliases: kit.TIMEZONE_ALIASES,
      });
    } catch (err) { next(err); }
  });
  app.post('/dashboard/bookings/settings', requireAuth, action('/dashboard/bookings/settings/payments', async (req, res) => {
    await bookings.saveSettings(req.session.user.id, 'payments', req.body || {});
    res.redirect(303, '/dashboard/bookings/settings/payments?ok=saved');
  }));
  app.post('/dashboard/bookings/availability', requireAuth, action('/dashboard/bookings/settings', async (req, res) => {
    await bookings.saveSettings(req.session.user.id, 'availability', req.body || {});
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
      });
    } catch (err) { next(err); }
  });
  // "Create event" — like a new payment page, it opens straight in the
  // editor: a hidden draft a week out at 6 pm, published from there.
  app.post('/dashboard/events', requireAuth, action('/dashboard/events', async (req, res) => {
    const newId = await events.createEvent(req.session.user.id, {
      title: 'Untitled event', date: kit.addDays(kit.nowLocal().date, 7), start_time: '18:00', mode: 'online', visible: 0,
    });
    res.redirect(303, `/dashboard/events/${newId}?ok=draft`);
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
    const body = req.body || {};
    // "Save & publish" on a hidden event turns it on as it saves.
    if (body.publish) body.visible = '1';
    await events.updateEvent(req.session.user.id, id(req.params.id), body);
    res.redirect(303, `/dashboard/events/${req.params.id}?ok=${body.publish ? 'published' : 'saved'}`);
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
      const userId = req.session.user.id;
      const [list, ab] = await Promise.all([courses.listCourses(userId), abandonedView(userId, { kind: 'course' })]);
      render(res, 'app-courses', 'Courses', { courses: list, ab });
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
      const [modules, lessons, students, scores, devices, ab] = await Promise.all([
        courses.listModules(course.id), courses.listLessons(course.id), courses.listStudents(userId, course.id), courses.quizScores(course.id),
        courses.listDevices(course.id), abandonedView(userId, { kind: 'course', itemId: course.id }),
      ]);
      render(res, 'app-course-edit', course.title, {
        course, lessons, students, scores, devices, modules, editing: id(req.query.lesson),
        abandonedCount: ab.carts.length,
        maxDevices: courses.MAX_DEVICES,
        outline: courses.groupModules(lessons, modules),
        counts: courses.countKinds(lessons),
        kinds: courses.KINDS,
        maxQuestions: courses.MAX_QUESTIONS,
        maxOptions: courses.MAX_OPTIONS,
        fileAccept: courseMedia.FILE_ACCEPT,
        maxFileMb: courseMedia.MAX_FILE_BYTES / 1024 / 1024,
        sizeLabel: courseMedia.sizeLabel,
        paymentMode: paymentMode(),
      });
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
    const newId = await courses.addLesson(req.session.user.id, course.id, req.body || {});
    res.redirect(303, `${coursePath(req)}?lesson=${newId}&ok=added#lesson-${newId}`);
  }));
  // Modules: add, rename, reorder, delete (its items stay, outside any module).
  app.post('/dashboard/courses/:id/modules', requireAuth, action(coursePath, async (req, res) => {
    const course = await ownCourse(req);
    const newId = await courses.addModule(req.session.user.id, course.id, req.body || {});
    res.redirect(303, `${coursePath(req)}?ok=module-added#module-${newId}`);
  }));
  app.post('/dashboard/courses/:id/modules/:moduleId', requireAuth, action(coursePath, async (req, res) => {
    const course = await ownCourse(req);
    await courses.renameModule(req.session.user.id, course.id, id(req.params.moduleId), req.body || {});
    res.redirect(303, `${coursePath(req)}?ok=saved#module-${req.params.moduleId}`);
  }));
  app.post('/dashboard/courses/:id/modules/:moduleId/move', requireAuth, action(coursePath, async (req, res) => {
    const course = await ownCourse(req);
    await courses.moveModule(req.session.user.id, course.id, id(req.params.moduleId), req.body && req.body.dir === 'up' ? -1 : 1);
    res.redirect(303, `${coursePath(req)}#module-${req.params.moduleId}`);
  }));
  app.post('/dashboard/courses/:id/modules/:moduleId/delete', requireAuth, action(coursePath, async (req, res) => {
    const course = await ownCourse(req);
    await courses.deleteModule(req.session.user.id, course.id, id(req.params.moduleId));
    res.redirect(303, `${coursePath(req)}?ok=deleted#lessons`);
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
  // A lesson's own video (lib/courseMedia.js): the editor's script sends
  // the file as the raw body and gets JSON back; it's stored privately.
  app.post('/dashboard/courses/:id/lessons/:lessonId/video', requireAuth, async (req, res) => {
    try {
      const course = await ownCourse(req);
      const lesson = await courses.getLesson(course.id, id(req.params.lessonId));
      if (!lesson) return res.status(404).json({ error: 'That lesson doesn’t exist.' });
      const file = await courseMedia.saveVideoFromRequest(req, req.session.user.id);
      const old = await courses.setLessonVideo(req.session.user.id, course.id, lesson.id, file);
      await courseMedia.removeVideo(old);
      return res.status(201).json({ ok: true });
    } catch (err) {
      if (err.code === 'INVALID_UPLOAD' || err.code === 'INVALID_INPUT') return res.status(err.status || 400).json({ error: err.message });
      console.error('Lesson video upload failed:', err);
      return res.status(500).json({ error: 'Could not upload that video. Please try again.' });
    }
  });
  app.post('/dashboard/courses/:id/lessons/:lessonId/video/delete', requireAuth, action((req) => `${coursePath(req)}?lesson=${req.params.lessonId}`, async (req, res) => {
    const course = await ownCourse(req);
    const old = await courses.setLessonVideo(req.session.user.id, course.id, id(req.params.lessonId), '');
    await courseMedia.removeVideo(old);
    res.redirect(303, `${coursePath(req)}?lesson=${req.params.lessonId}&ok=removed#lesson-${req.params.lessonId}`);
  }));
  // The creator watching their own upload in the editor.
  app.get('/dashboard/courses/:id/lessons/:lessonId/video', requireAuth, async (req, res, next) => {
    try {
      const course = await courses.getCourse(req.session.user.id, id(req.params.id));
      const lesson = course && await courses.getLesson(course.id, id(req.params.lessonId));
      if (!lesson || !lesson.video_file) return res.status(404).end();
      return courseMedia.sendVideo(req, res, lesson.video_file);
    } catch (err) {
      return next(err);
    }
  });
  // A download's file (lib/courseMedia.js): sent by the editor's script as
  // the raw body, its name in X-File-Name; JSON back. Stored privately.
  app.post('/dashboard/courses/:id/lessons/:lessonId/file', requireAuth, async (req, res) => {
    try {
      const course = await ownCourse(req);
      const item = await courses.getLesson(course.id, id(req.params.lessonId));
      if (!item || item.kind !== 'file') return res.status(404).json({ error: 'That download doesn’t exist.' });
      const file = await courseMedia.saveFileFromRequest(req, req.session.user.id);
      const old = await courses.setLessonFile(req.session.user.id, course.id, item.id, file);
      await courseMedia.removeFile(old);
      return res.status(201).json({ ok: true });
    } catch (err) {
      if (err.code === 'INVALID_UPLOAD' || err.code === 'INVALID_INPUT') return res.status(err.status || 400).json({ error: err.message });
      console.error('Course file upload failed:', err);
      return res.status(500).json({ error: 'Could not upload that file. Please try again.' });
    }
  });
  app.post('/dashboard/courses/:id/lessons/:lessonId/file/delete', requireAuth, action((req) => `${coursePath(req)}?lesson=${req.params.lessonId}`, async (req, res) => {
    const course = await ownCourse(req);
    const old = await courses.setLessonFile(req.session.user.id, course.id, id(req.params.lessonId), null);
    await courseMedia.removeFile(old);
    res.redirect(303, `${coursePath(req)}?lesson=${req.params.lessonId}&ok=removed#lesson-${req.params.lessonId}`);
  }));
  // The creator downloading their own upload from the editor.
  app.get('/dashboard/courses/:id/lessons/:lessonId/file', requireAuth, async (req, res, next) => {
    try {
      const course = await courses.getCourse(req.session.user.id, id(req.params.id));
      const item = course && await courses.getLesson(course.id, id(req.params.lessonId));
      if (!item || !item.file_name) return res.status(404).end();
      return courseMedia.sendCourseFile(res, item.file_name, item.file_label);
    } catch (err) {
      return next(err);
    }
  });
  // A student on a new phone / with cleared cookies: free their device slots.
  app.post('/dashboard/courses/:id/students/:studentId/devices/reset', requireAuth, action(coursePath, async (req, res) => {
    const course = await ownCourse(req);
    await courses.resetDevices(req.session.user.id, course.id, id(req.params.studentId));
    res.redirect(303, `${coursePath(req)}?ok=devices-reset#students`);
  }));
  app.post('/dashboard/courses/:id/students/:studentId/remove', requireAuth, action(coursePath, async (req, res) => {
    const course = await ownCourse(req);
    await courses.removeStudent(req.session.user.id, course.id, id(req.params.studentId));
    res.redirect(303, `${coursePath(req)}?ok=removed#students`);
  }));
}

module.exports = { installAppDashboards };
