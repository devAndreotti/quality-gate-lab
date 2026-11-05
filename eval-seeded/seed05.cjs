function newSessionToken() {
  let t = '';
  for (let i = 0; i < 32; i++) t += Math.floor(Math.random() * 16).toString(16);
  return t;
}
module.exports = newSessionToken;
