require('dotenv').config();
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const cron = require('node-cron');
const fs = require('fs');

// ============================================================
//  CONFIG
// ============================================================

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const TIMEZONE = process.env.TIMEZONE || 'Africa/Algiers';

// Where WhatsApp session is stored. On Render, point this to a persistent disk
// (e.g. /var/data/wwebjs_auth) or you will have to scan the QR after every restart.
const SESSION_PATH = process.env.SESSION_PATH || './.wwebjs_auth';

// Optional: protects /api/qr and /api/schedule/send  (use ?key=XXXX or header x-api-key)
const API_KEY = process.env.API_KEY || '';

// Monthly cron (default: 9th of every month at 20:00)
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 20 9 * *';

// Set SEND_ON_START=true to send next month's PDF once WhatsApp is ready after boot
const SEND_ON_START = process.env.SEND_ON_START === 'true';

// PHONE_1, PHONE_2, ... PHONE_5  (international format, e.g. +213555123456)
const PHONE_NUMBERS = [1, 2, 3, 4, 5]
  .map((i) => process.env[`PHONE_${i}`])
  .filter(Boolean)
  .map((p) => p.replace(/\D/g, ''))
  .filter(Boolean);

const MEMBERS = ['Fathi', 'Fouziya', 'Mejda', 'Hamza'];
const ROTATION_START_DATE = new Date(2026, 5, 30);
const DAYS_PER_TURN = 3;

const MEMBER_COLORS = {
  Fathi: { bg: '#e0e7ff', fg: '#4338ca', dot: '#6366f1', light: '#eef2ff' },
  Mejda: { bg: '#fce7f3', fg: '#be185d', dot: '#ec4899', light: '#fdf2f8' },
  Fouziya: { bg: '#d1fae5', fg: '#065f46', dot: '#10b981', light: '#ecfdf5' },
  Hamza: { bg: '#fef3c7', fg: '#92400e', dot: '#f59e0b', light: '#fffbeb' },
};
const FALLBACK_COLOR = { bg: '#f3f4f6', fg: '#374151', dot: '#9ca3af', light: '#f9fafb' };

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

console.log(`📱 Loaded ${PHONE_NUMBERS.length} phone number(s)`);
if (PHONE_NUMBERS.length === 0) {
  console.log('⚠️  No phone numbers! Set PHONE_1 in your Render environment variables.');
}

// ============================================================
//  CRASH PREVENTION
// ============================================================

process.on('unhandledRejection', (err) => {
  console.error('⚠️  Unhandled rejection:', err?.message || err);
});

process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught exception:', err?.message || err);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
//  WHATSAPP CLIENT
// ============================================================

let client = null;
let isReady = false;
let isInitializing = false;
let reconnectTimer = null;
let initAttempts = 0;
let pendingSend = null;
let currentQR = null;
let isSending = false;

function clearSession() {
  try {
    if (fs.existsSync(SESSION_PATH)) {
      console.log('🗑️  Clearing old session...');
      // delete the contents (not the folder itself - it may be a mounted disk)
      for (const entry of fs.readdirSync(SESSION_PATH)) {
        fs.rmSync(`${SESSION_PATH}/${entry}`, { recursive: true, force: true });
      }
      console.log('✅ Session cleared!');
    }
  } catch (e) {
    console.log('⚠️  Could not clear session:', e.message);
  }
}

function killChromeProcesses() {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      execSync('taskkill /f /im chrome.exe /im chromedriver.exe 2>nul', { stdio: 'ignore' });
    } else {
      execSync('pkill -f chrome || true', { stdio: 'ignore' });
    }
    console.log('✅ Killed hanging Chrome processes');
  } catch (e) {}
}

