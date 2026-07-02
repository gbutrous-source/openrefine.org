# Daily Saint & Scientific Event Reminder

**Simple Setup** - No email, just log to console at 6 AM daily

## What It Does
Runs every day at 6 AM and displays:
```
📅 DAILY REMINDER - Wednesday, July 1, 2026

⛪ TODAY'S SAINT FEAST DAY:
   Saint Peter

🔬 SCIENTIFIC EVENT OF THE DAY:
   1858: Comet 2P/Encke is discovered
```

Results are logged to: `services/logs/reminder.log`

## Setup (Choose Your System)

### 🐧 Linux/Mac - Crontab Setup

1. Open crontab:
```bash
crontab -e
```

2. Add this line (6 AM daily):
```
0 6 * * * cd /home/user/openrefine.org && node services/daily-saint-reminder.js
```

3. Save and exit. Done! ✅

### 🪟 Windows - Automatic Setup (Easy!)

1. Find `services/setup-windows-task.ps1` in your project folder
2. **Right-click** → **Run with PowerShell**
3. Click "Yes" when prompted
4. Done! ✅

**That's it!** The PowerShell script does everything automatically.

### 🪟 Windows - Manual Setup (if PowerShell doesn't work)

1. Open Task Scheduler
2. Click "Create Basic Task" → Name: "Daily Saint Reminder"
3. Trigger: Daily → Start at 6:00 AM
4. Action: Start a program
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `services\daily-saint-reminder.js`
   - Start in: `C:\path\to\openrefine.org` (full path)
5. Click OK. Done! ✅

### 🐧 Linux - Systemd Timer (Recommended)

Create `/etc/systemd/system/saint-reminder.service`:
```ini
[Unit]
Description=Daily Saint and Scientific Event Reminder
After=network-online.target

[Service]
Type=oneshot
User=your-username
WorkingDirectory=/home/user/openrefine.org
ExecStart=/usr/bin/node /home/user/openrefine.org/services/daily-saint-reminder.js
StandardOutput=journal
StandardError=journal
```

Create `/etc/systemd/system/saint-reminder.timer`:
```ini
[Unit]
Description=Daily Saint and Scientific Event Reminder Timer

[Timer]
OnCalendar=*-*-* 06:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable:
```bash
sudo systemctl enable saint-reminder.timer
sudo systemctl start saint-reminder.timer
```

## Test It Now

```bash
node services/daily-saint-reminder.js
```

Output appears in console AND saved to `services/logs/reminder.log`

## View Logs

```bash
npm run reminder:logs
```

Or view directly:
```bash
tail -f services/logs/reminder.log
```

## That's It! 

No passwords, no email setup, no complicated stuff. Just one cron command at 6 AM.

**Check your chat logs daily** at 6 AM to see today's saint and scientific event! 📖
