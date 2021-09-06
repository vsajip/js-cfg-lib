/*!
 * A test harness for the library for working with the CFG configuration format.
 *
 * @author   Vinay Sajip <http://vinay_sajip@yahoo.co.uk>
 * @copyright (C) 2020 Vinay Sajip. See LICENSE for licensing information.
 * @license  BSD-3-Clause
 * @see https://docs.red-dove.com/cfg/
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const stream = require('stream');

const Complex = require('complex.js');
const _ = require('lodash');

const chai = require('chai');
const {
  expect,
  assert
} = chai;
const chaiAlmost = require('chai-almost');
chai.use(chaiAlmost(1.0e-7));

const config = require('./config');
const {
  Location,
  Tokenizer,
  Token,
  Parser,
  TokenKind,
  UnaryNode,
  BinaryNode,
  SliceNode,
  ListNode,
  MappingNode,
  ASTNode,
  Config,
  // ConfigException,
  InvalidPathException,
  // BadIndexException,
  // CircularReferenceException,
  makeStream,
  makeFileStream,
  makeParser,
  parse,
  isIdentifier,
  parsePath,
  pathIterator,
  toSource,
  tokenRepr
} = config;

function makeTokenizer(s) {
  return new Tokenizer(makeStream(s));
}

function compareLocs(loc1, loc2) {
  expect(loc1).to.eql(loc2);
}

function compareObjects(o1, o2, ctx) {
  if (ctx === undefined) {
    ctx = '';
  } else {
    ctx = ` at ${ctx}`;
  }
  if (!_.isEqual(o1, o2)) {
    console.log('about to fail:');
  }
  // assert(_.isEqual(o1, o2), `not the same${ctx}: ${o1} !== ${o2}`);
  assert.deepEqual(o1, o2, `not the same${ctx}: ${o1} !== ${o2}`);
}

function compareArrays(a1, a2) {
  expect(a1.length).to.equal(a2.length);
  for (let i = 0; i < a1.length; i++) {
    compareObjects(a1[i], a2[i], i);
  }
}

function dataFilePath(name) {
  let d = path.join(process.cwd(), 'resources')

  return path.join(d, name);
}

function collectTokens(tokenizer) {
  let result = [];

  while (true) {
    let t = tokenizer.getToken();

    result.push(t);
    if (t.kind === TokenKind.EOF) {
      break;
    }
  }
  return result;
}

function makeToken(k, t, v, sl, sc, el, ec) {
  let result = new Token(k, t, v);

  result.start.line = sl;
  result.start.column = sc;
  result.end.line = el;
  result.end.column = ec;
  return result;
}

function W(s, sl, sc) {
  const ec = sc + s.length - 1;

  return makeToken(TokenKind.WORD, s, s, sl, sc, sl, ec);
}

function T(k, s, v, sl, sc) {
  let el, ec;

  if (k === TokenKind.NEWLINE) {
    el = sl + 1;
    ec = 0;
  }
  else {
    el = sl;
    ec = sc + s.length - 1;
  }

  return makeToken(k, s, v, sl, sc, el, ec);
}

const SEPARATOR_PATTERN = /^-- ([A-Z]\d+) -+/;

function loadData(path, resolver) {
  let result = {};
  let f = fs.createReadStream(path);
  let reader = readline.createInterface({
    input: f
  });
  let key = null;
  let value = [];

  function process_line(line) {
    let m = line.match(SEPARATOR_PATTERN);

    if (m === null) {
      value.push(line);
    } else {
      if ((key !== null) && (value.length > 0)) {
        result[key] = value.join('\n');
      }
      key = m[1];
      value.length = 0;
    }
  }

  let p = new Promise((resolve) => {
    reader.on('line', process_line);
    reader.on('close', function () {
      resolve(result);
    });
  });
  p.then(function (result) {
    resolver(result);
  });
}

/*
function open_file(path, resolver) {
  let f = fs.createReadStream(path, {
    encoding: 'utf-8'
  });
  let p = new Promise((resolve) => {
    f.on('readable', function () {
      resolve(f);
    });
  });
  p.then(function (f) {
    resolver(f);
  });
}
 */

function checkTokens(tokenizer, expected) {
  let i = 0;
  let n = expected.length;

  while (true) {
    let t = tokenizer.getToken();
    assert.isAtMost(i, n - 1, `more tokens than expected: ${t} [${t.start} - ${t.end}]`);
    let e = expected[i++];

    let sp = new Location(e[0], e[1]);
    let ep = new Location(e[2], e[3]);

    compareObjects(t.start, sp, i);
    compareObjects(t.end, ep, i);
    if (t.kind == TokenKind.EOF) {
      break;
    }
  }
}

describe('Location', function () {
  it('should have correct defaults', function () {
    var loc = new Location();
    expect(loc.line).to.equal(1);
    expect(loc.column).to.equal(1);
  });
  it('should move to next line', function () {
    let loc = new Location();
    loc.next_line();
    expect(loc.line).to.equal(2);
    expect(loc.column).to.equal(1);
    loc.line = 3;
    loc.column = 20;
    loc.next_line();
    expect(loc.line).to.equal(4);
    expect(loc.column).to.equal(1);
  });
});

