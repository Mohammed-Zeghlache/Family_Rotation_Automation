require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');

const PHONE_NUMBERS = [
  process.env.PHONE_1,
  process.env.PHONE_2,
  process.env.PHONE_3,
  process.env.PHONE_4
].filter(Boolean);

// Local image path
const IMAGE_PATH = path.join(__dirname, 'schedule.png');
const CAPTION = '📅 Family Rotation Schedule';

console.log(`🖼️ Sending image: ${IMAGE_PATH}`);

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
  console.log('✅ Ready! Sending...\n');
  
  for (const phone of PHONE_NUMBERS) {
    try {
      const formatted = phone.replace('+', '') + '@c.us';
      
      // Send local image
      await client.sendMessage(formatted, {
        image: { path: IMAGE_PATH },
        caption: CAPTION
      });
      
      console.log(`✅ Image sent to ${phone}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`❌ Error:`, error.message);
    }
  }
  
  console.log('\n✅ All done!');
  process.exit(0);
});

client.initialize();