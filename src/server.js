import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(root, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'clips');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const MIN_CLIP = Number(process.env.CLIP_MIN_SECONDS || 15);
const MAX_CLIP = Number(process.env.CLIP_MAX_SECONDS || 30);
const jobsFile = path.join(DATA_DIR, 'jobs.json');

await Promise.all([mkdir(UPLOAD_DIR, { recursive: true }), mkdir(OUTPUT_DIR, { recursive: true })]);
try { await readFile(jobsFile); } catch { await writeFile(jobsFile, '[]'); }

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null;
const r2 = process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
  ? new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } }) : null;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(root, 'public')));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }, fileFilter: (_req, file, cb) => {
  const ok = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'].includes(file.mimetype);
  cb(ok ? null : new Error('Format video tidak didukung. Gunakan MP4, MOV, WEBM, atau MKV.'), ok);
} });

async function readJobs() { return JSON.parse(await readFile(jobsFile, 'utf8')); }
async function saveJobs(jobs) { await writeFile(jobsFile, JSON.stringify(jobs, null, 2)); }
async function persistJob(job) {
  const jobs = await readJobs();
  const i = jobs.findIndex(x => x.id === job.id);
  if (i >= 0) jobs[i] = job; else jobs.unshift(job);
  await saveJobs(jobs);
  if (supabase) {
    const { error } = await supabase.from('clips').upsert({ id: job.id, title: job.title, status: job.status, source_name: job.sourceName, clip_path: job.clipPath || null, duration: job.duration || null, created_at: job.createdAt, updated_at: new Date().toISOString() });
    if (error) console.error('Supabase sync:', error.message);
  }
}
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { req.user = jwt.verify(token, process.env.JWT_SECRET || 'dev-only-change-this-secret'); next(); }
  catch { res.status(401).json({ error: 'Silakan login sebagai admin.' }); }
}
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(err.slice(-1800) || `FFmpeg exit ${code}`)));
  });
}
async function uploadToR2(filePath, key, contentType = 'video/mp4') {
  if (!r2) return null;
  await r2.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: await readFile(filePath), ContentType: contentType }));
  return key;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'AUTOCLIP AI', version: '0.1.0', storage: r2 ? 'cloudflare-r2' : 'local', database: supabase ? 'supabase' : 'local-json', ffmpeg: Boolean(ffmpegPath) }));
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const expectedEmail = process.env.ADMIN_EMAIL;
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!expectedEmail || !hash || !process.env.JWT_SECRET) return res.status(503).json({ error: 'Admin belum dikonfigurasi. Isi ADMIN_EMAIL, ADMIN_PASSWORD_HASH, dan JWT_SECRET.' });
  const valid = email === expectedEmail && await bcrypt.compare(String(password || ''), hash);
  if (!valid) return res.status(401).json({ error: 'Email atau password salah.' });
  res.json({ token: jwt.sign({ email, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h' }), email });
});
app.get('/api/jobs', auth, async (_req, res) => res.json(await readJobs()));
app.post('/api/upload', auth, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Pilih file video terlebih dahulu.' });
  const job = { id: randomUUID(), title: path.parse(req.file.originalname).name, sourceName: req.file.originalname, sourcePath: req.file.path, status: 'uploaded', createdAt: new Date().toISOString(), duration: null, clipPath: null, note: 'Video berhasil diunggah. Tentukan rentang waktu untuk membuat klip.' };
  await persistJob(job); res.status(201).json(job);
});
app.post('/api/jobs/:id/clip', auth, async (req, res) => {
  const jobs = await readJobs(); const job = jobs.find(x => x.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Video tidak ditemukan.' });
  const start = Number(req.body.startSeconds || 0); const duration = Number(req.body.duration || 20);
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration < MIN_CLIP || duration > MAX_CLIP) return res.status(400).json({ error: `Durasi klip harus ${MIN_CLIP}–${MAX_CLIP} detik dan waktu mulai tidak boleh negatif.` });
  const output = path.join(OUTPUT_DIR, `${job.id}.mp4`);
  job.status = 'processing'; job.note = 'Sedang memproses video dengan FFmpeg.'; await persistJob(job);
  res.status(202).json({ message: 'Pemrosesan dimulai.', id: job.id });
  (async () => {
    try {
      const watermark = String(req.body.watermark ?? process.env.WATERMARK_TEXT ?? 'AUTOCLIP AI').slice(0, 48).replace(/[^\p{L}\p{N} _.-]/gu, '');
      const draw = watermark ? `drawtext=text='${watermark.replace(/'/g, "\\'")}':fontcolor=white@0.85:fontsize=24:box=1:boxcolor=black@0.35:boxborderw=10:x=w-tw-24:y=h-th-24` : 'null';
      const filters = `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,${draw}`;
      await runFfmpeg(['-y', '-ss', String(start), '-i', job.sourcePath, '-t', String(duration), '-vf', filters, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output]);
      const s = await stat(output); const r2Key = await uploadToR2(output, `clips/${job.id}.mp4`);
      job.status = 'review'; job.duration = duration; job.clipPath = r2Key || `/media/${job.id}.mp4`; job.fileSize = s.size; job.note = 'Klip siap diperiksa admin. Publikasi belum dilakukan.';
      await persistJob(job);
    } catch (e) { job.status = 'error'; job.note = e.message; await persistJob(job); }
  })();
});
app.get('/media/:id.mp4', auth, async (req, res) => {
  const file = path.join(OUTPUT_DIR, `${path.basename(req.params.id)}.mp4`);
  try { await stat(file); res.sendFile(file); } catch { res.status(404).json({ error: 'File klip tidak tersedia di penyimpanan lokal.' }); }
});
app.post('/api/jobs/:id/review', auth, async (req, res) => {
  const jobs = await readJobs(); const job = jobs.find(x => x.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Klip tidak ditemukan.' });
  const action = req.body.action;
  if (!['approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'Aksi harus approved atau rejected.' });
  job.status = action; job.reviewedAt = new Date().toISOString(); job.note = action === 'approved' ? 'Disetujui admin. Belum dipublikasikan ke platform.' : 'Ditolak admin.';
  await persistJob(job); res.json(job);
});
app.get('/api/config/status', auth, (_req, res) => res.json({ supabase: Boolean(supabase), cloudflareR2: Boolean(r2), tiktok: false, youtube: false, note: 'Integrasi publikasi memerlukan OAuth dan persetujuan aplikasi platform.' }));
app.use((err, _req, res, _next) => { console.error(err); res.status(400).json({ error: err.message || 'Terjadi kesalahan.' }); });
app.listen(PORT, () => console.log(`AUTOCLIP AI running on :${PORT}`));
