import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
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
    const { error } = await supabase.from('clips').upsert({ id: job.id, title: job.title, status: job.status, source_name: job.sourceName, source_key: job.sourceKey || null, clip_path: job.clipPath || null, duration: job.duration || null, created_at: job.createdAt, updated_at: new Date().toISOString() });
    if (error) console.error('Supabase sync:', error.message);
  }
}
function auth(req, res, next) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    return res.status(503).json({ error: 'JWT_SECRET belum dikonfigurasi dengan aman.' });
  }
  const token = (req.headers.authorization || '').replace(/^Bearer\\s+/i, '');
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Akses admin diperlukan.' });
    next();
  } catch {
    res.status(401).json({ error: 'Sesi tidak valid atau sudah kedaluwarsa. Silakan login kembali.' });
  }
}
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(err.slice(-1800) || `FFmpeg exit ${code}`)));
  });
}
async function openAIJson(url, body, headers = {}) {
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...headers }, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `OpenAI API error (${response.status})`);
  return data;
}
async function analyzeVideo(job) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY belum diisi. Tambahkan API key untuk mengaktifkan analisis AI.');
  const audioPath = path.join(DATA_DIR, `${job.id}-analysis.mp3`);
  try {
    await ensureSourceLocal(job);
    await runFfmpeg(['-y', '-i', job.sourcePath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'mp3', audioPath]);
    const audioStat = await stat(audioPath);
    if (audioStat.size > 24 * 1024 * 1024) throw new Error('Audio hasil ekstraksi lebih dari 24 MB. Gunakan video yang lebih pendek atau kompres audio terlebih dahulu.');
    const form = new FormData();
    form.append('file', new Blob([await readFile(audioPath)], { type: 'audio/mpeg' }), 'source.mp3');
    form.append('model', process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    const transcript = await openAIJson('https://api.openai.com/v1/audio/transcriptions', form);
    const segments = (transcript.segments || []).map(s => ({ start: s.start, end: s.end, text: s.text })).filter(s => s.text?.trim());
    if (!segments.length) throw new Error('Transkrip kosong. Pastikan video memiliki audio atau percakapan yang jelas.');
    const prompt = {
      task: 'Pilih maksimal 5 momen paling menarik untuk video pendek vertikal. Gunakan timestamp dari transkrip. Pilih momen dengan hook kuat, emosi, insight, punchline, atau cerita yang utuh. Jangan mengarang isi.',
      constraints: { min_duration_seconds: MIN_CLIP, max_duration_seconds: MAX_CLIP, candidates: 5 },
      transcript_segments: segments
    };
    const completion = await openAIJson('https://api.openai.com/v1/chat/completions', JSON.stringify({
      model: process.env.OPENAI_HIGHLIGHT_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Kamu editor video short-form. Kembalikan JSON valid dengan properti candidates berupa array. Setiap item wajib memiliki start_seconds, end_seconds, title, reason, caption, hashtags (array string). Timestamp harus sesuai rentang transkrip. Durasi setiap kandidat harus 15 sampai 30 detik. Jangan membuat timestamp negatif atau melebihi durasi sumber.' },
        { role: 'user', content: JSON.stringify(prompt) }
      ]
    }), { 'Content-Type': 'application/json' });
    const parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    const maxEnd = Math.max(...segments.map(s => s.end));
    const candidates = (parsed.candidates || []).map(x => ({
      startSeconds: Math.max(0, Number(x.start_seconds)),
      duration: Math.min(MAX_CLIP, Math.max(MIN_CLIP, Number(x.end_seconds) - Number(x.start_seconds))),
      title: String(x.title || 'Klip pilihan').slice(0, 100),
      reason: String(x.reason || '').slice(0, 240),
      caption: String(x.caption || '').slice(0, 500),
      hashtags: Array.isArray(x.hashtags) ? x.hashtags.slice(0, 8).map(t => String(t).replace(/^#/, '').slice(0, 40)) : []
    })).filter(x => Number.isFinite(x.startSeconds) && Number.isFinite(x.duration) && x.startSeconds + x.duration <= maxEnd + 0.5);
    if (!candidates.length) throw new Error('AI belum menemukan kandidat klip yang valid. Coba video lain.');
    return { transcript: segments, candidates, analyzedAt: new Date().toISOString() };
  } finally {
    await unlink(audioPath).catch(() => {});
  }
}

function srtTimestamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000), milli = ms % 1000;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(milli).padStart(3,'0')}`;
}
function subtitleText(text) {
  return String(text || '').replace(/-->/g, '→').replace(/[\r\n]+/g, ' ').trim();
}
function escapeSubtitlePath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
async function createClipSubtitles(job, start, duration, style) {
  const segments = job.analysis?.transcript || [];
  const selected = segments.filter(s => Number(s.end) > start && Number(s.start) < start + duration);
  if (!selected.length) return null;
  const presets = {
    classic: 'FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=100',
    bold: 'FontName=Arial,FontSize=22,Bold=1,PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=110',
    minimal: 'FontName=Arial,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=1,Outline=1,Shadow=0,Alignment=2,MarginV=85'
  };
  const preset = presets[style] || presets.classic;
  const content = selected.map((s, i) => {
    const from = Math.max(0, Number(s.start) - start);
    const to = Math.min(duration, Number(s.end) - start);
    if (to <= from) return null;
    return `${i + 1}\n${srtTimestamp(from)} --> ${srtTimestamp(to)}\n${subtitleText(s.text)}\n`;
  }).filter(Boolean).join('\n');
  if (!content.trim()) return null;
  const file = path.join(OUTPUT_DIR, `${job.id}-subtitles.srt`);
  await writeFile(file, content, 'utf8');
  return { file, style: preset };
}

async function uploadToR2(filePath, key, contentType = 'video/mp4') {
  if (!r2) return null;
  await r2.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: await readFile(filePath), ContentType: contentType }));
  return key;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'AUTOCLIP AI', version: '0.1.0', storage: r2 ? 'cloudflare-r2' : 'local', database: supabase ? 'supabase' : 'local-json', ffmpeg: Boolean(ffmpegPath), renderConcurrency: 1, queuedRenders }));
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
app.post('/api/uploads/presign', auth, async (req, res) => {
  if (!r2 || !process.env.R2_BUCKET) return res.status(503).json({ error: 'Upload langsung R2 belum dikonfigurasi.' });
  const body = req.body || {};
  const allowed = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv' };
  const ext = allowed[body.contentType]; const size = Number(body.size);
  if (!ext || !Number.isFinite(size) || size < 1 || size > MAX_UPLOAD_MB * 1024 * 1024) return res.status(400).json({ error: 'Format/ukuran tidak valid. Maksimal ' + MAX_UPLOAD_MB + ' MB.' });
  const givenExt = path.extname(String(body.filename || '')).toLowerCase();
  if (givenExt && givenExt !== ext) return res.status(400).json({ error: 'Ekstensi file tidak cocok dengan tipe video.' });
  const id = randomUUID(); const key = 'sources/' + id + ext;
  const uploadUrl = await getSignedUrl(r2, new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, ContentType: body.contentType }), { expiresIn: 300 });
  res.json({ uploadUrl, key, id, contentType: body.contentType, expiresIn: 300 });
});
app.post('/api/uploads/complete', auth, async (req, res) => {
  if (!r2 || !process.env.R2_BUCKET) return res.status(503).json({ error: 'Cloudflare R2 belum dikonfigurasi.' });
  const body = req.body || {}; const key = String(body.key || ''); const size = Number(body.size);
  if (!/^sources\/[0-9a-f-]+\.(mp4|mov|webm|mkv)$/i.test(key) || !Number.isFinite(size) || size < 1 || size > MAX_UPLOAD_MB * 1024 * 1024) return res.status(400).json({ error: 'Data upload tidak valid.' });
  const object = await r2.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
  if (Number(object.ContentLength) !== size) return res.status(400).json({ error: 'Ukuran file di R2 tidak sesuai.' });
  const name = path.basename(String(body.filename || 'video')).slice(0, 180);
  const job = { id: key.split('/')[1].replace(/\.[^.]+$/, ''), title: path.parse(name).name, sourceName: name, sourceKey: key, status: 'uploaded', createdAt: new Date().toISOString(), duration: null, clipPath: null, note: 'Video tersimpan langsung di Cloudflare R2.' };
  await persistJob(job); res.status(201).json(job);
});
app.post('/api/upload', auth, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Pilih file video terlebih dahulu.' });
  const job = { id: randomUUID(), title: path.parse(req.file.originalname).name, sourceName: req.file.originalname, sourcePath: req.file.path, status: 'uploaded', createdAt: new Date().toISOString(), duration: null, clipPath: null, note: 'Video berhasil diunggah. Tentukan rentang waktu untuk membuat klip.' };
  await persistJob(job); res.status(201).json(job);
});
app.post('/api/jobs/:id/analyze', auth, async (req, res) => {
  const jobs = await readJobs();
  const job = jobs.find(x => x.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Video tidak ditemukan.' });
  if (!['uploaded', 'error'].includes(job.status)) return res.status(409).json({ error: 'Video sedang diproses atau sudah memiliki klip. Refresh daftar terlebih dahulu.' });
  job.status = 'analyzing'; job.note = 'AI sedang mengekstrak audio, membuat transkrip, dan mencari momen terbaik.';
  await persistJob(job);
  res.status(202).json({ message: 'Analisis AI dimulai.', id: job.id });
  (async () => {
    try {
      job.analysis = await analyzeVideo(job);
      job.status = 'uploaded';
      job.note = `Analisis selesai: ${job.analysis.candidates.length} kandidat klip ditemukan.`;
      await persistJob(job);
    } catch (error) {
      job.status = 'error'; job.note = `Analisis AI gagal: ${error.message}`;
      await persistJob(job);
    }
  })();
});
app.post('/api/jobs/:id/clip', auth, async (req, res) => {
  const jobs = await readJobs(); const job = jobs.find(x => x.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Video tidak ditemukan.' });
  if (!['uploaded', 'error'].includes(job.status)) return res.status(409).json({ error: 'Video sedang diproses atau sudah dalam antrean.' });
  const start = Number(req.body.startSeconds || 0); const duration = Number(req.body.duration || 20);
});
app.get('/media/:id.mp4', auth, async (req, res) => {
  const file = path.join(OUTPUT_DIR, `${path.basename(req.params.id)}.mp4`);
  try { await stat(file); res.sendFile(file); } catch { res.status(404).json({ error: 'File klip tidak tersedia di penyimpanan lokal.' }); }
});
app.get('/api/jobs/:id/preview', auth, async (req, res) => {
  const jobs = await readJobs();
  const job = jobs.find(x => x.id === req.params.id);
  if (!job || !['review', 'approved'].includes(job.status)) return res.status(404).json({ error: 'Preview belum tersedia.' });
  try {
    if (r2 && job.clipPath && !job.clipPath.startsWith('/')) {
      const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: job.clipPath }), { expiresIn: 300 });
      return res.json({ url, expiresIn: 300 });
    }
    const file = path.join(OUTPUT_DIR, `${job.id}.mp4`);
    await stat(file);
    return res.json({ url: `/media/${job.id}.mp4`, expiresIn: null });
  } catch { return res.status(404).json({ error: 'File preview tidak ditemukan.' }); }
});
app.patch('/api/jobs/:id/candidates/:index', auth, async (req, res) => {
  const jobs = await readJobs();
  const job = jobs.find(x => x.id === req.params.id);
  const index = Number(req.params.index);
  if (!job?.analysis?.candidates?.[index]) return res.status(404).json({ error: 'Kandidat tidak ditemukan.' });
  const { title, caption, hashtags } = req.body || {};
  if (title !== undefined) job.analysis.candidates[index].title = String(title).trim().slice(0, 100);
  if (caption !== undefined) job.analysis.candidates[index].caption = String(caption).trim().slice(0, 500);
  if (hashtags !== undefined) {
    if (!Array.isArray(hashtags)) return res.status(400).json({ error: 'Hashtag harus berupa daftar.' });
    job.analysis.candidates[index].hashtags = hashtags.slice(0, 8).map(x => String(x).replace(/^#/, '').replace(/[^\\p{L}\\p{N}_]/gu, '').slice(0, 40)).filter(Boolean);
  }
  await persistJob(job);
  return res.json(job.analysis.candidates[index]);
});
app.get('/api/jobs/:id/download', auth, async (req, res) => {
  const jobs = await readJobs();
  const job = jobs.find(x => x.id === req.params.id);
  if (!job || !['review', 'approved'].includes(job.status)) {
    return res.status(404).json({ error: 'Klip belum tersedia untuk diunduh.' });
  }
  try {
    if (r2 && job.clipPath && !job.clipPath.startsWith('/')) {
      const url = await getSignedUrl(r2, new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: job.clipPath,
        ResponseContentDisposition: `attachment; filename="autoclip-${job.id}.mp4"`
      }), { expiresIn: 300 });
      return res.redirect(url);
    }
    const localPath = path.join(OUTPUT_DIR, `${job.id}.mp4`);
    await stat(localPath);
    return res.download(localPath, `autoclip-${job.id}.mp4`);
  } catch {
    return res.status(404).json({ error: 'File tidak ditemukan. Periksa konfigurasi penyimpanan.' });
  }
});

app.post('/api/jobs/:id/review', auth, async (req, res) => {
  const jobs = await readJobs(); const job = jobs.find(x => x.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Klip tidak ditemukan.' });
  const action = req.body.action;
  if (!['approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'Aksi harus approved atau rejected.' });
  job.status = action; job.reviewedAt = new Date().toISOString(); job.note = action === 'approved' ? 'Disetujui admin. Belum dipublikasikan ke platform.' : 'Ditolak admin.';
  await persistJob(job); res.json(job);
});
app.get('/api/config/status', auth, (_req, res) => res.json({ supabase: Boolean(supabase), cloudflareR2: Boolean(r2), openai: Boolean(process.env.OPENAI_API_KEY), tiktok: false, youtube: false, note: 'Integrasi publikasi memerlukan OAuth dan persetujuan aplikasi platform.' }));
app.use((err, _req, res, _next) => { console.error(err); res.status(400).json({ error: err.message || 'Terjadi kesalahan.' }); });
app.listen(PORT, () => console.log(`AUTOCLIP AI running on :${PORT}`));
