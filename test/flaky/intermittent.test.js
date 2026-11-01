// EXPERIMENTO DE FLAKY (rótulo conhecido, não é bug).
// Falha em rodadas ímpares e passa em pares, usando um contador em arquivo.
// Serve para gerar runs de instabilidade com log completo e rótulo "flaky" por construção.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const counter = path.join(__dirname, '.run-counter');
test('intermittent: fails on odd runs, passes on even runs', () => {
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
  fs.writeFileSync(counter, String(n));
  assert.equal(n % 2, 0, `run ${n}: falha intermitente intencional`);
});
