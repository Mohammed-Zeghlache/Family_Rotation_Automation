require('dotenv').config();
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const pdf = require('html-pdf');

// ============================================================
//  CONFIG
// ============================================================

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const TIMEZONE = process.env.TIMEZONE || 'Africa/Algiers';

// Default month/year for sending
const DEFAULT_SEND_MONTH = Number(process.env.SEND_MONTH) || 7;  // July
const DEFAULT_SEND_YEAR = Number(process.env.SEND_YEAR) || 2026;

const PHONE_NUMBERS = [
  process.env.PHONE_1,
].filter(Boolean);

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

// ============================================================
//  CRASH PREVENTION
// ============================================================

process.on('unhandledRejection', (err) => {
  console.error('⚠️  Unhandled rejection:', err?.message || err);
});

process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught exception:', err?.message || err);
});

// ============================================================
//  WHATSAPP CLIENT
// ============================================================

let client = null;
let isReady = false;
let isInitializing = false;
let reconnectTimer = null;
let initAttempts = 0;
let qrDisplayed = false;
let pendingSend = null;
let currentQR = null; // Store QR code for API route

function clearSession() {
  try {
    const sessionPath = './.wwebjs_auth/session';
    if (fs.existsSync(sessionPath)) {
      console.log('🗑️  Clearing old session...');
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log('✅ Session cleared!');
    }
  } catch (e) {
    console.log('⚠️  Could not clear session:', e.message);
  }
}

function killChromeProcesses() {
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      execSync('taskkill /f /im chrome.exe /im chromedriver.exe 2>nul', { stdio: 'ignore' });
    } else {
      const { execSync } = require('child_process');
      execSync('pkill -f chrome || true', { stdio: 'ignore' });
    }
    console.log('✅ Killed hanging Chrome processes');
  } catch (e) {}
}