describe('Tokenizer', function () {
  it('should handle atEnd', function () {
    let t = new Tokenizer(makeStream(''));

    expect(t.atEnd()).to.equal(false);
    let c = t.getChar();
    expect(c).to.equal(null);
    expect(t.atEnd()).to.equal(true);
  });

  it('should handle empty input', function () {
    let tokenizer = makeTokenizer('');
    let t = tokenizer.getToken();
    expect(t.kind).to.equal(TokenKind.EOF);
    t = tokenizer.getToken();
    expect(t.kind).to.equal(TokenKind.EOF);
  });

  it('should handle comments', function () {
    let cases = ['# a comment\n', '# another comment', '# yet another comment\r'];

    cases.forEach(function (c) {
      let tokenizer = makeTokenizer(c);
      let t = tokenizer.getToken();
      expect(t.kind).to.equal(TokenKind.NEWLINE);
      expect(t.text).to.equal(c.trim());
      t = tokenizer.getToken();
      expect(t.kind).to.equal(TokenKind.EOF);
    });
  });

  it('should handle identifiers', function () {
    let cases = ['foo',
      '\u0935\u092e\u0938',
      '\u00e9', '\u00c8',
      '\uc548\ub155\ud558\uc138\uc694',
      '\u3055\u3088\u306a\u3089',
      '\u3042\u308a\u304c\u3068\u3046',
      '\u0425\u043e\u0440\u043e\u0448\u043e',
      '\u0441\u043f\u0430\u0441\u0438\u0431\u043e',
      '\u73b0\u4ee3\u6c49\u8bed\u5e38\u7528\u5b57\u8868'
    ];

    cases.forEach(function (c) {
      let tokenizer = makeTokenizer(c);
      let t = tokenizer.getToken();
      expect(t.kind).to.equal(TokenKind.WORD);
      expect(t.text).to.equal(c);
      t = tokenizer.getToken();
      expect(t.kind).to.equal(TokenKind.EOF);
    });
  });

  it('should handle string literals', function () {
    let cases = [
      ["'foo'", 'foo'],
      ['"bar"', 'bar'],
      ['"""abc\ndef\n"""', 'abc\ndef\n'],
      ['"\\n"', '\n']
    ];

    cases.forEach(function (c) {
      let tokenizer = makeTokenizer(c[0]);
      let t = tokenizer.getToken();
      expect(t.kind).to.equal(TokenKind.STRING);
      expect(t.text).to.equal(c[0]);
      expect(t.value).to.equal(c[1]);
      t = tokenizer.getToken();
      expect(t.kind).to.equal(TokenKind.EOF);
    });
  });

  it('should handle empty string literals', function () {
    let cases = [
      ["''", 1, 2],
      ['""', 1, 2],
      ["''''''", 1, 6],
      ['""""""', 1, 6]
    ];

    cases.forEach(function (c) {
      let tokenizer = makeTokenizer(c[0]);
      let t = tokenizer.getToken();
      expect(t.kind).to.equal(TokenKind.STRING);
      expect(t.text).to.equal(c[0]);
      expect(t.value).to.equal('');
      compareLocs(t.end, new Location(c[1], c[2]));
      t = tokenizer.getToken();
      expect(t.kind).to.equal(TokenKind.EOF);
    });
  });

  it('should handle float literals', function () {
    let cases = [
      ['2.71828'],
      ['.5'],
      ['-.5'],
      ['1e8'],
      ['1e-8'],
      ['-4e8'],
      ['-3e-8']
    ];

    cases.forEach(function (c) {
      let tokenizer = makeTokenizer(c[0]);
      let t = tokenizer.getToken();
      expect(t.kind).to.equal(TokenKind.FLOAT);
      expect(t.text).to.equal(c[0]);
      expect(t.value).to.equal(c[1] || parseFloat(c[0]));
      t = tokenizer.getToken();
      expect(t.kind).to.equal(TokenKind.EOF);
    });
  });

  it('should handle complex literals', function () {
    let cases = [
      ['4.3j', new Complex(0, 4.3)]
    ];

    cases.forEach(function (c) {
      let tokenizer = makeTokenizer(c[0]);
      let t = tokenizer.getToken();

      expect(t.value).to.eql(c[1]);
    });
  });

  it('should handle integer literals', function () {
    let cases = [
      ['0x123aBc', 0x123abc],
      ['0o123', 83],
      ['0123', 83],
      ['0b0001_0110_0111', 0x167]
    ];

    cases.forEach(function (c) {
      let tokenizer = makeTokenizer(c[0]);
      let t = tokenizer.getToken();
      expect(t.kind).to.equal(TokenKind.INTEGER);
      expect(t.text).to.equal(c[0]);
      expect(t.value).to.equal(c[1] || parseFloat(c[0]), `failed for ${c[0]}`);
      t = tokenizer.getToken();
      expect(t.kind).to.equal(TokenKind.EOF);
    });
  });

  it('should handle punctuation', function () {
    let s = '< > { } [ ] ( ) + - * / ** // % . <= <> << >= >> == != , : @ ~ & | ^ $ && ||';
    let tokenizer = makeTokenizer(s);
    let tokens = collectTokens(tokenizer);
    let kinds = tokens.map(t => t.kind);
    let expected = [TokenKind.LT, TokenKind.GT, TokenKind.LCURLY, TokenKind.RCURLY,
      TokenKind.LBRACK, TokenKind.RBRACK, TokenKind.LPAREN, TokenKind.RPAREN,
      TokenKind.PLUS, TokenKind.MINUS, TokenKind.STAR, TokenKind.SLASH,
      TokenKind.POWER, TokenKind.SLASHSLASH, TokenKind.MODULO, TokenKind.DOT,
      TokenKind.LE, TokenKind.ALT_NEQ, TokenKind.LSHIFT, TokenKind.GE,
      TokenKind.RSHIFT, TokenKind.EQ, TokenKind.NEQ, TokenKind.COMMA,
      TokenKind.COLON, TokenKind.AT, TokenKind.TILDE, TokenKind.BITAND,
      TokenKind.BITOR, TokenKind.BITXOR, TokenKind.DOLLAR, TokenKind.AND,
      TokenKind.OR, TokenKind.EOF
    ];
    expect(kinds).to.eql(expected);
    let texts = tokens.map(t => t.text);
    expected = s.split(' ');
    expected.push('');
    expect(texts).to.eql(expected);
  });

  it('should handle keywords', function () {
    let s = 'true false null is in not and or';
    let tokens = [];
    let tokenizer = makeTokenizer(s);

    while (true) {
      let t = tokenizer.getToken();

      tokens.push(t);
      if (t.kind === TokenKind.EOF) {
        break;
      }
    }
    let kinds = tokens.map(t => t.kind);
    let expected = [TokenKind.TRUE, TokenKind.FALSE, TokenKind.NONE, TokenKind.IS,
      TokenKind.IN, TokenKind.NOT, TokenKind.AND, TokenKind.OR,
      TokenKind.EOF
    ];

    expect(kinds).to.eql(expected);
    let texts = tokens.map(t => t.text);
    expected = s.split(' ');
    expected.push('');
    expect(texts).to.eql(expected);
  });

  it('should handle examples in data', function () {
    const dp = dataFilePath('testdata.txt');
    const expected = {
      'C16': [
        W('test', 1, 1),
        makeToken(TokenKind.COLON, ':', undefined, 1, 6, 1, 6),
        makeToken(TokenKind.FALSE, "false", false, 1, 8, 1, 12),
        makeToken(TokenKind.NEWLINE, '\n', undefined, 1, 13, 2, 0),
        W('another_test', 2, 1),
        makeToken(TokenKind.COLON, ':', undefined, 2, 13, 2, 13),
        makeToken(TokenKind.TRUE, "true", true, 2, 15, 2, 18),
        makeToken(TokenKind.EOF, '', undefined, 2, 19, 2, 19)
      ],
      'C17': [
        makeToken(TokenKind.WORD, 'test', 'test', 1, 1, 1, 4),
        makeToken(TokenKind.COLON, ':', undefined, 1, 6, 1, 6),
        makeToken(TokenKind.NONE, 'null', null, 1, 8, 1, 11),
        makeToken(TokenKind.EOF, '', undefined, 1, 12, 1, 12)
      ],
      'C25': [
        makeToken(TokenKind.WORD, 'unicode', 'unicode', 1, 1, 1, 7),
        makeToken(TokenKind.ASSIGN, '=', undefined, 1, 9, 1, 9),
        makeToken(TokenKind.STRING, "'Grüß Gott'", 'Grüß Gott', 1, 11, 1, 21),
        makeToken(TokenKind.NEWLINE, '\n', undefined, 1, 22, 2, 0),
        makeToken(TokenKind.WORD, 'more_unicode', 'more_unicode', 2, 1, 2, 12),
        makeToken(TokenKind.COLON, ':', undefined, 2, 13, 2, 13),
        makeToken(TokenKind.STRING, "'Øresund'", 'Øresund', 2, 15, 2, 23),
        makeToken(TokenKind.EOF, '', undefined, 2, 24, 2, 24)
      ]
    }
    loadData(dp, function (data) {
      let keys = Object.keys(data);

      keys.sort();
      keys.forEach(function (key) {
        if (key in expected) {
          const tokenizer = makeTokenizer(data[key]);
          const tokens = collectTokens(tokenizer);

          compareArrays(tokens, expected[key]);
        }
      });
    });
  });

  it('should handle locations', function () {
    let dp = dataFilePath('pos.forms.cfg.txt');
    let f = fs.createReadStream(dp);
    let reader = readline.createInterface({
      input: f
    });
    let positions = [];

    function process_line(line) {
      let parts = line.split(' ');
      // can't just pass in parseInt, as the other callback args shouldn't be forwarded
      let ints = parts.map(function (s) {
        return parseInt(s);
      });
      positions.push(ints);
    }

    let p = new Promise((resolve) => {
      reader.on('line', process_line);
      reader.on('close', function () {
        resolve(positions);
      });
    });
    p.then(function (expected) {
      let dp = dataFilePath('forms.cfg');
      let f = makeFileStream(dp);
      let tokenizer = new Tokenizer(f);

      checkTokens(tokenizer, expected);
    });
    let s = `# You can have comments anywhere in a configuration.
{
  # You can have standard JSON-like key-value mapping.
  "writer": "Oscar Fingal O'Flahertie Wills Wilde",
  # But also use single-quotes for keys and values.
  'a dimension': 'length: 5"',
  # You can use identifiers for the keys.
  string_value: 'a string value',
  integer_value: 3,
  float_value = 2.71828,         # you can use = instead of : as a key-value separator
  boolean_value: true,           # these values are just like in JSON
  opposite_boolean_value: false,
  null_value: null
  list_value: [
    123,
    4.5  # note the absence of a comma - a newline acts as a separator, too.
    [
      1,
      'A',
      2,
      'b',  # note the trailing comma - doesn't cause errors
    ]
  ]  # a comma isn't needed here.
  nested_mapping: {
    integer_as_hex: 0x123
    float_value: .14159,  # note the trailing comma - doesn't cause errors
  } # no comma needed here either.
  # You can use escape sequences ...
  snowman_escaped: '\u2603'
  # or not, and use e.g. utf-8 encoding.
  snowman_unescaped: '☃'
  # You can refer to code points outside the Basic Multilingual Plane
  face_with_tears_of_joy: '\U0001F602'
  unescaped_face_with_tears_of_joy: '😂'
  # Refer to other values in this configuration.
  refer_1: \${string_value},                  # -> 'a string value'
  refer_2: \${list_value[1]},                 # -> 4.5
  refer_3: \${nested_mapping.float_value},    # -> 0.14159
  # Special values are implementation-dependent.
  s_val_1: \`$LANG|en_GB.UTF-8\`               # -> environment var with default
  s_val_2: \`2019-03-28T23:27:04.314159\`      # -> date/time value

  # Expressions.
  # N.B. backslash immediately followed by newline is seen as a continuation:
  pi_approx: \${integer_value} + \
              \${nested_mapping.float_value}   # -> 3.14159
  sept_et_demi: \${integer_value} + \
                \${list_value[1]}             # -> 7.5
}`;
    let sf = makeStream(s);
    let tokenizer = new Tokenizer(sf);
    let expected = [
      [1, 1, 2, 0],
      [2, 1, 2, 1],
      [2, 2, 3, 0],
    ];
    //checkTokens(tokenizer, expected);
  });

  it('should handle bad tokens', function () {
    let bad_numbers = [
      ['9a', 'Invalid character in number', 1, 2],
      ['079', 'Invalid character in number', 1, 1],
      ['0xaBcz', 'Invalid character in number', 1, 6],
      ['0o79', 'Invalid character in number', 1, 4],
      ['.5z', 'Invalid character in number', 1, 3],
      ['0.5.7', 'Invalid character in number', 1, 4],
      [' 0.4e-z', 'Invalid character in number', 1, 7],
      [' 0.4e-8.3', 'Invalid character in number', 1, 8],
      [' 089z', 'Invalid character in number', 1, 5],
      ['0o89z', 'Invalid character in number', 1, 3],
      ['0X89g', 'Invalid character in number', 1, 5],
      ['10z', 'Invalid character in number', 1, 3],
      [' 0.4e-8Z', 'Invalid character in number: Z', 1, 8],
      ['123_', "Invalid '_' at end of number: 123_", 1, 4],
      ['1__23', "Invalid '_' in number: 1__", 1, 3],
      ['1_2__3', "Invalid '_' in number: 1_2__", 1, 5],
      [' 0.4e-8_', "Invalid '_' at end of number: 0.4e-8_", 1, 8],
      [' 0.4_e-8', "Invalid '_' at end of number: 0.4_", 1, 5],
      [' 0._4e-8', "Invalid '_' in number: 0._", 1, 4],
      ['\\ ', 'Unexpected character: \\', 1, 2]
    ];

    bad_numbers.forEach(function (c) {
      let tokenizer = makeTokenizer(c[0]);
      try {
        let t = tokenizer.getToken();
      } catch (e) {
        assert.include(e.message, c[1]);
        let pos = new Location(c[2], c[3]);
        compareLocs(e.location, pos);
      }
    });

    let bad_strings = [
      ["\'", "Unterminated quoted string:", 1, 1],
      ["\"", "Unterminated quoted string:", 1, 1],
      ["\'\'\'", "Unterminated quoted string:", 1, 1],
      ["  ;", "Unexpected character: ", 1, 3],
      ["\"abc", "Unterminated quoted string: ", 1, 1],
      ["\"abc\\\ndef", "Unterminated quoted string: ", 1, 1]
    ];

    bad_strings.forEach(function (c) {
      let tokenizer = makeTokenizer(c[0]);
      try {
        let t = tokenizer.getToken();
      } catch (e) {
        expect(e.message).to.have.string(c[1]);
        let pos = new Location(c[2], c[3]);
        compareLocs(e.location, pos);
      }
    });
  });

  it('should handle escapes', function () {
    let cases = [
      ["'\\a'", "\u0007"],
      ["'\\b'", "\b"],
      ["'\\f'", "\u000C"],
      ["'\\n'", "\n"],
      ["'\\r'", "\r"],
      ["'\\t'", "\t"],
      ["'\\v'", "\u000B"],
      ["'\\\\'", "\\"],
      ["'\\''", "'"],
      ["'\\\"'", "\""],
      ["'\\xAB'", "\u00AB"],
      ["'\\u2803'", "\u2803"],
      ["'\\u28A0abc\\u28A0'", "\u28a0abc\u28a0"],
      ["'\\u28A0abc'", "\u28a0abc"],
      ["'\\uE000'", "\ue000"],
      // Note: 32-bit Unicode is supported via surrogate pairs
      ["'\\U0010ffff'", "\udbff\udfff"]
    ];

    cases.forEach(function (c) {
      let tokenizer = makeTokenizer(c[0]);
      let t = tokenizer.getToken();

      expect(t.value).to.equal(c[1], `failed for ${c[0]}`);
    });

    let bad_cases = [
      "'\\z'",
      "'\\x'",
      "'\\xa'",
      "'\\xaz'",
      "'\\u'",
      "'\\u0'",
      "'\\u01'",
      "'\\u012'",
      "'\\u012z'",
      "'\\u012zA'",
      "'\\ud800'",
      "'\\udfff'",
      "'\\U00110000'"
    ];

    bad_cases.forEach(function (c) {
      let tokenizer = makeTokenizer(c);

      try {
        let t = tokenizer.getToken();
      } catch (e) {
        expect(e.message).to.have.string('Invalid escape sequence', `failed for ${c}`);
      }
    });
  });

  it('should handle token representation', function() {
    let cases = [
      [TokenKind.NEWLINE, 'end-of-line'],
      [TokenKind.WORD, 'identifier'],
      [TokenKind.INTEGER, 'whole number'],
      [TokenKind.FLOAT, 'floating-point number'],
      [TokenKind.COMPLEX, 'complex number'],
      [TokenKind.STRING, 'string']
    ];

    cases.forEach(function (c) {
      assert.equal(tokenRepr(c[0]), c[1]);
    });
  });
});

