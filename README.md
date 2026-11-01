# AUTOCLIP AI — Starter v0.1.0

Admin dashboard + Node.js API for uploading source videos, generating 9:16 clips with FFmpeg, and placing generated clips into an admin review queue.

## Included now
- Admin login using a bcrypt password hash and signed JWT.
- Upload source videos (MP4, MOV, WEBM, MKV).
- Create 15–30 second vertical 1080×1920 clips from a chosen start time.
- Configurable watermark text.
- Review queue with approve/reject states and authenticated clip downloads (local storage or short-lived R2 signed URLs).
- Optional Supabase record sync and Cloudflare R2 object upload.
- Health and integration status endpoints.

## Not yet active
- AI highlight detection and transcript-based clip suggestions are available when `OPENAI_API_KEY` is configured. This uses OpenAI transcription + text analysis APIs and incurs usage charges.
- Burned-in subtitles are available when a video has an AI transcript; subtitle editing and final AI caption/hashtag generation are not yet implemented.
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

## Render deployment
- Create a Web Service from this repository/ZIP after putting the source in GitHub.
- Build command: `npm install`
- Start command: `npm start`
- Add the environment variables from `.env.example` in Render.
- Important: Render free instances are ephemeral and can sleep. Local uploads/output are not durable. Configure R2 before relying on persistent media; this starter uploads finished clips to R2 but source upload still lands on local disk. For production, change source uploads to presigned R2 uploads and use a separate worker with persistent queue/storage.
- FFmpeg encoding may exceed free-instance resource limits. Treat free Render as a prototype environment, not a production video worker.

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
- Move media ingestion to direct-to-R2 signed uploads; never buffer large videos in app memory.
- Add a durable background job queue and separate FFmpeg worker.
- Add retention/deletion controls for uploaded source files.
- Add Supabase Auth/RLS and per-user roles before inviting multiple admins.
- Implement OAuth flows and review platform requirements before enabling publishing.
