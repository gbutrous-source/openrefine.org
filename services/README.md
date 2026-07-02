# Daily Saint & Scientific Event Reminder

Simple cron job that runs at 6 AM daily and logs:
- Today's date
- Today's Catholic saint feast day
- A notable scientific/historical event from today

## Quick Start

### Test it first:
```bash
node services/daily-saint-reminder.js
```

You'll see output in your console immediately.

### Set up cron (6 AM daily):

**Linux/Mac:**
```bash
crontab -e
# Add this line:
0 6 * * * cd /home/user/openrefine.org && node services/daily-saint-reminder.js
```

**Windows:**
Use Task Scheduler to run at 6 AM daily

### View logs:
```bash
npm run reminder:logs
```

## Files
- `daily-saint-reminder.js` - Main script
- `view-logs.js` - Log viewer
- `logs/reminder.log` - Output log (auto-created)

## Data Sources
- **Saints**: Catholic News Agency API
- **Scientific Events**: Wikipedia "On This Day" API

That's all! No configuration needed.
