'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Video Analysis — разбор/анализ длинных и многих видео (интервью, созвоны).
//
// Зачем в КОДЕ скила (а не в per-user скриптах transcribe.sh/analyze.sh): пайплайн
// должен быть один для всех сессий/юзеров и попадаться в MCP, чтобы любая будущая
// сессия применила «пачку видео → разбор» без переизобретения bash-обвязки.
//
// Пайплайн на каждое видео:
//   1) resolve — прямой href (в т.ч. публичные ссылки Яндекс.Диска)
//   2) ffmpeg -vn — ОТКЛЕИВАЕМ аудиодорожку (моно 16кГц opus). Видео = 95%+ веса
//      файла и 0% пользы для расшифровки; из сотен МБ получаем пару МБ →
//      аплоад в Deepgram падает с десятков секунд до пары. Это и есть ускорение
//      «многих/длинных видео».
//   3) Deepgram (nova-2) → транскрипт
//   4) чейн в interview_analyze (тот же движок, что и для готовых транскриптов) →
//      портрет / вопросы рекрутёру / чек-лист / взвешенный скоринг + вердикт
//
// Идемпотентно и резюмируемо: транскрипт и разбор пишутся ПОФАЙЛОВО в сессию юзера;
// повторный вызов скипает готовое (force переделывает). Так пачку из 15 видео можно
// доганивать по частям — рестарт/таймаут не теряет уже сделанное.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');

const USER_ID = process.env.USER_ID || '';

function tokenBase() {
  return process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
}

// Постоянное хранилище ключа Deepgram (переживает сессии), по одному на юзера.
function keyDir() {
  const dir = path.join(tokenBase(), USER_ID, 'deepgram');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const KEY_FILE = () => path.join(keyDir(), 'key.txt');

function loadDeepgramKey() {
  if (process.env.DEEPGRAM_KEY) return process.env.DEEPGRAM_KEY.trim();
  try { return fs.readFileSync(KEY_FILE(), 'utf-8').trim(); } catch { return ''; }
}

// Рабочая директория пайплайна в сессии юзера — пофайловая, резюмируемая.
function workDir() {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  const dir = path.join(dataDir, 'sessions', USER_ID, 'video-analysis');
  fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  return dir;
}

function slugName(name) {
  return String(name || 'video')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'video';
}

// ── Яндекс.Диск: публичная ссылка → прямой href ──────────────────────────────

function resolveYandex(publicUrl) {
  return new Promise((resolve) => {
    const api = 'https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=' +
      encodeURIComponent(publicUrl);
    https.get(api, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).href || ''); } catch { resolve(''); }
      });
    }).on('error', () => resolve('')).on('timeout', function () { this.destroy(); resolve(''); });
  });
}

async function resolveSource(source) {
  const s = String(source || '').trim();
  if (/yadi\.sk|disk\.yandex/i.test(s)) {
    const href = await resolveYandex(s);
    return href || s;
  }
  return s; // локальный путь или прямой http(s)-URL — ffmpeg читает и то, и то
}

// ── ffmpeg: отклеиваем аудио (моно 16кГц opus) ───────────────────────────────

function extractAudio(input, outPath) {
  return new Promise((resolve, reject) => {
    // -vn: без видео. opus @24k моно 16кГц — крошечный, Deepgram ест ogg/opus.
    const args = ['-y', '-loglevel', 'error', '-i', input,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', outPath];
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', c => { err += c; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) resolve(outPath);
      else reject(new Error(`ffmpeg failed (code ${code}): ${err.slice(0, 300)}`));
    });
  });
}

// ── Deepgram (pre-recorded) ──────────────────────────────────────────────────

