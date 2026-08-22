const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
// ── Persistent storage ─────────────────────────────────────────
// On Railway: set RAILWAY_VOLUME_MOUNT_PATH env var to your volume mount path (e.g. /data)
// Locally: falls back to the project folder as before
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH)
  : __dirname;

const STATE_FILE  = path.join(DATA_DIR, 'state.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Seed state.json from repo bundle if volume is fresh (first deploy)
const SEED_FILE = path.join(__dirname, 'seed-state.json');
if (!fs.existsSync(STATE_FILE) && fs.existsSync(SEED_FILE)) {
  fs.copyFileSync(SEED_FILE, STATE_FILE);
  console.log('  Seeded state.json from seed-state.json');
}

// Simple multipart/form-data parser for single PDF file upload
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return reject(new Error('Not multipart/form-data'));
    }
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return reject(new Error('No boundary found'));
    const boundary = boundaryMatch[1];

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from('--' + boundary);

      // Find parts
      let start = 0;
      const parts = [];
      while (true) {
        const idx = buffer.indexOf(boundaryBuf, start);
        if (idx === -1) break;
        if (start > 0) {
          parts.push(buffer.slice(start, idx));
        }
        start = idx + boundaryBuf.length;
        // Skip \r\n after boundary
        if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
        // Check for closing --
        if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;
      }

      // Parse first file part
      for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd).toString();
        if (!headers.includes('filename=')) continue;

        const filenameMatch = headers.match(/filename="([^"]+)"/);
        const filename = filenameMatch ? filenameMatch[1] : 'upload.pdf';
        // Body starts after \r\n\r\n and ends before trailing \r\n
        let body = part.slice(headerEnd + 4);
        if (body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
          body = body.slice(0, body.length - 2);
        }
        return resolve({ filename, data: body });
      }
      reject(new Error('No file found in upload'));
    });
    req.on('error', reject);
  });
}

app.use(express.json());

// Never cache HTML pages — always send fresh from server
app.use((req, res, next) => {
  const p = req.path;
  if (p === '/' || p === '/scan' || p.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Clean URL alias: /scan → /scan.html
app.get('/scan', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scan.html'));
});

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ customers: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

app.get('/api/customers', (req, res) => {
  const state = loadState();
  const q = (req.query.q || '').toLowerCase();
  let customers = state.customers;
  if (q) {
    customers = customers.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.mobile || '').includes(q) ||
      (c.aadhaar || '').includes(q) ||
      (c.receiptNo || '').toLowerCase().includes(q)
    );
  }
  res.json(customers);
});

app.get('/api/next-receipt-number', (req, res) => {
  const state = loadState();
  const year = new Date().getFullYear();
  const prefix = 'RL-' + year + '-';
  let maxNum = 0;
  state.customers.forEach(c => {
    if (c.receiptNo && c.receiptNo.startsWith(prefix)) {
      const num = parseInt(c.receiptNo.replace(prefix, ''), 10);
      if (!isNaN(num) && num > maxNum) maxNum = num;
    }
  });
  const next = prefix + String(maxNum + 1).padStart(3, '0');
  res.json({ receiptNo: next });
});

app.get('/api/customers/:id', (req, res) => {
  const state = loadState();
  const c = state.customers.find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

app.post('/api/customers', (req, res) => {
  const state = loadState();
  const customer = { id: Date.now().toString(), createdAt: new Date().toISOString(), ...req.body };
  state.customers.unshift(customer);
  saveState(state);
  res.json(customer);
});

app.put('/api/customers/:id', (req, res) => {
  const state = loadState();
  const idx = state.customers.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  state.customers[idx] = { ...state.customers[idx], ...req.body };
  saveState(state);
  res.json(state.customers[idx]);
});

app.delete('/api/customers/:id', (req, res) => {
  const state = loadState();
  state.customers = state.customers.filter(c => c.id !== req.params.id);
  saveState(state);
  // Also delete any uploaded agreement PDF
  const pdfPath = path.join(UPLOADS_DIR, 'agreement-' + req.params.id + '.pdf');
  if (fs.existsSync(pdfPath)) {
    fs.unlinkSync(pdfPath);
  }
  // Also delete any uploaded receipt PDF
  const receiptPdfPath = path.join(UPLOADS_DIR, 'receipt-' + req.params.id + '.pdf');
  if (fs.existsSync(receiptPdfPath)) {
    fs.unlinkSync(receiptPdfPath);
  }
  res.json({ ok: true });
});

// Upload agreement PDF for a customer
app.post('/api/customers/:id/upload-agreement', async (req, res) => {
  try {
    const { filename, data } = await parseMultipart(req);
    if (!filename.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'Only PDF files are allowed' });
    }
    if (data.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 10MB)' });
    }
    const state = loadState();
    const idx = state.customers.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Customer not found' });

    const savedFilename = 'agreement-' + req.params.id + '.pdf';
    fs.writeFileSync(path.join(UPLOADS_DIR, savedFilename), data);
    state.customers[idx].agreementPdf = savedFilename;
    saveState(state);
    res.json({ ok: true, filename: savedFilename });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Upload failed' });
  }
});

