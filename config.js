/*!
 * A library for working with the CFG configuration format.
 *
 * @author   Vinay Sajip <http://vinay_sajip@yahoo.co.uk>
 * @copyright (C) 2020 Vinay Sajip. See LICENSE for licensing information.
 * @license  BSD-3-Clause
 * @see https://docs.red-dove.com/cfg/
 */
'use strict';

const fs = require('fs');
const path = require('path');
const stream = require('stream');
const util = require('util');

const clonedeep = require('lodash.clonedeep');
const Complex = require('complex.js');

function makeStream(s) {
  let result = new stream.Readable({
    encoding: 'utf-8'
  });

  // push stuff ready to be read, but only once the consumer is ready
  result._read = () => {
    result.push(s);
    result.push(null);
  };
  return result;
}

function makeFileStream(p) {
  let s = fs.readFileSync(p, {
    encoding: 'utf-8'
  });
  return makeStream(s);
}

function isReadable(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch (e) {
    return false;
  }
}

class Location {
  constructor(line, column) {
    this.line = (line === undefined) ? 1 : line;
    this.column = (column === undefined) ? 1 : column;
  }

  next_line() {
    this.line++;
    this.column = 1;
  }

  toString() {
    return `(${this.line}, ${this.column})`;
  }

  copy() {
    return new Location(this.line, this.column);
  }

  update(other) {
    this.line = other.line;
    this.column = other.column;
  }
}

class PushBackInfo {
  constructor(c, cloc, loc) {
    this.c = c;
    this.cloc = cloc;
    this.loc = loc;
  }
}

// Token kinds

const EOF = '';
const WORD = 'a';
const INTEGER = '0';
const FLOAT = '1';
const COMPLEX = 'j';
const STRING = '"';
const NEWLINE = '\n';
const LCURLY = '{';
const RCURLY = '}';
const LBRACK = '[';
const RBRACK = ']';
const LPAREN = '(';
const RPAREN = ')';
const LT = '<';
const GT = '>';
const LE = '<=';
const GE = '>=';
const EQ = '==';
const ASSIGN = '=';
const NEQ = '!=';
const ALT_NEQ = '<>';
const LSHIFT = '<<';
const RSHIFT = '>>';
const DOT = '.';
const COMMA = ',';
const COLON = ':';
const AT = '@';
const PLUS = '+';
const MINUS = '-';
const STAR = '*';
const POWER = '**';
const SLASH = '/';
const TILDE = '~';
const SLASHSLASH = '//';
const MODULO = '%';
const BACKTICK = '`';
const DOLLAR = '$';
const TRUE = 'true';
const FALSE = 'false';
const NONE = 'null';
const IS = 'is';
const IN = 'in';
const NOT = 'not';
const AND = 'and';
const OR = 'or';
const BITAND = '&';
const BITOR = '|';
const BITXOR = '^';
const ISNOT = 'is not';
const NOTIN = 'not in';

const TOKEN_REPR_MAPPING = Object.fromEntries([
  [NEWLINE,  'end-of-line'],
  [WORD, 'identifier'],
  [INTEGER, 'whole number'],
  [FLOAT, 'floating-point number'],
  [COMPLEX, 'complex number'],
  [STRING, 'string']
]);

function tokenRepr(k) {
  return (k in TOKEN_REPR_MAPPING) ? TOKEN_REPR_MAPPING[k] : `'${k}'`;
}

class ASTNode {
  constructor(kind) {
    this.kind = kind;
  }
}

class Token extends ASTNode {
  constructor(kind, text, value) {
    super(kind);
    this.text = text;
    this.value = value;
    this.start = new Location();
    this.end = new Location();
  }

  toString() {
    return `Token(${this.kind}:${this.text}:${this.value})`;
  }
}

const PUNCTUATION = {
  ':': COLON,
  '-': MINUS,
  '+': PLUS,
  '*': STAR,
  '/': SLASH,
  '%': MODULO,
  ',': COMMA,
  '{': LCURLY,
  '}': RCURLY,
  '[': LBRACK,
  ']': RBRACK,
  '(': LPAREN,
  ')': RPAREN,
  '@': AT,
  '$': DOLLAR,
  '<': LT,
  '>': GT,
  '!': NOT,
  '~': TILDE,
  '&': BITAND,
  '|': BITOR,
  '^': BITXOR,
  '.': DOT
};

const KEYWORDS = {
  'true': TRUE,
  'false': FALSE,
  'null': NONE,
  'is': IS,
  'in': IN,
  'not': NOT,
  'and': AND,
  'or': OR
};

const KEYWORD_VALUES = {
  'true': true,
  'false': false,
  'null': null
};

const ESCAPES = {
  'a': '\u0007',
  'b': '\b',
  'f': '\u000C',
  'n': '\n',
  'r': '\r',
  't': '\t',
  'v': '\u000B',
  '\\': '\\',
  '\'': '\'',
  '"': '"'
};


function is_whitespace(c) {
  return /\s/.test(c);
}

/*
 * Note: due to browser shortcomings, the \p{...} escapes aren't available in Firefox (amongst others).
 * Ways of overcoming this:
 *
 * a) Provide alternatives for use with Firefox and switch conditionally in the bundling step.
 * b) Use a third-party library such as XRegexp which will handle the browser differences for us.
 */
function is_letter(c) {
  // N.B. \p{...} not supported in Firefox :-(
  return /\p{L}/u.test(c);
}

function is_digit(c) {
  // N.B. \p{...} not supported in Firefox :-(
  return /\p{Nd}/u.test(c);
}

function is_hex_digit(c) {
  return /[0-9A-Fa-f]/.test(c);
}

function is_letter_or_digit(c) {
  // N.B. \p{...} not supported in Firefox :-(
  return /[\p{L}\p{Nd}]/u.test(c);
}

function parseEscapes(inp) {
  let result;
  var s = inp;
  let i = s.indexOf('\\');

  if (i < 0) {
    result = s;
  } else {
    let sb = '';
    let failed = false;

    while (i >= 0) {
      let n = s.length;

      if (i > 0) {
        sb += s.substring(0, i);
      }
      let c = s[i + 1];
      if (c in ESCAPES) {
        sb += ESCAPES[c];
        i += 2;
      } else if ((c == 'x') || (c == 'X') || (c == 'u') || (c == 'U')) {
        let slen;

        if ((c == 'x') || (c == 'X')) {
          slen = 4;
        } else {
          slen = (c == 'u') ? 6 : 10;
        }

        if ((i + slen) > n) {
          failed = true;
          break;
        }
        let p = s.substring(i + 2, i + slen);
        try {
          let j = parseInt(p, 16);

          if (((j >= 0xd800) && (j <= 0xdfff)) || (j >= 0x110000)) {
            failed = true;
            break;
          }
          sb += String.fromCodePoint(j);
          i += slen;
        } catch (fe) {
          failed = true;
          break;
        }
      } else {
        failed = true;
        break;
      }
      s = s.substring(i);
      i = s.indexOf('\\');
    }
    if (failed) {
      throw new TokenizerException(`Invalid escape sequence at index ${i}`);
    }
    result = sb + s;
  }
  return result;
}

var IDENTIFIER_PATTERN = /^[\p{L}_][\p{L}\p{Nd}_]*$/u;

function isIdentifier(s) {
  return IDENTIFIER_PATTERN.test(s);
}

class RecognizerException extends Error {}

class TokenizerException extends RecognizerException {}

class ParserException extends RecognizerException {}

class ConfigException extends RecognizerException {}

class InvalidPathException extends ConfigException {}

class BadIndexException extends ConfigException {}

class CircularReferenceException extends ConfigException {}

class Tokenizer {
  constructor(stream) {
    this.stream = stream;
    this.pushed_back = [];
    this.char_location = new Location();
    this.location = new Location();
    this._atEnd = false;
  }

