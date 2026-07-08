require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const PHONE_NUMBERS = [
  process.env.PHONE_1,
  process.env.PHONE_2,
  process.env.PHONE_3,
  process.env.PHONE_4
].filter(Boolean);

// Your image URL or local path
const IMAGE_PATH = './schedule.png'; // Local file
// OR
const IMAGE_URL = 'https://via.placeholder.com/800x400/FF7E33/FFFFFF?text=Family+Schedule';

const CAPTION = '📅 Family Rotation Schedule';

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
  console.log('✅ Ready! Sending images...\n');
  
  for (const phone of PHONE_NUMBERS) {
    try {
      const formatted = phone.replace('+', '') + '@c.us';
      
      // Send image from URL or local file
      await client.sendMessage(formatted, {
        image: { url: IMAGE_URL },
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