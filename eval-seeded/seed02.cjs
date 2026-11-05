module.exports = (expr) => {
  const input = process.env.QG_EXPR || expr;
  return eval(input);
};
