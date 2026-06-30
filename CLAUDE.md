# OpenRefine.org - Claude Development Guide

## Active Routines

### 📧 Daily Saint & Scientific Event Reminder Service
**Status**: Active Setup  
**Branch**: `claude/daily-saint-event-reminder-o8im2e`  
**Purpose**: Send daily emails at 6 AM with today's saint feast day and scientific event

#### What It Does
- Runs every day at 6 AM
- Fetches today's Catholic saint feast day
- Gets a notable scientific/historical event from Wikipedia
- Sends HTML-formatted email to `gbutrous@gmail.com`
- Logs all activities to `services/logs/reminder.log`

#### Setup Checklist
- [x] Service code created: `services/daily-saint-reminder.js`
- [x] Configuration template: `.env.example`
- [x] Documentation: `services/README.md`
- [x] Logging system with viewer
- [ ] **TODO**: Create `.env` with Gmail app password
- [ ] **TODO**: Set up cron job (see instructions below)
- [ ] **TODO**: Test with `npm run reminder:test`

#### Quick Commands
```bash
# Test the service immediately
npm run reminder:test

# View recent logs
npm run reminder:logs

# Check logs file directly
tail -f services/logs/reminder.log
```

#### Setup Instructions

**1. Environment Configuration**
```bash
cp .env.example .env
```

Edit `.env` with your Gmail credentials:
```
EMAIL_USER=gbutrous@gmail.com
EMAIL_PASSWORD=your-16-char-app-password
RECIPIENT_EMAIL=gbutrous@gmail.com
```

Get Gmail app password:
1. Visit https://myaccount.google.com/apppasswords
2. Select "Mail" and "Windows Computer"
3. Generate password (16 characters)
4. Copy to `.env` file

**2. Cron Job Setup**

**Linux/Mac - crontab:**
```bash
crontab -e
# Add: 0 6 * * * cd /home/user/openrefine.org && node services/daily-saint-reminder.js >> /var/log/saint-reminder.log 2>&1
```

**Linux - systemd (Recommended):**
See `services/README.md` for full systemd timer setup

**Windows - Task Scheduler:**
- Create new task
- Trigger: Daily at 6:00 AM
- Action: Run `node` with arguments `C:\path\to\services\daily-saint-reminder.js`
- Working directory: `C:\path\to\openrefine.org`

**3. Test**
```bash
npm run reminder:test  # Should send email immediately
npm run reminder:logs  # View logs with colors
```

#### Files
- `services/daily-saint-reminder.js` - Main service
- `services/view-logs.js` - Log viewer
- `services/logs/reminder.log` - Log file (auto-created)
- `services/README.md` - Full documentation
- `.env.example` - Configuration template
- `.env` - (create this) Actual credentials

#### Data Sources
- **Saints**: Catholic News Agency API
- **Scientific Events**: Wikipedia "On This Day" API
- **Email**: Gmail SMTP

#### Monitoring
- Check logs: `npm run reminder:logs`
- Check email inbox: `gbutrous@gmail.com`
- Manual test: `npm run reminder:test`

#### Troubleshooting
- **Email not sending**: Verify Gmail app password is 16 chars and correct
- **API errors**: Check internet connection or API availability
- **Cron not running**: Verify path is correct and node is in PATH
- **Logs not appearing**: Ensure `services/logs/` directory exists or runs first time

---

## Project Info
- **Project**: OpenRefine Documentation (Docusaurus)
- **Node**: >=18.0
- **Package Manager**: npm@9.6.7
- **Tech**: Docusaurus 3.9.2

## Useful Scripts
```bash
npm start          # Start dev server
npm build          # Build docs
npm run reminder:send   # Send reminder email
npm run reminder:test   # Test reminder
npm run reminder:logs   # View recent logs
```
