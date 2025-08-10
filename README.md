# Ivy Options (NIFTY Options Trader) — vCurrent

A full-stack React + Node/Express + Prisma (SQLite) app for building, staging, and managing NIFTY/BANKNIFTY options strategies with a live (synthetic for now) market stream, payoff analytics, and persistent strategies per user.

This README covers **local setup**, **database init**, **running dev servers**, and a quick tour of features/endpoints.

---

## Tech Stack

* **Frontend:** React (Vite), Tailwind + Material Tailwind components, ApexCharts, Socket.io client
* **Backend:** Node/Express (TypeScript), Socket.io server, Prisma ORM
* **DB:** SQLite (Prisma)
* **Auth:** JWT (email + password)
* **Persistence:** Strategies + Legs saved to DB, user-scoped
* **Live data:** Synthetic price/ticks for now (pluggable later with Dhan/Kite feeds)

---

## Prerequisites

* **Node.js 18+** (LTS recommended)
* **npm** (we use npm everywhere)
* MacOS (as you’re using)

---

## 1) Clone / Unzip

```
your-project/
  app/        # frontend
  server/     # backend (TypeScript)
```

Open the project folder in VS Code.

---

## 2) Environment variables

### `server/.env`

Create `server/.env`:

```
# Web API
PORT=4000
ALLOW_ORIGIN=http://localhost:5173

# SQLite database
DATABASE_URL="file:./dev.db"

# Auth
JWT_SECRET=change_me_in_prod

# (Placeholders for future broker integrations)
KITE_API_KEY=
KITE_API_SECRET=
KITE_ACCESS_TOKEN=
DHAN_CLIENT_ID=
DHAN_ACCESS_TOKEN=
```

> `ALLOW_ORIGIN` should match your Vite dev server origin.

### `app/.env` (optional)

If your frontend calls the API via **relative** `/api/...` and your Vite dev server already proxies `/api` → `http://localhost:4000`, you can skip this.
If you prefer absolute URLs, create `app/.env`:

```
VITE_API_BASE="http://localhost:4000"
```

---

## 3) Install dependencies

In two terminals:

### Backend

```bash
cd server
npm install
```

### Frontend

```bash
cd app
npm install
```

---

## 4) Initialize the database (Prisma + SQLite)

From **`server/`**:

```bash
# Format & generate client
npx prisma format
npx prisma generate

# Create / migrate the local SQLite DB
npx prisma migrate dev -n init
```

This creates `server/prisma/dev.db` (via `DATABASE_URL`) with the following tables:

* `User` (id, email, password, name, …)
* `Strategy` (userId, name, isArchived, defaultLots, underlying, atmBasis, selectedExpiry, realized, …)
* `Leg` (strategyId, status, side, type, strike, premium, lots, expiry, entryPrice, exitPrice, …)

> If you later change the schema, run another `npx prisma migrate dev -n <name>` and `npx prisma generate`.

---

## 5) Run in development

### Backend

From **`server/`**:

```bash
npm run dev
```

* Starts Express on `http://localhost:4000`
* Socket.io server is attached to the same port
* Synthetic ticks are broadcast for spot/VIX/PCR (you’ll see logs)

### Frontend

From **`app/`**:

```bash
npm run dev
```

* Starts Vite on `http://localhost:5173`
* If you have a Vite proxy set, `/api/*` calls will go to `http://localhost:4000`
* Otherwise, set `VITE_API_BASE` in `app/.env` as shown above

