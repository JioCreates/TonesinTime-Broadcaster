# TonesinTime Cloud

Multi-tenant Icecast streaming platform. DJs connect with broadcasting software, listeners connect via stream URLs.

## Architecture

```
Nginx (reverse proxy)
  |
  +-- *.tonesintime.io --> per-user Icecast containers (ports 8001-9000)
  +-- tonesintime.io   --> Express API + Dashboard
```

- **Express API** manages users, streams, billing, and Docker containers
- **Icecast containers** are provisioned per-stream via Dockerode
- **Nginx** routes subdomains to the correct container port
- **SQLite** stores users, streams, and billing state
- **Stripe** handles subscriptions (free / basic / pro)

## Prerequisites

- Docker & Docker Compose
- Node.js 18+
- Stripe account (for billing)

## Quick Start

### 1. Build the Icecast image

```bash
cd cloud/docker
docker compose build
```

### 2. Start Nginx reverse proxy

```bash
docker compose up -d nginx
```

### 3. Configure the API server

```bash
cd cloud/server
cp .env.example .env
# Edit .env with your secrets
```

### 4. Install dependencies and start

```bash
npm install
npm start
```

The API and dashboard will be available at `http://localhost:3000`.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login, returns JWT |
| POST | `/api/streams/create` | Provision Icecast container |
| DELETE | `/api/streams/:id` | Stop and remove container |
| GET | `/api/streams` | List user's streams |
| GET | `/api/streams/:id` | Stream details + DJ connection info |
| POST | `/api/billing/subscribe` | Create Stripe checkout session |
| POST | `/api/billing/webhook` | Stripe webhook handler |
| GET | `/api/health` | Health check |

## DJ Connection

After creating a stream, configure your broadcasting software (e.g., TonesinTime Desktop, BUTT, or Mixxx):

- **Host:** `tonesintime.io` (or your domain)
- **Port:** shown in stream details
- **Mount:** `/live` (or custom)
- **Username:** `source`
- **Password:** shown in stream details

## Plans

| Plan | Streams | Max Listeners |
|------|---------|---------------|
| Free | 1 | 50 |
| Basic | 3 | 200 |
| Pro | 10 | 1,000 |

## Development

```bash
cd cloud/server
npm run dev   # auto-restart on file changes (Node 18+ --watch)
```

## Production Notes

- Set strong passwords in `.env`
- Configure SSL certificates in `cloud/docker/nginx/certs/`
- Use a process manager (PM2, systemd) for the API server
- Set up Stripe webhook endpoint: `https://tonesintime.io/api/billing/webhook`
- Configure DNS: `*.tonesintime.io` A record pointing to your server