// Delete uploaded agreement PDF
app.delete('/api/customers/:id/agreement', (req, res) => {
  const state = loadState();
  const idx = state.customers.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Customer not found' });
  const filename = state.customers[idx].agreementPdf;
  if (filename) {
    const pdfPath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }
    delete state.customers[idx].agreementPdf;
    saveState(state);
  }
  res.json({ ok: true });
});

// Upload receipt PDF for a customer
app.post('/api/customers/:id/upload-receipt', async (req, res) => {
  try {
    const { filename, data } = await parseMultipart(req);
    if (!filename.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'Only PDF files are allowed' });
    }
    if (data.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 10MB)' });
    }
    const state = loadState();
    const idx = state.customers.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Customer not found' });

    const savedFilename = 'receipt-' + req.params.id + '.pdf';
    fs.writeFileSync(path.join(UPLOADS_DIR, savedFilename), data);
    state.customers[idx].receiptPdf = savedFilename;
    saveState(state);
    res.json({ ok: true, filename: savedFilename });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Upload failed' });
  }
});

// Delete uploaded receipt PDF
app.delete('/api/customers/:id/receipt', (req, res) => {
  const state = loadState();
  const idx = state.customers.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Customer not found' });
  const filename = state.customers[idx].receiptPdf;
  if (filename) {
    const pdfPath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }
    delete state.customers[idx].receiptPdf;
    saveState(state);
  }
  res.json({ ok: true });
});


// ===== VIDEO VERIFICATION ROUTES =====
const VIDEO_DIR = path.join(UPLOADS_DIR, 'videos');
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });

// Simple multipart parser for video/webm blobs (reuses same pattern as PDF upload)
function parseVideoMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return reject(new Error('Not multipart'));
    }
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return reject(new Error('No boundary'));
    const boundary = boundaryMatch[1].trim();
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from('--' + boundary);
      let start = 0;
      const parts = [];
      while (true) {
        const idx = buf.indexOf(boundaryBuf, start);
        if (idx === -1) break;
        if (start > 0) parts.push(buf.slice(start, idx));
        start = idx + boundaryBuf.length;
        if (buf[start] === 0x0d && buf[start+1] === 0x0a) start += 2;
        if (buf[start] === 0x2d && buf[start+1] === 0x2d) break;
      }
      for (const part of parts) {
        const hEnd = part.indexOf('\r\n\r\n');
        if (hEnd === -1) continue;
        const headers = part.slice(0, hEnd).toString();
        if (!headers.includes('filename=') && !headers.includes('name="video"')) continue;
        let body = part.slice(hEnd + 4);
        if (body[body.length-2] === 0x0d && body[body.length-1] === 0x0a) body = body.slice(0, -2);
        const fnMatch = headers.match(/filename="([^"]+)"/);
        return resolve({ filename: fnMatch ? fnMatch[1] : 'video.webm', data: body });
      }
      reject(new Error('No video part found'));
    });
    req.on('error', reject);
  });
}

