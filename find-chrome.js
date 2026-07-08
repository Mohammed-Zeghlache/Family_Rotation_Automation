const fs = require('fs');
const { execSync } = require('child_process');

console.log('🔍 Searching for Chrome...');

// Try common paths
const paths = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
  '/usr/bin/chrome',
];

for (const p of paths) {
  if (fs.existsSync(p)) {
    console.log(`✅ Found Chrome at: ${p}`);
    try {
      const version = execSync(`${p} --version`).toString();
      console.log(`   Version: ${version.trim()}`);
    } catch (e) {}
  }
}

console.log('\n🔍 Checking which command exists...');
try {
  const which = execSync('which google-chrome || which google-chrome-stable || which chromium || which chromium-browser').toString();
  console.log(`✅ 'which' found: ${which.trim()}`);
} catch (e) {
  console.log('❌ No Chrome found in PATH');
}