function expressions(ops, rule, multiple = true) {
  ops.forEach(function (op) {
    const s = `foo${op}bar`;
    const kind = makeTokenizer(op).getToken().kind;
    const o = parse(s, rule);

    assert.isNotNull(o);
    assert.instanceOf(o, BinaryNode);
    assert.instanceOf(o.left, Token);
    assert.instanceOf(o.right, Token);
    assert.strictEqual(o.kind, kind);
    assert.strictEqual(o.left.value, 'foo');
    assert.strictEqual(o.right.value, 'bar');
  });
  if (multiple) {
    const size = ops.length;

    function randIndex(n) {
      let result = Math.floor(Math.random() * n);

      return result;
    }

    for (let i = 0; i < 500; i++) {
      const op1 = ops[randIndex(size)];
      const op2 = ops[randIndex(size)];
      const k1 = makeTokenizer(op1).getToken().kind;
      const k2 = makeTokenizer(op2).getToken().kind;
      const s = `foo${op1}bar${op2}baz`;
      const o = parse(s, rule);

      assert.isNotNull(o);
      assert.instanceOf(o, BinaryNode);
      assert.strictEqual(o.kind, k2);
      assert.strictEqual(o.right.value, 'baz');
      assert.strictEqual(o.left.kind, k1);
      assert.strictEqual(o.left.left.value, 'foo');
      assert.strictEqual(o.left.right.value, 'bar');
    }
  }
}