// GET /api/video/:customerId/script — returns dynamic script with substituted fields
app.get('/api/video/:customerId/script', (req, res) => {
  const state = loadState();
  const c = state.customers.find(x => x.id === req.params.customerId);
  if (!c) return res.status(404).json({ error: 'Customer not found' });

  // Format agreement date from customer date or today
  // en-IN so the script stays fully in Latin script (Hinglish)
  const agreeDate = c.date
    ? new Date(c.date).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : new Date().toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const name = c.name || '___';
  const fee = c.successFee ? 'Rs. ' + Number(c.successFee).toLocaleString('en-IN') : 'Rs. ___';
  const chequeNo = c.chequeNo || '___';
  const bankBranch = c.chequeBankBranch || '___';

  // Cheque amount + the 25% liquidated-damages figure (Sections 16.5 / 17.6 / 18.6)
  const chequeAmtNum = Number(c.chequeAmt || c.successFee || 0) || 0;
  const chequeAmt = chequeAmtNum ? 'Rs. ' + chequeAmtNum.toLocaleString('en-IN') : 'Rs. ___';
  const ld25 = chequeAmtNum
    ? 'Rs. ' + Math.round(chequeAmtNum * 0.25).toLocaleString('en-IN')
    : 'Rs. ___';

  const blocks = [
    {
      label: 'Prarambh (Opening)',
      type: 'opening',
      text: `Aaj dinank ${agreeDate}, hum ${name} ji ke loan facility consultancy agreement ki video pushti record kar rahe hain.`
    },
    {
      label: 'Q1 — Pehchaan (Section 1)',
      text: 'Apna pura naam aur pita/pati ka naam bataiye.'
    },
    {
      label: 'Q2 — Apni marzi se signature (Section 19 (b))',
      text: 'Kya aapne yeh agreement bina kisi dabaav ya zor-zabardasti ke, apni marzi se sign kiya hai?'
    },
    {
      label: 'Q3 — Fee ki samajh (Section 2, Section 19 (s))',
      text: `Kya aap samajhte hain ki Ruralift ki consultancy service nishulk (free) hai, aur success-based fee ${fee} sirf loan ke safal disbursement par hi deni hogi?`
    },
    {
      label: 'Q4 — PDC ki samajh (Section 3, Section 19 (i))',
      text: `Kya aapne apni marzi se cheque number ${chequeNo} (${bankBranch}), rashi ${chequeAmt} jari kiya hai, aur aap samajhte hain ki yeh kab jama kiya ja sakta hai — loan disbursement par fee ke roop mein, ya agreement bhang hone par nuksan bharpai ki vasooli ke roop mein?`
    },
    {
      label: 'Q5 — Cheque bounce ka parinaam (Section 3 (f), Section 19 (n))',
      text: 'Kya aap jaante hain ki cheque bounce hone ki sthiti mein aap Section 138, Negotiable Instruments Act ke antargat criminal roop se zimmedar honge?'
    },
    {
      label: 'Q6 — DSA/commission ka khulasa (Section 1 (d), Section 19 (j))',
      text: 'Kya aapko bataya gaya hai ki Ruralift ka loan sansthaon ke saath DSA sambandh ho sakta hai aur vah commission bhi prapt kar sakta hai — phir bhi aap yeh atirikt consultancy fee dene par sahmat hain?'
    },
    {
      label: 'Q7 — Best efforts / poori koshish (Section 1 (b), Section 19 (h))',
      text: 'Kya aap samajhte hain ki Ruralift aapka loan approve karane ke liye apni poori koshish aur best efforts karega — sahi lender ka chunaav, file ki sahi prastuti aur lagatar follow-up — parantu approval ka antim nirnay bank/NBFC ka hota hai, jis par Ruralift ka koi control nahi hai?'
    },
    {
      label: 'Q8 — Documents ki satyata (Section 19 (g))',
      text: 'Kya aapke dwara diye gaye sabhi documents aur jaankari satya, sateek aur poorn hain?'
    },
    {
      label: 'Q9 — Poore loan, EMI aur guarantee ki ghoshna (Section 16 (a), Section 19 (th))',
      text: `Kya aapne humein apne sabhi loan aur daayitva bata diye hain? Ismein shamil hai —
(a) aapke apne naam par chaalu sabhi loan — home loan, car loan, personal loan, business loan, gold loan, KCC;
(b) har loan ki EMI aur outstanding balance;
(c) credit card, overdraft, cash credit limit;
(d) microfinance / SHG / joint liability group ka koi bhi loan;
(e) ve sabhi loan jinmein aap GUARANTOR ya co-applicant hain — chaahe aap EMI na bharte hon;
(f) koi bhi loan jo band ho gaya ho magar poori tarah vasool nahi hua — write-off, settlement ya restructure;
(g) koi bhi overdue ya late payment jo abhi bhi pending hai;
(h) koi bhi niji / saahukaar ka loan jo bank record mein nahi hai.

Kya aapne yeh sab bata diya hai aur kuch bhi nahi chhipaya? — sirf "Haan" ya "Nahi" kahein.`
    },
    {
      label: 'Q10 — Parishisht "A" swa-ghoshna aur 25% penalty (Section 16 (b))',
      text: `Kya aapne Parishisht "A" — yaani apne sabhi loan, EMI, guarantee aur daayitvon ki list — apne haath se likhkar sign kiya hai?

Aur kya aap samajhte hain ki yadi process ke beech mein — CIBIL report aane ke baad ya file submit hone ke baad — koi bhi aisa loan, EMI, guarantee, write-off, settlement ya koi bhi daayitva saamne aaya jo aapne ghoshna-patra mein nahi likha — chaahe vah aapka khud ka loan ho ya kisi aur ke liye di gayi guarantee ho — to:
(a) cheque rashi ka 25%, yaani lagbhag ${ld25}, nuksan bharpai ke roop mein dena hoga;
(b) Ruralift ko poora adhikar hai ki vah us cheque ko bank mein prastut kare — chaahe vah bounce ho ya na ho;
(c) ya aap ${ld25} nakad / UPI se penalty ke roop mein de sakte hain.

Kya aap yeh sab samajhte hain aur sahmat hain? — sirf "Haan" ya "Nahi" kahein.`
    },
    {
      label: 'Q11 — Nirantar disclosure, 24 ghante (Section 16 (c))',
      text: 'Kya aap sahmat hain ki aaj ke baad aur loan milne se pehle agar aap koi naya loan ya credit card lete hain, kisi ka guarantor bante hain, ya koi EMI chook jaati hai — to aap 24 ghante ke bheetar humein likhit soochna denge?'
    },
    {
      label: 'Q12 — Process shuru hone ke baad wapsi nahi (Section 17, Section 19 (d))',
      text: `Kya aap samajhte hain ki aapki CIBIL report nikalne ya file bank mein login hone ke baad aap application wapas nahi le sakte — na parivaar ki aapatti par, na mann badalne par, na kisi doosre agent ke prastaav par, na interest rate se asantosh par? Aur aisa karne par cheque rashi ka 25%, yaani lagbhag ${ld25}, nuksan bharpai deni hogi? Aapko yeh bhi bata diya gaya hai ki process shuru hone se pehle aap bina koi fee diye kabhi bhi peechhe hat sakte hain.`
    },
    {
      label: 'Q13 — Loan milne par 2 ghante mein soochna (Section 18, Section 19 (d-2))',
      text: 'Kya aap sahmat hain ki loan ki rashi aapke account mein aane ke 2 ghante ke bheetar aap humein WhatsApp/SMS/email par likhit soochna denge — jismein jama ki taarikh aur samay, jama hui rashi, bank/NBFC ka naam, loan account number, aur bank ka SMS ya statement ka screenshot hoga? Aur kya aap samajhte hain ki disbursement chhipane par cheque rashi ka 25% nuksan bharpai ke roop mein dena hoga?'
    },
    {
      label: 'Q14 — Nuksan bharpai ki vasooli-vyavastha (Section 16 (f), Section 19 (n))',
      text: 'Kya aap samajhte hain ki koi bhi nuksan bharpai deni hone par pehle aapko 7 din ka samay aur nakad/UPI/bank transfer se seedhe payment karne ka option diya jayega — aur poora payment karne par aapka cheque aapko wapas kar diya jayega? Agar aap 7 din mein payment nahi karte, tabhi cheque vasooli ke liye lagaya jayega, aur cheque ki rashi deni wali rashi se zyada hone par baaki paisa 15 din mein aapko wapas kar diya jayega.'
    },
    {
      label: 'Q15 — Data sharing sahmati (Section 8, Section 19 (j))',
      text: 'Kya aap sahmat hain ki aapki jaankari banks/NBFCs ke saath share ki ja sakti hai, aur Ruralift aapki credit report nikaalkar va lender se aapki di gayi jaankari ka swatantra verification kar sakta hai?'
    },
    {
      label: 'Samapan Pushti (Closing — pratinidhi padhkar sunayein)',
      type: 'closing',
      text: `${name} ji, main aapko yeh antim pushti padhkar suna raha/rahi hoon. Kripya dhyaan se sunein aur ant mein sirf "Haan" ya "Nahi" kahein —

Aapne yeh agreement aur Parishisht "A" swayam padhkar athva padhvaakar sunkar, poori tarah samajhkar, apni marzi se sign kiya hai. Aapne apne sabhi loan, EMI, guarantee aur daayitva — chaalu hon ya band — sahi-sahi ghoshit kar diye hain aur kuch bhi nahi chhipaya hai. Aap yeh bhi jaante hain ki koi bhi chhipi hui jaankari saamne aane par cheque rashi ka 25% nuksan bharpai ke roop mein dena hoga aur Ruralift ko cheque prastut karne ka poora adhikar hoga.

Kya yeh sab sahi hai aur kya aap isse sahmat hain?`
    }
  ];

  // Customers are often unable to read, so nothing is ever recited by the
  // customer. The representative reads each block aloud and the customer
  // answers Haan / Nahi. Q1 (name) is the only open-ended answer.
  blocks.forEach(b => {
    if (b.type === 'opening')          b.respond = 'Pratinidhi padhein';
    else if (b.type === 'closing')     b.respond = 'Pratinidhi padhkar sunayein — Grahak: Haan / Nahi';
    else if (/^Q1\b/.test(b.label))    b.respond = 'Grahak bolkar bataye';
    else                               b.respond = 'Haan / Nahi';
  });

  res.json({ blocks });
});

