# PageZaper — SEO Content Pack

Everything below is ready to paste into **Platform admin → SEO** (`/admin/seo`, built from `lib/seo.js` + `views/admin-seo.ejs`) and into the code for the one missing technical piece (structured data). No new feature needs to be built — the SEO panel, sitemap, robots.txt, canonical tags, Open Graph and Twitter Card tags are already live and working.

---

## 1. What's already built (confirmed from the code)

- **`/admin/seo`** — an admin panel where you set title, description and a share image per public page (Home, Explore, About, Blog), plus your Google Search Console verification code and GA4 ID. Leave a field blank and it falls back to a built-in default.
- **`/sitemap.xml`** — auto-generated, lists `/`, `/explore`, `/about`, `/blog`, and every published blog post with its last-updated date.
- **`/robots.txt`** — auto-generated, blocks `/dashboard`, `/admin`, `/login`, `/signup` from being crawled, points to the sitemap.
- **Canonical URL, Open Graph, Twitter Card tags** — rendered automatically on every public page via `views/partials/seo-meta.ejs`, driven by whatever you set in the admin panel.
- **The one gap:** no structured data (JSON-LD / schema.org markup) anywhere. That's what gets you the richer Google result (sitelinks search box, knowledge panel eligibility) — code snippet to close that gap is in section 4.

Creator stores (subdomains) and the logged-in dashboard are correctly left out of all of this — that's right, they shouldn't be indexed.

---

## 2. Keyword research (what's actually being searched/targeted in this space)

I don't have a paid keyword-volume tool (Keyword Planner / Ahrefs) connected, so treat the picks below as **directionally right, not volume-verified** — worth a 10-minute pass through the free tier of Google Keyword Planner or Ubersuggest before you commit a content calendar to them.

What's clear from live research into this niche right now: the India creator-tools space is being fought almost entirely on two content patterns — **"[competitor] alternative India"** and **"best platform to sell [X] in India"**. Multiple sites are actively targeting exactly this:

