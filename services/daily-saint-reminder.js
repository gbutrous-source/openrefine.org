#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Get today's date
function getTodayDate() {
  const today = new Date();
  return today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

// Fetch saint feast day
async function getFeastDay() {
  try {
    const today = new Date();
    const month = today.getMonth() + 1;
    const day = today.getDate();

    const response = await axios.get(`https://api.catholicnewsagency.com/saint/${month}/${day}`, {
      timeout: 5000
    });

    if (response.data && response.data.saint) {
      return response.data.saint;
    }
    return 'Saint information not available';
  } catch (error) {
    return 'Saint information not available';
  }
}

// Fetch scientific event of the day
async function getScientificEvent() {
  try {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');

    const response = await axios.get(
      `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`,
      { timeout: 5000 }
    );

    if (response.data && response.data.events && response.data.events.length > 0) {
      const event = response.data.events[0];
      return `${event.year}: ${event.text}`;
    }
    return 'Scientific event information unavailable';
  } catch (error) {
    return 'Scientific event information unavailable';
  }
}

// Log to file
function logToFile(content) {
  const logsDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const logFile = path.join(logsDir, 'reminder.log');
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${content}\n`;

  fs.appendFileSync(logFile, logEntry);
}

// Main function
async function sendDailyReminder() {
  try {
    const todayDate = getTodayDate();
    console.log('\n📅 DAILY REMINDER - ' + todayDate + '\n');

    logToFile('========== DAILY REMINDER ==========');
    logToFile('Date: ' + todayDate);

    const [saintInfo, scientificEvent] = await Promise.all([
      getFeastDay(),
      getScientificEvent()
    ]);

    console.log('⛪ TODAY\'S SAINT FEAST DAY:');
    console.log('   ' + saintInfo + '\n');
    logToFile('Saint: ' + saintInfo);

    console.log('🔬 SCIENTIFIC EVENT OF THE DAY:');
    console.log('   ' + scientificEvent + '\n');
    logToFile('Event: ' + scientificEvent);

    logToFile('====================================\n');

  } catch (error) {
    console.error('Error:', error.message);
    logToFile('ERROR: ' + error.message);
  }
}

// Run the service
sendDailyReminder();