// POST /api/video/:customerId/upload — accept webm blob, save to uploads/videos/
app.post('/api/video/:customerId/upload', async (req, res) => {
  const state = loadState();
  const c = state.customers.find(x => x.id === req.params.customerId);
  if (!c) return res.status(404).json({ error: 'Customer not found' });

  try {
    const { data } = await parseVideoMultipart(req);
    if (data.length > 200 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 200MB)' });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `video-${req.params.customerId}-${timestamp}.webm`;
    fs.writeFileSync(path.join(VIDEO_DIR, filename), data);
    res.json({ ok: true, filename });
  } catch(e) {
    res.status(400).json({ error: e.message || 'Upload failed' });
  }
});

// GET /api/video/:customerId/list — list saved videos for a customer
app.get('/api/video/:customerId/list', (req, res) => {
  const prefix = 'video-' + req.params.customerId + '-';
  let files = [];
  if (fs.existsSync(VIDEO_DIR)) {
    files = fs.readdirSync(VIDEO_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.webm'))
      .sort()
      .reverse()
      .map(f => {
        const stat = fs.statSync(path.join(VIDEO_DIR, f));
        const mb = (stat.size / (1024*1024)).toFixed(1);
        // Parse date from filename: video-{id}-YYYY-MM-DDTHH-MM-SS.webm
        const datePart = f.replace(prefix, '').replace('.webm', '');
        const friendly = datePart.replace('T', ' ').replace(/-/g, (m, o) => o < 10 ? '-' : ':');
        return { filename: f, date: friendly, size: mb + ' MB' };
      });
  }
  res.json({ videos: files });
});

// GET /api/video/download/:filename — force-download video file
app.get('/api/video/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(VIDEO_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  const stat = fs.statSync(filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/webm');
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(filePath).pipe(res);
});

