const fs = require('node:fs');
const target = process.argv[2];
module.exports = () => fs.readFileSync(target, 'utf8');
