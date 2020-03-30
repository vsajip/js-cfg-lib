'use strict';

var stream = require('stream');
//var util = require('util');

function make_stream(s) {
  let result = new stream.Readable();

  result._read = () => {};
  result.push(s);
  result.push(null);
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

class PushbackInfo {
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
  '<': LE,
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

function is_letter_or_digit(c) {
  // N.B. \p{...} not supported in Firefox :-(
  return /[\p{L}\p{Nd}]/u.test(c);
}

function read_line(stream) {
  let result = '';
  let c = stream.read(1);

  while ((c = stream.read(1)) !== null) {
    result += c;
    if (c == '\n') {
      break;
    }
  }
  return result;
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
    this.pushed_back = [];
    this.char_location = new Location();
    this.location = new Location();
    this._at_end = false;
  }

  get_char() {
    let result;

    if (this.pushed_back.length > 0) {
      let pb = this.pushed_back.pop();
      this.char_location = pb.loc;
      this.location = pb.loc;
      result = pb.c;
    } else {
      var b = this.stream.read(1);

      result = b === null ? null : b.toString();
      if (result === null) {
        this._at_end = true;
      }
    }
    if (result == '\n') {
      this.location.next_line();
    } else {
      this.location.column++;
    }
    return result;
  }

  at_end() {
    return this._at_end;
  }

  push_back(c) {
    if ((c !== null) && ((c == '\n') || !is_whitespace(c))) {
      let pb = new PushbackInfo(c, this.char_location.copy());

      this.pushed_back.push(pb);
    }
  }

  get_token() {
    let kind = EOF;
    let text = '';
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
        text += read_line(this.stream);
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
        s = text;
        try {
          value = parse_escapes(s.substring(n, text.length - n));
        } catch (e) {
          e.location = start_loc;
          throw e;
        }
        break;
      }
      /*
                                          else if (c.isDigit()) {
                                              appendChar(text, c, endLocation)
                                              val t = getNumber(text, startLocation, endLocation)
                                              kind = t.first
                                              value = t.second
                                              break
                                          }
                                          else if (c == '=') {
                                              val nc = getChar()

                                              if (nc != '=') {
                                                  kind = TokenKind.Assign
                                                  appendChar(text, c, endLocation)
                                                  pushBack(nc)
                                              }
                                              else {
                                                  kind = TokenKind.Equal
                                                  text.append(c)
                                                  appendChar(text, c, endLocation)
                                              }
                                              break
                                          }
                                          else if (punctuation.containsKey(c)) {
                                              kind = punctuation[c] ?: error("unexpected null value in internal lookup")
                                              appendChar(text, c, endLocation)
                                              if (c == '.') {
                                                  c = getChar()
                                                  if (!c.isDigit()) {
                                                      pushBack(c)
                                                  }
                                                  else {
                                                      appendChar(text, c, endLocation)
                                                      val t = getNumber(text, startLocation, endLocation)
                                                      kind = t.first
                                                      value = t.second
                                                  }
                                              }
                                              else if (c == '-') {
                                                  c = getChar()
                                                  if (!c.isDigit() && (c != '.')) {
                                                      pushBack(c)
                                                  }
                                                  else {
                                                      appendChar(text, c, endLocation)
                                                      val t = getNumber(text, startLocation, endLocation)
                                                      kind = t.first
                                                      value = t.second
                                                  }
                                              }
                                              else if (c == '<') {
                                                  c = getChar()
                                                  when (c) {
                                                      '=' -> {
                                                          kind = TokenKind.LessThanOrEqual
                                                          appendChar(text, c, endLocation)
                                                      }
                                                      '>' -> {
                                                          kind = TokenKind.AltUnequal
                                                          appendChar(text, c, endLocation)
                                                      }
                                                      '<' -> {
                                                          kind = TokenKind.LeftShift
                                                          appendChar(text, c, endLocation)
                                                      }
                                                      else -> pushBack(c)
                                                  }
                                              }
                                              else if (c == '>') {
                                                  c = getChar()
                                                  when (c) {
                                                      '=' -> {
                                                          kind = TokenKind.GreaterThanOrEqual
                                                          appendChar(text, c, endLocation)
                                                      }
                                                      '>' -> {
                                                          kind = TokenKind.RightShift
                                                          appendChar(text, c, endLocation)
                                                      }
                                                      else -> pushBack(c)
                                                  }
                                              }
                                              else if (c == '!') {
                                                  c = getChar()
                                                  if (c == '=') {
                                                      kind = TokenKind.Unequal
                                                      appendChar(text, c, endLocation)
                                                  }
                                                  else {
                                                      pushBack(c)
                                                  }
                                              }
                                              else if (c == '/') {
                                                  c = getChar()
                                                  if (c != '/') {
                                                      pushBack(c)
                                                  }
                                                  else {
                                                      kind = TokenKind.SlashSlash
                                                      appendChar(text, c, endLocation)
                                                  }
                                              }
                                              else if (c == '*') {
                                                  c = getChar()
                                                  if (c != '*') {
                                                      pushBack(c)
                                                  }
                                                  else {
                                                      kind = TokenKind.Power
                                                      appendChar(text, c, endLocation)
                                                  }
                                              }
                                              else if ((c == '&') || (c == '|')) {
                                                  val c2 = getChar()

                                                  if (c2 != c) {
                                                      pushBack(c2)
                                                  }
                                                  else {
                                                      kind = if (c2 == '&') {
                                                          TokenKind.And
                                                      } else {
                                                          TokenKind.Or
                                                      }
                                                      appendChar(text, c2, endLocation)
                                                  }
                                              }
                                              break
                                          }
                                          else {
                                              val e = TokenizerException("Unexpected character: $c")

                                              e.location = charLocation
                                              throw e
                                          }
                               */
    }
  }
}

module.exports = {
  make_stream: make_stream,
  Location: Location,
  Token: Token,
  Tokenizer: Tokenizer
};