  getChar() {
    let result;

    if (this.pushed_back.length > 0) {
      let pb = this.pushed_back.pop();
      this.char_location.update(pb.cloc);
      this.location.update(pb.loc);
      result = pb.c;
    } else {
      this.char_location.update(this.location);
      // if (!this.stream.readableFlowing) {
      //   this.stream.resume();
      // }
      result = this.stream.read(1);
      if (result === null) {
        this._atEnd = true;
      }
      if (result == '\n') {
        this.location.next_line();
      } else {
        this.location.column++;
      }
    }
    return result;
  }

  atEnd() {
    return this._atEnd;
  }

  pushBack(c) {
    if (c !== null) {
      let pb = new PushBackInfo(c, this.char_location.copy(), this.location.copy());

      this.pushed_back.push(pb);
    }
  }

  getNumber(text, start_loc, end_loc) {
    let result = INTEGER;
    let value;
    let in_exponent = false;
    let radix = 0;
    let dot_seen = text.indexOf('.') >= 0;
    let last_was_digit = is_digit(text[text.length - 1]);
    let c;

    while (true) {
      c = this.getChar();
      if (c === null) {
        break;
      }
      if (c === '.') {
        dot_seen = true;
      }
      if (c === '_') {
        if (last_was_digit) {
          text += c;
          end_loc.update(this.char_location);
          last_was_digit = false;
          continue;
        }
        let msg = `Invalid '_' in number: ${text}${c}`;
        let e = new TokenizerException(msg);

        e.location = this.char_location;
        throw e;
      }
      last_was_digit = false; // unless set in one of the clauses below
      if (((radix == 0) && (c >= '0') && (c <= '9')) ||
        ((radix == 2) && (c >= '0') && (c <= '1')) ||
        ((radix == 8) && (c >= '0') && (c <= '7')) ||
        ((radix == 16) && is_hex_digit(c))) {
        text += c;
        end_loc.update(this.char_location);
        last_was_digit = true;
      } else if (((c == 'o') || (c == 'O') || (c == 'x') ||
          (c == 'X') || (c == 'b') || (c == 'B')) &&
        (text.length == 1) && (text[0] == '0')) {
        radix = ((c == 'x') || (c == 'X')) ? 16 : (((c == 'o') || (c == 'O')) ? 8 : 2);
        text += c;
        end_loc.update(this.char_location);
      } else if ((radix == 0) && (c == '.') && !in_exponent && (text.indexOf(c) < 0)) {
        text += c;
        end_loc.update(this.char_location);
      } else if ((radix == 0) && (c == '-') && (text.indexOf('-', 1) < 0) && in_exponent) {
        text += c;
        end_loc.update(this.char_location);
      } else if ((radix == 0) && ((c == 'e') || (c == 'E')) && (text.indexOf('e') < 0) &&
        (text.indexOf('E') < 0) && (text[text.length - 1] != '_')) {
        text += c;
        end_loc.update(this.char_location);
        in_exponent = true;
      } else {
        break;
      }
    }
    // Reached the end of the actual number part. Before checking
    // for complex, ensure that the last char wasn't an underscore.
    if (text[text.length - 1] == '_') {
      let msg = `Invalid '_' at end of number: ${text}`;
      let e = new TokenizerException(msg);

      e.location = end_loc;
      throw e;
    }
    if ((radix == 0) && ((c == 'j') || (c == 'J'))) {
      text += c;
      end_loc.update(this.char_location);
      result = COMPLEX;
    } else {
      // not allowed to have a letter or digit which wasn't accepted
      if ((c !== '.') && !is_letter_or_digit(c)) {
        this.pushBack(c);
      } else if (c !== null) {
        let msg = `Invalid character in number: ${c}`;
        let e = new TokenizerException(msg);

        e.location = this.char_location;
        throw e;
      }
    }
    let s = text.replace(/_/g, '');
    if (radix !== 0) {
      value = parseInt(s.substring(2), radix);
    } else if (result == COMPLEX) {
      let imaginary = parseFloat(s.substring(0, s.length - 1));
      value = new Complex(0.0, imaginary);
    } else if (in_exponent || dot_seen) {
      result = FLOAT;
      value = parseFloat(s);
    } else {
      radix = (s[0] == '0') ? 8 : 10;
      try {
        value = parseInt(s, radix);
      } catch (fe) {
        let e = new TokenizerException(`Invalid character in number: ${s}`);

        e.location = start_loc;
        throw e;
      }
    }
    return [result, text, value];
  }