describe('Parser', function () {
  it('should return tokens', function () {
    const node = makeParser('a + 4').expr();

    assert.instanceOf(node, BinaryNode);
    assert.strictEqual(node.kind, TokenKind.PLUS);
    assert.instanceOf(node.left, Token);
    assert.strictEqual(node.left.kind, TokenKind.WORD);
    assert.strictEqual(node.left.value, 'a');
    assert.instanceOf(node.right, Token);
    assert.strictEqual(node.right.kind, TokenKind.INTEGER);
    assert.strictEqual(node.right.value, 4);
  });

  it('should handle parsing misc. fragments', function () {
    let node = parse('foo', 'expr');
    assert.instanceOf(node, Token);
    assert.strictEqual(node.value, 'foo');
    node = makeParser('0.5').expr();
    assert.instanceOf(node, Token);
    assert.strictEqual(node.value, 0.5);
    node = makeParser("'foo' \"bar\"").expr();
    assert.strictEqual(node.value, 'foobar');
    node = makeParser('a.b').expr();
    const dot = TokenKind.DOT;
    assert.strictEqual(node.kind, dot);
    assert.strictEqual(node.left.value, 'a');
    assert.strictEqual(node.right.value, 'b');
    node = makeParser('a.b.c.d').expr();
    assert.strictEqual(node.kind, dot);
    assert.strictEqual(node.right.value, 'd');
    const abc = node.left;
    assert.isNotNull(abc);
    assert.instanceOf(abc, BinaryNode);
    assert.strictEqual(abc.kind, dot);
    assert.strictEqual(abc.right.value, 'c');
    const ab = abc.left;
    assert.isNotNull(ab);
    assert.strictEqual(ab.kind, dot);
    assert.strictEqual(ab.left.value, 'a');
    assert.strictEqual(ab.right.value, 'b');
  });

  it('should handle unaries', function () {
    const ops = ["+", "-", "~", "not ", "@"];

    ops.forEach(function (op) {
      const s = `${op}foo`;
      const kind = makeTokenizer(op).getToken().kind;

      const o = parse(s, 'expr');

      assert.instanceOf(o, UnaryNode);
      assert.strictEqual(o.kind, kind);
      assert.strictEqual(o.operand.value, 'foo');
    });
  });

  it('should handle binaries', function () {
    expressions(['*', '/', '//', '%'], 'mulExpr');
    expressions(['+', '-'], 'addExpr');
    expressions(['<<', '>>'], 'shiftExpr');
    expressions(['&'], 'bitandExpr');
    expressions(['^'], 'bitxorExpr');
    expressions(['|'], 'bitorExpr');
    expressions(['**'], 'power', false);
    let o = parse('foo**bar**baz', 'power');
    assert.instanceOf(o, BinaryNode);
    const k = TokenKind.POWER;
    assert.strictEqual(o.kind, k);
    assert.strictEqual(o.left.kind, TokenKind.WORD);
    assert.strictEqual(o.left.value, 'foo');
    assert.strictEqual(o.right.kind, k);
    assert.strictEqual(o.right.left.value, 'bar');
    assert.strictEqual(o.right.right.value, 'baz');

    o = parse('foo is not bar', 'comparison');
    assert.instanceOf(o, BinaryNode);
    assert.strictEqual(o.kind, TokenKind.ISNOT);
    assert.strictEqual(o.left.value, 'foo');
    assert.strictEqual(o.right.value, 'bar');

    o = parse('foo not in bar', 'comparison');
    assert.instanceOf(o, BinaryNode);
    assert.strictEqual(o.kind, TokenKind.NOTIN);
    assert.strictEqual(o.left.value, 'foo');
    assert.strictEqual(o.right.value, 'bar');

    expressions(['<=', '<>', '<', '>=', '>', '==', '!=', ' in ', ' is '], 'comparison', false);
    expressions([' and ', '&&'], 'andExpr');
    expressions([' or ', '||'], 'expr');
  });

  it('should handle atoms', function () {
    ['[1, 2, 3]', '[1, 2, 3,]'].forEach(function (s) {
      let o = parse(s, 'atom');

      assert.instanceOf(o, ListNode);
      o.elements.forEach(function (item, i) {
        assert.instanceOf(item, Token);
        assert.strictEqual(item.value, i + 1);
      });
    });
  });

  it('should handle examples in data', function () {
    const dp = dataFilePath('testdata.txt');
    loadData(dp, function (data) {
      let keys = Object.keys(data);

      keys.sort();
      keys.forEach(function (key) {
        let parser = makeParser(data[key]);

        if (key < 'D01') {
          let o = parser.mappingBody();

          assert.instanceOf(o, MappingNode);
        } else {
          try {
            parser.mappingBody();
          } catch (e) {
            assert.include(e.message, 'Unexpected type for key');
          }
        }
      });
    });
  });

  it('should handle JSON', function () {
    const dp = dataFilePath('forms.conf');
    let parser = new Parser(makeFileStream(dp));
    let node = parser.mapping();
    let keys = ['refs', 'fieldsets', 'forms', 'modals', 'pages'];

    assert.instanceOf(node, MappingNode);
    node.elements.forEach(function (e, i) {
      assert.instanceOf(e[0], Token);
      assert.strictEqual(e[0].value, keys[i]);
    });
  });

  it('should handle syntax errors', function () {
    const cases = [
      ['{foo', 'mapping', 'Expected key-value separator, but found'],
      ['   :', 'value', 'Unexpected when looking for value'],
      ['   :', 'atom', 'Unexpected: ']
    ];

    cases.forEach(function (c) {
      const [s, rule, msg] = c;

      try {
        parse(s, rule);
      } catch (e) {
        assert.include(e.message, msg);
      }
    });
  });

  it('should handle containers', function () {
    const dp = dataFilePath('derived');

    fs.readdir(dp, function (err, files) {
      files.forEach(function (fn) {
        const p = path.join(dp, fn);
        const parser = new Parser(makeFileStream(p));
        try {
          let node = parser.container();

          assert.instanceOf(node, ASTNode);
        }
        catch (e) {
          console.log(`Failed when processing ${p}: ${e.message} at ${e.location}`);
        }
      });
    });
  });

  it('should handle slices', function () {
    // valid slice cases
    const cases = [
      ['foo[start:stop:step]', new BinaryNode(TokenKind.COLON,
        W('foo', 1, 1),
        new SliceNode(W('start', 1, 5),
          W('stop', 1, 11),
          W('step', 1, 16)))],
      ['foo[start:stop]', new BinaryNode(TokenKind.COLON,
        W('foo', 1, 1),
        new SliceNode(W('start', 1, 5),
          W('stop', 1, 11),
          null))],
      ['foo[start:stop:]', new BinaryNode(TokenKind.COLON,
        W('foo', 1, 1),
        new SliceNode(W('start', 1, 5),
          W('stop', 1, 11),
          null))],
      ['foo[start:]', new BinaryNode(TokenKind.COLON,
        W('foo', 1, 1),
        new SliceNode(W('start', 1, 5), null, null))],
      ['foo[start::]', new BinaryNode(TokenKind.COLON,
        W('foo', 1, 1),
        new SliceNode(W('start', 1, 5), null, null))],
      ['foo[:stop]', new BinaryNode(TokenKind.COLON,
        W('foo', 1, 1),
        new SliceNode(null, W('stop', 1, 6), null))],
      ['foo[:stop:]', new BinaryNode(TokenKind.COLON,
        W('foo', 1, 1),
        new SliceNode(null, W('stop', 1, 6), null))],
      ['foo[::step]', new BinaryNode(TokenKind.COLON,
        W('foo', 1, 1),
        new SliceNode(null, null, W('step', 1, 7)))],
      ['foo[start::step]', new BinaryNode(TokenKind.COLON,
        W('foo', 1, 1),
        new SliceNode(W('start', 1, 5), null, W('step', 1, 12)))],
      ['foo[::]', new BinaryNode(TokenKind.COLON,
        W('foo', 1, 1), new SliceNode(null, null, null))],
      ['foo[:]', new BinaryNode(TokenKind.COLON,
        W('foo', 1, 1),
        new SliceNode(null, null, null))],
    ];

    const origin = new Location(1, 1);

    cases.forEach(function (c) {
      let node = makeParser(c[0]).expr();
      let expected = c[1];

      expected.start = origin;
      assert.deepEqual(node, expected);
    });

    // non-slice case
    let node = makeParser('foo[start]').expr();
    let expected = new BinaryNode(TokenKind.LBRACK, W('foo', 1, 1), W('start', 1, 5));
    expected.start = origin;
    expect(node).to.eql(expected);

    // failure cases
    const failures = [
      ['foo[start::step:]', `expected ']' but got ':'`],
      ['foo[a, b:c:d]', 'expected 1 expression, found 2'],
      ['foo[a:b:c,d, e]', 'expected 1 expression, found 3'],
    ];

    failures.forEach(function (c) {
      try {
        makeParser(c[0]).expr();
      } catch (e) {
        assert.include(e.message, c[1]);
      }
    });
  });
});

