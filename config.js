'use strict';

const stream = require('stream');
const util = require('util');
const Complex = require('complex.js');

function make_stream(s) {
  let result = new stream.Readable();

  // push stuff ready to be read, but only once the consumer is ready
  result._read = () => {
    result.push(s);
    result.push(null);
  };
  return result;
}

class Location {
  constructor(line, column) {
    this.line = line || 1;
    this.column = column || 1;
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
  constructor(c, loc) {
    this.c = c;
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

class Token {
  constructor(kind, text, value) {
    this.kind = kind;
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
  "true": TRUE,
  "false": FALSE,
  "null": NONE,
  "is": IS,
  "in": IN,
  "not": NOT,
  "and": AND,
  "or": OR
};

const KEYWORD_VALUES = {
  TRUE: true,
  FALSE: false,
  NONE: null
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

function parse_escapes(inp) {
  let result;
  var s = inp;
  var i = s.indexOf('\\');

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
          if (j < 0x10000) {
            sb += String.fromCharCode(j);
          } else {
            throw new TokenizerException('Error handling surrogate pair');
          }
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
    this.decoder = new util.TextDecoder('utf-8');
    this.decoded = '';
    this.pos = 0;
    this.pushed_back = [];
    this.char_location = new Location();
    this.location = new Location();
    this._at_end = false;
    stream.on('data', (chunk) => {
      if (Buffer.isBuffer(chunk)) {
        let s = this.decoder.decode(chunk, {stream: true});
        this.decoded += s;
      }
      else {
        this.decoded += chunk;
      }
    });
  }

  get_char() {
    let result;

    if (this.pushed_back.length > 0) {
      let pb = this.pushed_back.pop();
      this.char_location = pb.loc;
      this.location = pb.loc;
      result = pb.c;
    } else {
      this.char_location.update(this.location);
      if (this.pos < this.decoded.length) {
        result = this.decoded[this.pos++];
      } else {
        this.stream.read();
        if (this.pos < this.decoded.length) {
          result = this.decoded[this.pos++];
        } else {
          result = null;
          this._at_end = true;
          }
      }
      if (result == '\n') {
        this.location.next_line();
      } else {
        this.location.column++;
      }
    }
    return result;
  }

  at_end() {
    return this._at_end;
  }

  push_back(c) {
    if ((c !== null) && ((c == '\n') || !is_whitespace(c))) {
      let pb = new PushBackInfo(c, this.char_location.copy());

      this.pushed_back.push(pb);
    }
  }

  get_number(text, start_loc, end_loc) {
    let result = INTEGER;
    let value;
    let in_exponent = false;
    let radix = 0;
    let dot_seen = text.indexOf('.') >= 0;
    let last_was_digit = is_digit(text[text.length - 1]);
    let c;

    while (true) {
      c = this.get_char();
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
        this.push_back(c);
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

  get_token() {
    let kind = EOF;
    let text = '';
    let value;
    let start_loc = new Location();
    let end_loc = new Location();

    while (true) {
      let c = this.get_char();

      start_loc.update(this.char_location);
      end_loc.update(this.char_location);

      if (c === null) {
        break;
      }
      if (c === '#') {
        text += c;
        while (true) {
          c = this.get_char();
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
          c = this.get_char();
          if (c != '\n') {
            this.push_back(c);
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
        c = this.get_char();
        if (c != '\n') {
          this.push_back(c);
        }
        kind = NEWLINE;
        this.location.next_line();
        break;
      } else if (c == '\\') {
        c = this.get_char();
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
        c = this.get_char();
        while ((c !== null) && (is_letter_or_digit(c) || (c == '_'))) {
          text += c;
          end_loc.update(this.char_location);
          c = this.get_char();
        }
        this.push_back(c);
        value = text;
        if (text in KEYWORDS) {
          kind = KEYWORDS[text];
          if (kind in KEYWORD_VALUES) {
            value = KEYWORD_VALUES[kind];
          }
        }
        break;
      } else if (c === '`') {
        kind = BACKTICK;
        text += c;
        end_loc.update(this.char_location);
        while (true) {
          c = this.get_char();
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
          value = parse_escapes(text.substring(1, text.length - 1));
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
        end_loc.update(this.char_location);

        let c1 = this.get_char();
        let c1_loc = this.char_location.copy();

        if (c1 !== quote) {
          this.push_back(c1);
        } else {
          let c2 = this.get_char();

          if (c2 !== quote) {
            this.push_back(c2);
            if (c2 === null) {
              this.char_location.update(c1_loc);
            }
            this.push_back(c1);
          } else {
            multi_line = true;
            text += quote;
            text += quote;
          }
        }

        let quoter = text;

        while (true) {
          c = this.get_char()
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
          value = parse_escapes(s.substring(n, text.length - n));
        } catch (e) {
          e.location = start_loc;
          throw e;
        }
        break;
      } else if (is_digit(c)) {
        text += c;
        end_loc.update(this.char_location);
        let gn = this.get_number(text, start_loc, end_loc);
        kind = gn[0];
        text = gn[1];
        value = gn[2];
        break;
      } else if (c === '=') {
        let nc = this.get_char();

        if (nc !== '=') {
          kind = ASSIGN;
          text += c;
          end_loc.update(this.char_location);
          this.push_back(nc);
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
          c = this.get_char();
          if (!is_digit(c)) {
            this.push_back(c);
          } else {
            text += c;
            end_loc.update(this.char_location);
            let gn = this.get_number(text, start_loc, end_loc);
            kind = gn[0];
            text = gn[1];
            value = gn[2];
          }
        } else if (c === '-') {
          c = this.get_char();
          if (!is_digit(c) && (c !== '.')) {
            this.push_back(c);
          } else {
            text += c;
            end_loc.update(this.char_location);
            let gn = this.get_number(text, start_loc, end_loc);
            kind = gn[0];
            text = gn[1];
            value = gn[2];    
          }
        } else if (c === '<') {
          c = this.get_char();
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
            this.push_back(c);
          }
        } else if (c === '>') {
          c = this.get_char();
          if (c === '=') {
            kind = GE;
            text += c;
            end_loc.update(this.char_location);
          } else if (c === '>') {
            kind = RSHIFT;
            text += c;
            end_loc.update(this.char_location);
          } else {
            this.push_back(c);
          }
        } else if (c === '!') {
          c = this.get_char();
          if (c === '=') {
            kind = NEQ;
            text += c;
            end_loc.update(this.char_location);
          } else {
            this.push_back(c);
          }
        } else if (c === '/') {
          c = this.get_char();
          if (c !== '/') {
            this.push_back(c);
          } else {
            kind = SLASHSLASH;
            text += c;
            end_loc.update(this.char_location);
          }
        } else if (c === '*') {
          c = this.get_char();
          if (c != '*') {
            this.push_back(c);
          } else {
            kind = POWER;
            text += c;
            end_loc.update(this.char_location);
          }
        } else if ((c === '&') || (c === '|')) {
          let c2 = this.get_char();

          if (c2 !== c) {
            this.push_back(c2);
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

module.exports = {
  make_stream: make_stream,
  Location: Location,
  TokenKind: TokenKind,
  Token: Token,
  Tokenizer: Tokenizer
};