function deepgramTranscribe(key, audioBuf, language) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      model: 'nova-2',
      smart_format: 'true',
      punctuate: 'true',
      paragraphs: 'true',
    });
    if (language && language !== 'auto') qs.set('language', language);
    else qs.set('detect_language', 'true');
    const req = https.request({
      hostname: 'api.deepgram.com',
      path: `/v1/listen?${qs.toString()}`,
      method: 'POST',
      headers: {
        Authorization: `Token ${key}`,
        'Content-Type': 'audio/ogg',
        'Content-Length': audioBuf.length,
      },
      timeout: 300000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          const alt = d?.results?.channels?.[0]?.alternatives?.[0];
          const text = String(alt?.paragraphs?.transcript || alt?.transcript || '').trim();
          if (!text) return reject(new Error('Deepgram вернул пустой транскрипт (тишина/не распознано) — не кэшируем, повтор перепробует'));
          resolve(text);
        } catch { reject(new Error(`Deepgram parse error: ${data.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Deepgram timeout')); });
    req.write(audioBuf);
    req.end();
  });
}

// Тот же движок разбора, что и для готовых транскриптов — не переизобретаем.
const interviewAnalyze = require('./99-interview-analysis.js').tools.interview_analyze.handler;

// Нормализация входа: строка / список строк / список {name, source|url|path}.
function normalizeVideos(videos) {
  const arr = Array.isArray(videos) ? videos : [videos];
  return arr.map((v, i) => {
    if (typeof v === 'string') return { name: `video-${i + 1}`, source: v };
    const source = v.source || v.url || v.path || v.href || '';
    const name = v.name || v.candidate_name || v.title || `video-${i + 1}`;
    return { name, source };
  }).filter(v => v.source);
}

// ── Tools ────────────────────────────────────────────────────────────────────

module.exports = {
  isReady: () => true,
  // set-ключ виден всегда, даже пока ключ не задан — чтобы можно было настроить.
  setupTools: ['video_set_deepgram_key', 'video_analysis_status'],

  tools: {
    video_set_deepgram_key: {
      description:
        'Сохранить API-ключ Deepgram для расшифровки видео/аудио (нужен для video_analyze_batch). ' +
        'Задаётся один раз, переживает сессии. Ключ хранится только на сервере (файл в директории юзера), ' +
        'не в коде и не в ответах.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Deepgram API key (токен).' } },
        required: ['key'],
      },
      handler: async ({ key }) => {
        if (!key || !key.trim()) throw new Error('key пустой');
        fs.writeFileSync(KEY_FILE(), key.trim(), 'utf-8');
        return { saved: true, path: KEY_FILE(), hint: 'Ключ сохранён. Теперь video_analyze_batch может расшифровывать.' };
      },
    },

    video_analysis_status: {
      description: 'Показать состояние пайплайна разбора видео: задан ли ключ Deepgram, сколько транскриптов/разборов уже готово.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const dir = workDir();
        const tdir = path.join(dir, 'transcripts');
        const transcripts = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter(f => f.endsWith('.txt')) : [];
        return {
          deepgram_key_set: !!loadDeepgramKey(),
          ffmpeg: true,
          transcripts_done: transcripts.length,
          transcripts,
          work_dir: dir,
          hint: loadDeepgramKey() ? undefined : 'Ключ Deepgram не задан — вызови video_set_deepgram_key(key).',
        };
      },
    },

    video_analyze_batch: {
      description:
        'Разбор/анализ длинных и многих видео (интервью, созвоны) одним вызовом: для каждого видео ' +
        'отклеивает аудио (ffmpeg -vn, ускоряет в разы), расшифровывает через Deepgram и сразу прогоняет ' +
        'через interview_analyze (портрет / вопросы рекрутёру / чек-лист / взвешенный скоринг + вердикт по ' +
        'критериям заказчика из interview_set_criteria). Идемпотентно и резюмируемо пофайлово — пачку можно ' +
        'доганивать по частям, повтор скипает готовое. Вызывай, когда пользователь даёт видео/ссылки на ' +
        'записи интервью и просит их разобрать/оценить. Требует ключ Deepgram (video_set_deepgram_key).',
      inputSchema: {
        type: 'object',
        properties: {
          videos: {
            description: 'Видео: путь/URL строкой, список строк, или список объектов {name, source} ' +
              '(source = локальный путь, прямой http(s)-URL или публичная ссылка Яндекс.Диска).',
            type: ['array', 'string'],
          },
          criteria: { type: 'string', description: 'Опц.: критерии заказчика на эту пачку. Если не задано — берутся сохранённые (interview_set_criteria).' },
          language: { type: 'string', description: 'Опц.: язык расшифровки (ru/en/…) или "auto" для авто-детекта. Дефолт ru.' },
          model: { type: 'string', description: 'Опц.: модель OpenRouter для разбора. Дефолт google/gemini-2.5-flash.' },
          max_items: { type: 'number', description: 'Опц.: обработать не больше N новых видео за вызов (для очень больших пачек). Дефолт без лимита.' },
          transcribe_only: { type: 'boolean', description: 'Опц.: только расшифровать, без анализа.' },
          force: { type: 'boolean', description: 'Опц.: перерасшифровать/переоценить, даже если результат уже есть.' },
        },
        required: ['videos'],
      },
      handler: async ({ videos, criteria, language, model, max_items, transcribe_only, force }) => {
        const key = loadDeepgramKey();
        if (!key) {
          return {
            error: 'deepgram_key_missing',
            hint: 'Ключ Deepgram не задан. Вызови video_set_deepgram_key(key) и повтори.',
          };
        }
        const items = normalizeVideos(videos);
        if (!items.length) throw new Error('videos пустой — нет ни одного источника');

        const dir = workDir();
        const results = [];
        let processed = 0;

        for (const item of items) {
          const slug = slugName(item.name);
          const txtPath = path.join(dir, 'transcripts', `${slug}.txt`);
          const r = { name: item.name, slug };

          try {
            // 1) Транскрипт — резюмируемость: готовый переиспользуем.
            let transcript;
            if (!force && fs.existsSync(txtPath) && fs.statSync(txtPath).size > 0) {
              transcript = fs.readFileSync(txtPath, 'utf-8');
              r.transcribed = 'cached';
            } else {
              if (max_items && processed >= max_items) { r.skipped = 'max_items reached'; results.push(r); continue; }
              const src = await resolveSource(item.source);
              const audioPath = path.join(dir, 'audio', `${slug}.ogg`);
              await extractAudio(src, audioPath);
              const audioBuf = fs.readFileSync(audioPath);
              r.audio_bytes = audioBuf.length;
              transcript = await deepgramTranscribe(key, audioBuf, language || 'ru');
              fs.writeFileSync(txtPath, transcript, 'utf-8');
              fs.unlinkSync(audioPath); // аудио — промежуточное, чистим
              r.transcribed = 'ok';
              processed++;
            }
            r.transcript_chars = transcript.length;
            r.transcript_path = txtPath;

            // 2) Анализ (если не transcribe_only) — тот же движок, идемпотентный.
            if (!transcribe_only) {
              const a = await interviewAnalyze({
                transcript, candidate_name: item.name, criteria, model, force,
              });
              r.analyzed = a.cached ? 'cached' : 'ok';
              r.total_score = a.total_score ?? a.analysis?.total_score;
              r.max_score = a.max_score ?? a.analysis?.max_score;
              r.recommendation = a.recommendation ?? a.analysis?.recommendation;
              r.analysis_md_path = a.md_path;
            }
          } catch (e) {
            r.error = String(e.message || e);
          }
          results.push(r);
        }

        const ok = results.filter(x => !x.error).length;
        return {
          total: items.length,
          succeeded: ok,
          failed: results.length - ok,
          new_transcriptions: processed,
          results,
          work_dir: dir,
          hint: 'Транскрипты и разборы сохранены пофайлово — повторный вызов доганит незавершённое.',
        };
      },
    },
  },
};
