// Single source of truth for every Telegram slash-command the agent recognizes in
// getQuickAnswer (src/runner.js). This is the "backend" half of the command registry —
// see trained-assist-tg-bot/commands-registry.json for the gateway half (switch-local
// commands + the forward-allowlist that must mirror `command`/`aliases` below).
//
// Why this exists: the gateway (trained-assist-tg-bot) only relays a command to the
// agent if it's in its own allowlist. New agent-side commands are invisible in Telegram
// until someone remembers to update that allowlist by hand — tests/telegram-commands.test.js
// catches the case where a registry entry here isn't actually implemented; keeping the
// gateway's copy in sync is a manual step (documented in that repo's registry file).
//
// Adding a new /command to getQuickAnswer? Add it here too, in the same PR.
const TELEGRAM_COMMANDS = [
  { command: '/ping', aliases: [], description: 'Проверка что агент онлайн' },
  { command: '/help', aliases: [], description: 'Список возможностей и подсказки по настройке' },
  { command: '/usage', aliases: [], description: 'Расход токенов и оценочная стоимость' },
  { command: '/context_on', aliases: [], description: 'Показывать карточку статуса контекста' },
  { command: '/context_off', aliases: [], description: 'Скрыть карточку статуса контекста' },
  { command: '/wakeup', aliases: [], description: 'Разбудить зависшую задачу агента' },
  { command: '/hh_status', aliases: [], description: 'Статус фоновой оценки кандидатов HeadHunter' },
  { command: '/enable_illustrate', aliases: [], description: 'Включить скил генерации иллюстраций' },
  { command: '/new_job_post', aliases: [], description: 'Начать создание новой вакансии HeadHunter' },
  { command: '/cancel_vacancy', aliases: [], description: 'Отменить текущее создание вакансии' },
  { command: '/bugreport', aliases: [], description: 'Короткий алиас для /bug_or_feature' },
  { command: '/google_drive_sharing_notifications_switch_off', aliases: [], description: 'Выключить уведомления о шаринге Google Drive' },
  { command: '/google_drive_sharing_notifications_switch_on', aliases: [], description: 'Включить уведомления о шаринге Google Drive' },
  {
    command: '/persona',
    aliases: ['/role', '/роль', '/персона', '/character', '/характер'],
    description: 'Роль ассистента для текущего профиля (без текста — показать)',
  },
  {
    command: '/project',
    aliases: ['/projects', '/проект', '/проекты'],
    description: 'Проекты профиля: список / сменить / создать',
  },
  {
    command: '/bug_or_feature',
    aliases: ['/bug', '/feature', '/баг', '/фича', '/report', '/репорт'],
    description: 'Сообщить о баге или предложить фичу — создаёт GitHub issue',
  },
  {
    command: '/get_webpass',
    aliases: ['/webpass', '/вебпароль'],
    description: 'Сгенерировать пароль для веб-интерфейса (только для себя)',
  },
];

module.exports = { TELEGRAM_COMMANDS };
