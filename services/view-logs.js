#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const logFile = path.join(__dirname, 'logs', 'reminder.log');

console.log('\n📋 Daily Saint Reminder - Recent Logs\n');
console.log('=====================================\n');

if (!fs.existsSync(logFile)) {
  console.log('❌ No logs found yet. Run the reminder service first.\n');
  process.exit(0);
}

// Read the last 50 lines
const fileStream = fs.createReadStream(logFile);
const rl = readline.createInterface({
  input: fileStream,
  crlfDelay: Infinity
});

const lines = [];

rl.on('line', (line) => {
  lines.push(line);
});

rl.on('close', () => {
  // Show last 50 lines
  const recentLines = lines.slice(-50);

  recentLines.forEach(line => {
    // Color code by log level
    if (line.includes('[SUCCESS]')) {
      console.log('\x1b[32m' + line + '\x1b[0m'); // Green
    } else if (line.includes('[ERROR]')) {
      console.log('\x1b[31m' + line + '\x1b[0m'); // Red
    } else if (line.includes('[WARN]')) {
      console.log('\x1b[33m' + line + '\x1b[0m'); // Yellow
    } else {
      console.log(line);
    }
  });

  console.log('\n=====================================');
  console.log(`Total log entries: ${lines.length}`);
  console.log(`Log file: ${logFile}\n`);
});
