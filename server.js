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
  const agreeDate = c.date
    ? new Date(c.date).toLocaleDateString('hi-IN', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : new Date().toLocaleDateString('hi-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const name = c.name || '___';
  const fee = c.successFee ? 'रु. ' + Number(c.successFee).toLocaleString('en-IN') : 'रु. ___';
  const chequeNo = c.chequeNo || '___';
  const bankBranch = c.chequeBankBranch || '___';

  // Cheque amount + the 25% liquidated-damages figure (Sections 16.5 / 17.6 / 18.6)
  const chequeAmtNum = Number(c.chequeAmt || c.successFee || 0) || 0;
  const chequeAmt = chequeAmtNum ? 'रु. ' + chequeAmtNum.toLocaleString('en-IN') : 'रु. ___';
  const ld25 = chequeAmtNum
    ? 'रु. ' + Math.round(chequeAmtNum * 0.25).toLocaleString('en-IN')
    : 'रु. ___';

  const blocks = [
    {
      label: 'प्रारंभ (Opening)',
      type: 'opening',
      text: `आज दिनांक ${agreeDate}, हम ${name} जी की ऋण सुविधा परामर्श अनुबंध की वीडियो पुष्टि रिकॉर्ड कर रहे हैं।`
    },
    {
      label: 'Q1 — पहचान (Section 1)',
      text: 'अपना पूरा नाम और पिता/पति का नाम बताइए।'
    },
    {
      label: 'Q2 — स्वैच्छिक हस्ताक्षर (Section 19 (b))',
      text: 'क्या आपने यह अनुबंध बिना किसी दबाव या जोर-जबरदस्ती के, अपनी स्वतंत्र इच्छा से हस्ताक्षर किया है?'
    },
    {
      label: 'Q3 — शुल्क की समझ (Section 2, Section 19 (s))',
      text: `क्या आप समझते हैं कि Ruralift की परामर्श सेवा निःशुल्क है, और सफलता-आधारित शुल्क ${fee} केवल ऋण के सफल वितरण पर ही देय होगा?`
    },
    {
      label: 'Q4 — PDC की समझ (Section 3, Section 19 (i))',
      text: `क्या आपने स्वेच्छा से चेक नंबर ${chequeNo} (${bankBranch}), राशि ${chequeAmt} जारी किया है, और आप समझते हैं कि यह कब जमा किया जा सकता है — ऋण वितरण पर शुल्क के रूप में, या अनुबंध भंग होने पर नुकसान भरपाई की वसूली के रूप में?`
    },
    {
      label: 'Q5 — चेक बाउंस परिणाम (Section 3 (f), Section 19 (n))',
      text: 'क्या आप जानते हैं कि चेक अनादरण की स्थिति में आप Section 138, परक्राम्य लिखत अधिनियम के अंतर्गत आपराधिक रूप से दायी होंगे?'
    },
    {
      label: 'Q6 — DSA/कमीशन खुलासा (Section 1 (d), Section 19 (j))',
      text: 'क्या आपको बताया गया है कि Ruralift का ऋण संस्थानों के साथ DSA संबंध हो सकता है और वह कमीशन भी प्राप्त कर सकता है — फिर भी आप यह अतिरिक्त परामर्श शुल्क देने पर सहमत हैं?'
    },
    {
      label: 'Q7 — सर्वोत्तम प्रयास / पूरी कोशिश (Section 1 (b), Section 19 (h))',
      text: 'क्या आप समझते हैं कि Ruralift आपका ऋण स्वीकृत कराने के लिए अपनी पूरी कोशिश और सर्वोत्तम प्रयास करेगा — सही ऋणदाता का चुनाव, फ़ाइल की सही प्रस्तुति और लगातार फॉलो-अप — परंतु स्वीकृति का अंतिम निर्णय बैंक/NBFC का होता है, जिस पर Ruralift का कोई नियंत्रण नहीं है?'
    },
    {
      label: 'Q8 — दस्तावेज़ों की सत्यता (Section 19 (g))',
      text: 'क्या आपके द्वारा दिए गए सभी दस्तावेज़ और जानकारी सत्य, सटीक और पूर्ण हैं?'
    },
    {
      label: 'Q9 — पूर्ण ऋण, EMI और गारंटी घोषणा (Section 16 (a), Section 19 (th))',
      text: `क्या आपने हमें अपने सभी ऋण और दायित्व बता दिए हैं? इसमें शामिल है —
(a) आपके अपने नाम पर चालू सभी ऋण — होम लोन, कार लोन, पर्सनल लोन, बिज़नेस लोन, गोल्ड लोन, KCC;
(b) हर ऋण की EMI और outstanding balance;
(c) क्रेडिट कार्ड, ओवरड्राफ्ट, कैश क्रेडिट लिमिट;
(d) माइक्रोफाइनांस / SHG / joint liability group का कोई भी लोन;
(e) वे सभी ऋण जिनमें आप GUARANTOR या co-applicant हैं — चाहे आप EMI न भरते हों;
(f) कोई भी ऋण जो बंद हो गया हो मगर पूरी तरह वसूल नहीं हुआ — write-off, settlement या restructure;
(g) कोई भी overdue या late payment जो अभी भी pending है;
(h) कोई भी निजी / साहूकार का लोन जो बैंक रिकॉर्ड में नहीं है।
कृपया स्पष्ट रूप से कहें: "हाँ, मैंने सब कुछ बता दिया है, कुछ भी नहीं छिपाया।"`
    },
    {
      label: 'Q10 — परिशिष्ट "अ" स्व-घोषणा और 25% पेनल्टी (Section 16 (b))',
      text: `क्या आपने परिशिष्ट "अ" — यानी अपने सभी ऋण, EMI, गारंटी और दायित्वों की सूची — अपने हाथ से लिखकर हस्ताक्षर किया है?

और क्या आप समझते हैं कि यदि प्रक्रिया के बीच में — CIBIL रिपोर्ट आने के बाद या फ़ाइल submit होने के बाद — कोई भी ऐसा ऋण, EMI, गारंटी, write-off, settlement या कोई भी दायित्व सामने आया जो आपने घोषणापत्र में नहीं लिखा — चाहे वह आपका खुद का ऋण हो या किसी और के लिए दी गई गारंटी हो — तो:
(a) चेक राशि का 25%, यानी लगभग ${ld25}, नुकसान भरपाई के रूप में देना होगा;
(b) Ruralift को पूरा अधिकार है कि वह उस चेक को बैंक में प्रस्तुत करे — चाहे वह bounce हो या न हो;
(c) या आप ${ld25} नकद / UPI से penalty के रूप में दे सकते हैं।

कृपया स्पष्ट रूप से कहें: "हाँ, मैं समझता/समझती हूँ और सहमत हूँ।"`
    },
    {
      label: 'Q11 — निरंतर प्रकटन, 24 घंटे (Section 16 (c))',
      text: 'क्या आप सहमत हैं कि आज के बाद और ऋण मिलने से पहले अगर आप कोई नया ऋण या क्रेडिट कार्ड लेते हैं, किसी का गारंटर बनते हैं, या कोई EMI चूक जाती है — तो आप 24 घंटे के भीतर हमें लिखित सूचना देंगे?'
    },
    {
      label: 'Q12 — प्रक्रिया शुरू होने के बाद वापसी नहीं (Section 17, Section 19 (d))',
      text: `क्या आप समझते हैं कि आपकी CIBIL रिपोर्ट निकलने या फ़ाइल बैंक में लॉगिन होने के बाद आप आवेदन वापस नहीं ले सकते — न परिवार की आपत्ति पर, न मन बदलने पर, न किसी दूसरे एजेंट के प्रस्ताव पर, न ब्याज दर से असंतोष पर? और ऐसा करने पर चेक राशि का 25%, यानी लगभग ${ld25}, नुकसान भरपाई देनी होगी? आपको यह भी बता दिया गया है कि प्रक्रिया शुरू होने से पहले आप बिना कोई शुल्क दिए कभी भी पीछे हट सकते हैं।`
    },
    {
      label: 'Q13 — ऋण मिलने पर 2 घंटे में सूचना (Section 18, Section 19 (d-2))',
      text: 'क्या आप सहमत हैं कि ऋण की राशि आपके खाते में आने के 2 घंटे के भीतर आप हमें WhatsApp/SMS/ईमेल पर लिखित सूचना देंगे — जिसमें जमा की तारीख और समय, जमा हुई राशि, बैंक/NBFC का नाम, ऋण खाता नंबर, और बैंक का SMS या स्टेटमेंट का स्क्रीनशॉट होगा? और क्या आप समझते हैं कि वितरण छिपाने पर चेक राशि का 25% नुकसान भरपाई के रूप में देय होगा?'
    },
    {
      label: 'Q14 — नुकसान भरपाई की वसूली-व्यवस्था (Section 16 (f), Section 19 (n))',
      text: 'क्या आप समझते हैं कि कोई भी नुकसान भरपाई देय होने पर पहले आपको 7 दिन का समय और नकद/UPI/बैंक ट्रांसफर से सीधे भुगतान करने का विकल्प दिया जाएगा — और पूरा भुगतान करने पर आपका चेक आपको वापस कर दिया जाएगा? अगर आप 7 दिन में भुगतान नहीं करते, तभी चेक वसूली के लिए लगाया जाएगा, और चेक की राशि देय राशि से ज़्यादा होने पर बाकी पैसा 15 दिन में आपको वापस कर दिया जाएगा।'
    },
    {
      label: 'Q15 — डेटा शेयरिंग सहमति (Section 8, Section 19 (j))',
      text: 'क्या आप सहमत हैं कि आपकी जानकारी बैंकों/NBFCs के साथ साझा की जा सकती है, और Ruralift आपकी क्रेडिट रिपोर्ट निकालकर व ऋणदाता से आपकी दी गई जानकारी का स्वतंत्र सत्यापन कर सकता है?'
    },
    {
      label: 'समापन (Closing — ग्राहक बोलें)',
      type: 'closing',
      text: `मैं ${name} पुष्टि करता/करती हूँ कि मैंने यह अनुबंध और परिशिष्ट "अ" पढ़कर, समझकर, स्वेच्छा से हस्ताक्षर किया है। मैंने अपने सभी ऋण, EMI, गारंटी और दायित्व — चालू हों या बंद — सही-सही घोषित किए हैं। कुछ भी नहीं छिपाया है। मुझे पता है कि कोई भी छिपी हुई जानकारी सामने आने पर चेक राशि का 25% नुकसान भरपाई के रूप में देना होगा और Ruralift को चेक प्रस्तुत करने का पूरा अधिकार होगा।`
    }
  ];

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
