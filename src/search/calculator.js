'use strict';

/**
 * A small, safe expression evaluator for the instant-answer calculator.
 *
 * Deliberately avoids `eval` / `new Function`: the string comes straight from
 * the omnibox, so it must be parsed, never executed. The grammar is a plain
 * recursive-descent parser with the usual precedence rules.
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '%' | 'x' | '÷' | '×') unary)*
 *   unary   := ('-' | '+') unary | power
 *   power   := postfix ('^' unary)?          // right associative
 *   postfix := primary ('%' | '!')?
 *   primary := number | constant | func '(' expr ')' | '(' expr ')'
 */

const CONSTANTS = {
  pi: Math.PI,
  π: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
  τ: Math.PI * 2,
};

const FUNCTIONS = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log10: Math.log10,
  log2: Math.log2,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sign: Math.sign,
  round: (n) => Math.round(n),
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  min: (...args) => Math.min(...args),
  max: (...args) => Math.max(...args),
  pow: (a, b) => a ** b,
  hypot: (...args) => Math.hypot(...args),
};

const CONST_FUNCTION_ARGS = { min: 2, max: 2, pow: 2, hypot: 1 };

class CalcError extends Error {}

function tokenize(input) {
  const tokens = [];
  let i = 0;

  const isDigit = (c) => c >= '0' && c <= '9';
  const isIdentStart = (c) => /[a-zA-Zπτ_]/i.test(c);
  const isIdent = (c) => /[a-zA-Z0-9πτ_]/i.test(c);

  while (i < input.length) {
    const c = input[i];

    if (c === ' ' || c === '\t' || c === '\n') {
      i += 1;
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(input[i + 1]))) {
      let num = '';
      while (i < input.length && (isDigit(input[i]) || input[i] === '.')) {
        num += input[i];
        i += 1;
      }
      if (input[i] === 'e' || input[i] === 'E') {
        const save = i;
        let exp = input[i];
        i += 1;
        if (input[i] === '+' || input[i] === '-') {
          exp += input[i];
          i += 1;
        }
        if (isDigit(input[i])) {
          while (i < input.length && isDigit(input[i])) {
            exp += input[i];
            i += 1;
          }
          num += exp;
        } else {
          i = save;
        }
      }
      if (num.split('.').length > 2) throw new CalcError('Malformed number');
      tokens.push({ type: 'number', value: parseFloat(num) });
      continue;
    }

    if (isIdentStart(c)) {
      let ident = '';
      while (i < input.length && isIdent(input[i])) {
        ident += input[i];
        i += 1;
      }
      const lower = ident.toLowerCase();
      if (FUNCTIONS[lower]) {
        tokens.push({ type: 'function', value: lower });
      } else if (lower in CONSTANTS) {
        tokens.push({ type: 'number', value: CONSTANTS[lower] });
      } else if (lower === 'ans' || lower === 'answer') {
        tokens.push({ type: 'number', value: 0 });
      } else {
        throw new CalcError(`Unknown name "${ident}"`);
      }
      continue;
    }

    const two = input.slice(i, i + 2);
    if (two === '**') {
      tokens.push({ type: 'op', value: '^' });
      i += 2;
      continue;
    }

    if ('+-*/%^(),!'.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i += 1;
      continue;
    }

    if (c === '×' || c === '·') {
      tokens.push({ type: 'op', value: '*' });
      i += 1;
      continue;
    }
    if (c === '÷' || c === '∕') {
      tokens.push({ type: 'op', value: '/' });
      i += 1;
      continue;
    }
    if (c === '−') {
      tokens.push({ type: 'op', value: '-' });
      i += 1;
      continue;
    }
    if (c === '√') {
      tokens.push({ type: 'function', value: 'sqrt' });
      i += 1;
      continue;
    }

    throw new CalcError(`Unexpected character "${c}"`);
  }

  return tokens;
}

