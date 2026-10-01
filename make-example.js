// Writes examples/example-block.stl from the built-in example generator.
// Run with: node tools/make-example.js
'use strict';
const fs = require('fs');
const path = require('path');
require('../js/stl.js');
require('../js/example.js');
const out = path.join(__dirname, '..', 'examples', 'example-block.stl');
fs.writeFileSync(out, Buffer.from(globalThis.IP.stl.toBinarySTL(globalThis.IP.exampleBlock())));
console.log('Wrote ' + out);
