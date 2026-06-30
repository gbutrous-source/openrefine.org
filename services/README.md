# Daily Saint & Scientific Event Reminder Service

This service sends a daily email at 6 AM with:
- Today's date
- The main Saint's feast day
- A notable scientific event from history

## Setup Instructions

### 1. Environment Variables

Copy `.env.example` to `.env` and fill in your details:

```bash
cp .env.example .env
```

Edit `.env` with your Gmail credentials:
```
EMAIL_USER=your-gmail@gmail.com
EMAIL_PASSWORD=your-app-password
RECIPIENT_EMAIL=gbutrous@gmail.com
```

**Important:** For Gmail, you need an **App Password**, not your regular password:
1. Go to https://myaccount.google.com/apppasswords
2. Select "Mail" and "Windows Computer" (or your device)
3. Generate an app password
4. Use this 16-character password in `.env`

### 2. Test the Service

```bash
npm run reminder:test
```

This will send a test email immediately.

### 3. Schedule with Cron

#### **On Linux/Mac:**

Edit your crontab:
```bash
crontab -e
```

Add this line to run at 6 AM every day:
```cron
0 6 * * * cd /home/user/openrefine.org && node services/daily-saint-reminder.js >> /var/log/saint-reminder.log 2>&1
```

Change the path `/home/user/openrefine.org` to your actual project path.

#### **On Windows:**

Use Task Scheduler:
1. Open Task Scheduler
2. Create a new task
3. Set trigger: Daily at 6:00 AM
4. Set action: `node C:\path\to\openrefine.org\services\daily-saint-reminder.js`
5. Add working directory: `C:\path\to\openrefine.org`

Or use a batch file:
```batch
@echo off
cd C:\path\to\openrefine.org
node services\daily-saint-reminder.js >> saint-reminder.log 2>&1
```

### 4. Using systemd Timer (Linux Recommended)

Create `/etc/systemd/system/saint-reminder.service`:
```ini
[Unit]
Description=Daily Saint and Scientific Event Reminder
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=your-username
WorkingDirectory=/home/user/openrefine.org
ExecStart=/usr/bin/node /home/user/openrefine.org/services/daily-saint-reminder.js
Environment="NODE_ENV=production"
StandardOutput=journal
StandardError=journal
```

Create `/etc/systemd/system/saint-reminder.timer`:
```ini
[Unit]
Description=Daily Saint and Scientific Event Reminder Timer
Requires=saint-reminder.service

[Timer]
OnCalendar=*-*-* 06:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable and start:
```bash
sudo systemctl enable saint-reminder.timer
sudo systemctl start saint-reminder.timer
sudo systemctl status saint-reminder.timer
```

View logs:
```bash
sudo journalctl -u saint-reminder.service -f
```

## Email Configuration

### Using Gmail SMTP (Recommended for simplicity)

Already configured in the script. Just use your app password (see Setup step 1).

### Using Gmail API (Alternative)

For OAuth2 (more secure):
1. Set up Google Cloud project
2. Generate OAuth credentials
3. Update the script to use `googleapis` package
4. Store refresh token in `.env`

## Troubleshooting

### Email not sending?
- Check `.env` file has correct EMAIL_USER and EMAIL_PASSWORD
- Verify Gmail app password (16 chars, no spaces)
- Check firewall isn't blocking port 587
- Enable "Less secure apps" (if not using app password)

### Cron job not running?
- Test directly: `node services/daily-saint-reminder.js`
- Check crontab: `crontab -l`
- Check logs: `tail -f /var/log/saint-reminder.log`
- Verify node is in PATH: `which node`

### API errors?
- Some APIs may be rate-limited or unavailable
- The script has fallback messages for failed API calls
- Check internet connection

## Project Scripts

Add to `package.json`:
```json
"scripts": {
  "reminder:send": "node services/daily-saint-reminder.js",
  "reminder:test": "node services/daily-saint-reminder.js"
}
```

Then run:
```bash
npm run reminder:send
```

## Files

- `daily-saint-reminder.js` - Main service script
- `README.md` - This file
- `.env` - Environment variables (create from .env.example)

## Data Sources

- **Saint Feast Days:** Catholic News Agency API / Fallback to local data
- **Scientific Events:** Wikipedia "On This Day" API
- **Email:** Gmail SMTP

## Notes

- Times are in your local timezone
- Emails are HTML formatted for better readability
- Service logs to console and can be redirected to files
- The service exits after sending (for cron compatibility)
