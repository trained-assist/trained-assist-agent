'use strict';
// Journal hygiene (#1239): a message that is not really a task must never be resumed after a
// restart. Pings / status questions ("движется?", "упало?", "работает?") reach the engine
// (they don't match a quick intent), get journaled, and a restart then replays them as tasks —
// the user sees a nonsense "resume" of their own status ping.
//
// Deliberately conservative: the WHOLE (prefix-stripped) message must be a short, clearly
// ping-like line. A real task that merely contains a question word ("посмотри, почему упало?")
// must NOT be dropped — the anchored match guarantees that.
const PING_LIKE = new RegExp(
  '^(?:' +
    '\\/?(?:ping|пинг)' +            // /ping, пинг
    '|ты\\s+(?:живой|онлайн|работаешь|тут)' +
    '|(?:что\\s+там|как\\s+дела|ну\\s+что|как\\s+оно|что\\s+по\\s+\\S+|' +
      'движется|работает|упало|делаем|готово|есть\\s+результат|есть\\s+что|сделал|ну\\?)' +
  ')\\s*[?.!…]*$', 'i'
);

/** True when `task` is a non-task (ping / status question) that must not be resumed. */
function isNonTaskMessage(task) {
  if (!task) return false;
  // Strip gateway labels like "[Сообщение 1]" / "[Файл сохранён: …]" that prefix batched input.
  const stripped = String(task).replace(/^\s*\[[^\]]*\]\s*/gm, '').trim();
  if (!stripped) return false;
  // A ping is one short line; anything longer or multi-line is a real task.
  if (stripped.length > 40 || stripped.includes('\n')) return false;
  return PING_LIKE.test(stripped);
}

module.exports = { isNonTaskMessage, PING_LIKE };
