# consulado-bot

Avisa por Telegram cuando el Consulado de España en Buenos Aires habilita citas de alta de matrícula consular.

- `worker/`: el bot que corre solo, en Cloudflare Workers, cada minuto. Secretos: `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_IDS` (el primero es el administrador).
  - Tests: `cd worker && npm install && npm test`
  - Publicar: `npx wrangler deploy`
- `check.py` + `.github/workflows/check.yml`: versión de respaldo en Python, solo manual (GitHub casi no ejecuta crons frecuentes).
