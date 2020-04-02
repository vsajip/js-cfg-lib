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
const Location = config.Location;
const Tokenizer = config.Tokenizer;
const Token = config.Token;
const make_stream = config.make_stream;
const make_file_stream = config.make_file_stream;

const TokenKind = config.TokenKind;

function make_tokenizer(s) {
  return new Tokenizer(make_stream(s));
}

function compare_locs(loc1, loc2) {
  expect(loc1).to.eql(loc2);
}

function compare_objects(o1, o2, ctx) {
  if (ctx === undefined) {
    ctx = '';
  } else {
    ctx = ` at ${ctx}`;
  }
  if (!_.isEqual(o1, o2)) {
    console.log('about to fail:');
  }
  assert(_.isEqual(o1, o2), `not the same${ctx}: ${o1} !== ${o2}`);
}

function compare_arrays(a1, a2) {
  expect(a1.length).to.equal(a2.length);
  for (let i = 0; i < a1.length; i++) {
    compare_objects(a1[i], a2[i], i);
  }
}

function data_file_path(name) {
  let d = path.join(process.cwd(), 'resources')

  return path.join(d, name);
}

function collect_tokens(tokenizer) {
  let result = [];

  while (true) {
    let t = tokenizer.get_token();

    result.push(t);
    if (t.kind === TokenKind.EOF) {
      break;
    }
  }
  return result;
}

function make_token(k, t, v, sl, sc, el, ec) {
  let result = new Token(k, t, v);

  result.start.line = sl;
  result.start.column = sc;
  result.end.line = el;
  result.end.column = ec;
  return result;
}

const SEPARATOR_PATTERN = /^-- ([A-Z]\d+) -+/;

