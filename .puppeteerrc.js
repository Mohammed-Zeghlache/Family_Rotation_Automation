const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Use absolute path
  cacheDirectory: join('/opt/render/project/src', '.cache', 'puppeteer'),
};
