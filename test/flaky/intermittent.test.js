// EXPERIMENTO DE FLAKY (rótulo conhecido: causa = timeout sensível a tempo).
// Simula um teste que depende de tempo: espera um atraso aleatório e só passa
// se terminar antes de um prazo fixo. Quando o atraso estoura, a falha é
// "tempo excedido". Não é bug do código.
const test = require("node:test");
const assert = require("node:assert/strict");

const DEADLINE_MS = 1000;

test("timing-sensitive: fails when a random wait overruns a fixed deadline", async () => {
  const started = Date.now();
  const delay = 200 + Math.floor(Math.random() * 1600); // 200 a 1800 ms
  await new Promise((resolve) => setTimeout(resolve, delay));
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed <= DEADLINE_MS,
    `tempo excedido: ${elapsed}ms > ${DEADLINE_MS}ms (causa: timeout sensível a tempo)`,
  );
});
