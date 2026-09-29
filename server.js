// Slotpay server entrypoint — homepage only for now, same stack as
// PageZaper (Node/Express + EJS views, public/ served statically) so this
// can grow into a full app the same way PageZaper did.
const express = require('express');
const path = require('path');

const app = express();
// Falls back to 3000 when PORT isn't set in the environment (e.g. local dev).
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));

// Placeholder brand strings, kept in one place so renaming the product
// later is a one-line change instead of hunting through views/index.ejs.
const SITE_NAME = 'Slotpay';
const SITE_DOMAIN = 'slotpay.page';

app.get('/', (req, res) => {
  res.render('index', {
    title: `${SITE_NAME} — One page. Every way you earn.`,
    siteName: SITE_NAME,
    siteDomain: SITE_DOMAIN,
  });
});

app.listen(PORT, () => {
  console.log(`Slotpay homepage running on port ${PORT}`);
});
