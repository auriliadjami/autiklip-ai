const $=s=>document.querySelector(s);let token=localStorage.getItem('autoclip_token');
const headers=()=>({Authorization:`Bearer ${token}`});
async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{...headers(),...(opts.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Request gagal');return d}
function showApp(){ $('#login').classList.toggle('hidden',!!token);$('#app').classList.toggle('hidden',!token);$('#logout').classList.toggle('hidden',!token);if(token){refresh();status()}}
$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#loginError').textContent='';try{const data=Object.fromEntries(new FormData(e.target));const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const d=await r.json();if(!r.ok)throw new Error(d.error);token=d.token;localStorage.setItem('autoclip_token',token);showApp()}catch(err){$('#loginError').textContent=err.message}});
$('#logout').onclick=()=>{token=null;localStorage.removeItem('autoclip_token');showApp()};
$('#uploadForm').addEventListener('submit',async e=>{e.preventDefault();const f=e.target.video.files[0];if(!f)return;$('#uploadMessage').textContent='Menyiapkan upload…';try{let job;try{const signed=await api('/api/uploads/presign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:f.name,contentType:f.type,size:f.size})});$('#uploadMessage').textContent='Mengunggah langsung ke Cloudflare R2…';const put=await fetch(signed.uploadUrl,{method:'PUT',headers:{'Content-Type':f.type},body:f});if(!put.ok)throw new Error('Upload ke R2 gagal. Periksa konfigurasi CORS bucket.');job=await api('/api/uploads/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:signed.key,filename:f.name,contentType:f.type,size:f.size})});}catch(err){if(!String(err.message).includes('belum dikonfigurasi'))throw err;const fd=new FormData();fd.append('video',f);$('#uploadMessage').textContent='R2 belum aktif, memakai upload server…';job=await api('/api/upload',{method:'POST',body:fd});}$('#uploadMessage').textContent='Video berhasil diunggah.';e.target.reset();refresh()}catch(err){$('#uploadMessage').textContent=err.message}});
$('#refresh').onclick=refresh;
async function refresh(){try{const jobs=await api('/api/jobs');$('#total').textContent=jobs.length;$('#review').textContent=jobs.filter(x=>x.status==='review').length;$('#approved').textContent=jobs.filter(x=>x.status==='approved').length;$('#errors').textContent=jobs.filter(x=>x.status==='error').length;$('#jobs').innerHTML=jobs.length?jobs.map(j=>`<article class="job"><div><b>${esc(j.title)}</b><small>${esc(j.sourceName)} · ${new Date(j.createdAt).toLocaleString('id-ID')}</small><small>${esc(j.note||'')}</small><span class="pill ${j.status}">${label(j.status)}</span></div><div class="job-actions">${['uploaded','error'].includes(j.status)?`<button class="ghost" onclick="analyzeClip('${j.id}')">Analisis AI</button><button class="primary" onclick="makeClip('${j.id}')">Buat klip manual</button>`:''}${j.status==='analyzing'?'<span class="pill processing">AI menganalisis…</span>':''}${(j.analysis?.candidates||[]).map((x,i)=>`<div class="candidate"><b>${esc(x.title)}</b><small>${x.startSeconds.toFixed(1)}s · ${x.duration}s — ${esc(x.reason)}</small><small>${esc(x.caption)} ${x.hashtags.map(t=>'#'+esc(t)).join(' ')}</small><button class="ghost" onclick="editCandidate('${j.id}',${i})">Edit caption</button><button class="primary" onclick="makeSuggestedClip('${j.id}',${i})">Buat klip ini</button></div>`).join('')}${['review','approved'].includes(j.status)?`<button class="ghost" onclick="previewClip('${j.id}')">Preview</button><button class="ghost" onclick="downloadClip('${j.id}')">Unduh klip</button>`:''}${j.status==='review'?`<button class="ghost" onclick="review('${j.id}','rejected')">Tolak</button><button class="primary" onclick="review('${j.id}','approved')">Setujui</button>`:''}</div></article>`).join(''):'<p class="muted">Belum ada video. Upload video pertama untuk memulai.</p>'}catch(e){$('#jobs').textContent=e.message}}
window.analyzeClip=async id=>{try{await api(`/api/jobs/${id}/analyze`,{method:'POST'});alert('Analisis AI dimulai. Proses dapat memerlukan beberapa menit. Tekan Perbarui untuk melihat hasil.');refresh()}catch(e){alert(e.message)}};

window.downloadClip=async id=>{try{const r=await fetch(`/api/jobs/${id}/download`,{headers:headers()});if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||'Unduhan gagal')}const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`autoclip-${id}.mp4`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url)}catch(e){alert(e.message)}};
window.review=async(id,action)=>{try{await api(`/api/jobs/${id}/review`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});refresh()}catch(e){alert(e.message)}};
async function status(){try{const s=await api('/api/config/status');$('#integrations').innerHTML=`<span>AI (OpenAI): ${s.openai?'terhubung':'API key belum diisi'}</span><span>Supabase: ${s.supabase?'terhubung':'belum dikonfigurasi'}</span><span>Cloudflare R2: ${s.cloudflareR2?'terhubung':'belum dikonfigurasi'}</span><span>TikTok: ${s.tiktok?'terhubung':'belum terhubung'}</span><span>YouTube: ${s.youtube?'terhubung':'belum terhubung'}</span>`}catch{}}
function label(s){return ({uploaded:'Uploaded',processing:'Processing',queued:'Dalam antrean',review:'Menunggu review',approved:'Disetujui',rejected:'Ditolak',error:'Error'})[s]||s}function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

window.makeClip=async id=>{
  const start=Number(prompt('Mulai klip dari detik ke berapa?', '0'));
  if(!Number.isFinite(start)||start<0)return;
  const duration=Number(prompt('Durasi klip (15–30 detik):','20'));
  if(!Number.isFinite(duration)||duration<15||duration>30){alert('Durasi harus 15–30 detik.');return}
  try{await api(`/api/jobs/${id}/clip`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({startSeconds:start,duration,subtitles:false})});alert('Klip masuk antrean render.');refresh()}catch(e){alert(e.message)}
};
window.makeSuggestedClip=async(id,index)=>{
  try{
    const jobs=await api('/api/jobs');
    const job=jobs.find(x=>x.id===id);
    const candidate=job?.analysis?.candidates?.[index];
    if(!candidate)throw new Error('Kandidat klip tidak ditemukan.');
    await api(`/api/jobs/${id}/clip`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({startSeconds:candidate.startSeconds,duration:candidate.duration,subtitles:true,subtitleStyle:'classic',candidate})});
    alert('Kandidat masuk antrean render. Subtitle akan dibuat dari transkrip AI jika tersedia.');
    refresh();
  }catch(e){alert(e.message)}
};
window.editCandidate=async(id,index)=>{
  try{
    const jobs=await api('/api/jobs');
    const candidate=jobs.find(x=>x.id===id)?.analysis?.candidates?.[index];
    if(!candidate)throw new Error('Kandidat tidak ditemukan.');
    const title=prompt('Edit judul klip:',candidate.title);if(title===null)return;
    const caption=prompt('Edit caption:',candidate.caption);if(caption===null)return;
    const tags=prompt('Hashtag (pisahkan dengan koma):',(candidate.hashtags||[]).join(', '));if(tags===null)return;
    await api(`/api/jobs/${id}/candidates/${index}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,caption,hashtags:tags.split(',').map(x=>x.trim())})});
    refresh();
  }catch(e){alert(e.message)}
};
window.previewClip=async id=>{
  try{
    const result=await api(`/api/jobs/${id}/preview`);
    let source=result.url;
    if(source.startsWith('/')){
      const response=await fetch(source,{headers:headers()});
      if(!response.ok)throw new Error('Preview gagal dimuat.');
      source=URL.createObjectURL(await response.blob());
    }
    const video=$('#previewVideo');
    if(video.dataset.objectUrl)URL.revokeObjectURL(video.dataset.objectUrl);
    if(source.startsWith('blob:'))video.dataset.objectUrl=source;
    video.src=source;
    $('#previewModal').classList.remove('hidden');
    await video.play().catch(()=>{});
  }catch(e){alert(e.message)}
};
$('#closePreview').addEventListener('click',()=>{
  const video=$('#previewVideo');video.pause();video.removeAttribute('src');video.load();
  if(video.dataset.objectUrl){URL.revokeObjectURL(video.dataset.objectUrl);delete video.dataset.objectUrl}
  $('#previewModal').classList.add('hidden');
});
\nshowApp();
