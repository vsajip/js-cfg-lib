'use strict';

var fs = require('fs');
var path = require('path');
const stream = require('stream');
const util = require('util');

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

class RecognizerException extends Error {}

class TokenizerException extends RecognizerException {}

class ParserException extends RecognizerException {}

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
    if ((c == '\n') || !is_whitespace(c)) {
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
        text += c;
        while (true) {
          c = this.getChar();
          if (c === null) {
            break;
          }
          if (c === '\n') {
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
        }
        kind = NEWLINE;
        this.location.next_line();
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
      let e = new ParserException(`expected ${kind} but got ${n.kind}`);

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
      let e = new ParserException(`Unexpected when looking for value: ${kind}`);

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
        let e = new ParserException(`Unexpected: ${kind}`);

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
        const e = new ParserException(`Unexpected type for key: ${kind}`);

        e.location = this.next.start;
        throw e;
      }
      while ((kind == WORD) || (kind == STRING)) {
        const key = this.objectKey();
        kind = this.next.kind;
        if ((kind !== COLON) && (kind !== ASSIGN)) {
          const e = new ParserException(`Expected key-value separator, found: ${kind}`);

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
    const result = [];
    let kind = this.consumeNewlines();

    while (EXPRESSION_STARTERS.has(kind)) {
      result.push(this.expr());
      kind = this.next.kind;
      if ((kind !== NEWLINE) && (kind !== COMMA)) {
        break;
      }
      this.advance();
      kind = this.consumeNewlines();
    }
    return new ListNode(result);
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
      const e = new ParserException(`Unexpected type for container: ${kind}`);

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
  MappingNode: MappingNode
};