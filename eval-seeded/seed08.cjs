const crypto = require('node:crypto');
module.exports = () => crypto.randomBytes(16).toString('hex');
