const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'alesa-data');
const TOKEN_FILE = path.join(DATA_DIR, 'drive-watch-token.json');
const CHATS_FILE = path.join(DATA_DIR, 'drive-watch-chats.json');

// Call this on every /run request to keep the chatId list up to date
function trackChat(userId) {
  const id = String(userId);
  const chats = _readChats();
  if (!chats.includes(id)) {
    chats.push(id);
    _writeChats(chats);
    console.log('[drive-watcher] tracking new chatId:', id);
  }
}

function _readChats() {
  try { return JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')); }
  catch { return []; }
}

function _writeChats(chats) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CHATS_FILE, JSON.stringify(chats));
}

function _readToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); }
  catch { return {}; }
}

function _writeToken(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data));
}

function _mimeLabel(mimeType) {
  if (!mimeType) return 'файл';
  if (mimeType.includes('spreadsheet')) return 'таблицу';
  if (mimeType.includes('document')) return 'документ';
  if (mimeType.includes('presentation')) return 'презентацию';
  if (mimeType.includes('folder')) return 'папку';
  if (mimeType.includes('video')) return 'видео';
  return 'файл';
}

async function pollDriveChanges({ botToken, tgBase }) {
  // Skip on non-GCP VMs (no ADC available)
  if (process.env.SECRETS_SOURCE === 'env') return;

  let google;
  try {
    ({ google } = require('googleapis'));
  } catch {
    return; // package not installed
  }

  try {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const drive = google.drive({ version: 'v3', auth });

    const tokenData = _readToken();

    // First run: just store the starting page token, nothing to report yet
    if (!tokenData.startPageToken) {
      const r = await drive.changes.getStartPageToken();
      _writeToken({ startPageToken: r.data.startPageToken });
      console.log('[drive-watcher] initialized, startPageToken saved');
      return;
    }

    const r = await drive.changes.list({
      pageToken: tokenData.startPageToken,
      fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(name,webViewLink,mimeType,sharingUser))',
      includeRemoved: false,
      spaces: 'drive',
    });

    const nextToken = r.data.newStartPageToken || r.data.nextPageToken;
    if (nextToken) _writeToken({ startPageToken: nextToken });

    const newFiles = (r.data.changes || []).filter(c => !c.removed && c.file?.webViewLink);
    if (!newFiles.length) return;

    const chatIds = _readChats();
    if (!chatIds.length) {
      console.log('[drive-watcher] new files found but no chatIds tracked yet');
      return;
    }

    const tgUrl = (tgBase || 'https://api.telegram.org').replace(/\/$/, '');

    for (const change of newFiles) {
      const { name, webViewLink, mimeType, sharingUser } = change.file;
      const sharer = sharingUser?.emailAddress || sharingUser?.displayName || '?';
      const label = _mimeLabel(mimeType);
      const text = `📂 Ассистенту открыли доступ к ${label} [${name}](${webViewLink})\nОт: ${sharer}`;

      console.log(`[drive-watcher] new file: "${name}" from ${sharer}`);

      for (const chatId of chatIds) {
        await fetch(`${tgUrl}/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'Markdown',
            disable_web_page_preview: false,
          }),
        }).catch(e => console.error('[drive-watcher] tg send failed:', e.message));
      }
    }
  } catch (e) {
    console.error('[drive-watcher] poll error:', e.message);
  }
}

module.exports = { trackChat, pollDriveChanges };
