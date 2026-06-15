'use strict';

function add(left, right) {
  return left + right;
}

function divide(left, right) {
  if (right === 0) {
    throw new Error('division by zero');
  }
  return left / right;
}

function classifyScore(score) {
  if (score >= 90) return 'excellent';
  if (score >= 70) return 'ok';
  return 'needs-work';
}

module.exports = {
  add,
  classifyScore,
  divide,
};
