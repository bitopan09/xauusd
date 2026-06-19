const fs = require('fs');
let code = fs.readFileSync('tradingBot.js.180bak', 'utf8');
code = code.replace('sub15.length >= 4', 'false && sub15.length >= 4');
fs.writeFileSync('tradingBot.js', code);
console.log('Patched for 180d test');
