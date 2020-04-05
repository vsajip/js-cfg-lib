'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const stream = require('stream');

const Complex = require('complex.js');
const _ = require('lodash');

const {
  expect,
  assert
} = require('chai');

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
  makeStream,
  makeFileStream,
  makeParser,
  parse
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
      let i = 0;

      while (true) {
        let e = expected[i++];
        let t = tokenizer.getToken();

        let sp = new Location(e[0], e[1]);
        let ep = new Location(e[2], e[3]);

        // if (i === 2501) {
        //   console.log('Failing entry');
        // }
        compareObjects(t.start, sp, i);
        compareObjects(t.end, ep, i);
        if (t.kind == TokenKind.EOF) {
          break;
        }
      }
    });
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

    for (let i = 0; i < 1000; i++) {
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
      ['{foo', 'mapping', 'Expected key-value separator, found'],
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
        let node = parser.container();

        assert.instanceOf(node, ASTNode);
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
    // for some reason, assert.strictEqual doesn't work here!
    assert(_.isEqual(node, expected));

    // failure cases
    const failures = [
      ['foo[start::step:]', 'expected ] but got :'],
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

describe('Config', function() {
  it('should handle initialization', function() {
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
});