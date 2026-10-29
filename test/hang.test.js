// Cenário de stress: timer aberto mantém o processo vivo. Sem timeout de job,
// o CI espera até o limite padrão do GitHub. Esperado: o passo de testes morre
// em 10 min com mensagem de timeout, e os demais jobs não ficam presos.
const test = require('node:test');
test('leaves a timer open', () => {
  setInterval(() => {}, 1000);
});
