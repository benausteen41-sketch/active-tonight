ACTIVE TONIGHT v2 — Cloudflare Pages + Korapay + Supabase

WHAT CHANGED
- Hosting moved from Netlify to Cloudflare Pages. Site files are in /public, server code in /functions (served at /api/*).
- Payments moved from Paystack to Korapay (checkout redirect + signed webhook + server-side verification).
- 5% platform commission calculated on every order (platform_fee / organizer_amount stored per order).
- Ticket issuing is now one atomic database function (fulfil_order): no duplicate tickets, no "paid but no ticket", no overselling.
- One ticket row (one future QR code) per person admitted.

SETUP (in order)
1) SUPABASE: SQL Editor > run supabase-schema.sql (safe on a fresh or existing project).
   Then make yourself admin: edit and run the last commented line in that file.
   Auth > URL Configuration: set Site URL to your Cloudflare URL.

2) CLOUDFLARE (Workers, connected to GitHub): wrangler.jsonc + src/worker.js tell Cloudflare what to deploy.
   Build command: (empty)   Deploy command: npx wrangler deploy
   The "name" in wrangler.jsonc MUST equal your Worker's name in Cloudflare.
   Worker > Settings > Variables and Secrets (type Secret for the keys; not "Build" variables):
     SUPABASE_URL
     SUPABASE_ANON_KEY
     SUPABASE_SERVICE_ROLE_KEY   (secret)
     KORAPAY_SECRET_KEY          (secret; use the sk_test_ key first)
     COMMISSION_RATE             (optional, default 0.05 = 5%)

3) KORAPAY dashboard > Settings > API Configuration:
   Webhook URL: https://YOUR-SITE.workers.dev/api/korapay-webhook
   (the site also sends this URL with every payment, so it works either way)
   Test the full flow in sandbox with the test secret key BEFORE going live.

4) LOCAL TESTING: npm install, copy .dev.vars.example to .dev.vars, fill it in, then npm run dev.

HOW MONEY IS TRACKED
- order.total_amount        what the buyer pays
- order.platform_fee        5% of total (your commission)
- order.organizer_amount    95% owed to the organizer
- Korapay's own processing fee is not added on top of the ticket price in this version; check your Korapay settlement
  terms and decide who bears it. Organizer payouts are still manual until the payouts feature is built.

STILL TO BUILD (agreed next steps)
- Admin dashboard (until then, approve events in Supabase: update events set status='published' where id=...)
- Organizer earnings dashboard, QR code images, entrance scanner, VIP tables, push notifications, mobile apps
- Refund handling for orders marked needs_refund, email receipts, rate limiting (Cloudflare WAF rules)

NOTES
- Existing test data: tickets from the old milestone lose their quantity column; re-buy test tickets after migrating.
- Never commit .dev.vars or paste secret keys in chat. The Supabase publishable key in app.js is meant to be public.
- Verify in the Korapay sandbox that the verify response's "amount" equals the ticket total (see functions/_lib/shared.js).
