// Detects "a meeting is happening" the same way Granola does on Windows:
// polls the CapabilityAccessManager consent store to see which apps are
// actively using the microphone. LastUsedTimeStop == 0 means "in use now".
const { EventEmitter } = require('events');
const { execFile } = require('child_process');

const REG_KEY = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
// our own processes + dictation tools that grab the mic briefly
const EXCLUDE = /turtle|electron|meeting-notes|wispr|flow/i;
const FRIENDLY = [
  [/teams/i, 'Microsoft Teams'],
  [/zoom/i, 'Zoom'],
  [/chrome/i, 'Google Chrome'],
  [/msedge|microsoftedge/i, 'Microsoft Edge'],
  [/firefox/i, 'Firefox'],
  [/slack/i, 'Slack'],
  [/discord/i, 'Discord'],
  [/webex/i, 'Webex'],
  [/skype/i, 'Skype'],
];

function friendly(name) {
  for (const [re, label] of FRIENDLY) if (re.test(name)) return label;
  return name;
}

function parseInUse(stdout) {
  const apps = new Set();
  let key = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) { key = line.trim(); continue; }
    if (!key || !/LastUsedTimeStop\s+REG_QWORD\s+0x0\s*$/.test(line)) continue;
    if (EXCLUDE.test(key)) continue;
    let name;
    const np = key.split(/\\NonPackaged\\/i)[1];
    if (np) {
      const exe = np.replace(/#/g, '\\').split('\\').pop();
      name = exe.replace(/\.exe$/i, '');
    } else {
      name = key.split('\\').pop().split('_')[0];
    }
    if (name && !EXCLUDE.test(name)) apps.add(friendly(name));
  }
  return [...apps];
}

class MeetingWatch extends EventEmitter {
  constructor(intervalMs = 5000) {
    super();
    this.intervalMs = intervalMs;
    this.timer = null;
    this.active = false;   // a meeting is considered ongoing
    this.busyPolls = 0;
    this.idlePolls = 0;
    this.apps = [];
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.poll();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  poll() {
    execFile('reg', ['query', REG_KEY, '/s', '/v', 'LastUsedTimeStop'],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return; // key may not exist / transient failure — just skip this poll
        const apps = parseInUse(String(stdout));
        if (apps.length > 0) {
          this.idlePolls = 0;
          this.busyPolls += 1;
          // require 2 consecutive polls so a quick dictation blip doesn't nudge
          if (!this.active && this.busyPolls >= 2) {
            this.active = true;
            this.apps = apps;
            this.emit('meeting-start', apps);
          }
        } else {
          this.busyPolls = 0;
          this.idlePolls += 1;
          if (this.active && this.idlePolls >= 2) {
            this.active = false;
            this.apps = [];
            this.emit('meeting-stop');
          }
        }
      });
  }
}

module.exports = { MeetingWatch, parseInUse };
