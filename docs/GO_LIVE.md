# Hope Kitchen web: going live (Supabase + Vercel)

Prepared 2026-10-31. Nothing here has been run against a real Supabase project yet: every step was
rehearsed on this Mac (PGlite with Supabase's layout, the local test server). Tick each box as it is done.
About an hour, most of it waiting on dashboards.

## 0. Before you start

- [ ] **A Supabase project of its own** (not FQC's: that project is Hope's). The CEO's account is at its
      2-free-project limit (2026-10-29): free a slot or use a paid plan.
- [ ] **Make `cgomez1365/htm-kitchen` private.** Vercel deploys private repos; give its GitHub app access.
- [ ] **Vercel plan.** Hobby is for personal, non-commercial use. Daily use by a kitchen likely needs Pro: confirm.

## 1. Supabase project

- [ ] Create the project (region: West US). Save the **database password** in your password manager.
- [ ] **Authentication → Sign In / Providers → Email:** on. **Email OTP length = 6** (the default is 8; the
      sign-in screen takes 6. FQC hit this.) OTP expiry 3600 s.
- [ ] **Authentication → Email Templates → Magic Link:** the body must show the code: `{{ .Token }}`
      (for example "Your Hope Kitchen code: {{ .Token }}"). A link alone does not work with this sign-in.
- [ ] **Authentication → Sign In / Providers:** turn **off** "Allow new users to sign up". Directors add
      everyone from Admin; the app's server makes their sign-ins.
- [ ] **Authentication → URL Configuration:** Site URL = the Vercel address (fill in after step 3).
- [ ] **Email sending:** the built-in sender allows only a few emails an hour, enough for a pilot. For daily
      use set up your own SMTP (Authentication → Emails → SMTP).

## 2. The database (pick one)

**A. SQL Editor with `supabase/master.sql`** (no connection string needed; the FQC way):
- [ ] Open `supabase/master.sql` from the repo, copy **all** of it, paste into **SQL Editor → New query**, press **Run** once.
- [ ] The result must read: `Hope Kitchen schema 9 installed, security check passed`.
      Anything else means nothing was kept: it runs as one transaction and rolls back on any error.
- [ ] It refuses, changing nothing, in a project that already has Hope Kitchen, has any other tables
      (FQC's project), or is not Supabase. Paste it into the wrong project and it says so.
- [ ] It was sanitised for the editor (FQC's 2026-09-21 trap): no comments outside function bodies, no
      `;` inside ordinary strings. `test:sql` runs it split the worst way an editor could and proves it builds
      exactly what the migrations build. Regenerate after any migration change: `npm run sql:master`.

**B. `npm run db:apply`** (direct connection; also how every LATER update goes in, with a backup first):
- [ ] **Project Settings → Database → Connection string → Session pooler**, password filled in, as one line
      in `web/.env.local` (never committed):
      `SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-us-west-1.pooler.supabase.com:5432/postgres`
- [ ] `cd web && npm run db:apply -- --dry`: it must name your project and list 0001 to 0009.
- [ ] `npm run db:apply`: nine `ok` lines, then `schema now: 9. Done.` It refuses a database that holds
      somebody else's tables or is newer than the code, and backs up every row first (from the second run on)
      into `Hope_Online/live/hope-kitchen-dumps/`, beside the repo.

**Either way, then:**
- [ ] Paste `supabase/security_check.sql` into the SQL Editor and run it: `security check passed`. It changes
      nothing; run it again after any change made by hand in the dashboard.

## 3. Vercel

- [ ] New project → import `cgomez1365/htm-kitchen` → **Root Directory `web`** (Next.js is detected).
- [ ] Environment variables (Production and Preview):

  | Name | Value | Where from |
  |---|---|---|
  | `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` | Project Settings → API |
  | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the anon (publishable) key | Project Settings → API |
  | `SUPABASE_SERVICE_ROLE_KEY` | the service_role (secret) key, marked **Sensitive** | Project Settings → API |

  The service key is the one real secret: it must never get a `NEXT_PUBLIC_` name, and only the server
  routes (`/api/admin/accounts`, `/api/pair`) use it. Do not set `NEXT_PUBLIC_HK_PREVIEW` (preview mode is
  refused on Vercel anyway).
- [ ] Deploy. Put the address into Supabase's Site URL (step 1).

## 3b. Security steps (dashboard; SQL cannot check these)

- [ ] **Sign-ups off** (step 1) and **email code length 6**.
- [ ] **MFA** on every account that can open the Supabase and Vercel dashboards; only the people who need
      them are members of Hope's Supabase organisation and Vercel team.
- [ ] **Service key**: only in Vercel, marked Sensitive, never `NEXT_PUBLIC_`, never in a chat, ticket or the repo.
      If it is ever exposed: Supabase → Project Settings → API → roll it, update Vercel, redeploy.
- [ ] **Database password**: in the password manager only. `web/.env.local` stays on the one Mac that applies updates.
- [ ] **Supabase → Advisors → Security Advisor**: no errors. (Warnings about functions are expected to be
      checked against `security_check.sql`; it is the stricter list.)
- [ ] **Data API → exposed schemas**: `public` only (the default).
- [ ] **The repo is private** before the first deploy.
- [ ] What the database already refuses on its own, whatever the app does: writes that do not go through a door;
      reading another location's stock from a tablet; deleting any record; PIN guessing (5 wrong = 15 min);
      names or notes with hidden control or right-to-left characters, or longer than the screens show (0009).

## 4. The first Director

- [ ] Supabase → **Authentication → Users → Add user** → your email, **Auto Confirm** on, no password.
- [ ] Open the site → Manager → your email → the 6-digit code from your inbox → **Setup** asks your name.
      You are the Director. Setup refuses once anyone exists.

## 5. Smoke test, on a real iPad (about 10 minutes)

- [ ] Admin → People → add a chef (the PIN is made for you; note it).
- [ ] Admin → Tablets → Add tablet → on the iPad, point the **Camera** at the QR and tap the link. The
      Director's screen turns green. *(First real test of the tablet sign-in addresses: if Supabase refuses
      `@tablets.hope-kitchen.invalid`, set `HK_TABLET_EMAIL_DOMAIN` in Vercel to a domain you own, redeploy, retry.)*
- [ ] On the iPad: tap the chef, enter the PIN, **Use the camera**, scan a printed item label (Items → an item
      → Print label). Stock changes and the feed shows the chef's name.
- [ ] Airplane mode on, scan once ("waiting for signal"), airplane mode off: it sends itself within 30 s,
      and the item's history shows it once.
- [ ] Admin → People → add an Inventory Manager with an email; they sign in with an emailed code.

## 6. After go-live

- [ ] **Backups.** Supabase's free plan keeps none. `db:apply` backs up only when it applies something.
      A nightly backup job like FQC's (dated zip, restore rehearsal) is not built yet: build it before
      the kitchen relies on the data.
- [ ] Decide `shortfallDecision` (taking out more than the system shows): it refuses until decided.
- [ ] Old Vercel projects `hope-inventory` / `hope-inventory-command`: leave or delete, owner's call. The old
      Firebase project is never reused.
