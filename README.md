# line-group-bridge

> Relays messages between several LINE group chats so they behave like one community with up to N × 500 participants, attributing messages to original authors via LINE `sender` overrides.

[![CI](https://github.com/line-group-bridge/line-group-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/line-group-bridge/line-group-bridge/actions/workflows/ci.yml)
[![Node 22+](https://img.shields.io/badge/node-%3E%3D22-blue.svg)](https://nodejs.org)
[![License: UNLICENSED](https://img.shields.io/badge/license-UNLICENSED-red.svg)](#license)

---

## Overview

A single LINE group chat is capped at roughly 500 members. Communities that outgrow that cap end up fragmented across multiple groups. **line-group-bridge** connects those groups together:

- **Unified Identity:** A single LINE Official Account is invited into each group.
- **Author Attribution:** Relayed messages display the original author's LINE display name and avatar (converted to 1:1 PNG), along with origin group tags (e.g. `Ken·B`).
- **Rich Media Relay:** Text, LINE stickers (allowlisted + text fallbacks), photos, album sets, videos, voice audio, files, and locations.
- **Cross-Group Replies & Edits:** Replying to a relayed copy in group A quotes that message; editing an earlier message updates other groups with an `(edited)` marker.
- **Privacy & Unsend:** Honors LINE unsend events by canceling pending relays, purging stored text/media, and posting unquoted retraction notices.
- **Cost & Quota Guard:** Supports **immediate**, **batched**, and **economy** delivery modes (using free reply-token piggybacking), with automatic throttling and strict economy switching when approaching monthly quotas.

---

## Architecture

```text
 LINE Platform                   line-group-bridge
┌──────────────┐     HTTPS      ┌──────────────────────────────────────────────┐
│ Group A, B, C│◄───(Push/Reply)┤ Worker Tier:                                  │
│              │                │  - Serial lanes per target (ordering)       │
│ Webhook      │───(HMAC-SHA256)┤  - Message translator & pack engine         │
│ Dispatcher   │                │  - Media download & transcoding             │
└──────────────┘                ├──────────────────────────────────────────────┤
                                │ Web Tier:                                    │
                                │  - Webhook ingress (fast < 2s response)      │
                                │  - Public media origin (/m/*, /i/*)          │
                                │  - Admin HTTP API (/admin/v1/*)              │
                                └──────┬───────────────────────┬───────────────┘
                                       │                       │
                                ┌──────▼───────┐        ┌──────▼───────┐
                                │ PostgreSQL 16│        │ S3 / Storage │
                                │ (Jobs, State)│        │ (Media, PNG) │
                                └──────────────┘        └──────────────┘
```

---

## Quick Start

### 1. Zero-dependency Development (Embedded PGlite)

Run locally without installing PostgreSQL or Docker:

```bash
# Install dependencies
npm ci

# Run development server with in-memory database
DATABASE_URL=pglite://memory \
LINE_CHANNEL_SECRET=your_channel_secret \
LINE_ACCESS_TOKEN=your_token \
MEDIA_BACKEND=fs \
MEDIA_FS_ROOT=./data/media \
MEDIA_PUBLIC_BASE_URL=https://your-public-tunnel.example.com \
npm run dev
```

### 2. Production with Docker Compose

Deploy a full stack with PostgreSQL, MinIO (S3 object storage), Caddy (automatic HTTPS), and the bridge service:

```bash
# Copy and configure environment variables
cp .env.example .env

# Start all services
docker compose up -d
```

---

## Configuration Reference

All options are configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `ROLE` | `all` | Process role: `web`, `worker`, or `all` |
| `PORT` | `8080` | Public HTTP port (webhook ingress & media origin) |
| `ADMIN_PORT` | `8081` | Internal HTTP port (admin API & Prometheus metrics) |
| `LINE_CHANNEL_SECRET` | — | **Required.** Channel secret for webhook HMAC-SHA256 verification |
| `LINE_ACCESS_TOKEN` | — | Channel access token (long-lived mode) |
| `LINE_TOKEN_MODE` | `long_lived` | Token issuance mode: `long_lived`, `v21` (JWT assertion), or `stateless` |
| `LINE_CHANNEL_ID` | — | Channel ID (required for `v21` and `stateless` token modes) |
| `LINE_API_BASE` | `https://api.line.me` | LINE API base endpoint (overridable for testing) |
| `LINE_API_DATA_BASE` | `https://api-data.line.me` | LINE Data base endpoint |
| `DATABASE_URL` | — | **Required.** PostgreSQL connection string (or `pglite:///path`) |
| `MEDIA_BACKEND` | `s3` | Storage backend: `s3` or `fs` |
| `MEDIA_PUBLIC_BASE_URL` | — | **Required.** Public HTTPS base URL for serving media and avatars |
| `S3_ENDPOINT` | — | S3-compatible endpoint (e.g. MinIO, Cloudflare R2) |
| `S3_BUCKET` | — | S3 bucket name (required when `MEDIA_BACKEND=s3`) |
| `OPERATOR_USER_IDS` | — | Comma-separated LINE user IDs granted super-admin privileges |
| `DEFAULT_DELIVERY_MODE` | `batched` | Default delivery mode for new bridges: `immediate`, `batched`, `economy`, or `strict_economy` |
| `BATCH_WINDOW_MS` | `3000` | Coalescing window in milliseconds for batched delivery mode |
| `ECONOMY_MAX_HOLD_S` | `600` | Max hold time in seconds before pushing in economy mode (null = strict) |
| `QUOTA_ALERT_PCT` | `80` | Quota projection warning threshold percentage |
| `QUOTA_HARD_PCT` | `95` | Hard quota threshold percentage that triggers automatic strict economy |
| `ADMIN_API_TOKENS` | — | Comma-separated SHA-256 hashes of bearer tokens for admin API access |
| `RETENTION_TEXT_DAYS` | `30` | Retention TTL for stored message text before nulling |
| `RETENTION_PAYLOAD_DAYS`| `7` | Retention TTL for raw webhook payloads before scrubbing |

---

## In-Chat Commands (`/bridge`)

Organizers and members can control bridges entirely through in-chat commands:

### Member Commands
- `/bridge status` — Shows bridge name, member groups, member counts, pause state, and delivery mode.
- `/bridge optout` / `/bridge optin` — Disables or re-enables relaying of your own messages.
- `/bridge help` — Displays available commands for your role.

### Moderator Commands
- `/bridge pause [in|out|both]` / `/bridge resume` — Temporarily pauses message incoming, outgoing, or both directions for this group.
- `/bridge mute @user` / `/bridge unmute @user` — Mutes or unmutes a user bridge-wide.

### Admin Commands
- `/bridge create <name>` — Creates a new bridge, attaches the current group as tag `A`, and issues a link code.
- `/bridge code [uses] [hours]` — Issues a new one-time link code.
- `/bridge join <code>` — Attaches the current group to an existing bridge using a link code.
- `/bridge leave` / `/bridge kick` — Detaches the group from the bridge, or causes the bot to exit the group chat.
- `/bridge mode <immediate|batched|economy|strict>` — Switches message delivery modes.
- `/bridge admin <add|remove> @user` — Appoints or removes bridge administrators.

---

## Admin CLI (`lgb`)

The CLI interacts with the administrative HTTP API:

```bash
# List all active bridges
lgb bridges ls --token <token>

# Inspect dead-letter jobs
lgb jobs dead --token <token>

# Retry a dead-letter job
lgb job retry <job-id> --token <token>

# Resume pushes after reaching a monthly quota stop
lgb quota resume --token <token>

# GDPR/APPI user data erasure
lgb user erase <userId> --token <token>
```

---

## Development & Testing

```bash
# Run typechecking
npm run typecheck

# Run linter
npm run lint

# Run all test suites
npm run test

# Run tests with code coverage (enforces >= 80% on core modules)
npm run test:coverage

# Run isolated performance load test (validates 200+ req/s burst)
npm run load-test

# Run standalone fake LINE server for manual integration tests
npm run fake-line -- --port 9000 --secret dev_secret
```
