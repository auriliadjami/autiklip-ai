# AUTOCLIP AI — Starter v0.1.0

Admin dashboard + Node.js API for uploading source videos, generating 9:16 clips with FFmpeg, and placing generated clips into an admin review queue.

## Included now
- Admin login using a bcrypt password hash and signed JWT.
- Upload source videos (MP4, MOV, WEBM, MKV).
- Create 15–30 second vertical 1080×1920 clips from a chosen start time.
- Configurable watermark text.
- Review queue with approve/reject states and authenticated clip downloads (local storage or short-lived R2 signed URLs).
- Direct browser-to-R2 source upload using short-lived signed PUT URLs (with local upload fallback).
- Serial FFmpeg render queue (one render at a time) to avoid competing encoders.
- Health and integration status endpoints.

## Not yet active
- AI highlight detection and transcript-based clip suggestions are available when `OPENAI_API_KEY` is configured. This uses OpenAI transcription + text analysis APIs and incurs usage charges.

- YouTube URL ingestion. Use videos you own or are authorized to process; platform restrictions apply.
- TikTok and YouTube publishing. These require OAuth credentials, API scopes, platform app setup/approval, and a publishing implementation. Approval in this dashboard does not publish anything.
- Full Supabase Auth / multi-user roles. This starter uses one server-configured admin login; Supabase is currently an optional records mirror.

## Local setup
1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Generate a bcrypt hash for your admin password:
   ```bash
   node -e "import('bcryptjs').then(async b=>console.log(await b.hash('GANTI_PASSWORD',12)))"
   ```
4. Put the resulting hash in `ADMIN_PASSWORD_HASH`; set `ADMIN_EMAIL` and a long random `JWT_SECRET`.
5. Set `JWT_SECRET` to a random value of at least 32 characters. The API rejects short or missing secrets.
6. Install dependencies and run:
   ```bash
   npm install
   npm start
   ```
7. Open `http://localhost:3000`.

## Deploy to Render (prototype)
This repository includes a Render Blueprint in `render.yaml`. To deploy:
1. Push/merge this repository to GitHub.
2. In Render, choose **New > Blueprint** and select `auriliadjami/autiklip-ai`.
3. Render creates the web service from `render.yaml`. Set the secret environment variables in the Render dashboard.
4. Configure Supabase and R2 before processing real videos. Run the SQL migrations in `supabase/migrations/` in filename order in the Supabase SQL Editor.
5. Confirm `/api/health` returns `ok: true`, then test with a short video you own.

Required secrets/settings:
- `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` (bcrypt hash), and `JWT_SECRET` (at least 32 random characters).
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (server-side only; never expose in browser).
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET`.
- `OPENAI_API_KEY` only if AI transcription/highlight suggestions are needed. API usage is billed separately.

The Blueprint marks secrets as `sync: false`; enter them manually in Render. Do not commit a real `.env` file or credentials.

### Hosting limitations
The free Render web service is suitable only for a prototype: it can sleep when idle, has ephemeral local storage, and limited CPU/RAM. FFmpeg rendering can be slow or fail on resource limits. Use Cloudflare R2 for source/output files and Supabase for job metadata. A single Render web instance runs the queue worker; do not scale multiple instances until worker coordination/heartbeat is designed and tested. For reliable production rendering, budget for an always-on worker with adequate CPU/RAM and persistent object storage. The free tier does not guarantee uninterrupted processing or production availability.

## AI highlight analysis (optional)
- Set `OPENAI_API_KEY` on the server. The dashboard then offers **Analisis AI** for uploaded videos.
- AUTOCLIP extracts mono MP3 audio at 16 kHz / 32 kbps, transcribes it with the configured transcription model, then asks the highlight model to propose up to five 15–30 second segments with titles, reasons, captions, and hashtags.
- The extracted audio must be under 24 MB. Long videos may exceed this limit; split or shorten them before analysis.
- OpenAI API usage is billed separately and is not included in the hosting budget. Never put the API key in frontend code or commit it to Git.
- AI suggestions are editorial candidates, not guaranteed viral moments. Admin must review each candidate and approve the resulting clip.
- When creating a clip, choose whether to burn subtitles and select `classic`, `bold`, or `minimal`. Subtitles are generated from timestamped transcript segments that overlap the selected clip. This requires an FFmpeg build with the `subtitles`/libass filter; if the deployed FFmpeg build lacks it, render will fail with a filter error.

## Supabase
Create a table named `clips`:
```sql
create table if not exists public.clips (
  id uuid primary key,
  title text,
  status text,
  source_name text,
  source_key text,
  clip_path text,
  duration integer,
  created_at timestamptz,
  updated_at timestamptz
);
```
Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the server only. Never expose the service-role key in frontend code.

## Cloudflare R2
Create a private bucket and an R2 API token with object read/write permission. Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET`. Keep the bucket private; use signed URLs for future preview/download flows. Set `R2_PUBLIC_BASE_URL` only if you intentionally configure a public domain (not currently used by this starter).

## Security / production checklist
- Replace all secrets; do not commit `.env`.
- Add HTTPS and configure trusted proxy settings before production.
- Add CSRF protection and stronger session management for a public deployment. The current admin JWT is stored in browser local storage; consider an HttpOnly secure cookie before public launch.
- Replace the in-process render queue with a durable queue and separate FFmpeg worker; the current queue only serializes work within one running process.
- Load job metadata from Supabase (the current Supabase integration is a write-through mirror, not the source of truth).
- Add retention/deletion controls for uploaded source files.
- Add Supabase Auth/RLS and per-user roles before inviting multiple admins.
- Implement OAuth flows and review platform requirements before enabling publishing.