function parse(tokens) {
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (value) => {
    const token = next();
    if (!token || token.value !== value) throw new CalcError(`Expected "${value}"`);
  };
  const isOp = (value) => {
    const token = peek();
    return token && token.type === 'op' && token.value === value;
  };

  function parseExpr() {
    let left = parseTerm();
    while (isOp('+') || isOp('-')) {
      const op = next().value;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = next().value;
      const right = parseUnary();
      if (op === '*') left *= right;
      else if (op === '/') {
        if (right === 0) throw new CalcError('Division by zero');
        left /= right;
      } else {
        if (right === 0) throw new CalcError('Division by zero');
        left %= right;
      }
    }
    return left;
  }

  function parseUnary() {
    if (isOp('-')) {
      next();
      return -parseUnary();
    }
    if (isOp('+')) {
      next();
      return parseUnary();
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePostfix();
    if (isOp('^')) {
      next();
      const exponent = parseUnary(); // right associative
      const result = base ** exponent;
      if (Number.isNaN(result)) throw new CalcError('Invalid exponent');
      return result;
    }
    return base;
  }

  function parsePostfix() {
    let value = parsePrimary();
    // Only the factorial sits after a primary. `%` is a binary modulo
    // operator and `^` is handled by parsePower, so leaving them out here is
    // what keeps `10 % 3` and `2 ^ 10` working.
    while (isOp('!')) {
      next();
      value = factorial(value);
    }
    return value;
  }

  function parsePrimary() {
    const token = next();
    if (!token) throw new CalcError('Unexpected end of expression');

    if (token.type === 'number') return token.value;

    if (token.type === 'function') {
      const name = token.value;
      if (!isOp('(')) throw new CalcError(`Expected "(" after ${name}`);
      next();
      const args = [];
      if (!isOp(')')) {
        args.push(parseExpr());
        // A comma separates arguments; it must be consumed before parsing
        // the next one, otherwise the next parse sees it as a primary.
        while (isOp(',')) {
          next();
          args.push(parseExpr());
        }
      }
      expect(')');
      const minArgs = CONST_FUNCTION_ARGS[name] ?? 1;
      if (args.length < minArgs) throw new CalcError(`${name}() needs ${minArgs} argument(s)`);
      const result = FUNCTIONS[name](...args);
      if (typeof result !== 'number' || Number.isNaN(result)) throw new CalcError(`${name}() is undefined here`);
      return result;
    }

    if (token.type === 'op' && token.value === '(') {
      const value = parseExpr();
      expect(')');
      return value;
    }

    throw new CalcError('Malformed expression');
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new CalcError('Trailing characters');
  return result;
}

function factorial(n) {
  if (n < 0 || !Number.isInteger(n)) throw new CalcError('Factorial needs a non-negative integer');
  if (n > 170) throw new CalcError('Factorial is too large');
  let result = 1;
  for (let i = 2; i <= n; i += 1) result *= i;
  return result;
}

/** Strip conversational noise so "what is 5 plus 3" becomes an expression. */
function normalizeExpression(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^(?:what(?:'s| is)|calculate|compute|evaluate|solve|how much is)\s+/i, '');
  text = text.replace(/\?+$/, '');
  text = text.replace(/\s*=\s*$/, '');
  text = text.replace(/\bplus\b/gi, '+');
  text = text.replace(/\bminus\b/gi, '-');
  text = text.replace(/\b(?:times|multiplied by|x)\b/gi, '*');
  text = text.replace(/\b(?:divided by|over)\b/gi, '/');
  text = text.replace(/\b(?:to the power of|power)\b/gi, '^');
  text = text.replace(/\bmodulo\b/gi, '%');
  // "15 percent of 80" and "15% of 80" mean (15/100)*80.
  text = text.replace(/(\d+(?:\.\d+)?)\s*(?:percent|%)\s*of\b/gi, '($1/100)*');
  // The word "percent" is never the modulo operator, so convert it anywhere.
  text = text.replace(/(\d+(?:\.\d+)?)\s*percent\b/gi, '($1/100)');
  // A lone "50%" is 0.5. The `$` anchor keeps `10 % 3` as a modulo.
  text = text.replace(/(\d+(?:\.\d+)?)\s*%(?=\s*$)/g, '($1/100)');
  // Thousands separators ("1,000"), but never a comma that separates
  // function arguments such as min(1,2) or hypot(3,4).
  text = text.replace(/(\d),(?=\d{3}\b)/g, '$1');
  return text.trim();
}

/** Characters that hint the query is arithmetic rather than a web search. */
const MATH_HINT = /[0-9].*[+\-*/^()]|^(?:sqrt|sin|cos|tan|log|ln|pi|exp)\b/i;

/**
 * Try to evaluate a query as a calculation.
 * @returns {{value:number, expression:string, formatted:string}|null}
 */
function evaluate(raw) {
  const expression = normalizeExpression(raw);
  if (!expression) return null;
  if (!MATH_HINT.test(expression) && !/^\d/.test(expression)) return null;
  // Only attempt expressions that contain no letters other than function names.
  if (!/^[\d\s+\-*/%^(),!.\wπτ]*$/.test(expression)) return null;

  try {
    const value = parse(tokenize(expression));
    if (!Number.isFinite(value)) return null;
    return {
      value,
      expression,
      formatted: formatNumber(value),
    };
  } catch {
    return null;
  }
}

/** Render a number the way a calculator should: no trailing ".0000001". */
function formatNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-6 || abs >= 1e15)) {
    return value.toExponential(6).replace(/e([+-])(\d)$/, 'e$10$2');
  }
  const rounded = Number(value.toPrecision(12));
  return String(rounded);
}

module.exports = { evaluate, formatNumber, normalizeExpression, CalcError, CONSTANTS, FUNCTIONS };