function initWhatsApp() {
  if (isInitializing) return;
  isInitializing = true;
  initAttempts++;
  console.log(`🔄 Initializing WhatsApp... (Attempt ${initAttempts})`);

  if (initAttempts === 1) killChromeProcesses();

  if (client) {
    try { client.destroy(); } catch (_) {}
    client = null;
    isReady = false;
  }

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    puppeteer: {
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
      defaultViewport: null,
    },
    // NOTE: the old pinned webVersionCache (wppconnect 2.3000.1018732221) was removed.
    // Keep whatsapp-web.js updated instead:  npm i whatsapp-web.js@latest
  });

  client.on('qr', (qr) => {
    currentQR = qr;
    console.log('\n📱 SCAN QR CODE WITH WHATSAPP:');
    qrcodeTerminal.generate(qr, { small: true });
    console.log('1. Open WhatsApp on your phone');
    console.log('2. Settings → Linked Devices → Link a Device');
    console.log('3. Scan the QR code above');
    console.log('🔗 Or open /api/qr in your browser\n');
  });

  client.on('authenticated', () => {
    console.log('✅ Authenticated! Session saved.');
  });

  client.on('ready', async () => {
    isReady = true;
    isInitializing = false;
    currentQR = null;
    console.log('✅ WhatsApp READY!');

    // give WhatsApp Web a few seconds to finish loading before sending
    await sleep(5000);

    if (pendingSend) {
      console.log('📤 Executing pending PDF send...');
      const { month, year } = pendingSend;
      pendingSend = null;
      await sendScheduleFor(month, year);
    }
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ Auth failed:', msg);
    isInitializing = false;
    isReady = false;
    currentQR = null;
    clearSession();
    setTimeout(() => initWhatsApp(), 5000);
  });

  client.on('disconnected', (reason) => {
    console.log('⚠️  Disconnected:', reason);
    isReady = false;
    isInitializing = false;
    currentQR = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => initWhatsApp(), 10000);
  });

  client.initialize().catch((err) => {
    console.error('❌ Init failed:', err.message);
    isInitializing = false;
    isReady = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => initWhatsApp(), 10000);
  });
}

// ============================================================
//  ROTATION LOGIC
// ============================================================

function getPersonForDate(date) {
  const diffDays = Math.floor((date - ROTATION_START_DATE) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return 'Not started';
  const block = Math.floor(diffDays / DAYS_PER_TURN);
  return MEMBERS[block % MEMBERS.length];
}

function generateSchedule(month, year) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const schedule = {};
  for (let day = 1; day <= daysInMonth; day++) {
    schedule[day] = getPersonForDate(new Date(year, month - 1, day));
  }
  return schedule;
}

function getNextMonthYear() {
  const now = new Date();
  let month = now.getMonth() + 2; // getMonth() is 0-based, +1 for real month, +1 for next
  let year = now.getFullYear();
  if (month > 12) {
    month = 1;
    year += 1;
  }
  return { month, year };
}

// ============================================================
//  CALENDAR HTML
// ============================================================

