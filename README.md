The CFG configuration format is a text format for configuration files which is similar to, and a superset of, the JSON format. It dates from [2008](https://wiki.python.org/moin/HierConfig) and has the following aims:

* Allow a hierarchical configuration scheme with support for key-value mappings and lists.
* Support cross-references between one part of the configuration and another.
* Provide the ability to compose configurations (using include and merge facilities).
* Provide the ability to access real application objects safely.

It overcomes a number of drawbacks of JSON when used as a configuration format:

* JSON is more verbose than necessary.
* JSON doesn’t allow comments.
* JSON doesn’t allow trailing commas in lists and mappings.

Installation
============
You can use this package using `npm install cfg-lib` and then `require('config')`  in your code.

Exploration
============
To explore CFG functionality for JavaScript, we can just use the `node` Read-Eval-Print-Loop (REPL). You can invoke it using
```
$ node
```

Getting Started with CFG in JavaScript
======================================
A configuration is represented by an instance of the `Config` class. The constructor for this class can be passed a filename or a stream which contains the text for the configuration. The text is read in, parsed and converted to an object that you can then query. A simple example:

```
a: 'Hello, '
b: 'world!'
c: {
  d: 'e'
}
'f.g': 'h'
christmas_morning: `2019-12-25 08:39:49`
home: `$HOME`
foo: `$FOO|bar`
```

Loading a configuration
=======================
The configuration above can be loaded as shown below. In the REPL shell:

```
> const config = require('config');
undefined
> let cfg = new Config("test0.cfg");
undefined
```

Access elements with keys
=========================
Accessing elements of the configuration with a simple key uses the `get` method:

```
> cfg.get('a')
'Hello, '
> cfg.get('b')
'world!'
```

Access elements with paths
==========================
As well as simple keys, elements  can also be accessed using `path` strings:
```
> cfg.get('c.d')
'e'
```
Here, the desired value is obtained in a single step, by (under the hood) walking the path `c.d` – first getting the mapping at key `c`, and then the value at `d` in the resulting mapping.

Note that you can have simple keys which look like paths:
```
> cfg.get('f.g')
'h'
```
If a key is given that exists in the configuration, it is used as such, and if it is not present in the configuration, an attempt is made to interpret it as a path. Thus, `f.g` is present and accessed via key, whereas `c.d` is not an existing key, so is interpreted as a path.

Access to date/time objects
===========================
You can also get native date/time objects from a configuration, by using an ISO date/time pattern in a `backtick-string`:
```
> cfg.get('christmas_morning')
2019-12-25T08:39:49.000Z
```
Access to environment variables
===============================

To access an environment variable, use a `backtick-string` of the form `$VARNAME`:
```
> cfg.get('home')
'/home/vinay'
```
You can specify a default value to be used if an environment variable isn’t present using the `$VARNAME|default-value` form. Whatever string follows the pipe character (including the empty string) is returned if `VARNAME` is not a variable in the environment.
```
> cfg.get('foo')
'bar'
```
For more information, see [the CFG documentation](https://docs.red-dove.com/cfg/index.html).