  getToken() {
    let kind = EOF;
    let text = '';
    let value;
    let start_loc = new Location();
    let end_loc = new Location();

    while (true) {
      let c = this.getChar();

      start_loc.update(this.char_location);
      end_loc.update(this.char_location);

      if (c === null) {
        break;
      }
      if (c === '#') {
        let nl_seen = false;

        text += c;
        while (true) {
          c = this.getChar();
          if (c === null) {
            break;
          }
          if (c === '\n') {
            nl_seen = true;
            break;
          }
          if (c != '\r') {
            text += c;
            continue;
          }
          c = this.getChar();
          if (c != '\n') {
            this.pushBack(c);
            break;
          }
          nl_seen = true;
        }
        kind = NEWLINE;
        if (!nl_seen) {
          this.location.next_line();
        }
        end_loc.update(this.location);
        end_loc.column -= 1;
        break;
      } else if (c === '\n') {
        text += c;
        end_loc.update(this.location);
        end_loc.column -= 1;
        kind = NEWLINE;
        break;
      } else if (c === '\r') {
        c = this.getChar();
        if (c != '\n') {
          this.pushBack(c);
        }
        kind = NEWLINE;
        this.location.next_line();
        break;
      } else if (c == '\\') {
        c = this.getChar();
        if (c !== '\n') {
          let e = new TokenizerException("Unexpected character: \\");

          e.location = this.char_location;
          throw e;
        }
        end_loc.update(this.char_location);
        continue;
      } else if (is_whitespace(c)) {
        continue;
      } else if (is_letter(c) || (c === '_')) {
        kind = WORD;
        text += c;
        end_loc.update(this.char_location);
        c = this.getChar();
        while ((c !== null) && (is_letter_or_digit(c) || (c == '_'))) {
          text += c;
          end_loc.update(this.char_location);
          c = this.getChar();
        }
        this.pushBack(c);
        value = text;
        if (text in KEYWORDS) {
          kind = KEYWORDS[text];
          if (text in KEYWORD_VALUES) {
            value = KEYWORD_VALUES[text];
          }
        }
        break;
      } else if (c === '`') {
        kind = BACKTICK;
        text += c;
        end_loc.update(this.char_location);
        while (true) {
          c = this.getChar();
          if (c === null) {
            break;
          }
          text += c;
          end_loc.update(this.char_location);
          if (c === '`') {
            break;
          }
        }
        if (c === null) {
          let msg = `Unterminated \`-string: ${text}`;
          let e = new TokenizerException(msg);

          e.location = start_loc;
          throw e;
        }
        try {
          value = parseEscapes(text.substring(1, text.length - 1));
        } catch (e) {
          e.location = start_loc;
          throw e;
        }
        break;
      } else if ((c === '\'') || (c === '\"')) {
        let quote = c;
        let multi_line = false;
        let escaped = false;
        let n;

        kind = STRING;

        text += c;

        let c1 = this.getChar();
        let c1_loc = this.char_location.copy();

        if (c1 !== quote) {
          this.pushBack(c1);
        } else {
          let c2 = this.getChar();

          if (c2 !== quote) {
            this.pushBack(c2);
            if (c2 === null) {
              this.char_location.update(c1_loc);
            }
            this.pushBack(c1);
          } else {
            multi_line = true;
            text += quote;
            text += quote;
          }
        }

        let quoter = text;

        while (true) {
          c = this.getChar();
          if (c === null) {
            break;
          }
          text += c;
          end_loc.update(this.char_location);
          if ((c === quote) && !escaped) {
            n = text.length;

            if (!multi_line || (n >= 6) && (text.substring(n - 3, n) == quoter) && text[n - 4] != '\\') {
              break;
            }
          }
          escaped = (c === '\\') ? !escaped : false;
        }
        if (c === null) {
          let msg = `Unterminated quoted string: ${text}`;
          let e = new TokenizerException(msg);

          e.location = start_loc;
          throw e;
        }
        n = quoter.length;
        let s = text;
        try {
          value = parseEscapes(s.substring(n, text.length - n));
        } catch (e) {
          e.location = start_loc;
          throw e;
        }
        break;
      } else if (is_digit(c)) {
        text += c;
        end_loc.update(this.char_location);
        let gn = this.getNumber(text, start_loc, end_loc);
        kind = gn[0];
        text = gn[1];
        value = gn[2];
        break;
      } else if (c === '=') {
        let nc = this.getChar();

        if (nc !== '=') {
          kind = ASSIGN;
          text += c;
          this.pushBack(nc);
        } else {
          kind = EQ;
          text += c + c;
          end_loc.update(this.char_location);
        }
        break
      } else if (c in PUNCTUATION) {
        kind = PUNCTUATION[c];
        text += c;
        end_loc.update(this.char_location);
        if (c === '.') {
          c = this.getChar();
          if (!is_digit(c)) {
            this.pushBack(c);
          } else {
            text += c;
            end_loc.update(this.char_location);
            let gn = this.getNumber(text, start_loc, end_loc);
            kind = gn[0];
            text = gn[1];
            value = gn[2];
          }
        } else if (c === '-') {
          c = this.getChar();
          if (!is_digit(c) && (c !== '.')) {
            this.pushBack(c);
          } else {
            text += c;
            end_loc.update(this.char_location);
            let gn = this.getNumber(text, start_loc, end_loc);
            kind = gn[0];
            text = gn[1];
            value = gn[2];
          }
        } else if (c === '<') {
          c = this.getChar();
          if (c === '=') {
            kind = LE;
            text += c;
            end_loc.update(this.char_location);
          } else if (c === '>') {
            kind = ALT_NEQ;
            text += c;
            end_loc.update(this.char_location);
          } else if (c === '<') {
            kind = LSHIFT;
            text += c;
            end_loc.update(this.char_location);
          } else {
            this.pushBack(c);
          }
        } else if (c === '>') {
          c = this.getChar();
          if (c === '=') {
            kind = GE;
            text += c;
            end_loc.update(this.char_location);
          } else if (c === '>') {
            kind = RSHIFT;
            text += c;
            end_loc.update(this.char_location);
          } else {
            this.pushBack(c);
          }
        } else if (c === '!') {
          c = this.getChar();
          if (c === '=') {
            kind = NEQ;
            text += c;
            end_loc.update(this.char_location);
          } else {
            this.pushBack(c);
          }
        } else if (c === '/') {
          c = this.getChar();
          if (c !== '/') {
            this.pushBack(c);
          } else {
            kind = SLASHSLASH;
            text += c;
            end_loc.update(this.char_location);
          }
        } else if (c === '*') {
          c = this.getChar();
          if (c != '*') {
            this.pushBack(c);
          } else {
            kind = POWER;
            text += c;
            end_loc.update(this.char_location);
          }
        } else if ((c === '&') || (c === '|')) {
          let c2 = this.getChar();

          if (c2 !== c) {
            this.pushBack(c2);
          } else {
            kind = (c2 === '&') ? AND : OR;
            text += c;
            end_loc.update(this.char_location);
          }
        }
        break;
      } else {
        let e = new TokenizerException(`Unexpected character: ${c}`);

        e.location = this.char_location;
        throw e;
      }
    }
    let result = new Token(kind, text, value);

    result.start = start_loc;
    result.end = end_loc;
    return result;
  }
}

const EXPRESSION_STARTERS = new Set();

[
  LCURLY, LBRACK, LPAREN, AT, DOLLAR, BACKTICK, PLUS, MINUS, TILDE, INTEGER, FLOAT, COMPLEX,
  TRUE, FALSE, NONE, NOT, STRING, WORD
].forEach(tk => EXPRESSION_STARTERS.add(tk));

const VALUE_STARTERS = new Set();
[
  WORD, INTEGER, FLOAT, COMPLEX, STRING, BACKTICK, NONE, TRUE, FALSE
].forEach(tk => VALUE_STARTERS.add(tk));

const COMPARISON_OPERATORS = new Set();

[
  LT, LE, GT, GE, EQ, NEQ, ALT_NEQ, IS, IN, NOT
].forEach(tk => COMPARISON_OPERATORS.add(tk));

const SCALAR_TOKENS = new Set();
[
  STRING, INTEGER, FLOAT, COMPLEX, TRUE, FALSE, NONE
].forEach(tk => SCALAR_TOKENS.add(tk));

class UnaryNode extends ASTNode {
  constructor(kind, operand) {
    super(kind);
    this.operand = operand;
  }

  toString() {
    return `UnaryNode(${this.kind}, ${this.operand})`;
  }
}

class BinaryNode extends ASTNode {
  constructor(kind, left, right) {
    super(kind);
    this.left = left;
    this.right = right;
  }

  toString() {
    return `BinaryNode(${this.kind}, ${this.left}, ${this.right})`;
  }
}

class SliceNode extends ASTNode {
  constructor(start, stop, step) {
    super(COLON);
    this.startIndex = start;
    this.stopIndex = stop;
    this.step = step;
  }

  toString() {
    return `SliceNode(${this.startIndex}:${this.stopIndex}:${this.step})`
  }
}

class ListNode extends ASTNode {
  constructor(elements) {
    super(LBRACK);
    this.elements = elements;
  }
}

class MappingNode extends ASTNode {
  constructor(elements) {
    super(LCURLY);
    this.elements = elements;
  }
}

class Parser {
  constructor(stream) {
    this.tokenizer = new Tokenizer(stream);
    this.next = this.tokenizer.getToken();
  }

  atEnd() {
    return this.next.kind == EOF;
  }

  advance() {
    this.next = this.tokenizer.getToken();
    return this.next.kind;
  }

  expect(kind) {
    let n = this.next;
    if (n.kind !== kind) {
      let e = new ParserException(`expected ${tokenRepr(kind)} but got ${tokenRepr(n.kind)}`);

      e.location = n.start;
      throw e;
    }
    let result = n;
    this.advance();
    return result;
  }

  consumeNewlines() {
    let result = this.next.kind;

    while (result == NEWLINE) {
      result = this.advance();
    }
    return result;
  }

  strings() {
    let result = this.next;

    if (this.advance() == STRING) {
      let allText = '';
      let allValue = '';
      let kind;
      let end;
      let t = result.text;
      let v = result.value;
      let start = result.start;

      do {
        allText += t;
        allValue += v;
        t = this.next.text;
        v = this.next.value;
        end = this.next.end;
        kind = this.advance();
      } while (kind == STRING);
      allText += t; // the last one
      allValue += v;
      result = new Token(STRING, allText, allValue);
      result.start.update(start);
      result.end.update(end);
    }
    return result;
  }

  value() {
    let kind = this.next.kind;
    let t;

    if (!VALUE_STARTERS.has(kind)) {
      let e = new ParserException(`Unexpected when looking for value: ${tokenRepr(kind)}`);

      e.location = this.next.start;
      throw e;
    }

    if (kind === STRING) {
      t = this.strings();
    } else {
      t = this.next;
      this.advance();
    }
    return t;
  }

  atom() {
    let kind = this.next.kind;
    let result;

    switch (kind) {
      case LCURLY:
        result = this.mapping();
        break;
      case LBRACK:
        result = this.list();
        break;
      case DOLLAR:
        this.advance();
        this.expect(LCURLY);
        let spos = this.next.start;
        result = new UnaryNode(DOLLAR, this.primary());
        result.start = spos;
        this.expect(RCURLY);
        break;
      case WORD:
      case INTEGER:
      case FLOAT:
      case COMPLEX:
      case STRING:
      case BACKTICK:
      case TRUE:
      case FALSE:
      case NONE:
        result = this.value();
        break;
      case LPAREN:
        this.advance();
        result = this.expr();
        this.expect(RPAREN);
        break;
      default:
        let e = new ParserException(`Unexpected: ${tokenRepr(kind)}`);

        e.location = this.next.start;
        throw e;
    }
    return result;
  }