function initWhatsApp() {
  if (isInitializing) return;
  isInitializing = true;
  initAttempts++;
  qrDisplayed = false;
  console.log(`🔄 Initializing WhatsApp... (Attempt ${initAttempts})`);

  if (initAttempts === 1) {
    killChromeProcesses();
  }

  if (client) {
    try { client.destroy(); } catch (_) {}
    client = null;
    isReady = false;
  }

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth/session' }),
    puppeteer: {
      headless: 'new',
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
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1018732221.html',
    },
  });

  client.on('qr', (qr) => {
    qrDisplayed = true;
    currentQR = qr; // Store QR code for API
    console.log('\n📱 SCAN QR CODE WITH WHATSAPP:');
    console.log('===================================='); 
    qrcode.generate(qr, { small: true });
    console.log('====================================');
    console.log('1. Open WhatsApp on your phone');
    console.log('2. Settings → Linked Devices → Link a Device');
    console.log('3. Scan the QR code above\n');
    console.log('🔗 Or visit /api/qr to scan from your browser\n');
  });

  client.on('authenticated', () => {
    console.log('✅ Authenticated! Session saved.');
  });

  client.on('ready', () => {
    isReady = true;
    isInitializing = false;
    console.log('✅ WhatsApp READY!');
    console.log(`📱 Will send to ${PHONE_NUMBERS.length} number(s)`);
    console.log('🎉 Connection established successfully!');
    
    if (pendingSend) {
      console.log('📤 Executing pending PDF send...');
      const { month, year } = pendingSend;
      pendingSend = null;
      sendScheduleFor(month, year);
    }
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ Auth failed:', msg);
    isInitializing = false;
    qrDisplayed = false;
    currentQR = null;
    clearSession();
    setTimeout(() => initWhatsApp(), 5000);
  });

  client.on('disconnected', (reason) => {
    console.log('⚠️  Disconnected:', reason);
    isReady = false;
    isInitializing = false;
    qrDisplayed = false;
    currentQR = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => initWhatsApp(), 10000);
  });

  client.initialize().catch((err) => {
    console.error('❌ Init failed:', err.message);
    isInitializing = false;
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

// ============================================================
//  WHATSAPP SENDING HELPERS - PDF ONLY
// ============================================================

async function sendMediaToAll(media, caption) {
  if (!isReady) {
    console.log('⏳ WhatsApp not ready, skipping media send');
    return [];
  }

  const results = [];
  for (const phone of PHONE_NUMBERS) {
    try {
      const chatId = phone.replace('+', '') + '@c.us';
      await client.sendMessage(chatId, media, { caption });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
//  CALENDAR HTML - CLEAN & MODERN DESIGN
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
  const totalCells = firstDay + daysInMonth;
  const totalRows = Math.ceil(totalCells / 7);

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
            ${isNotStarted ? '<div class="pending">⏳</div>' : ''}
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
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: #f0f2f5;
    padding: 24px;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .calendar {
    max-width: 820px;
    width: 100%;
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

  .header h1 {
    font-size: 26px;
    font-weight: 700;
    color: #ffffff;
    letter-spacing: 0.5px;
  }

  .header h2 {
    font-size: 17px;
    font-weight: 400;
    color: rgba(255, 255, 255, 0.92);
    margin-top: 4px;
    letter-spacing: 0.3px;
  }

  table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 4px;
  }

  th {
    color: #6b7280;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 8px 0 6px;
    text-align: center;
  }

  td {
    background: #fafbfc;
    border-radius: 12px;
    height: 72px;
    width: 14.28%;
    text-align: center;
    vertical-align: middle;
    padding: 6px 4px;
    transition: background 0.15s ease;
    position: relative;
  }

  td.empty {
    background: transparent;
  }

  td.weekend {
    background: #f8f9fa;
  }

  td.today {
    outline: 2.5px solid #f97316;
    outline-offset: -2.5px;
    background: #fff7ed;
  }

  td.has-person {
    background: #ffffff;
  }

  .day-number {
    font-size: 15px;
    font-weight: 600;
    color: #1f2937;
    line-height: 1.2;
  }

  .person-badge {
    display: inline-block;
    margin-top: 4px;
    padding: 3px 10px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    background: #e5e7eb;
    color: #374151;
  }

  .pending {
    margin-top: 4px;
    font-size: 16px;
    opacity: 0.5;
  }

  .legend {
    display: flex;
    justify-content: center;
    gap: 18px;
    margin-top: 24px;
    padding-top: 20px;
    border-top: 1.5px solid #f0f0f0;
    flex-wrap: wrap;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
    font-weight: 500;
    color: #374151;
  }

  .legend-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
  }

  .footer {
    text-align: center;
    margin-top: 20px;
    color: #9ca3af;
    font-size: 12px;
    letter-spacing: 0.3px;
  }

  @media (max-width: 600px) {
    body {
      padding: 12px;
    }

    .calendar {
      padding: 16px 12px 18px;
      border-radius: 16px;
    }

    .header {
      padding: 14px 16px;
      border-radius: 12px;
    }

    .header h1 {
      font-size: 20px;
    }

    .header h2 {
      font-size: 14px;
    }

    table {
      border-spacing: 3px;
    }

    td {
      height: 60px;
      padding: 4px 2px;
      border-radius: 8px;
    }

    .day-number {
      font-size: 13px;
    }

    .person-badge {
      font-size: 9px;
      padding: 2px 7px;
      margin-top: 2px;
    }

    .legend {
      gap: 10px;
      padding-top: 14px;
      margin-top: 16px;
    }

    .legend-item {
      font-size: 11px;
      gap: 5px;
    }

    .legend-dot {
      width: 10px;
      height: 10px;
    }

    th {
      font-size: 10px;
      padding: 4px 0;
    }
  }
</style>
</head>
<body>
  <div class="calendar">
    <div class="header">
      <h1>🏠 Family Rotation</h1>
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
//  PDF GENERATION USING HTML-PDF (NO CHROME NEEDED!)
// ============================================================

async function renderPDF(month, year, schedule) {
  const html = generateCalendarHTML(month, year, schedule);
  
  return new Promise((resolve, reject) => {
    pdf.create(html, {
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20px',
        bottom: '20px',
        left: '20px',
        right: '20px'
      }
    }).toBuffer((err, buffer) => {
      if (err) {
        console.error('❌ PDF generation error:', err.message);
        reject(err);
      } else {
        resolve(buffer);
      }
    });
  });
}

// ============================================================
//  SEND PDF ONLY (NO TEXT)
// ============================================================

async function sendPDFToAll(month, year, pdfBuffer) {
  const filename = `schedule_${month}_${year}.pdf`;
  const tmpPath = path.join('.', filename);

  try {
    fs.writeFileSync(tmpPath, pdfBuffer);
    const base64 = fs.readFileSync(tmpPath).toString('base64');
    const media = new MessageMedia('application/pdf', base64, filename);
    return await sendMediaToAll(media, `📅 ${MONTH_NAMES[month - 1]} ${year} Family Rotation Schedule`);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

// ============================================================
//  GET NEXT MONTH
// ============================================================

function getNextMonthYear() {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  
  let nextMonth = currentMonth + 1;
  let nextYear = currentYear;
  
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear = currentYear + 1;
  }
  
  return { month: nextMonth, year: nextYear };
}

// ============================================================
//  MAIN SEND FLOW - PDF ONLY
// ============================================================

async function sendScheduleFor(month, year) {
  console.log(`📅 Generating PDF for ${MONTH_NAMES[month - 1]} ${year}...`);

  if (!isReady) {
    console.log('⏳ WhatsApp not ready yet. 📌 PDF queued - will send when WhatsApp connects');
    pendingSend = { month, year };
    return;
  }

  try {
    const schedule = generateSchedule(month, year);
    const pdfBuffer = await renderPDF(month, year, schedule);
    
    console.log('📤 Sending PDF...');
    await sendPDFToAll(month, year, pdfBuffer);
    
    console.log('✅ PDF sent successfully!');
  } catch (error) {
    console.error('❌ Error sending PDF:', error.message);
  }
}

// ============================================================
//  ONE-TIME SCHEDULED SEND
// ============================================================

let oneTimeScheduled = false;

function scheduleOneTimeSend() {
  if (oneTimeScheduled) return;
  
  const sendAt = process.env.SEND_AT;
  
  if (sendAt) {
    const targetDate = new Date(sendAt);
    if (Number.isNaN(targetDate.getTime())) {
      console.log(`⚠️  Invalid SEND_AT value: "${sendAt}"`);
      console.log('📤 Will send next month PDF on startup instead...');
      oneTimeScheduled = true;
      const { month, year } = getNextMonthYear();
      sendScheduleFor(month, year);
      return;
    }

    const delay = targetDate.getTime() - Date.now();
    
    if (delay > 0) {
      console.log(`⏰ One-time PDF scheduled for: ${targetDate.toLocaleString()}`);
      const { month, year } = getNextMonthYear();
      console.log(`📅 Will send ${MONTH_NAMES[month - 1]} ${year} PDF`);
      oneTimeScheduled = true;
      
      setTimeout(async () => {
        console.log(`📤 Sending scheduled ${MONTH_NAMES[month - 1]} ${year} PDF...`);
        await sendScheduleFor(month, year);
        console.log('📌 PDF queued - will send when WhatsApp connects');
      }, delay);
      return;
    } else {
      console.log('⏰ SEND_AT already passed — sending next month PDF now...');
    }
  } else {
    console.log('📤 No SEND_AT set. Will send next month PDF on startup when WhatsApp is ready...');
  }
  
  oneTimeScheduled = true;
  const { month, year } = getNextMonthYear();
  sendScheduleFor(month, year);
}

// ============================================================
//  MONTHLY SCHEDULER - Send on 9th at 8 PM
// ============================================================

// cron.schedule(
//   '0 20 9 * *',
//   async () => {
//     const { month, year } = getNextMonthYear();
//     console.log(`📅 Monthly job: sending ${MONTH_NAMES[month - 1]} ${year} PDF at 8 PM`);
//     await sendScheduleFor(month, year);
//   },
//   { timezone: TIMEZONE }
// );

cron.schedule(
  '14 19 14 7 *'  // July 14 at 7:14 PM (19:14)
  // '0 19 14 7 *',  // July 14 at 7:00 PM (19:00)
  async () => {
    const { month, year } = getNextMonthYear();
    console.log(`📅 Monthly job: sending ${MONTH_NAMES[month - 1]} ${year} PDF at 7 PM`);
    await sendScheduleFor(month, year);
  },
  { timezone: TIMEZONE }
);

console.log(`⏰ Monthly send scheduled: "0 19 11 7 *" (${TIMEZONE}) - Sends next month's PDF on the 9th at 8 PM`);

// ============================================================
//  API ROUTES
// ============================================================

// Root route
app.get('/', (req, res) => {
  res.json({
    message: '🏠 Family Rotation Automation API is running!',
    status: 'healthy',
    whatsappReady: isReady,
    endpoints: {
      health: '/api/health',
      qr: '/api/qr',
      preview: '/api/schedule/preview',
      send: '/api/schedule/send (POST)'
    }
  });
});

// QR Code route - View QR in browser
app.get('/api/qr', (req, res) => {
  if (!currentQR) {
    return res.send(`
      <html>
        <head><title>QR Code</title></head>
        <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:Arial;">
          <div style="text-align:center;">
            <h2>⏳ No QR Code Available</h2>
            <p>Waiting for WhatsApp to generate QR code...</p>
            <p>Check the Render logs or refresh in a few seconds.</p>
          </div>
        </body>
      </html>
    `);
  }
  
  res.send(`
    <html>
      <head>
        <title>Scan QR Code</title>
        <style>
          body {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            flex-direction: column;
            font-family: Arial, sans-serif;
            background: #f0f2f5;
            margin: 0;
          }
          .container {
            background: white;
            padding: 40px;
            border-radius: 16px;
            box-shadow: 0 4px 24px rgba(0,0,0,0.1);
            text-align: center;
            max-width: 400px;
          }
          img {
            width: 280px;
            height: 280px;
            border-radius: 8px;
          }
          h1 { color: #1f2937; font-size: 24px; }
          p { color: #6b7280; font-size: 14px; }
          .steps {
            text-align: left;
            margin: 16px 0;
            color: #374151;
            font-size: 13px;
            line-height: 1.6;
          }
          .status {
            color: #10b981;
            font-weight: 600;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>📱 Scan with WhatsApp</h1>
          <p class="status">✅ QR Code Ready</p>
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(currentQR)}" />
          <div class="steps">
            <p><strong>1.</strong> Open WhatsApp on your phone</p>
            <p><strong>2.</strong> Settings → Linked Devices → Link a Device</p>
            <p><strong>3.</strong> Scan the QR code above</p>
          </div>
          <p style="font-size:12px;color:#9ca3af;">After scanning, wait for "WhatsApp READY!" in logs</p>
        </div>
      </body>
    </html>
  `);
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

app.post('/api/schedule/send', async (req, res) => {
  try {
    const { month, year } = req.body || {};
    const m = Number(month) || DEFAULT_SEND_MONTH;
    const y = Number(year) || DEFAULT_SEND_YEAR;

    await sendScheduleFor(m, y);

    res.json({
      success: true,
      message: `PDF sent to ${PHONE_NUMBERS.length} number(s)`,
      month: m,
      year: y,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/schedule/preview', (req, res) => {
  const m = Number(req.query.month) || DEFAULT_SEND_MONTH;
  const y = Number(req.query.year) || DEFAULT_SEND_YEAR;
  const schedule = generateSchedule(m, y);
  res.send(generateCalendarHTML(m, y, schedule));
});

// ============================================================
//  START SERVER
// ============================================================

app.listen(PORT,'0.0.0.0', () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📱 Configured ${PHONE_NUMBERS.length} phone number(s)`);
  console.log(`👀 Preview the calendar at /api/schedule/preview`);
  console.log(`📱 Scan QR at /api/qr`);
  const { month, year } = getNextMonthYear();
  console.log(`\n📤 Will send ${MONTH_NAMES[month - 1]} ${year} PDF on the 9th of each month at 8 PM`);
  console.log(`   (or when WhatsApp connects if scheduled time has passed)`);
  console.log(`📄 Using html-pdf - NO Chrome required!\n`);
  setTimeout(initWhatsApp, 2000);
  scheduleOneTimeSend();
});
