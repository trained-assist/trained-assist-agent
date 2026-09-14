# Server Ops Playbook — GCP VM

SSH: `ssh vova@136.65.7.197`

---

## Статус сервиса

```bash
sudo systemctl status assist-agent --no-pager -n 20
```

## Логи (последние 50 строк)

```bash
sudo journalctl -u assist-agent --no-pager -n 50
```

## Логи в реальном времени

```bash
sudo journalctl -u assist-agent -f
```

## Рестарт сервиса

```bash
sudo systemctl restart assist-agent
```

Или из Telegram — отправь `/restart` в админ-чат.

---

## Сеть

```bash
# Что слушает на 8080
ss -tlnp | grep 8080

# Внешний IP
curl -s ifconfig.me

# Активные соединения
ss -tnp | grep 8080 | head -20

# nginx статус
sudo systemctl status nginx --no-pager -n 5

# nginx ошибки
sudo tail -20 /var/log/nginx/error.log
```

## Healthcheck

```bash
curl -s http://localhost:3000/health
```

---

## Память и диск

```bash
# Память
free -h

# Своп
swapon --show

# Диск
df -h /

# Топ процессов по памяти
ps aux --sort=-%mem | head -10
```

## CPU

```bash
# Топ по CPU
ps aux --sort=-%cpu | head -10

# Средняя нагрузка
uptime
```

---

## Активные процессы Claude

```bash
# Все запущенные claude процессы
ps aux | grep claude | grep -v grep

# Убить зависший claude процесс (по PID)
kill <PID>

# Убить все claude процессы (осторожно!)
pkill -f "claude --dangerously"
```

## Очередь задач (pending)

```bash
ls ~/agent-data/pending/ 2>/dev/null | wc -l
ls ~/agent-data/pending/ 2>/dev/null
```

---

## Секреты и конфиг

```bash
# Проверить что секреты загружены
grep -c "=" ~/secrets.env

# Посмотреть список (без значений)
grep -o "^[A-Z_]*" ~/secrets.env
```

## Обновить код вручную

```bash
cd ~/trained-assist-agent
git pull origin main
npm ci --omit=dev
sudo systemctl restart assist-agent
```

---

## Nginx

```bash
# Проверить конфиг
sudo nginx -t

# Перезагрузить без downtime
sudo systemctl reload nginx

# Статус
sudo systemctl status nginx --no-pager
```