  trailer() {
    let op = this.next.kind;
    let result;

    function invalidIndex(n, pos) {
      let msg = `Invalid index at ${pos}: expected 1 expression, found ${n}`;

      throw new ParserException(msg);
    }

    if (op !== LBRACK) {
      this.expect(DOT);
      result = this.expect(WORD);
    } else {
      let kind = this.advance();
      let isSlice = false;
      let startIndex = null;
      let stopIndex = null;
      let step = null;

      function getSliceElement(parser) {
        const lb = parser.listBody();
        const size = lb.elements.length;

        if (size !== 1) {
          invalidIndex(size, lb.start);
        }
        return lb.elements[0];
      }

      function tryGetStep(parser) {
        kind = parser.advance();
        if (kind !== RBRACK) {
          step = getSliceElement(parser);
        }
      }

      if (kind === COLON) {
        // it's a slice like [:xyz:abc]
        isSlice = true;
      } else {
        const elem = getSliceElement(this);

        kind = this.next.kind;
        if (kind !== COLON) {
          result = elem;
        } else {
          startIndex = elem;
          isSlice = true;
        }
      }
      if (isSlice) {
        op = COLON;
        // at this point startIndex is either null (if foo[:xyz]) or a
        // value representing the start. We are pointing at the COLON
        // after the start value
        kind = this.advance();
        if (kind === COLON) { // no stop, but there might be a step
          tryGetStep(this);
        } else if (kind !== RBRACK) {
          stopIndex = getSliceElement(this);
          kind = this.next.kind;
          if (kind === COLON) {
            tryGetStep(this);
          }
        }
        result = new SliceNode(startIndex, stopIndex, step);
      }
      this.expect(RBRACK);
    }
    return [op, result];
  }

  primary() {
    let result = this.atom();
    let kind = this.next.kind;

    while ((kind === DOT) || (kind === LBRACK)) {
      const p = this.trailer();
      result = new BinaryNode(p[0], result, p[1]);
      kind = this.next.kind;
    }
    return result;
  }

  objectKey() {
    let result;

    if (this.next.kind === STRING) {
      result = this.strings();
    } else {
      result = this.next;
      this.advance();
    }
    return result;
  }

  mappingBody() {
    const result = [];
    let kind = this.consumeNewlines();

    if ((kind !== RCURLY) && (kind !== EOF)) {
      if ((kind !== WORD) && (kind !== STRING)) {
        const e = new ParserException(`Unexpected type for key: ${tokenRepr(kind)}`);

        e.location = this.next.start;
        throw e;
      }
      while ((kind == WORD) || (kind == STRING)) {
        const key = this.objectKey();
        kind = this.next.kind;
        if ((kind !== COLON) && (kind !== ASSIGN)) {
          const e = new ParserException(`Expected key-value separator, but found ${tokenRepr(kind)}`);

          e.location = this.next.start;
          throw e;
        }
        this.advance();
        this.consumeNewlines();
        result.push([key, this.expr()]);
        kind = this.next.kind;
        if ((kind === NEWLINE) || (kind === COMMA)) {
          this.advance();
          kind = this.consumeNewlines();
        }
      }
    }
    return new MappingNode(result);
  }

  mapping() {
    this.expect(LCURLY);
    const result = this.mappingBody();
    this.expect(RCURLY);
    return result;
  }

  listBody() {
    let result = [];
    let kind = this.consumeNewlines();
    let spos = this.next.start;

    while (EXPRESSION_STARTERS.has(kind)) {
      result.push(this.expr());
      kind = this.next.kind;
      if ((kind !== NEWLINE) && (kind !== COMMA)) {
        break;
      }
      this.advance();
      kind = this.consumeNewlines();
    }
    result = new ListNode(result);
    result.start = spos;
    return result;
  }

  list() {
    this.expect(LBRACK);
    const result = this.listBody();
    this.expect(RBRACK);
    return result;
  }

  container() {
    const kind = this.consumeNewlines();
    let result;

    if (kind === LCURLY) {
      result = this.mapping();
    } else if (kind === LBRACK) {
      result = this.list();
    } else if (kind === WORD || kind === STRING || kind === EOF) {
      result = this.mappingBody();
    } else {
      const e = new ParserException(`Unexpected type for container: ${tokenRepr(kind)}`);

      e.location = this.next.start;
      throw e;
    }
    this.consumeNewlines();
    return result;
  }

  power() {
    let result = this.primary();

    while (this.next.kind === POWER) {
      this.advance();
      result = new BinaryNode(POWER, result, this.unaryExpr());
    }
    return result;
  }

  unaryExpr() {
    let result;
    const kind = this.next.kind;
    const spos = this.next.start;

    if ((kind !== PLUS) && (kind !== MINUS) && (kind !== TILDE) && (kind !== AT)) {
      result = this.power();
    } else {
      this.advance();
      return new UnaryNode(kind, this.unaryExpr());
    }
    result.start = spos;
    return result;
  }

  mulExpr() {
    let result = this.unaryExpr();
    let kind = this.next.kind;

    while ((kind === STAR) || (kind === SLASH) ||
      (kind === SLASHSLASH) || (kind === MODULO)) {
      this.advance();
      result = new BinaryNode(kind, result, this.unaryExpr());
      kind = this.next.kind;
    }
    return result;
  }

  addExpr() {
    let result = this.mulExpr();
    let kind = this.next.kind;

    while ((kind === PLUS) || (kind === MINUS)) {
      this.advance();
      result = new BinaryNode(kind, result, this.mulExpr());
      kind = this.next.kind;
    }
    return result;
  }

  shiftExpr() {
    let result = this.addExpr();
    let kind = this.next.kind;

    while ((kind === LSHIFT) || (kind === RSHIFT)) {
      this.advance();
      result = new BinaryNode(kind, result, this.addExpr());
      kind = this.next.kind;
    }
    return result;
  }

  bitandExpr() {
    let result = this.shiftExpr();

    while (this.next.kind === BITAND) {
      this.advance();
      result = new BinaryNode(BITAND, result, this.shiftExpr());
    }
    return result;
  }

  bitxorExpr() {
    let result = this.bitandExpr();

    while (this.next.kind === BITXOR) {
      this.advance();
      result = new BinaryNode(BITXOR, result, this.bitandExpr());
    }
    return result;
  }

  bitorExpr() {
    let result = this.bitxorExpr();

    while (this.next.kind === BITOR) {
      this.advance();
      result = new BinaryNode(BITOR, result, this.bitxorExpr());
    }
    return result;
  }

  compOp() {
    let result = this.next.kind;
    let shouldAdvance = false;
    const nk = this.advance();

    if ((result === IS) && (nk === NOT)) {
      result = ISNOT;
      shouldAdvance = true;
    } else if ((result === NOT) && (nk === IN)) {
      result = NOTIN;
      shouldAdvance = true;
    }
    if (shouldAdvance) {
      this.advance();
    }
    return result;
  }

  comparison() {
    let result = this.bitorExpr();

    while (COMPARISON_OPERATORS.has(this.next.kind)) {
      const op = this.compOp();

      result = new BinaryNode(op, result, this.bitorExpr());
    }
    return result
  }

  notExpr() {
    if (this.next.kind !== NOT) {
      return this.comparison();
    }
    this.advance();
    return new UnaryNode(NOT, this.notExpr());
  }

  andExpr() {
    let result = this.notExpr();

    while (this.next.kind === AND) {
      this.advance();
      result = new BinaryNode(AND, result, this.notExpr());
    }
    return result;
  }

  expr() {
    let result = this.andExpr();

    while (this.next.kind === OR) {
      this.advance();
      result = new BinaryNode(OR, result, this.andExpr());
    }
    return result;
  }
}