- [Best Link in Bio Tools for Indian Creators 2026](https://profiletap.io/in/blog/best-link-in-bio-tools-india)
- [Link in Bio for India 2026: Turn Your Instagram Bio Into Sales](https://myminiprofile.in/blog/link-in-bio-india-2026)
- [Best Link-in-Bio for Indian Creators 2026: Top 6 Compared](https://www.playto.so/blogs/best-link-in-bio-indian-creators)
- [SuperProfile Alternative for India 2026](https://ownstreet.in/blog/superprofile-alternative-india-2026-guide)
- [Best Platform to Sell Digital Products India 2026](https://ownstreet.in/blog/best-platform-sell-digital-products-india-2026-guide)
- [SuperProfile vs Stan Store (2026) — Fees, Features & the Free Option](https://creatorlanehq.com/compare/superprofile-vs-stan-store)
- [Best SuperProfile Alternative India 2026: 0% Platform Fee + Full Stack](https://playto.so/blogs/superprofile-alternative-india)

That tells you two things: there's real search demand for these terms (enough that multiple sites built pages for them), and nobody owns the "PageZaper" angle on them yet — which is your opening.

**Primary keyword clusters to target:**

- *Category:* link in bio tool India, no-code website builder for creators, creator business toolkit India
- *Use-case:* sell digital products online India, booking page for coaches, course selling platform India, event ticketing page for creators
- *Comparison (highest intent, least competition for you specifically):* superprofile alternative India, stan store alternative India, linktree alternative for selling, pagezaper vs superprofile
- *Local-business angle (matches where you've said you want to take this — booking + payments for salons/clinics/coaches):* online booking page for salon India, appointment booking website for clinic, repeat customer loyalty page for local business

---

## 3. Page-by-page SEO — paste into `/admin/seo`

Character limits are enforced by the form itself (title ≤ 70, description ≤ 160), counts given so you can see the room you have left to tweak.

### Homepage (`/`)
- **Title** (63/70): `PageZaper — Sell Courses, Bookings, Events & Digital Products`
- **Description** (150/160): `One page for your bookings, courses, events, digital products and payments — built for Indian creators, coaches and local businesses. Start free.`

### Explore (`/explore`)
- **Title** (61/70): `Explore — Courses, Bookings & Digital Products | PageZaper`
- **Description** (131/160): `Discover courses, coaching sessions, events and digital products from creators and local businesses on PageZaper's marketplace.`

### About (`/about`)
- **Title** (58/70): `About PageZaper — Built for Indian Creators & Businesses`
- **Description** (145/160): `PageZaper is one page for bookings, courses, events, digital products and payments — built in India, for Indian creators and local businesses.`

### Blog (`/blog`)
- **Title** (56/70): `PageZaper Blog — Guides for Creators & Local Businesses`
- **Description** (106/160): `Tips, guides and platform comparisons for creators, coaches and local businesses selling online in India.`

(Share image: upload one 1200×630px image per page in the same panel — it's what shows up when the link is shared on WhatsApp/Instagram/X. If you don't have one per page yet, a single good homepage share image used everywhere beats a blank one.)

---

## 4. On-page content/structure (homepage especially)

The title/description tags above only control what shows in the Google result and link previews — they don't change anything Google reads to decide you deserve to rank. For that, the actual homepage copy needs the same keywords worked in naturally:

- **H1** should literally contain the core phrase, not just the brand name — e.g. *"One page for bookings, courses, events, digital products and payments"* rather than just *"PageZaper."*
- **Intro paragraph** right under the H1: one sentence stating who it's for (Indian creators, coaches, local businesses) and what problem it solves — this is the paragraph Google usually pulls into the search snippet when your meta description isn't used.
- **A section per app** (Bookings, Courses, Events, Digital Products, Payments) each with its own `<h2>` naming the use-case, not a generic label — e.g. `<h2>Take bookings and payments for your salon, clinic or coaching sessions</h2>` instead of `<h2>Bookings</h2>`. This is also where the local-business keyword cluster earns its place.
- **An FAQ section** near the bottom with 4–6 real questions as `<h3>`s — "Is PageZaper free to start?", "How is PageZaper different from SuperProfile or Stan Store?", "Can I use my own domain?", "Does PageZaper support Indian payment methods?" Direct, factual answers here are what gets pulled into Google's "People also ask" and featured snippets, and it's the natural place to use comparison keywords without writing a whole separate page yet.
- **Internal links** from the homepage into `/explore` and `/about` with real anchor text (not "click here") — you already link to these in the nav, this is about also linking from within the body copy once.

---

## 5. Technical SEO — the one gap: structured data

Nothing to build, just a snippet to paste. Add this inside `views/index.ejs`, right after the `seo-meta` partial is included in the `<head>`:

```html
<script type="application/ld+json">
<%- JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "name": siteName,
      "url": seo.url,
      "logo": seo.url + "logo.png"
    },
    {
      "@type": "WebSite",
      "name": siteName,
      "url": seo.url,
      "potentialAction": {
        "@type": "SearchAction",
        "target": seo.url + "explore?q={search_term_string}",
        "query-input": "required name=search_term_string"
      }
    }
  ]
}) %>
</script>
```

Two things to check before you paste it: `seo.url` on the homepage already resolves to `https://pagezaper.com/` (trailing slash, from `lib/seo.js`'s `PAGES.home.path`), so the string concatenation above doesn't produce a double slash — but confirm `/logo.png` is actually where your logo lives (swap the path if it's served from somewhere else, e.g. `/public/logo.png`). This is homepage-only on purpose — Organization/WebSite schema belongs on the page Google treats as canonical for your brand, not repeated on every page.

A smaller next step, not urgent: adding `Article` schema to `views/blog-post.ejs` the same way, using the post's title/excerpt/cover image — worth doing once you've got a few posts live, since it's what gets blog posts rich results (author, date, image) in search.

---

## 6. Blog topics worth writing (to actually rank for the comparison cluster)

Given what's already ranking in this space, the highest-leverage posts to write first:

1. "PageZaper vs SuperProfile: Which Is Right for Indian Creators?"
2. "Best SuperProfile Alternative for India (2026 comparison)"
3. "How to Take Bookings and Payments for Your Salon or Clinic Online"
4. "Best Platform to Sell Digital Products in India in 2026"

These map directly to the keyword clusters in section 2 and to queries that are already proven to have content (and presumably traffic) built around them by competitors.