// GET /api/video/file/:filename — stream video with range support
app.get('/api/video/file/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filePath = path.join(VIDEO_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    const fileStream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/webm',
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/webm',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});


// DELETE /api/video/:customerId/:filename — delete a saved video
app.delete('/api/video/:customerId/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const prefix = 'video-' + req.params.customerId + '-';
  if (!filename.startsWith(prefix) || !filename.endsWith('.webm')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(VIDEO_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  try {
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Delete failed' });
  }
});

// ===== EMAIL CONFIG =====
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ===== GMAIL OAUTH2 =====
const { google } = require('googleapis');

function getRedirectUri() {
  // Railway sets RAILWAY_PUBLIC_DOMAIN automatically
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN + '/oauth2callback';
  }
  return 'http://localhost:' + PORT + '/oauth2callback';
}

function getOAuth2Client() {
  const cfg = loadConfig();
  const client = new google.auth.OAuth2(
    cfg.oauthClientId,
    cfg.oauthClientSecret,
    getRedirectUri()
  );
  if (cfg.oauthTokens) client.setCredentials(cfg.oauthTokens);
  // Auto-save refreshed tokens
  client.on('tokens', tokens => {
    const c = loadConfig();
    c.oauthTokens = { ...c.oauthTokens, ...tokens };
    saveConfig(c);
  });
  return client;
}

// GET /api/email-config — return current OAuth status
app.get('/api/email-config', (req, res) => {
  const cfg = loadConfig();
  res.json({
    hasClientId:     !!cfg.oauthClientId,
    hasClientSecret: !!cfg.oauthClientSecret,
    isConnected:     !!(cfg.oauthTokens && cfg.oauthTokens.refresh_token),
    gmailUser:       cfg.gmailUser || ''
  });
});

// POST /api/email-config — save Client ID + Secret
app.post('/api/email-config', (req, res) => {
  const { oauthClientId, oauthClientSecret } = req.body;
  if (!oauthClientId || !oauthClientSecret) {
    return res.status(400).json({ error: 'Client ID and Client Secret required' });
  }
  const cfg = loadConfig();
  cfg.oauthClientId     = oauthClientId.trim();
  cfg.oauthClientSecret = oauthClientSecret.trim();
  delete cfg.oauthTokens; // reset tokens when credentials change
  saveConfig(cfg);
  res.json({ ok: true });
});

// GET /api/gmail-auth — generate OAuth2 consent URL and redirect
app.get('/api/gmail-auth', (req, res) => {
  const cfg = loadConfig();
  if (!cfg.oauthClientId || !cfg.oauthClientSecret) {
    return res.status(400).send('Client ID/Secret not set. Configure in Gmail Setup first.');
  }
  const client = getOAuth2Client();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    // NOTE: gmail.send alone does NOT grant access to gmail.users.getProfile.
    // userinfo.email is added so we can read the connected account's email
    // address via the lightweight OAuth2 userinfo endpoint instead.
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/userinfo.email'
    ]
  });
  res.redirect(url);
});

