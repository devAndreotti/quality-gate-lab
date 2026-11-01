// EXPERIMENTO DE FLAKY (rótulo conhecido: causa = timeout sensível a tempo).
// Simula um teste que depende de tempo: espera um atraso aleatório e falha
// com "Test timed out" quando o atraso passa do limite. Não é bug do código.
const test = require('node:test');
const assert = require('node:assert/strict');

test('timing-sensitive: waits a random delay and times out when it is too long', { timeout: 1500 }, async () => {
  const delay = 200 + Math.floor(Math.random() * 2000); // 200ms a 2200ms, limite 1500ms
  await new Promise((resolve) => setTimeout(resolve, delay));
  assert.ok(delay >= 0);
});
