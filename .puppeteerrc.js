// const { join } = require('path');

// /**
//  * @type {import("puppeteer").Configuration}
//  */
// module.exports = {
//   // Use absolute path
//   cacheDirectory: join('/opt/render/project/src', '.cache', 'puppeteer'),
// };



const { join } = require('path');

module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
