'use strict';

var stream = require('stream');

var expect = require('chai').expect;
var config = require('./config');
var Location = config.Location;
var Tokenizer = config.Tokenizer;
var make_stream = config.make_stream;
var TokenKind = config.TokenKind;

function make_tokenizer(s) {
  return new Tokenizer(make_stream(s));
}

function compare_locs(loc1, loc2) {
  // expect(loc1.line).to.equal(loc2.line);
  // expect(loc1.column).to.equal(loc2.column);
  expect(loc1).to.eql(loc2);
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
    let expected = [TokenKind.LT, TokenKind.GT, TokenKind.LCURLY, TokenKind.RCURLY,
                    TokenKind.LBRACK, TokenKind.RBRACK, TokenKind.LPAREN, TokenKind.RPAREN,
                    TokenKind.PLUS, TokenKind.MINUS, TokenKind.STAR, TokenKind.SLASH,
                    TokenKind.POWER, TokenKind.SLASHSLASH, TokenKind.MODULO, TokenKind.DOT,
                    TokenKind.LE, TokenKind.ALT_NEQ, TokenKind.LSHIFT, TokenKind.GE,
                    TokenKind.RSHIFT, TokenKind.EQ, TokenKind.NEQ, TokenKind.COMMA,
                    TokenKind.COLON, TokenKind.AT, TokenKind.TILDE, TokenKind.BITAND,
                    TokenKind.BITOR, TokenKind.BITXOR, TokenKind.DOLLAR, TokenKind.AND,
                    TokenKind.OR, TokenKind.EOF];
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
                    TokenKind.EOF];

    expect(kinds).to.eql(expected);
    let texts = tokens.map(t => t.text);
    expected = s.split(' ');
    expected.push('');
    expect(texts).to.eql(expected);
  });
});