function load_data(path, resolver) {
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
  it('should handle at_end', function () {
    let t = new Tokenizer(make_stream(''));

    expect(t.at_end()).to.equal(false);
    let c = t.get_char();
    expect(c).to.equal(null);
    expect(t.at_end()).to.equal(true);
  });

  it('should handle empty input', function () {
    let tokenizer = make_tokenizer('');
    let t = tokenizer.get_token();
    expect(t.kind).to.equal(TokenKind.EOF);
    t = tokenizer.get_token();
    expect(t.kind).to.equal(TokenKind.EOF);
  });

  it('should handle comments', function () {
    let cases = ['# a comment\n', '# another comment', '# yet another comment\r'];

    cases.forEach(function (c) {
      let tokenizer = make_tokenizer(c);
      let t = tokenizer.get_token();
      expect(t.kind).to.equal(TokenKind.NEWLINE);
      expect(t.text).to.equal(c.trim());
      t = tokenizer.get_token();
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
      let tokenizer = make_tokenizer(c);
      let t = tokenizer.get_token();
      expect(t.kind).to.equal(TokenKind.WORD);
      expect(t.text).to.equal(c);
      t = tokenizer.get_token();
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
      let tokenizer = make_tokenizer(c[0]);
      let t = tokenizer.get_token();
      expect(t.kind).to.equal(TokenKind.STRING);
      expect(t.text).to.equal(c[0]);
      expect(t.value).to.equal(c[1]);
      t = tokenizer.get_token();
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
      let tokenizer = make_tokenizer(c[0]);
      let t = tokenizer.get_token();
      expect(t.kind).to.equal(TokenKind.STRING);
      expect(t.text).to.equal(c[0]);
      expect(t.value).to.equal('');
      compare_locs(t.end, new Location(c[1], c[2]));
      t = tokenizer.get_token();
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
      let tokenizer = make_tokenizer(c[0]);
      let t = tokenizer.get_token();
      expect(t.kind).to.equal(TokenKind.FLOAT);
      expect(t.text).to.equal(c[0]);
      expect(t.value).to.equal(c[1] || parseFloat(c[0]));
      t = tokenizer.get_token();
      expect(t.kind).to.equal(TokenKind.EOF);
    });
  });

  it('should handle complex literals', function() {
    let cases = [
      ['4.3j', new Complex(0, 4.3)]
    ];

    cases.forEach(function(c) {
      let tokenizer = make_tokenizer(c[0]);
      let t = tokenizer.get_token();

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
      let tokenizer = make_tokenizer(c[0]);
      let t = tokenizer.get_token();
      expect(t.kind).to.equal(TokenKind.INTEGER);
      expect(t.text).to.equal(c[0]);
      expect(t.value).to.equal(c[1] || parseFloat(c[0]), `failed for ${c[0]}`);
      t = tokenizer.get_token();
      expect(t.kind).to.equal(TokenKind.EOF);
    });
  });

  it('should handle punctuation', function () {
    let s = '< > { } [ ] ( ) + - * / ** // % . <= <> << >= >> == != , : @ ~ & | ^ $ && ||';
    let tokenizer = make_tokenizer(s);
    let tokens = collect_tokens(tokenizer);
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
    let tokenizer = make_tokenizer(s);

    while (true) {
      let t = tokenizer.get_token();

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
    let dp = data_file_path('testdata.txt');
    let expected = {
      'C16': [
        make_token(TokenKind.WORD, 'test', 'test', 1, 1, 1, 4),
        make_token(TokenKind.COLON, ':', undefined, 1, 6, 1, 6),
        make_token(TokenKind.FALSE, "false", false, 1, 8, 1, 12),
        make_token(TokenKind.NEWLINE, '\n', undefined, 1, 13, 2, 0),
        make_token(TokenKind.WORD, 'another_test', 'another_test', 2, 1, 2, 12),
        make_token(TokenKind.COLON, ':', undefined, 2, 13, 2, 13),
        make_token(TokenKind.TRUE, "true", true, 2, 15, 2, 18),
        make_token(TokenKind.EOF, '', undefined, 2, 19, 2, 19)
      ],
      'C17': [
        make_token(TokenKind.WORD, 'test', 'test', 1, 1, 1, 4),
        make_token(TokenKind.COLON, ':', undefined, 1, 6, 1, 6),
        make_token(TokenKind.NONE, 'null', null, 1, 8, 1, 11),
        make_token(TokenKind.EOF, '', undefined, 1, 12, 1, 12)
      ],
      'C25': [
        make_token(TokenKind.WORD, 'unicode', 'unicode', 1, 1, 1, 7),
        make_token(TokenKind.ASSIGN, '=', undefined, 1, 9, 1, 9),
        make_token(TokenKind.STRING, "'Grüß Gott'", 'Grüß Gott', 1, 11, 1, 21),
        make_token(TokenKind.NEWLINE, '\n', undefined, 1, 22, 2, 0),
        make_token(TokenKind.WORD, 'more_unicode', 'more_unicode', 2, 1, 2, 12),
        make_token(TokenKind.COLON, ':', undefined, 2, 13, 2, 13),
        make_token(TokenKind.STRING, "'Øresund'", 'Øresund', 2, 15, 2, 23),
        make_token(TokenKind.EOF, '', undefined, 2, 24, 2, 24)
      ]
    }
    load_data(dp, function (data) {
      let keys = Object.keys(data);

      keys.sort();
      keys.forEach(function (key) {
        if (key in expected) {
          let tokenizer = make_tokenizer(data[key]);
          let tokens = collect_tokens(tokenizer);

          compare_arrays(tokens, expected[key]);
        }
      });
    });
  });

  it('should handle locations', function () {
    let dp = data_file_path('pos.forms.cfg.txt');
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
      let dp = data_file_path('forms.cfg');
      let f = make_file_stream(dp);
      let tokenizer = new Tokenizer(f);
      let i = 0;

      while (true) {
        let e = expected[i++];
        let t = tokenizer.get_token();

        let sp = new Location(e[0], e[1]);
        let ep = new Location(e[2], e[3]);

        // if (i === 2501) {
        //   console.log('Failing entry');
        // }
        compare_objects(t.start, sp, i);
        compare_objects(t.end, ep, i);
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
      let tokenizer = make_tokenizer(c[0]);
      try {
        let t = tokenizer.get_token();
      } catch (e) {
        expect(e.message).to.have.string(c[1]);
        let pos = new Location(c[2], c[3]);
        compare_locs(e.location, pos);
      }
    });

    let bad_strings = [
      ["\'", "Unterminated quoted string:",1, 1],
      ["\"", "Unterminated quoted string:",1, 1],
      ["\'\'\'", "Unterminated quoted string:", 1, 1],
      ["  ;", "Unexpected character: ", 1, 3],
      ["\"abc", "Unterminated quoted string: ", 1, 1],
      ["\"abc\\\ndef", "Unterminated quoted string: ", 1, 1]
    ];

    bad_strings.forEach(function (c) {
      let tokenizer = make_tokenizer(c[0]);
      try {
        let t = tokenizer.get_token();
      } catch (e) {
        expect(e.message).to.have.string(c[1]);
        let pos = new Location(c[2], c[3]);
        compare_locs(e.location, pos);
      }
    });
  });

  it('should handle escapes', function() {
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

    cases.forEach(function(c) {
      let tokenizer = make_tokenizer(c[0]);
      let t = tokenizer.get_token();

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

    bad_cases.forEach(function(c) {
      let tokenizer = make_tokenizer(c);

      try {
        let t = tokenizer.get_token();
      } catch (e) {
        expect(e.message).to.have.string('Invalid escape sequence', `failed for ${c}`);
      }
    });
  });
});

describe('Parser', function() {
  
});