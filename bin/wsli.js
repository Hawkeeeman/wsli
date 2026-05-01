#!/usr/bin/env node

const path = require('path');
const { main } = require('../dist/cli.js');

// Run main with CLI args
main(process.argv.slice(2))
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