function generateCalendarHTML(month, year, schedule) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDay = new Date(year, month - 1, 1).getDay();
  const today = new Date();
  const isCurrentMonth = today.getMonth() + 1 === month && today.getFullYear() === year;

  const legendItems = MEMBERS.map((name) => {
    const color = MEMBER_COLORS[name] || FALLBACK_COLOR;
    return `
      <span class="legend-item">
        <span class="legend-dot" style="background:${color.dot}"></span>
        ${name}
      </span>`;
  }).join('');

  let cells = '';
  let dateCounter = 1;
  const totalRows = Math.ceil((firstDay + daysInMonth) / 7);

  for (let r = 0; r < totalRows; r++) {
    cells += '<tr>';
    for (let c = 0; c < 7; c++) {
      const cellIndex = r * 7 + c;
      const isBlank = cellIndex < firstDay || dateCounter > daysInMonth;

      if (isBlank) {
        cells += '<td class="empty"></td>';
      } else {
        const day = dateCounter;
        const person = schedule[day] || '';
        const isNotStarted = person === 'Not started';
        const isWeekend = c === 0 || c === 6;
        const isToday = isCurrentMonth && day === today.getDate();
        const color = MEMBER_COLORS[person] || FALLBACK_COLOR;

        cells += `
          <td class="${isWeekend ? 'weekend' : ''} ${isToday ? 'today' : ''} ${person ? 'has-person' : ''}">
            <div class="day-number">${day}</div>
            ${
              person && !isNotStarted
                ? `<div class="person-badge" style="background:${color.bg};color:${color.fg}">${person}</div>`
                : ''
            }
            ${isNotStarted ? '<div class="pending">-</div>' : ''}
          </td>`;
        dateCounter++;
      }
    }
    cells += '</tr>';
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Family Rotation Calendar</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: #f0f2f5;
    padding: 24px;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .calendar {
    max-width: 820px;
    width: 100%;
    margin: 0 auto;
    background: #ffffff;
    border-radius: 24px;
    padding: 32px 28px 28px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
  }

  .header {
    text-align: center;
    padding: 20px 24px;
    background: linear-gradient(135deg, #f97316, #ef4444);
    border-radius: 16px;
    margin-bottom: 28px;
  }
  .header h1 { font-size: 26px; font-weight: 700; color: #ffffff; letter-spacing: 0.5px; }
  .header h2 { font-size: 17px; font-weight: 400; color: rgba(255,255,255,0.92); margin-top: 4px; letter-spacing: 0.3px; }

  table { width: 100%; border-collapse: separate; border-spacing: 4px; }

  th {
    color: #6b7280; font-size: 12px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.08em; padding: 8px 0 6px; text-align: center;
  }

  td {
    background: #fafbfc; border-radius: 12px; height: 72px; width: 14.28%;
    text-align: center; vertical-align: middle; padding: 6px 4px; position: relative;
  }
  td.empty { background: transparent; }
  td.weekend { background: #f8f9fa; }
  td.today { outline: 2.5px solid #f97316; outline-offset: -2.5px; background: #fff7ed; }
  td.has-person { background: #ffffff; border: 1px solid #f0f0f0; }

  .day-number { font-size: 15px; font-weight: 600; color: #1f2937; line-height: 1.2; }

  .person-badge {
    display: inline-block; margin-top: 4px; padding: 3px 10px; border-radius: 20px;
    font-size: 11px; font-weight: 600; letter-spacing: 0.02em; background: #e5e7eb; color: #374151;
  }

  .pending { margin-top: 4px; font-size: 16px; opacity: 0.5; }

  .legend {
    display: flex; justify-content: center; gap: 18px; margin-top: 24px; padding-top: 20px;
    border-top: 1.5px solid #f0f0f0; flex-wrap: wrap;
  }
  .legend-item { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 500; color: #374151; }
  .legend-dot { width: 14px; height: 14px; border-radius: 50%; display: inline-block; flex-shrink: 0; }

  .footer { text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px; letter-spacing: 0.3px; }

  @media (max-width: 600px) {
    body { padding: 12px; }
    .calendar { padding: 16px 12px 18px; border-radius: 16px; }
    .header { padding: 14px 16px; border-radius: 12px; }
    .header h1 { font-size: 20px; }
    .header h2 { font-size: 14px; }
    table { border-spacing: 3px; }
    td { height: 60px; padding: 4px 2px; border-radius: 8px; }
    .day-number { font-size: 13px; }
    .person-badge { font-size: 9px; padding: 2px 7px; margin-top: 2px; }
    .legend { gap: 10px; padding-top: 14px; margin-top: 16px; }
    .legend-item { font-size: 11px; gap: 5px; }
    .legend-dot { width: 10px; height: 10px; }
    th { font-size: 10px; padding: 4px 0; }
  }
</style>
</head>
<body>
  <div class="calendar">
    <div class="header">
      <h1>Family Rotation</h1>
      <h2>${MONTH_NAMES[month - 1]} ${year}</h2>
    </div>
    <table>
      <thead>
        <tr>
          <th>Sun</th><th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th><th>Sat</th>
        </tr>
      </thead>
      <tbody>${cells}</tbody>
    </table>
    <div class="legend">${legendItems}</div>
    <div class="footer">Created by Zeghlache Mohammed</div>
  </div>
</body>
</html>`;
}

// ============================================================
//  PDF GENERATION - uses the same Chrome that whatsapp-web.js
//  already runs (no PhantomJS / html-pdf needed)
// ============================================================

async function renderPDF(month, year, schedule) {
  if (!client || !client.pupBrowser) {
    throw new Error('Browser is not available yet');
  }

  const html = generateCalendarHTML(month, year, schedule);
  const page = await client.pupBrowser.newPage();

  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMediaType('screen');
    const pdfData = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' },
    });
    return Buffer.from(pdfData);
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

// ============================================================
//  SENDING
// ============================================================

async function sendPDFToAll(month, year, pdfBuffer) {
  const filename = `Family_Rotation_${MONTH_NAMES[month - 1]}_${year}.pdf`;
  const media = new MessageMedia('application/pdf', pdfBuffer.toString('base64'), filename);
  const caption = `📅 ${MONTH_NAMES[month - 1]} ${year} Family Rotation Schedule`;

  const results = [];
  for (const phone of PHONE_NUMBERS) {
    try {
      // Resolve the real WhatsApp ID (also checks the number is on WhatsApp)
      const numberId = await client.getNumberId(phone);
      if (!numberId) {
        console.error(`❌ ${phone} is not registered on WhatsApp`);
        results.push({ phone, success: false, error: 'Number not registered on WhatsApp' });
        continue;
      }

      await client.sendMessage(numberId._serialized, media, {
        caption,
        sendMediaAsDocument: true,
        sendSeen: false, // avoids the "markedUnread" crash in some versions
      });
      console.log(`✅ PDF sent to ${phone}`);
      results.push({ phone, success: true });
    } catch (error) {
      console.error(`❌ Error sending PDF to ${phone}:`, error.message);
      results.push({ phone, success: false, error: error.message });
    }
    await sleep(2000);
  }
  return results;
}

async function sendScheduleFor(month, year) {
  console.log(`📅 Preparing PDF for ${MONTH_NAMES[month - 1]} ${year}...`);

  if (PHONE_NUMBERS.length === 0) {
    return { status: 'failed', error: 'No phone numbers configured (PHONE_1)' };
  }

  if (!isReady) {
    console.log('⏳ WhatsApp not ready yet. PDF queued - will send when WhatsApp connects');
    pendingSend = { month, year };
    return { status: 'queued' };
  }

  if (isSending) {
    return { status: 'failed', error: 'Another send is already in progress' };
  }

  isSending = true;
  try {
    const schedule = generateSchedule(month, year);
    const pdfBuffer = await renderPDF(month, year, schedule);
    console.log(`📄 PDF generated (${Math.round(pdfBuffer.length / 1024)} KB). Sending...`);

    const results = await sendPDFToAll(month, year, pdfBuffer);
    const ok = results.some((r) => r.success);
    console.log(ok ? '✅ PDF sent!' : '❌ PDF was NOT sent to anyone');
    return { status: ok ? 'sent' : 'failed', results };
  } catch (error) {
    console.error('❌ Error in send flow:', error.message);
    return { status: 'failed', error: error.message };
  } finally {
    isSending = false;
  }
}

// ============================================================
//  SCHEDULER
// ============================================================

if (cron.validate(CRON_SCHEDULE)) {
  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      const { month, year } = getNextMonthYear();
      console.log(`📅 Monthly job: sending ${MONTH_NAMES[month - 1]} ${year} PDF`);
      await sendScheduleFor(month, year);
    },
    { timezone: TIMEZONE }
  );
  console.log(`⏰ Monthly send scheduled: "${CRON_SCHEDULE}" (${TIMEZONE})`);
} else {
  console.error(`❌ Invalid CRON_SCHEDULE: "${CRON_SCHEDULE}"`);
}

// ============================================================
//  API ROUTES
// ============================================================

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  const provided = req.query.key || req.headers['x-api-key'];
  if (provided === API_KEY) return next();
  return res.status(401).json({ success: false, error: 'Unauthorized' });
}

app.get('/', (req, res) => {
  res.json({
    message: '🏠 Family Rotation Automation API is running!',
    status: 'healthy',
    whatsappReady: isReady,
    endpoints: {
      health: '/api/health',
      qr: '/api/qr',
      preview: '/api/schedule/preview',
      send: '/api/schedule/send  (GET or POST, optional ?month=12&year=2026)',
    },
  });
});

app.get('/api/qr', requireKey, async (req, res) => {
  if (isReady) {
    return res.send('<h2 style="font-family:Arial;text-align:center;margin-top:20vh">✅ WhatsApp is already connected</h2>');
  }

  if (!currentQR) {
    return res.send(`
      <html><head><meta http-equiv="refresh" content="5"></head>
      <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:Arial;">
        <div style="text-align:center;">
          <h2>⏳ No QR Code Available yet</h2>
          <p>Waiting for WhatsApp to generate it... this page refreshes automatically.</p>
        </div>
      </body></html>`);
  }

  // QR is generated locally - it is NOT sent to any third-party website
  const dataUrl = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });

  res.send(`
    <html>
      <head>
        <title>Scan QR Code</title>
        <meta http-equiv="refresh" content="20">
        <style>
          body { display:flex; justify-content:center; align-items:center; height:100vh; font-family:Arial,sans-serif; background:#f0f2f5; margin:0; }
          .container { background:white; padding:40px; border-radius:16px; box-shadow:0 4px 24px rgba(0,0,0,0.1); text-align:center; max-width:400px; }
          img { width:280px; height:280px; }
          h1 { color:#1f2937; font-size:24px; }
          p { color:#6b7280; font-size:14px; }
          .steps { text-align:left; margin:16px 0; color:#374151; font-size:13px; line-height:1.6; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>📱 Scan with WhatsApp</h1>
          <img src="${dataUrl}" />
          <div class="steps">
            <p><strong>1.</strong> Open WhatsApp on your phone</p>
            <p><strong>2.</strong> Settings → Linked Devices → Link a Device</p>
            <p><strong>3.</strong> Scan the QR code above</p>
          </div>
        </div>
      </body>
    </html>`);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    phones: PHONE_NUMBERS.length,
    whatsappReady: isReady,
    hasPendingSend: !!pendingSend,
    hasQR: !!currentQR,
  });
});

async function sendHandler(req, res) {
  try {
    const src = { ...(req.query || {}), ...(req.body || {}) };
    const next = getNextMonthYear();
    const m = Number(src.month) || next.month;
    const y = Number(src.year) || next.year;

    if (m < 1 || m > 12) {
      return res.status(400).json({ success: false, error: 'month must be 1-12' });
    }

    const result = await sendScheduleFor(m, y);
    const code = result.status === 'failed' ? 500 : 200;
    res.status(code).json({ success: result.status !== 'failed', month: m, year: y, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

app.route('/api/schedule/send').get(requireKey, sendHandler).post(requireKey, sendHandler);

app.get('/api/schedule/preview', (req, res) => {
  const next = getNextMonthYear();
  const m = Number(req.query.month) || next.month;
  const y = Number(req.query.year) || next.year;
  res.send(generateCalendarHTML(m, y, generateSchedule(m, y)));
});

// ============================================================
//  START SERVER
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`👀 Preview: /api/schedule/preview   📱 QR: /api/qr`);

  setTimeout(initWhatsApp, 2000);

  if (SEND_ON_START) {
    const { month, year } = getNextMonthYear();
    console.log(`📤 SEND_ON_START=true → ${MONTH_NAMES[month - 1]} ${year} PDF will be sent once WhatsApp is ready`);
    pendingSend = { month, year };
  }
});
