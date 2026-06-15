'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  add,
  classifyScore,
  divide,
} = require('../src/calculator');

test('add sums two numbers', () => {
  assert.equal(add(2, 3), 5);
});

test('divide returns quotient', () => {
  assert.equal(divide(8, 2), 4);
});

test('divide rejects zero divisor', () => {
  assert.throws(() => divide(1, 0), /division by zero/);
});

test('classifyScore maps boundaries', () => {
  assert.equal(classifyScore(95), 'excellent');
  assert.equal(classifyScore(70), 'ok');
  assert.equal(classifyScore(30), 'needs-work');
});
