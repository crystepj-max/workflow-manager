#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--help') || args.length === 0) {
  console.log('Usage: demo-cli [--help]')
  process.exit(0)
}
console.error('Unknown argument')
process.exit(2)