function makeParser(s) {
  return new Parser(makeStream(s));
}


function parse(s, rule) {
  const p = makeParser(s);

  if (typeof p[rule] !== 'function') {
    throw new Error(`unknown rule: ${rule}`);
  }
  return p[rule]();
}

// Config API

function parsePath(s) {
  try {
    const parser = makeParser(s);

    if (parser.next.kind !== WORD) {
      throw new InvalidPathException(`Invalid path: ${s}`);
    }
    let result = parser.primary();
    if (!parser.atEnd()) {
      throw new InvalidPathException(`Invalid path: ${s}`);
    }
    return result;
  } catch (e) {
    if (!(e instanceof InvalidPathException)) {
      let ipe = new InvalidPathException(`Invalid path: ${s}`);

      ipe.cause = e;
      e = ipe;
    }
    throw e;
  }
}

function* pathIterator(start) {
  function* visit(node) {
    if (node instanceof Token) {
      yield node;
    } else if (node instanceof UnaryNode) {
      yield* visit(node.operand);
    } else if (node instanceof BinaryNode) {
      yield* visit(node.left);
      switch (node.kind) {
        case DOT:
        case LBRACK:
          yield [node.kind, node.right.value];
          break;
        case COLON:
          yield [node.kind, node.right];
          break;
        default:
          throw new Error(`unexpected node ${node}`);
      }
    }
  }
  for (const it of visit(start)) {
    yield it;
  }
}

function toSource(node) {
  if (node instanceof Token) {
    return node.value.toString();
  }
  if (!(node instanceof ASTNode)) {
    return node.toString();
  }
  let pi = pathIterator(node);
  let first = pi.next();
  let parts = [];

  if (!first.done) {
    parts.push(first.value.value);
  }
  for (const item of pi) {
    let [op, operand] = item;

    switch (op) {
      case DOT:
        parts.push('.');
        parts.push(operand);
        break;
      case LBRACK:
        parts.push('[');
        parts.push(toSource(operand));
        parts.push(']');
        break;
      case COLON:
        parts.push('[');
        if (operand.startIndex !== null) {
          parts.push(toSource(operand.startIndex));
        }
        parts.push(':');
        if (operand.stopIndex !== null) {
          parts.push(toSource(operand.stopIndex));
        }
        if (operand.step !== null) {
          parts.push(':');
          parts.push(toSource(operand.step));
        }
        parts.push(']');
        break;
      default:
        throw new ConfigException(`unable to compute source for ${node}`);
    }
  }
  return parts.join('');
}

function unwrap(o) {
  if (o instanceof DictWrapper) {
    return o.asDict();
  }
  if (o instanceof ListWrapper) {
    return o.asList();
  }
  return o;
}

function stringFor(o) {
  let result;

  if (Array.isArray(o)) {
    const parts = [];

    for (let i = 0; i < o.length; i++) {
      parts.push(stringFor(o[i]));
    }
    result = `[${parts.join(', ')}]`;
  } else if (typeof o == 'object') {
    const parts = [];

    for (var key of Object.keys(o)) {
      parts.push(`${key}: ${stringFor(o[key])}`);
    }
    result = `{${parts.join(', ')}}`;
  } else {
    result = o.toString();
  }
  return result;
}