// GET /oauth2callback — handle OAuth2 redirect from Google
app.get('/oauth2callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.send(`<h2>❌ Authorization failed: ${error || 'no code'}</h2><a href="/">Back to CRM</a>`);
  }
  try {
    const client = getOAuth2Client();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Get user's email address via the OAuth2 userinfo endpoint.
    // (gmail.users.getProfile requires a broader Gmail scope than
    // gmail.send provides, which was causing "Insufficient Permission".)
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const userinfo = await oauth2.userinfo.get();
    const email = userinfo.data.email;

    const cfg = loadConfig();
    cfg.oauthTokens = tokens;
    cfg.gmailUser = email;
    saveConfig(cfg);

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4;">
        <h2 style="color:#15803d">✅ Gmail Connected!</h2>
        <p style="font-size:18px">Emails will now send from <strong>${email}</strong></p>
        <p style="color:#666">You can close this tab and return to the CRM.</p>
        <script>setTimeout(()=>window.close(),3000)</script>
      </body></html>
    `);
  } catch (e) {
    console.error('OAuth callback error:', e.message);
    res.send(`<h2>❌ Error: ${e.message}</h2><a href="/">Back to CRM</a>`);
  }
});

// Upload a file to Google Drive and return a public shareable link
async function uploadToDrive(auth, filePath, filename, mimeType) {
  const drive = google.drive({ version: 'v3', auth });
  const fileSize = fs.statSync(filePath).size;
  console.log(`  Uploading to Drive: ${filename} (${(fileSize/1024/1024).toFixed(1)} MB)…`);

  const res = await drive.files.create({
    requestBody: { name: filename, mimeType },
    media: { mimeType, body: fs.createReadStream(filePath) },
    fields: 'id, name'
  });
  const fileId = res.data.id;

  // Make it viewable by anyone with the link
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  const link = `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
  console.log(`  Drive upload done: ${link}`);
  return link;
}