describe('Config', function () {
  it('should handle initialization', function () {
    let cfg = new Config();

    cfg = new Config(dataFilePath('forms.cfg'));
    cfg = new Config(makeStream('{}'));
    try {
      cfg = new Config(makeStream('[]'));
    } catch (e) {
      assert.include(e.message, 'Root configuration must be a mapping');
    }
    try {
      cfg = new Config(4);
    } catch (e) {
      assert.include(e.message, 'Expecting pathname or stream, got 4');
    }
  });

  it('should handle identifiers', function () {
    const cases = [
      ["foo", true],
      ["\u0935\u092e\u0938", true],
      ["\u73b0\u4ee3\u6c49\u8bed\u5e38\u7528\u5b57\u8868", true],
      ["foo ", false],
      ["foo[", false],
      ["foo [", false],
      ["foo.", false],
      ["foo .", false],
      ["\u0935\u092e\u0938.", false],
      ["\u73b0\u4ee3\u6c49\u8bed\u5e38\u7528\u5b57\u8868.", false],
      ["9", false],
      ["9foo", false],
      ["hyphenated-key", false]
    ];

    cases.forEach(function (c) {
      assert.equal(isIdentifier(c[0]), c[1], `failed for ${c[0]}`);
    });
  });

  it('should handle duplicates', function () {
    const dp = dataFilePath(path.join('derived', 'dupes.cfg'));
    let cfg = new Config();

    try {
      cfg.loadFile(dp);
      assert.fail('expected exception not thrown');
    } catch (e) {
      assert.include(e.message, 'Duplicate key foo seen at (4, 1) (previously at (1, 1))');
    }
    cfg.noDuplicates = false;
    cfg.loadFile(dp);
    assert.equal(cfg.get('foo'), 'not again!');
  });

  it('should handle variable lookup', function () {
    const dp = dataFilePath(path.join('derived', 'context.cfg'));
    let cfg = new Config(dp);
    cfg.context = {
      bozz: 'bozz-bozz'
    };
    assert.equal(cfg.get('baz'), 'bozz-bozz');
    try {
      cfg.get('bad');
      assert.fail('expected exception not thrown');
    } catch (e) {
      assert.include(e.message, 'Unknown variable: ');
    }
  });

  it('should handle path iteration', function () {
    let p = parsePath('foo[bar].baz[2].bozz[a:b:c].fizz ');
    let actual = Array.from(pathIterator(p));
    let expected = [
      W('foo', 1, 1),
      ['[', 'bar'],
      ['.', 'baz'],
      ['[', 2],
      ['.', 'bozz'],
      [':', new SliceNode(W('a', 1, 22), W('b', 1, 24), W('c', 1, 26))],
      ['.', 'fizz']
    ];

    assert.deepEqual(actual, expected);
  });

  it('should handle bad paths', function () {
    const cases = [
      ['foo[1, 2]', 'Invalid index at (1, 5): expected 1 expression, found 2'],
      ['foo[1] bar', 'Invalid path: foo[1] bar'],
      ['foo.123', 'Invalid path: foo.123'],
      ['foo.', ' but got '],
      ['foo[]', 'Invalid index at (1, 5): expected 1 expression, found 0'],
      ['foo[1a]', 'Invalid character in number: a'],
      ['4', null]
    ];

    cases.forEach(function (c) {
      try {
        parsePath(c[0]);
        assert.fail('expected exception not thrown');
      } catch (e) {
        assert.equal(e.message, `Invalid path: ${c[0]}`);
        if (e.cause) {
          assert.include(e.cause.message, c[1], `failed for ${c[0]}`);
        }
      }
    });
  });

  it('should handle conversion to source', function () {
    const cases = [
      'foo[::2]',
      'foo[:]',
      'foo[:2]',
      'foo[2:]',
      'foo[::1]',
      'foo[::-1]'
    ];

    cases.forEach(function (c) {
      let node = parsePath(c);

      assert.equal(toSource(node), c);
    });
  });

  it('should handle slices and indices', function () {
    const dp = dataFilePath(path.join('derived', 'test.cfg'));
    const cfg = new Config(dp);
    const theList = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

    // slices

    expect(cfg.get('test_list[:]')).to.eql(theList);
    expect(cfg.get('test_list[::]')).to.eql(theList);
    expect(cfg.get('test_list[:20]')).to.eql(theList);
    expect(cfg.get('test_list[-20:4]')).to.eql(theList.slice(0, 4));
    expect(cfg.get('test_list[-20:20]')).to.eql(theList);
    expect(cfg.get('test_list[2:]')).to.eql(theList.slice(2));
    expect(cfg.get('test_list[-3:]')).to.eql(theList.slice(4));
    expect(cfg.get('test_list[-2:2:-1]')).to.eql(['f', 'e', 'd']);
    expect(cfg.get('test_list[::-1]')).to.eql(theList.slice().reverse());
    expect(cfg.get('test_list[2:-2:2]')).to.eql(['c', 'e']);
    expect(cfg.get('test_list[::2]')).to.eql(['a', 'c', 'e', 'g']);
    expect(cfg.get('test_list[::3]')).to.eql(['a', 'd', 'g']);
    expect(cfg.get('test_list[::2][::3]')).to.eql(['a', 'g']);

    // indices

    theList.forEach(function (v, i) {
      assert.equal(cfg.get(`test_list[${i}]`), v);
    });

    // negative indices

    const n = theList.length;
    for (let i = n; i >= 1; i--) {
      assert.equal(cfg.get(`test_list[-${i}]`), theList[n - i]);
    }

    // invalid indices

    [n, n + 1, -(n + 1), -(n + 2)].forEach(function (i) {
      try {
        cfg.get(`test_list[${i}]`);
        assert.fail('expected exception not thrown');
      } catch (e) {
        assert.include(e.message, 'index out of range: ');
        assert.include(e.message, `, must be between 0 and ${n - 1}`);
      }
    });
  });

  it('should handle bad string conversions', function () {
    let cfg = new Config();
    let cases = ['foo'];

    cases.forEach(function (c) {
      let s;

      cfg.strictConversions = true;
      try {
        s = cfg.convertString(c);
        assert.fail('expected exception not thrown');
      } catch (e) {
        assert.equal(e.message, `unable to convert string '${c}'`);
      }
      cfg.strictConversions = false;
      s = cfg.convertString(c);
      assert.equal(s, c);
    });
  });

  it('should handle circular references', function () {
    const dp = dataFilePath(path.join('derived', 'test.cfg'));
    const cfg = new Config(dp);
    let cases = [
      ['circ_list[1]', 'Circular reference: circ_list[1] (42, 5)'],
      ['circ_map.a', 'Circular reference: circ_map.a (49, 8), circ_map.b (47, 8), circ_map.c (48, 8)']
    ];

    cases.forEach(function (c) {
      try {
        cfg.get(c[0]);
        assert.fail('expected exception not thrown');
      } catch (e) {
        assert.equal(e.message, c[1]);
      }
    });
  });

  it('should handle paths across includes', function () {
    const dp = dataFilePath(path.join('base', 'main.cfg'));
    const cfg = new Config(dp);
    let cases = [
      ['logging.appenders.file.filename', 'run/server.log'],
      ['logging.appenders.file.append', true],
      ['logging.appenders.error.filename', 'run/server-errors.log'],
      ['logging.appenders.error.append', false],
      ['redirects.freeotp.url', 'https://freeotp.github.io/'],
      ['redirects.freeotp.permanent', false]
    ];

    cases.forEach(function (c) {
      assert.equal(cfg.get(c[0]), c[1]);
    });
  });

  it('should handle the "main" test config', function () {
    const dp = dataFilePath(path.join('derived', 'main.cfg'));
    const options = {
      includePath: [dataFilePath('base')]
    };
    const cfg = new Config(dp, options);
    const logConf = cfg.get('logging');

    assert.instanceOf(logConf, Config);
    let d = logConf.asDict();
    let keys = Object.keys(d);
    let expected = ['formatters', 'handlers', 'loggers', 'root'];
    keys.sort();
    expect(keys).to.eql(expected);
    try {
      logConf.get('"handlers.file/filename');
      assert.fail('expected exception not thrown');
    } catch (e) {
      assert.instanceOf(e, InvalidPathException);
    }
    assert.equal(logConf.get('foo', 'bar'), 'bar');
    assert.equal(logConf.get('foo.bar', 'baz'), 'baz');
    assert.equal(logConf.get('handlers.debug.levl', 'bozz'), 'bozz');
    assert.equal(logConf.get('handlers.file.filename'), 'run/server.log');
    assert.equal(logConf.get('handlers.debug.filename'), 'run/server-debug.log');
    expect(logConf.get('root.handlers')).to.eql(['file', 'error', 'debug']);
    expect(logConf.get('root.handlers[:2]')).to.eql(['file', 'error']);
    expect(logConf.get('root.handlers[::2]')).to.eql(['file', 'debug']);

    const test = cfg.get('test');
    assert.instanceOf(test, Config);
    assert.equal(test.get('float'), 1.0e-7);
    assert.equal(test.get('float2'), 0.3);
    assert.equal(test.get('float3'), 3.0);
    assert.equal(test.get('list[1]'), 2);
    assert.equal(test.get('dict.a'), 'b');
    expect(test.get('date')).to.eql(new Date(2019, 2, 28));
    let dt = new Date(2019, 2, 28, 23, 27, 4, 314.159);
    dt = new Date(dt.getTime() + 3600 * 5 + 60 * 30);
    expect(test.get('date_time')).to.eql(dt);
    dt = new Date(2019, 2, 28, 23, 27, 4, 271.828);
    expect(test.get('alt_date_time')).to.eql(dt);
    dt = new Date(2019, 2, 28, 23, 27, 4);
    expect(test.get('no_ms_time')).to.eql(dt);
    assert.equal(test.get('computed'), 3.3);
    assert.equal(test.get('computed2'), 2.7);
    expect(test.get('computed3')).to.almost.equal(0.9);
    assert.equal(test.get('computed4'), 10.0);
    assert.instanceOf(cfg.get('base'), Config);
    expect(cfg.get('combined_list')).to.eql([
      'derived_foo', 'derived_bar', 'derived_baz',
      'test_foo', 'test_bar', 'test_baz',
      'base_foo', 'base_bar', 'base_baz'
    ]);
    expect(cfg.get('combined_map_1')).to.eql({
      foo_key: 'base_foo',
      bar_key: 'base_bar',
      baz_key: 'base_baz',
      base_foo_key: 'base_foo',
      base_bar_key: 'base_bar',
      base_baz_key: 'base_baz',
      derived_foo_key: 'derived_foo',
      derived_bar_key: 'derived_bar',
      derived_baz_key: 'derived_baz',
      test_foo_key: 'test_foo',
      test_bar_key: 'test_bar',
      test_baz_key: 'test_baz'
    });
    expect(cfg.get('combined_map_2')).to.eql({
      derived_foo_key: 'derived_foo',
      derived_bar_key: 'derived_bar',
      derived_baz_key: 'derived_baz'
    });
    const n1 = cfg.get('number_1');
    const n2 = cfg.get('number_2');
    assert.equal(n1, 104);
    assert.equal(n2, 175);
    assert.equal(cfg.get('number_3'), n1 & n2);
    assert.equal(cfg.get('number_4'), n1 ^ n2);

    let cases = [
      ['logging[4]', 'string required, but found 4'],
      ['logging[:4]', 'slices can only operate on lists'],
      ['no_such_key', 'Not found in configuration: no_such_key']
    ];

    cases.forEach(function (c) {
      try {
        cfg.get(c[0]);
        assert.fail('expected exception not thrown');
      } catch (e) {
        assert.equal(e.message, c[1]);
      }
    });
  });

  it('should handle the "example" test config', function () {
    const dp = dataFilePath(path.join('derived', 'example.cfg'));
    const options = {
      includePath: [dataFilePath('base')]
    };
    const cfg = new Config(dp, options);
    var expected;

    assert.equal(cfg.get('snowman_escaped'), cfg.get('snowman_unescaped'));
    assert.equal(cfg.get('snowman_unescaped'), '\u2603');
    assert.equal(cfg.get('face_with_tears_of_joy'), '\ud83d\ude02');
    assert.equal(cfg.get('unescaped_face_with_tears_of_joy'), '\ud83d\ude02');
    if (process.platform === "win32") {
      expected = [
        "Oscar Fingal O'Flahertie Wills Wilde", 'size: 5"',
        "Triple quoted form\r\ncan span\r\n'multiple' lines",
        "with \"either\"\r\nkind of 'quote' embedded within"
      ];
    } else {
      expected = [
        "Oscar Fingal O'Flahertie Wills Wilde", 'size: 5"',
        "Triple quoted form\ncan span\n'multiple' lines",
        "with \"either\"\nkind of 'quote' embedded within"
      ];
    }
    expect(cfg.get('strings')).to.eql(expected);

    // special values

    globalThis.path = path;
    assert.equal(cfg.get('special_value_1'), path.delimiter);
    delete globalThis.path;
    assert.equal(cfg.get('special_value_2'), process.env['HOME']);
    let dt = new Date(2019, 2, 28, 23, 27, 4, 314.159 + 123.456);
    dt = new Date(dt.getTime() + 5 * 3600 + 30 * 60 + 43);
    expect(cfg.get('special_value_3')).to.eql(dt);
    assert.equal(cfg.get('special_value_4'), 'bar');

    // integers

    assert.equal(cfg.get('decimal_integer'), 123);
    assert.equal(cfg.get('hexadecimal_integer'), 0x123);
    assert.equal(cfg.get('octal_integer'), 83);
    assert.equal(cfg.get('binary_integer'), 291);

    // floats

    assert.equal(cfg.get('common_or_garden'), 123.456);
    assert.equal(cfg.get('leading_zero_not_needed'), 0.123);
    assert.equal(cfg.get('trailing_zero_not_needed'), 123.0);
    assert.equal(cfg.get('scientific_large'), 1.0e6);
    assert.equal(cfg.get('scientific_small'), 1.0e-7);
    assert.equal(cfg.get('expression_1'), 3.14159);

    // complex

    expect(cfg.get('expression_2')).to.eql(new Complex(3, 2));
    expect(cfg.get('list_value[4]')).to.eql(new Complex(1, 3));

    // Boolean

    assert.equal(cfg.get('boolean_value'), true);
    assert.equal(cfg.get('opposite_boolean_value'), false);
    assert.equal(cfg.get('computed_boolean_1'), true);
    assert.equal(cfg.get('computed_boolean_2'), false);

    // list

    expect(cfg.get('incl_list')).to.eql(['a', 'b', 'c']);

    // mapping

    expect(cfg.get('incl_mapping').asDict()).to.eql({
      bar: 'baz',
      foo: 'bar'
    });
    expect(cfg.get('incl_mapping_body').asDict()).to.eql({
      baz: 'bozz',
      fizz: 'buzz'
    });

  });

  it('should handle expressions', function () {
    const dp = dataFilePath(path.join('derived', 'test.cfg'));
    const cfg = new Config(dp);

    expect(cfg.get('dicts_added')).to.eql({
      a: 'b',
      c: 'd'
    });
    expect(cfg.get('nested_dicts_added')).to.eql({
      a: {
        b: 'c',
        w: 'x'
      },
      d: {
        e: 'f',
        y: 'z'
      }
    });
    expect(cfg.get('lists_added')).to.eql(['a', 1, 'b', 2]);
    expect(cfg.get('list[:2]')).to.eql([1, 2]);
    expect(cfg.get('dicts_subtracted')).to.eql({
      a: 'b'
    });
    expect(cfg.get('nested_dicts_subtracted')).to.eql({});
    expect(cfg.get('dict_with_nested_stuff')).to.eql({
      a_list: [1, 2, {
        a: 3
      }],
      a_map: {
        k1: ['b', 'c', {
          d: 'e'
        }]
      }
    });
    expect(cfg.get('dict_with_nested_stuff.a_list[:2]')).to.eql([1, 2]);
    assert.equal(cfg.get('unary'), -4);
    assert.equal(cfg.get('abcdefghijkl'), 'mno');
    assert.equal(cfg.get('power'), 8);
    assert.equal(cfg.get('computed5'), 2.5);
    assert.equal(cfg.get('computed6'), 2);
    expect(cfg.get('c3')).to.eql(new Complex(3, 1));
    expect(cfg.get('c4')).to.eql(new Complex(5, 5));
    assert.equal(cfg.get('computed8'), 2);
    assert.equal(cfg.get('computed9'), 160);
    assert.equal(cfg.get('computed10'), 62);
    assert.equal(cfg.get('interp'), 'A-4 a test_foo true 10 1e-7 1 b [a, c, e, g]Z');
    assert.equal(cfg.get('interp2'), '{a: b}');

    let cases = [
      ['bad_include', '@ operand must be a string'],
      ['computed7', 'Not found in configuration: float4'],
      ['bad_interp', 'unable to convert string ']
    ];

    cases.forEach(function (c) {
      try {
        cfg.get(c[0]);
        assert.fail('expected exception not thrown');
      } catch (e) {
        assert.include(e.message, c[1]);
      }
    });
    assert.equal(cfg.get('dict.a'), 'b');
  });

  it('should handle forms', function () {
    const dp = dataFilePath(path.join('derived', 'forms.cfg'));
    const options = {
      includePath: [dataFilePath('base')]
    };
    const cfg = new Config(dp, options);
    let cases = [
      ['modals.deletion.contents[0].id', 'frm-deletion'],
      ['refs.delivery_address_field', {
        kind: 'field',
        type: 'textarea',
        name: 'postal_address',
        label: 'Postal address',
        label_i18n: 'postal-address',
        short_name: 'address',
        placeholder: 'We need this for delivering to you',
        ph_i18n: 'your-postal-address',
        message: ' ',
        required: true,
        attrs: {
          minlength: 10
        },
        grpclass: 'col-md-6'
      }],
      ['refs.delivery_instructions_field', {
        kind: 'field',
        type: 'textarea',
        name: 'delivery_instructions',
        label: 'Delivery Instructions',
        short_name: 'notes',
        placeholder: 'Any special delivery instructions?',
        message: ' ',
        label_i18n: 'delivery-instructions',
        ph_i18n: 'any-special-delivery-instructions',
        grpclass: 'col-md-6'
      }],
      ['refs.verify_field', {
        kind: 'field',
        type: 'input',
        name: 'verification_code',
        label: 'Verification code',
        label_i18n: 'verification-code',
        short_name: 'verification code',
        placeholder: 'Your verification code (NOT a backup code)',
        ph_i18n: 'verification-not-backup-code',
        attrs: {
          minlength: 6,
          maxlength: 6,
          autofocus: true
        },
        append: {
          label: 'Verify',
          type: 'submit',
          classes: 'btn-primary'
        },
        message: ' ',
        required: true
      }],
      ['refs.signup_password_field', {
        kind: 'field',
        type: 'password',
        name: 'password',
        label: 'Password',
        label_i18n: 'password',
        placeholder: 'The password you want to use on this site',
        ph_i18n: 'password-wanted-on-site',
        message: ' ',
        toggle: true,
        required: true
      }],
      ['refs.signup_password_conf_field', {
        kind: 'field',
        type: 'password',
        name: 'password_conf',
        label: 'Password confirmation',
        label_i18n: 'password-confirmation',
        placeholder: 'The same password, again, to guard against mistyping',
        ph_i18n: 'same-password-again',
        message: ' ',
        toggle: true,
        required: true
      }],
      ['fieldsets.signup_ident[0].contents[0]', {
        kind: 'field',
        type: 'input',
        name: 'display_name',
        label: 'Your name',
        label_i18n: 'your-name',
        placeholder: 'Your full name',
        ph_i18n: 'your-full-name',
        message: ' ',
        data_source: 'user.display_name',
        required: true,
        attrs: {
          autofocus: true
        },
        grpclass: 'col-md-6'
      }],
      ['fieldsets.signup_ident[0].contents[1]', {
        kind: 'field',
        type: 'input',
        name: 'familiar_name',
        label: 'Familiar name',
        label_i18n: 'familiar-name',
        placeholder: 'If not just the first word in your full name',
        ph_i18n: 'if-not-first-word',
        data_source: 'user.familiar_name',
        message: ' ',
        grpclass: 'col-md-6'
      }],
      ['fieldsets.signup_ident[1].contents[0]', {
        kind: 'field',
        type: 'email',
        name: 'email',
        label: 'Email address (used to sign in)',
        label_i18n: 'email-address',
        short_name: 'email address',
        placeholder: 'Your email address',
        ph_i18n: 'your-email-address',
        message: ' ',
        required: true,
        data_source: 'user.email',
        grpclass: 'col-md-6'
      }],
      ['fieldsets.signup_ident[1].contents[1]', {
        kind: 'field',
        type: 'input',
        name: 'mobile_phone',
        label: 'Phone number',
        label_i18n: 'phone-number',
        short_name: 'phone number',
        placeholder: 'Your phone number',
        ph_i18n: 'your-phone-number',
        classes: 'numeric',
        message: ' ',
        prepend: {
          icon: 'phone'
        },
        attrs: {
          maxlength: 10
        },
        required: true,
        data_source: 'customer.mobile_phone',
        grpclass: 'col-md-6'
      }]
    ];

    cases.forEach(function (c) {
      const v = cfg.get(c[0]);

      expect(v).to.eql(c[1]);
    });
  });

  it('should handle caching', function() {
    const dp = dataFilePath(path.join('derived', 'test.cfg'));
    const cfg = new Config(dp, {cached: true});
    const time = {now: function() { return new Date(); }}

    globalThis.time = time;
    const v1 = cfg.get('time_now');

    setTimeout(function() {
      const v2 = cfg.get('time_now');

      expect(v1).to.eql(v2);
      cfg.cache = null;
      cfg.cached = false;
      const v3 = cfg.get('time_now');

      setTimeout(function() {
        const v4 = cfg.get('time_now');

        expect(v3).to.not.eql(v4);
        delete globalThis.time;
      }, 50);
    }, 50);
  });

  it('should handle nested includes across paths', function() {
    const dp = dataFilePath(path.join('base', 'top.cfg'));
    const options = {
      includePath: [dataFilePath('derived'), dataFilePath('another')]
    };
    const cfg = new Config(dp, options);

    assert.equal(cfg.get('level1.level2.final'), 42);
  });
});