function mergeDicts(target, source) {
  for (const k in source) {
    const v = source[k];

    if ((k in target) && (typeof target[k] == 'object') && (typeof v == 'object')) {
      mergeDicts(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

function resolve(s) {
  let g = globalThis || window;
  let result = s;

  const parts = s.split('.');
  if (parts[0] in g) {
    result = g[parts.shift()];

    while (parts.length > 0) {
      if (parts[0] in result) {
        result = result[parts.shift()];
      } else {
        // failed to find something
        return s;
      }
    }
  }
  if (typeof result === 'function') {
    result = result();
  }
  return result;
}

function toComplex(v) {
  if (v instanceof Complex) {
    return v;
  }
  if (typeof v !== 'number') {
    throw new ConfigException(`cannot convert to Complex: ${v}`);
  }
  return new Complex(v, 0);
}

function intDiv(a, b) {
  const result = a / b;

  return (result >= 0) ? Math.floor(result) : Math.ceil(result);
}

var ISO_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(([ T])(((\d{2}):(\d{2}):(\d{2}))(\.\d{1,6})?(([+-])(\d{2}):(\d{2})(:(\d{2})(\.\d{1,6})?)?)?))?$/;
var ENV_VALUE_PATTERN = /^\$(\w+)(\|(.*))?$/;
var DOTTED_OBJECT_PATTERN = /^([A-Za-z_]\w*(\.[A-Za-z_]\w*)*)$/;
var INTERPOLATION_PATTERN = /\$\{([^}]+)\}/g;

function defaultStringConverter(s, cfg) {
  let result = s;
  let m = s.match(ISO_DATETIME_PATTERN);

  if (m !== null) {
    const year = parseInt(m[1]);
    const month = parseInt(m[2]);
    const day = parseInt(m[3]);
    const hasTime = m[5] !== undefined;

    if (!hasTime) {
      result = new Date(year, month - 1, day);
    } else {
      const hour = parseInt(m[8]);
      const minute = parseInt(m[9]);
      const second = parseInt(m[10]);
      const ms = m[11] === undefined ? 0 : parseFloat(m[11]) * 1.0e3;
      const hasOffset = m[13] !== undefined;

      result = new Date(year, month - 1, day, hour, minute, second, ms);
      if (hasOffset) {
        const sign = m[13] === '+' ? 1 : -1;
        const ohour = parseInt(m[14]);
        const ominute = parseInt(m[15]);
        const osecond = m[17] === undefined ? 0 : parseInt(m[17]);
        const oms = m[18] === undefined ? 0 : parseFloat(m[18]) * 1.0e3;
        const offset = oms + osecond + ominute * 60 + ohour * 3600;

        result = new Date(result.getTime() + sign * offset);
      }
    }
  } else {
    m = s.match(ENV_VALUE_PATTERN);
    if (m !== null) {
      const varName = m[1];
      const hasPipe = m[2] !== undefined;
      const dv = hasPipe ? m[3] : null;

      result = process.env[varName] || dv;
    } else {
      m = s.match(DOTTED_OBJECT_PATTERN);

      if (m !== null) {
        result = resolve(s);
      } else if (m = INTERPOLATION_PATTERN.exec(s)) {
        let cp = 0;
        const parts = [];
        let failed = false;

        while (m !== null) {
          let sp = m.index;
          let ep = INTERPOLATION_PATTERN.lastIndex;
          const path = s.substring(sp + 2, ep - 1);

          if (cp < sp) {
            parts.push(s.substring(cp, sp));
          }
          try {
            const v = cfg.get(path);

            parts.push(stringFor(v));
          } catch (e) {
            failed = true;
            break;
          }
          cp = ep;
          m = INTERPOLATION_PATTERN.exec(s);
        }
        if (!failed) {
          if (cp < s.length) {
            parts.push(s.substring(cp));
          }
          result = parts.join('');
        }
      }
    }
  }
  return result;
}

class DictWrapper {
  constructor(config, data) {
    this.config = config;
    this.data = data;
  }
  baseGet(k) {
    if (!(k in this.data)) {
      throw new ConfigException(`Not found in configuration: ${k}`);
    }
    return this.data[k];
  }
  get(k) {
    return this.config.evaluated(this.baseGet(k));
  }
  asDict() {
    const result = {};
    const cfg = this.config;

    for (let [k, v] of Object.entries(this.data)) {
      let rv = cfg.evaluated(v);

      if (rv instanceof DictWrapper) {
        rv = rv.asDict();
      } else if (rv instanceof ListWrapper) {
        rv = rv.asList();
      } else if (rv instanceof Config) {
        rv = rv.asDict();
      }
      result[k] = rv;
    }
    return result;
  }
}

class ListWrapper {
  constructor(config, data) {
    this.config = config;
    this.data = data;
  }

  baseGet(i) {
    if ((i < 0) || (i >= this.data.length)) {
      throw new ConfigException(`Index out of range: ${i}`);
    }
    return this.data[i];
  }

  get(i) {
    return this.config.evaluated(this.baseGet(i));
  }

  asList() {
    const result = [];
    const cfg = this.config;

    this.data.forEach(function (v) {
      let rv = cfg.evaluated(v);

      if (rv instanceof DictWrapper) {
        rv = rv.asDict();
      } else if (rv instanceof ListWrapper) {
        rv = rv.asList();
      } else if (rv instanceof Config) {
        rv = rv.asDict();
      }
      result.push(rv);
    });
    return result;
  }
}

const defaults = {
  noDuplicates: true,
  strictConversions: true,
  includePath: [],
  context: {},
  cached: false
};

const MISSING = new Object();
const PROPNAMES = 'noDuplicates strictConversions includePath cached'.split(' ');

class Config {
  constructor(pathOrReader, options) {
    let d = clonedeep(defaults);

    if (typeof options !== 'object') {
      options = d;
    } else {
      options = {
        ...d,
        ...options
      };
    }
    let self = this;
    PROPNAMES.forEach(function (n) {
      if (n in options) {
        self[n] = options[n];
      }
    });
    this.data = null;
    this.path = null;
    this.rootDir = null;
    this.stringConverter = defaultStringConverter;
    this.refsSeen = new Set();

    this.cache = this.cached ? {} : null;

    if (typeof pathOrReader === 'string') {
      this.loadFile(pathOrReader);
    } else if (pathOrReader instanceof stream.Readable) {
      this.load(pathOrReader);
    } else if (pathOrReader !== undefined) {
      throw new Error(`Expecting pathname or stream, got ${pathOrReader}`);
    }
  }

  setPath(p) {
    this.path = p;
    this.rootDir = path.dirname(p);
  }

  loadFile(path) {
    this.load(makeFileStream(path));
    this.setPath(path);
  }

  load(stream) {
    let p = new Parser(stream);
    let node = p.container();

    if (!(node instanceof MappingNode)) {
      throw new ConfigException('Root configuration must be a mapping');
    }
    this.data = this.wrapMapping(node);
    if (this.cache !== null) {
      this.cache = {};
    }
  }

  wrapMapping(mn) {
    let result = {};
    let noDupes = this.noDuplicates;
    let seen = noDupes ? {} : undefined;

    mn.elements.forEach(function (e) {
      const [t, v] = e;
      const k = t.value;

      if (!noDupes) {
        result[k] = v;
      } else {
        if (k in seen) {
          let msg = `Duplicate key ${k} seen at ${t.start} (previously at ${seen[k]})`;

          throw new ConfigException(msg);
        }
        seen[k] = t.start;
        result[k] = v;
      }
    });
    return new DictWrapper(this, result);
  }

  wrapList(ln) {
    return new ListWrapper(this, ln.elements);
  }

  evalAt(node) {
    let fn = this.evaluate(node.operand);

    if (typeof fn !== 'string') {
      const ce = new ConfigException(`@ operand must be a string, but is ${fn}`);

      ce.location = node.start;
      throw ce;
    }
    // The if below shouldn't be needed as you'd get an @ in an already loaded
    // configuration.
    // if (this.data === null) {
    //   throw new ConfigException('No configuration loaded');
    // }
    if (!this.rootDir) {
      throw new ConfigException('No root directory found');
    }
    let checkPath = true;

    if (!path.isAbsolute(fn)) {
      // look in rootDir, then includePath
      let p = path.join(this.rootDir, fn);

      if (isReadable(p)) {
        fn = p;
        checkPath = false;
      } else {
        let found = false;

        for (const d of this.includePath) {
          p = path.join(d, fn);
          if (isReadable(p)) {
            fn = p;
            checkPath = false;
            found = true;
            break;
          }
        }
        if (!found) {
          let ce = new ConfigException(`unable to locate ${fn}`);

          ce.location = node.operand.start;
          throw ce;
        }
      }
    }
    // fn contains the path of an existing file - try and load it
    if (checkPath && !isReadable(fn)) {
      let ce = new ConfigException(`unable to read ${fn}`);

      ce.location = node.operand.start;
      throw ce;
    }
    let stream = makeFileStream(fn);
    let parser = new Parser(stream);
    let cnode = parser.container();
    let result;

    if (!(cnode instanceof MappingNode)) {
      result = cnode;
    } else {
      let cfg = new Config();

      cfg.noDuplicates = this.noDuplicates;
      cfg.strictConversions = this.strictConversions;
      cfg.context = this.context;
      cfg.setPath(fn);
      cfg.parent = this;
      cfg.includePath = this.includePath;
      cfg.data = cfg.wrapMapping(cnode);
      result = cfg;
    }
    return result;
  }

  evalReference(node) {
    return this.getFromPath(node);
  }

  mergeDictWrappers(lhs, rhs) {
    let result = lhs.asDict();

    mergeDicts(result, rhs.asDict());
    return new DictWrapper(this, result);
  }

  evalAdd(node) {
    const lhs = this.evaluate(node.left);
    const rhs = this.evaluate(node.right);
    const tlhs = typeof lhs;
    const trhs = typeof rhs;
    let result;

    if ((lhs instanceof DictWrapper) && (rhs instanceof DictWrapper)) {
      result = this.mergeDictWrappers(lhs, rhs);
    } else if ((tlhs == 'string') && (trhs === 'string')) {
      result = lhs + rhs;
    } else if ((tlhs == 'number') && (trhs === 'number')) {
      result = lhs + rhs;
    } else if ((lhs instanceof ListWrapper) && (rhs instanceof ListWrapper)) {
      result = new ListWrapper(this, lhs.asList().concat(rhs.asList()));
    } else if ((lhs instanceof Complex) || (rhs instanceof Complex)) {
      result = toComplex(lhs).add(toComplex(rhs));
    } else {
      throw new ConfigException(`unable to add ${lhs} and ${rhs}`);
    }
    return result;
  }

  evalSubtract(node) {
    const lhs = this.evaluate(node.left);
    const rhs = this.evaluate(node.right);
    let result;

    if ((lhs instanceof DictWrapper) && (rhs instanceof DictWrapper)) {
      result = {};
      for (const [k, v] of Object.entries(lhs.data)) {
        if (!(k in rhs.data)) {
          result[k] = lhs.get(k);
        }
      }
      return new DictWrapper(lhs.config, result);
    } else if ((typeof lhs == 'number') && (typeof rhs === 'number')) {
      result = lhs - rhs;
    } else if ((lhs instanceof Complex) || (rhs instanceof Complex)) {
      result = toComplex(lhs).sub(toComplex(rhs));
    } else {
      throw new ConfigException(`unable to subtract ${rhs} from ${lhs}`);
    }
    return result;
  }

  negateNode(node) {
    const operand = this.evaluate(node.operand);

    if (operand instanceof Complex) {
      return operand.neg();
    }
    if (typeof operand !== 'number') {
      throw new ConfigException(`unable to negate ${operand}`);
    }
    return -operand;
  }

  evalMultiply(node) {
    const lhs = this.evaluate(node.left);
    const rhs = this.evaluate(node.right);
    let result;

    if ((typeof lhs == 'number') && (typeof rhs === 'number')) {
      result = lhs * rhs;
    } else if ((lhs instanceof Complex) || (rhs instanceof Complex)) {
      result = toComplex(lhs).mul(toComplex(rhs));
    } else {
      throw new ConfigException(`unable to multiply ${lhs} by ${rhs}`);
    }
    return result;
  }

  evalDivide(node) {
    const lhs = this.evaluate(node.left);
    const rhs = this.evaluate(node.right);
    let result;

    if ((typeof lhs == 'number') && (typeof rhs === 'number')) {
      result = lhs / rhs;
    } else if ((lhs instanceof Complex) || (rhs instanceof Complex)) {
      result = toComplex(lhs).div(toComplex(rhs));
    } else {
      throw new ConfigException(`unable to divide ${lhs} by ${rhs}`);
    }
    return result;
  }

  evalIntegerDivide(node) {
    const lhs = this.evaluate(node.left);
    const rhs = this.evaluate(node.right);
    let result;

    if (Number.isInteger(lhs) && Number.isInteger(rhs)) {
      result = intDiv(lhs, rhs);
    } else {
      throw new ConfigException(`unable to integer-divide ${lhs} by ${rhs}`);
    }
    return result;
  }

  evalModulo(node) {
    const lhs = this.evaluate(node.left);
    const rhs = this.evaluate(node.right);
    let result;

    if (Number.isInteger(lhs) && Number.isInteger(rhs)) {
      result = lhs % rhs;
    } else {
      throw new ConfigException(`unable to calculate ${lhs} modulo ${rhs}`);
    }
    return result;
  }

  evalPower(node) {
    const lhs = this.evaluate(node.left);
    const rhs = this.evaluate(node.right);
    let result;

    if ((typeof lhs == 'number') && (typeof rhs === 'number')) {
      result = Math.pow(lhs, rhs);
    } else if ((lhs instanceof Complex) || (rhs instanceof Complex)) {
      result = toComplex(lhs).pow(toComplex(rhs));
    } else {
      throw new ConfigException(`unable to raise ${lhs} to the power of ${rhs}`);
    }
    return result;
  }

  evalAnd(node) {
    const lhs = this.evaluate(node.left);

    if (!lhs) {
      return false;
    }
    return !!this.evaluate(node.right);
  }

  evalOr(node) {
    const lhs = this.evaluate(node.left);

    if (lhs) {
      return true;
    }
    return !!this.evaluate(node.right);
  }

  evalBitwiseOr(node) {
    const lhs = this.evaluate(node.left);
    const rhs = this.evaluate(node.right);
    const tlhs = typeof lhs;
    const trhs = typeof rhs;
    let result;

    if ((lhs instanceof DictWrapper) && (rhs instanceof DictWrapper)) {
      result = this.mergeDictWrappers(lhs, rhs);
    } else if ((tlhs == 'number') && (trhs === 'number') && Number.isInteger(lhs) && Number.isInteger(rhs)) {
      result = lhs | rhs;
    } else {
      throw new ConfigException(`unable to compute bitwise-or of ${lhs} and ${rhs}`);
    }
    return result;
  }

  evalBitwiseAnd(node) {
    const lhs = this.evaluate(node.left);
    const rhs = this.evaluate(node.right);
    const tlhs = typeof lhs;
    const trhs = typeof rhs;
    let result;

    if ((tlhs == 'number') && (trhs === 'number') && Number.isInteger(lhs) && Number.isInteger(rhs)) {
      result = lhs & rhs;
    } else {
      throw new ConfigException(`unable to compute bitwise-and of ${lhs} and ${rhs}`);
    }
    return result;
  }

  evalBitwiseXor(node) {
    const lhs = this.evaluate(node.left);
    const rhs = this.evaluate(node.right);
    const tlhs = typeof lhs;
    const trhs = typeof rhs;
    let result;

    if ((tlhs == 'number') && (trhs === 'number') && Number.isInteger(lhs) && Number.isInteger(rhs)) {
      result = lhs ^ rhs;
    } else {
      throw new ConfigException(`unable to compute bitwise-xor of ${lhs} and ${rhs}`);
    }
    return result;
  }

  evalLeftShift(node) {
    const lhs = this.evaluate(node.left);
    const rhs = this.evaluate(node.right);
    const tlhs = typeof lhs;
    const trhs = typeof rhs;
    let result;

    if ((tlhs == 'number') && (trhs === 'number') && Number.isInteger(lhs) && Number.isInteger(rhs)) {
      result = lhs << rhs;
    } else {
      throw new ConfigException(`unable to left-shift ${lhs} by ${rhs}`);
    }
    return result;
  }

  evalRightShift(node) {
    const lhs = this.evaluate(node.left);
    const rhs = this.evaluate(node.right);
    const tlhs = typeof lhs;
    const trhs = typeof rhs;
    let result;

    if ((tlhs == 'number') && (trhs === 'number') && Number.isInteger(lhs) && Number.isInteger(rhs)) {
      result = lhs >> rhs;
    } else {
      throw new ConfigException(`unable to right-shift ${lhs} by ${rhs}`);
    }
    return result;
  }

  evaluate(node) {
    let result;
    if (!(node instanceof ASTNode)) {
      throw new Error(`evaluate() called on non-node ${node}`);
    }
    const k = node.kind;
    if (node instanceof Token) {
      const v = node.value;

      if (SCALAR_TOKENS.has(k)) {
        result = v;
      } else if (k === WORD) {
        if (this.context && (v in this.context)) {
          result = this.context[v];
        } else {
          const e = new ConfigException(`Unknown variable: ${v}`);

          e.location = node.start;
          throw e;
        }
      } else if (k === BACKTICK) {
        try {
          result = this.convertString(v);
        }
        catch (err) {
          err.location = node.start;
          throw err;
        }
      } else {
        throw new ConfigException(`Unable to evaluate ${node}`);
      }
    } else if (node instanceof MappingNode) {
      result = this.wrapMapping(node);
    } else if (node instanceof ListNode) {
      result = this.wrapList(node);
    } else {
      switch (k) {
        case AT:
          result = this.evalAt(node);
          break;
        case DOLLAR:
          result = this.evalReference(node);
          break;
        case PLUS:
          result = this.evalAdd(node);
          break;
        case MINUS:
          if (node instanceof BinaryNode) {
            result = this.evalSubtract(node);
          } else {
            result = this.negateNode(node);
          }
          break;
        case STAR:
          result = this.evalMultiply(node);
          break;
        case SLASH:
          result = this.evalDivide(node);
          break;
        case SLASHSLASH:
          result = this.evalIntegerDivide(node);
          break;
        case MODULO:
          result = this.evalModulo(node);
          break;
        case POWER:
          result = this.evalPower(node);
          break;
        case BITOR:
          result = this.evalBitwiseOr(node);
          break;
        case BITAND:
          result = this.evalBitwiseAnd(node);
          break;
        case BITXOR:
          result = this.evalBitwiseXor(node);
          break;
        case LSHIFT:
          result = this.evalLeftShift(node);
          break;
        case RSHIFT:
          result = this.evalRightShift(node);
          break;
        case AND:
          result = this.evalAnd(node);
          break;
        case OR:
          result = this.evalOr(node);
          break;
        default:
          throw new ConfigException(`Unable to evaluate ${node}`);
      }
    }
    return result;
  }

  evaluated(v) {
    if (v instanceof ASTNode) {
      return this.evaluate(v);
    }
    return v;
  }

  asInt(node) {
    const result = this.evaluate(node);

    if (typeof result !== 'number') {
      throw new ConfigException(`expected number, but got ${result}`);
    }
    return result;
  }

  getSlice(container, slice) {
    let size = container.data.length;
    let step = (slice.step === null) ? 1 : this.asInt(slice.step);

    if (step === 0) {
      throw new ConfigException('slice step cannot be zero');
    }

    let startIndex = (slice.startIndex === null) ? 0 : this.asInt(slice.startIndex);

    if (startIndex < 0) {
      if (startIndex >= -size) {
        startIndex += size;
      } else {
        startIndex = 0;
      }
    } else if (startIndex >= size) {
      startIndex = size - 1;
    }

    let stopIndex;

    if (slice.stopIndex === null) {
      stopIndex = size - 1;
    } else {
      stopIndex = this.asInt(slice.stopIndex);
      if (stopIndex < 0) {
        if (stopIndex >= -size) {
          stopIndex += size;
        } else {
          stopIndex = 0;
        }
      }
      if (stopIndex > size) {
        stopIndex = size;
      }
      if (step < 0) {
        stopIndex++;
      } else {
        stopIndex--;
      }
    }
    if ((step < 0) && (startIndex < stopIndex)) {
      const tmp = stopIndex;

      stopIndex = startIndex;
      startIndex = tmp;
    }

    let result = [];
    let i = startIndex;
    let notDone = (step > 0) ? (i <= stopIndex) : (i >= stopIndex);

    while (notDone) {
      result.push(container.data[i]);
      i += step;
      notDone = (step > 0) ? (i <= stopIndex) : (i >= stopIndex);
    }
    return new ListWrapper(this, result);
  }

  getFromPath(node) {
    let pi = pathIterator(node);
    let first = pi.next();
    let result = this.baseGet(first.value.value);
    let currentCfg = this;

    function isRef(node) {
      if (!(node instanceof ASTNode)) {
        return false;
      }
      return node.kind === DOLLAR;
    }

    for (const item of pi) {
      let [op, operand] = item;
      const sliced = operand instanceof SliceNode;

      if (!sliced && (op != DOT) && (operand instanceof ASTNode)) {
        operand = currentCfg.evaluate(operand);
      }
      if (sliced && (!(result instanceof ListWrapper))) {
        throw new BadIndexException('slices can only operate on lists');
      }
      if (((result instanceof DictWrapper) ||
          (result instanceof Config)) && ((typeof operand !== 'string'))) {
        throw new BadIndexException(`string required, but found ${operand}`);
      }
      if (result instanceof DictWrapper) {
        if (operand in result.data) {
          result = result.baseGet(operand);
        } else {
          throw new ConfigException(`Not found in configuration: ${operand}`);
        }
      } else if (result instanceof Config) {
        currentCfg = result;
        result = result.baseGet(operand);
      } else if (result instanceof ListWrapper) {
        const n = result.data.length;

        if (typeof operand == 'number') {
          if (operand < 0) {
            if (operand >= -n) {
              operand += n;
            }
          }
          try {
            result = result.baseGet(operand);
          } catch (e) {
            throw new BadIndexException(`index out of range: is ${operand}, must be between 0 and ${n - 1}`);
          }
        } else if (sliced) {
          result = this.getSlice(result, operand);
        } else {
          throw new BadIndexException(`integer required, but found ${operand}`);
        }
      } else {
        // result is not a Config, DictWrapper or ListWrapper.
        // Just throw a generic "not in configuration" error
        const p = toSource(path);
        const ce = new ConfigException(`Not found in configuration: ${p}`);

        throw ce;
      }
      if (isRef(result)) {
        if (currentCfg.refsSeen.has(result)) {
          const parts = [];

          currentCfg.refsSeen.forEach(function (node) {
            parts.push(`${toSource(node)} ${node.start}`);
          });
          parts.sort();
          const msg = `Circular reference: ${parts.join(', ')}`;
          throw new CircularReferenceException(msg);
        }
        currentCfg.refsSeen.add(result);
      }
      if (result instanceof MappingNode) {
        result = currentCfg.wrapMapping(result);
      } else if (result instanceof ListNode) {
        result = currentCfg.wrapList(result);
      }
      if (result instanceof ASTNode) {
        let e = currentCfg.evaluate(result);

        if (e !== result) {
          // TODO put back in container to prevent repeated evaluations
          result = e;
        }
      }
    }
    this.refsSeen.clear();
    return result;
  }

  baseGet(k, dv = MISSING) {
    let result;

    if ((this.cache !== null) && (k in this.cache)) {
      result = this.cache[k];
    } else if (this.data === null) {
      throw new ConfigException('No data in configuration');
    } else {
      if (k in this.data.data) {
        result = this.evaluated(this.data.get(k));
      } else if (isIdentifier(k)) {
        if (dv === MISSING) {
          throw new ConfigException(`Not found in configuration: ${k}`);
        }
        result = dv;
      } else {
        // not an identifier. Treat as a path
        this.refsSeen.clear();
        try {
          result = this.getFromPath(parsePath(k));
        } catch (e) {
          if ((e instanceof InvalidPathException) ||
            (e instanceof BadIndexException) ||
            (e instanceof CircularReferenceException)) {
            throw e;
          }
          if (dv === MISSING) {
            if (e instanceof ConfigException) {
              throw e;
            }
            throw new ConfigException(`Not found in configuration: ${k}`);
          }
          result = dv;
        }
      }
      if (this.cache !== null) {
        this.cache[k] = result;
      }
    }
    return result;
  }

  get(k, dv = MISSING) {
    return unwrap(this.baseGet(k, dv));
  }

  convertString(s) {
    let result = this.stringConverter(s, this);

    if (this.strictConversions && (result === s)) {
      throw new ConfigException(`unable to convert string '${s}'`);
    }
    return result;
  }

  asDict() {
    return (this.data === null) ? {} : this.data.asDict();
  }
}

// Exports

var TokenKind = new Object();
TokenKind.EOF = EOF;
TokenKind.WORD = WORD;
TokenKind.INTEGER = INTEGER;
TokenKind.FLOAT = FLOAT;
TokenKind.COMPLEX = COMPLEX;
TokenKind.STRING = STRING;
TokenKind.NEWLINE = NEWLINE;
TokenKind.LCURLY = LCURLY;
TokenKind.RCURLY = RCURLY;
TokenKind.LBRACK = LBRACK;
TokenKind.RBRACK = RBRACK;
TokenKind.LPAREN = LPAREN;
TokenKind.RPAREN = RPAREN;
TokenKind.LT = LT;
TokenKind.GT = GT;
TokenKind.LE = LE;
TokenKind.GE = GE;
TokenKind.EQ = EQ;
TokenKind.ASSIGN = ASSIGN;
TokenKind.NEQ = NEQ;
TokenKind.ALT_NEQ = ALT_NEQ;
TokenKind.LSHIFT = LSHIFT;
TokenKind.RSHIFT = RSHIFT;
TokenKind.DOT = DOT;
TokenKind.COMMA = COMMA;
TokenKind.COLON = COLON;
TokenKind.AT = AT;
TokenKind.PLUS = PLUS;
TokenKind.MINUS = MINUS;
TokenKind.STAR = STAR;
TokenKind.POWER = POWER;
TokenKind.SLASH = SLASH;
TokenKind.TILDE = TILDE;
TokenKind.SLASHSLASH = SLASHSLASH;
TokenKind.MODULO = MODULO;
TokenKind.BACKTICK = BACKTICK;
TokenKind.DOLLAR = DOLLAR;
TokenKind.TRUE = TRUE;
TokenKind.FALSE = FALSE;
TokenKind.NONE = NONE;
TokenKind.IS = IS;
TokenKind.IN = IN;
TokenKind.NOT = NOT;
TokenKind.AND = AND;
TokenKind.OR = OR;
TokenKind.BITAND = BITAND;
TokenKind.BITOR = BITOR;
TokenKind.BITXOR = BITXOR;
TokenKind.ISNOT = ISNOT;
TokenKind.NOTIN = NOTIN;

module.exports = {
  makeStream: makeStream,
  makeFileStream: makeFileStream,
  makeParser: makeParser,
  parse: parse,
  isIdentifier: isIdentifier,
  parsePath: parsePath,
  pathIterator: pathIterator,
  toSource: toSource,
  tokenRepr: tokenRepr,
  Location: Location,
  TokenKind: TokenKind,
  Token: Token,
  Tokenizer: Tokenizer,
  Parser: Parser,
  ASTNode: ASTNode,
  UnaryNode: UnaryNode,
  BinaryNode: BinaryNode,
  SliceNode: SliceNode,
  ListNode: ListNode,
  MappingNode: MappingNode,
  Config: Config,
  RecognizerException: RecognizerException,
  ParserException: ParserException,
  ConfigException: ConfigException,
  InvalidPathException: InvalidPathException,
  BadIndexException: BadIndexException,
  CircularReferenceException: CircularReferenceException
};