// POST /api/send-email — send via Gmail HTTP API (works on Railway — no SMTP needed)
app.post('/api/send-email', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.oauthTokens || !cfg.oauthTokens.refresh_token) {
    return res.status(400).json({ error: 'Gmail not connected. Click "Connect Gmail" in settings.' });
  }

  const { customerId, toEmail, subject, body } = req.body;
  if (!customerId || !toEmail) {
    return res.status(400).json({ error: 'Customer ID and recipient email required.' });
  }

  const state = loadState();
  const c = state.customers.find(x => x.id === customerId);
  if (!c) return res.status(404).json({ error: 'Customer not found' });

  const safeName = (c.name||'Customer').replace(/\s+/g,'_');
  const auth = getOAuth2Client();

  // ── Collect files ──────────────────────────────────────────────
  const attachments = []; // small files attached directly
  let driveLink = null;   // large video uploaded to Drive instead

  if (c.agreementPdf) {
    const p = path.join(UPLOADS_DIR, c.agreementPdf);
    if (fs.existsSync(p)) attachments.push({ filename: `Signed_Agreement_${safeName}.pdf`, path: p, mime: 'application/pdf' });
  }
  if (c.receiptPdf) {
    const p = path.join(UPLOADS_DIR, c.receiptPdf);
    if (fs.existsSync(p)) attachments.push({ filename: `Consultancy_Receipt_${safeName}.pdf`, path: p, mime: 'application/pdf' });
  }

  // Video: attach if under 24MB, otherwise upload to Drive
  if (fs.existsSync(VIDEO_DIR)) {
    const prefix = 'video-' + customerId + '-';
    const videos = fs.readdirSync(VIDEO_DIR).filter(f => f.startsWith(prefix) && f.endsWith('.webm')).sort().reverse();
    if (videos.length > 0) {
      const videoPath = path.join(VIDEO_DIR, videos[0]);
      const videoName = `VideoVerification_${safeName}.webm`;
      const videoSize = fs.statSync(videoPath).size;
      const MB = videoSize / (1024 * 1024);
      console.log(`  Video: ${videoName} — ${MB.toFixed(1)} MB`);
      if (MB <= 24) {
        attachments.push({ filename: videoName, path: videoPath, mime: 'video/webm' });
      } else {
        console.log('  Video too large for email — uploading to Google Drive…');
        driveLink = await uploadToDrive(auth, videoPath, videoName, 'video/webm');
      }
    }
  }

  try {
    // Build email body — append Drive link if video was uploaded there
    let finalBody = body;
    if (driveLink) {
      finalBody += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      finalBody += `🎥 Video Verification Session:\n${driveLink}\n`;
      finalBody += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    }

    // Build RFC 2822 MIME email
    const boundary = `boundary_${Date.now()}`;
    const nl = '\r\n';
    let mime = '';
    mime += `From: "Ruralift" <${cfg.gmailUser}>${nl}`;
    mime += `To: ${toEmail}${nl}`;
    mime += `Subject: ${subject}${nl}`;
    mime += `MIME-Version: 1.0${nl}`;
    mime += `Content-Type: multipart/mixed; boundary="${boundary}"${nl}`;
    mime += nl;
    mime += `--${boundary}${nl}`;
    mime += `Content-Type: text/plain; charset="UTF-8"${nl}${nl}`;
    mime += finalBody + nl;
    for (const a of attachments) {
      const data = fs.readFileSync(a.path).toString('base64');
      mime += `--${boundary}${nl}`;
      mime += `Content-Type: ${a.mime}; name="${a.filename}"${nl}`;
      mime += `Content-Transfer-Encoding: base64${nl}`;
      mime += `Content-Disposition: attachment; filename="${a.filename}"${nl}${nl}`;
      mime += data + nl;
    }
    mime += `--${boundary}--`;

    const encoded = Buffer.from(mime).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });

    res.json({
      ok: true,
      attached: attachments.length,
      driveLink: driveLink || null,
      from: cfg.gmailUser
    });
  } catch (e) {
    const fullError = e.response?.data?.error?.message || e.message || 'Unknown error';
    console.error('Email send error:', fullError);
    res.status(500).json({ error: fullError });
  }
});

// Listen on all interfaces so any device on the same LAN can connect
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n===========================================');
  console.log('  Ruralift CRM started');
  console.log('===========================================');
  console.log(`  Local:  http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        console.log(`  LAN:    http://${addr.address}:${PORT}   <-- use this on other devices`);
      }
    }
  }
  console.log('===========================================\n');
});
