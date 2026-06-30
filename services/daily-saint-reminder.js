require('dotenv').config();
const nodemailer = require('nodemailer');
const axios = require('axios');

// Get today's date
function getTodayDate() {
  const today = new Date();
  return {
    date: today,
    formatted: today.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  };
}

// Fetch saint feast day
async function getFeastDay() {
  try {
    const today = new Date();
    const month = today.getMonth() + 1;
    const day = today.getDate();

    // Using Catholic Saints API
    const response = await axios.get(`https://api.catholicnewsagency.com/saint/${month}/${day}`);

    if (response.data && response.data.saint) {
      return response.data.saint;
    }
    return 'Saint information not available';
  } catch (error) {
    console.log('Using fallback method for saint data...');
    // Fallback: simple local database or message
    return 'Saint feast day information (API unavailable - check connection)';
  }
}

// Fetch scientific event of the day
async function getScientificEvent() {
  try {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');

    // Using Wikipedia API for "on this day" events
    const response = await axios.get(
      `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`
    );

    if (response.data && response.data.events && response.data.events.length > 0) {
      // Get the most significant event (first in the list)
      const event = response.data.events[0];
      return `${event.year}: ${event.text}`;
    }
    return 'No major scientific events recorded for today';
  } catch (error) {
    console.log('Error fetching scientific event:', error.message);
    return 'Scientific event information unavailable';
  }
}

// Send email
async function sendEmail(saintInfo, scientificEvent, todayInfo) {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      }
    });

    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; background-color: #f5f5f5; }
            .container { max-width: 600px; margin: 0 auto; background-color: white; padding: 20px; border-radius: 8px; }
            h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
            .section { margin: 20px 0; }
            .section-title { font-weight: bold; color: #3498db; font-size: 18px; margin-top: 15px; }
            .section-content { color: #333; line-height: 1.6; margin-top: 8px; }
            .date { color: #7f8c8d; font-size: 14px; margin-top: 20px; border-top: 1px solid #ecf0f1; padding-top: 10px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>📅 Daily Reminder - ${todayInfo.formatted}</h1>

            <div class="section">
              <div class="section-title">⛪ Today's Saint Feast Day</div>
              <div class="section-content">${saintInfo}</div>
            </div>

            <div class="section">
              <div class="section-title">🔬 Scientific Event of the Day</div>
              <div class="section-content">${scientificEvent}</div>
            </div>

            <div class="date">
              Sent on: ${new Date().toLocaleString()}
            </div>
          </div>
        </body>
      </html>
    `;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.RECIPIENT_EMAIL,
      subject: `Daily Reminder - ${todayInfo.formatted}`,
      html: htmlContent,
      text: `Daily Reminder\n\nDate: ${todayInfo.formatted}\n\nToday's Saint Feast Day:\n${saintInfo}\n\nScientific Event of the Day:\n${scientificEvent}`
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent successfully:', info.response);
    return true;
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
}

// Main function
async function sendDailyReminder() {
  try {
    console.log('Starting daily reminder service...');

    const todayInfo = getTodayDate();
    console.log(`Processing for: ${todayInfo.formatted}`);

    const [saintInfo, scientificEvent] = await Promise.all([
      getFeastDay(),
      getScientificEvent()
    ]);

    console.log('Saint info:', saintInfo);
    console.log('Scientific event:', scientificEvent);

    await sendEmail(saintInfo, scientificEvent, todayInfo);

    console.log('✅ Daily reminder sent successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error in daily reminder:', error);
    process.exit(1);
  }
}

// Run the service
sendDailyReminder();
