# 🏠 صندوق السكن — Housing Fund

A shared housing-fund app for roommates. It has a simple Arabic (RTL) interface, and every member sees the same balance in real time.

- **Real-time sync**: Firestore listeners update the balance, history and member list for everyone instantly.
- **Secure member access**: sign in with Firebase Authentication (Google, or email + password with a verified email). Only emails an admin has added can join.
- **Deposits, expenses, history**: every operation records who made it and when, plus the balance after it.
- **No overspending**: every money operation runs on the server inside an atomic Firestore transaction. An expense larger than the current balance is rejected, even when many members submit at once.
- **Append-only history and audit trail**: entries are never deleted. "إلغاء" adds a compensating reversal entry, and every action is written to `auditLog` in the same transaction.
- **Responsive**: single column on phones, two columns on desktop.

## Architecture

```
Browser (public/, src/client/)                 Render web service (server/)
  ├─ Firebase Auth  ── ID token ───────────────►  Express API (verifies token, checks membership)
  ├─ Firestore onSnapshot (READ ONLY) ◄─┐          └─ firebase-admin runTransaction:
  │                                      │              fund/main + transactions/{id} + auditLog/{id}
  └─ POST /api/transactions ... ─────────┼────────►     written together or not at all
                                         └──────── Firestore (rules: clients can't write anything)
```

| Collection | Contents | Client access (see `firestore.rules`) |
|---|---|---|
| `fund/main` | `balanceCents`, `totalDepositsCents`, `totalExpensesCents`, `transactionCount` | active members: read |
| `transactions/{id}` | type (`deposit`/`expense`/`reversal`), `amountCents`, `description`, member, `balanceAfterCents`, `createdAt` | active members: read |
| `members/{uid}` | name, email, role (`admin`/`member`), `active` | active members: read |
| `allowedEmails/{email}` | invite list | admins: read |
| `auditLog/{id}` | action, actor, details, timestamp | admins: read |

All writes are denied to clients, so a modified browser cannot change the balance. Amounts are stored as integer cents (1/100 JOD), so there is no floating-point drift.

### API (all require `Authorization: Bearer <Firebase ID token>`)

| Method | Path | Who |
|---|---|---|
| POST | `/api/session` | any signed-in user. Joins the fund if invited, otherwise 403 |
| POST | `/api/transactions` `{type, amount, description, requestId}` | members. `requestId` makes retries idempotent |
| POST | `/api/transactions/:id/reverse` `{reason}` | the transaction's creator, or an admin |
| PATCH | `/api/me` `{name}` | members |
| POST | `/api/admin/members` `{email, role}` | admins |
| DELETE | `/api/admin/members/:email` | admins (revokes access immediately) |

## Run locally (with the Firebase emulators, no Firebase account needed)

Requires Node 20+ and Java 11+.

```bash
npm ci
ADMIN_EMAILS=you@example.com npm run dev   # builds the client, starts Auth + Firestore emulators, serves http://localhost:3000
```

Create an account with that email in the UI. The email-verification link is printed in the emulator log; open it, then click "تم التأكيد".

## Tests

```bash
npm test
```

This runs:

- **Unit tests** (`test/unit`): amount parsing, text sanitising, formatting.
- **API integration tests** (`test/emulator/api.test.js`) against the Auth + Firestore emulators: membership, deposits and expenses, overspend rejection, 12 concurrent expenses against a limited balance (never overdrawn), idempotent retries, reversals, admin actions, token revocation, security headers.
- **Security rules tests** (`test/emulator/rules.test.mjs`).
- **Browser E2E** (`test/emulator/e2e.test.js`): two members in separate browsers, one desktop and one mobile, see each other's changes live. Runs when Playwright is available, and is skipped otherwise.

## Firebase setup (one-time, needs your Firebase account)

1. Create a project at <https://console.firebase.google.com>.
2. **Firestore Database** → Create database (production mode).
3. **Authentication** → Sign-in method → enable **Google** and/or **Email/Password**.
4. **Project settings → General → Your apps** → add a **Web app**. Copy `apiKey`, `authDomain`, `projectId`, `appId`.
5. **Project settings → Service accounts** → *Generate new private key*. This JSON file is a secret; never commit it.
6. Deploy the security rules:
   ```bash
   npx firebase login
   npx firebase deploy --only firestore:rules,firestore:indexes --project <your-project-id>
   ```
7. After deploying to Render, add your Render domain (e.g. `housing-fund.onrender.com`) under **Authentication → Settings → Authorized domains**.

## Deploy to Render

1. The Render service uses the **Docker** runtime (`Dockerfile`). For a new setup: **New + → Blueprint**, then select this repository; `render.yaml` defines the web service. For the existing `Housing-fund` service, just set the variables below.
2. Fill in the environment variables when prompted (see `.env.example`):
   - `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_APP_ID` (public web config)
   - `FIREBASE_SERVICE_ACCOUNT`: paste the service-account JSON, or base64 of it
   - `ADMIN_EMAILS`: your email (comma-separate several). These accounts are always admins.
3. Deploy. The health check is `GET /healthz`.
4. Open the site and sign in with an `ADMIN_EMAILS` address. Then add the other members' emails under **إدارة الأعضاء**. They sign in with those same emails.

> The free Render plan sleeps after inactivity, so the first request can take ~30–60 s.

## Migrating from the old version

The previous version stored data only in each browser's `localStorage` (`housing-fund-v1`). That data isn't migrated automatically. To carry over the old balance, an admin can record a single deposit, e.g. "رصيد سابق".
