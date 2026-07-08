require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const PHONE_NUMBERS = [
  process.env.PHONE_1,
  process.env.PHONE_2,
  process.env.PHONE_3,
  process.env.PHONE_4
].filter(Boolean);

const MESSAGE = process.env.MESSAGE || '🏠 Family Rotation Schedule!';
const IMAGE_URL = process.env.IMAGE_URL || null;

console.log(`📤 Sending to ${PHONE_NUMBERS.length} numbers`);

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', (qr) => {
  console.log('\n📱 SCAN QR CODE:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('✅ Ready! Sending...\n');
  
  for (const phone of PHONE_NUMBERS) {
    try {
      const formatted = phone.replace('+', '') + '@c.us';
      
      await client.sendMessage(formatted, MESSAGE);
      console.log(`✅ Sent to ${phone}`);
      
      if (IMAGE_URL) {
        await client.sendMessage(formatted, {
          image: { url: IMAGE_URL },
          caption: '📅 Your schedule'
        });
        console.log(`🖼️ Image sent to ${phone}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`❌ Error:`, error.message);
    }
  }
  
  console.log('\n✅ All done!');
  process.exit(0);
});

client.initialize();