Open **[http://localhost:5173](http://localhost:5173)** in your browser.

---

## 6) First use

1. Click the **Account** button (top-right) → **Create account**
   (We support “Name” on register; it will show next to your email after login.)

2. Click the **Strategy** pill (top-left) → `+ New` to create a strategy, or choose an existing one.

   * The active strategy shows **Active**.
   * You can **Archive** strategies and toggle **Show archived**.

3. **Option Chain** (left) → **Buy/Sell** to **stage** legs (not placed yet).

   * Staged legs appear in **Staged Orders** with **Place**, **Remove**, **Place all**, **Clear**.
   * Placing a staged leg moves it to **Open Positions** and records entry price.

4. **Open Positions** allow **Square off** (individual or all).

   * Realized P/L is tracked and shown; notional analytics update the payoff chart.

5. The **Payoff** panel updates live as market (synthetic) moves and as you stage/close legs.

All strategy state (prefs + legs) is **persisted per user** in SQLite.

---

## 7) Project structure (high-level)

```
server/
  src/
    index.ts               # Express app, Socket.io server
    db.ts                  # Prisma client
    middleware/auth.ts     # JWT sign/verify
    routes/
      auth.ts              # /api/auth (register/login/me)
      strategies.ts        # /api/strategies (CRUD + legacy /:id/state compat)
      legs.ts              # /api/legs (CRUD, realized P/L update on close)
      trade.ts             # /api/place-order (stubbed to broker adapters)
    ticks.ts               # synthetic feed broadcaster
  prisma/
    schema.prisma
  .env
  package.json

app/
  src/
    layout/
      Shell.jsx Sidebar.jsx Topbar.jsx
    pages/
      Dashboard.jsx
    components/
      OptionChain.jsx PositionsList.jsx PayoffPanel.jsx Toaster.jsx
    hooks/
      useSocket.js
    utils/
      api.js auth.js strategyStore.js bs.js format.js
    main.jsx App.jsx styles.css config.js
  .env (optional)
  package.json
```

---

## 8) API quick reference

All endpoints are **JWT-protected** except `/api/auth/*`.

### Auth

* `POST /api/auth/register` → `{ email, password, name? }`
* `POST /api/auth/login` → `{ email, password }`
* `GET  /api/auth/me` → current user

Send `Authorization: Bearer <token>` for protected routes.

### Strategies

* `GET    /api/strategies?includeArchived=0|1` → list
* `POST   /api/strategies` → `{ name, defaultLots?, underlying?, atmBasis?, selectedExpiry? }`
* `GET    /api/strategies/:id` → full strategy + legs + compat `state`
* `PATCH  /api/strategies/:id` → update name/archive/defaultLots/prefs
* `PUT    /api/strategies/:id/state` → **compat**: updates prefs (defaultLots, underlying, atmBasis, selectedExpiry, realized)
* `DELETE /api/strategies/:id` → deletes legs first, then strategy

### Legs

* `GET    /api/legs?strategyId=:id`
* `POST   /api/legs` → `{ strategyId, side, type, strike, premium, lots, expiry, status?, entryPrice? }`
* `PATCH  /api/legs/:id` → update status/lots/premium/entryPrice/exitPrice

  * When closing with `status=CLOSED` and `exitPrice`, we update `Strategy.realized`.
* `DELETE /api/legs/:id`

### Trade (stub)

* `POST /api/place-order` → forwards to (future) Dhan/Zerodha adapters; currently stubbed for optimistic UI

---

## 9) Scripts

### Server

* `npm run dev` — start dev server with ts-node / nodemon
* `npm run build` — compile to `dist/`
* `npm start` — run compiled server

### Frontend

* `npm run dev` — Vite dev server
* `npm run build` — production build to `dist/`
* `npm run preview` — preview production build locally

---

## 10) Troubleshooting

* **`500 /api/auth/login` from the frontend**
  Ensure the **server** is running and `ALLOW_ORIGIN` matches `http://localhost:5173`.

* **Prisma type errors (fields not found)**
  Your generated client is stale. From `server/`:

  ```
  npx prisma format
  npx prisma generate
  ```

  If you changed the schema:

  ```
  npx prisma migrate dev -n <migration-name>
  npx prisma generate
  ```

* **Database locked / need a clean start**
  Stop the server, delete `server/prisma/dev.db`, then:

  ```
  npx prisma migrate dev -n reset
  ```

* **CORS issues**
  Verify `ALLOW_ORIGIN` in `server/.env` is exactly your frontend origin.

* **Buttons not visible (Tailwind class missing)**
  Ensure Tailwind is scanning `./src/**/*.{js,jsx,ts,tsx}` and you restarted Vite after config changes.

---

## 11) What’s in this version

* Modern topbar with **NIFTY**, **VIX**, **PCR** chips and a **Strategy** pill:

  * Create / Load / Archive strategies (overlay list)
  * Show current strategy name
* **User auth** (register with name, login/logout)
* **Persistent strategies** per user (DB) with:

  * **Open Positions**, **Staged Orders**, and **Realized P/L**
  * Default lots (persisted)
  * Underlying / ATM basis / Selected expiry preferences (persisted)
* **Option Chain** with:

  * Expiry scroller (clickable)
  * ATM highlighting (spot/futures basis)
  * Hover Buy/Sell actions → **Stage** (no broker call)
  * Horizontally resizable; double-click to collapse/expand
* **Payoff** panel with live updates (synthetic feed)
* **Socket.io** synthetic market feed

---

## 12) Next steps (future version)

* Plug in **Zerodha Kite**/**Dhan** websockets + order APIs
* True LTP/Greeks server-side; replace synthetic ticks
* Role-based permissions for multi-user teams
* GCP VM + domain deployment (NGINX reverse proxy)
* PM2/systemd service scripts for production