require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

const PHONE_NUMBERS = [
  process.env.PHONE_1,
  process.env.PHONE_2,
  process.env.PHONE_3,
  process.env.PHONE_4
].filter(Boolean);

// ============ ROTATION LOGIC ============
const members = ["Fathi", "Mejda", "Fouziya", "Hamza"];
const startDate = new Date(2026, 5, 30);

function getPersonForDate(date) {
  const diff = Math.floor((date - startDate) / (24 * 60 * 60 * 1000));
  if (diff < 0) return 'Not started';
  const block = Math.floor(diff / 3);
  return members[block % members.length];
}

function generateSchedule(month, year) {
  const daysInMonth = new Date(year, month - 1, 0).getDate();
  const schedule = {};
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month - 1, day);
    schedule[day] = getPersonForDate(date);
  }
  return schedule;
}

function formatScheduleMessage(month, year, schedule) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  
  let msg = `🏠 *FAMILY ROTATION SCHEDULE*\n`;
  msg += `📅 ${months[month-1]} ${year}\n\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  const grouped = {};
  Object.entries(schedule).forEach(([day, person]) => {
    if (person !== 'Not started') {
      if (!grouped[person]) grouped[person] = [];
      grouped[person].push(day);
    }
  });
  
  for (const [person, days] of Object.entries(grouped)) {
    msg += `👤 *${person}*\n`;
    msg += `📆 Days: ${days.join(', ')}\n\n`;
  }
  
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📱 Auto-generated`;
  return msg;
}

// ============ SEND ============
const now = new Date();
const month = now.getMonth() + 1;
const year = now.getFullYear();

console.log(`📅 Generating schedule for ${month}/${year}`);
const schedule = generateSchedule(month, year);
const message = formatScheduleMessage(month, year, schedule);

console.log('📤 Message prepared:');
console.log(message);
console.log('\n');

// ============ WHATSAPP ============
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', (qr) => {
  console.log('📱 Scan QR:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('✅ WhatsApp Ready! Sending...\n');
  
  for (const phone of PHONE_NUMBERS) {
    try {
      const formatted = phone.replace('+', '') + '@c.us';
      await client.sendMessage(formatted, message);
      console.log(`✅ Sent to ${phone}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`❌ Error:`, error.message);
    }
  }
  
  console.log('\n✅ All sent!');
  process.exit(0);
});

client.initialize();