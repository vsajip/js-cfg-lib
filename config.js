'use strict';

var stream = require('stream');
//var util = require('util');

function Location(line, column) {
  this.line = line || 1;
  this.column = column || 1;
}

Location.prototype = {
  next_line: function() {
    this.line++;
    this.column = 1;
  },

  toString: function() {
    return `(${this.line}, ${this.column})`
  },

  copy: function() {
    return new Location(this.line, this.column);
  }
};

function PushbackInfo(c, loc) {
  this.c = c;
  this.loc = loc;
}

function Tokenizer(stream) {
  this.stream = stream;
  this.pushed_back = [];
  this.char_location = new Location();
  this.location = new Location();
  this._at_end = false;
}

Tokenizer.prototype = {
  get_char: function() {
    let result;

    if (this.pushed_back.length > 0) {
      let pb = this.pushed_back.pop();
      this.char_location = pb.loc;
      this.location = pb.loc;
      result = pb.c;
    }
    else {
      var b = this.stream.read(1);

      result = b === null ? null : b.toString();
    }
    if (result === null) {
      this._at_end = true;
    }
    else {
      if (result == '\n') {
        this.location.next_line();
      }
      else {
        this.location.column++;
      }
    }
    return result;
  },

  push_back: function(c) {
    let pb = new PushbackInfo(c, this.char_location.copy());

    this.pushed_back.push(pb);
  },

  at_end: function() {
    return this._at_end;
  }
};

module.exports = {
  Location: Location,
  Tokenizer: Tokenizer
};