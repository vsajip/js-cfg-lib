'use strict';

var stream = require('stream');

var expect = require('chai').expect;
var config = require('./config');
var Location = config.Location;
var Tokenizer = config.Tokenizer;

function make_stream(s) {
  let result = new stream.Readable();

  result._read = () => {};
  result.push(s);
  result.push(null);
  return result;
}

describe('Location', function() {
  it('should have correct defaults', function() {
    var loc = new Location();
    expect(loc.line).to.equal(1);
    expect(loc.column).to.equal(1);
  });
  it('should move to next line', function() {
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

describe('Tokenizer', function() {
  it('should handle at_end', function() {
    let t = new Tokenizer(make_stream(''));

    expect(t.at_end()).to.equal(false);
    let c = t.get_char();
    expect(c).to.equal(null);
    expect(t.at_end()).to.equal(true);
  });
});