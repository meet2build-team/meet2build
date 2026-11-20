# Meet2Build

Уеб приложение за анализ на работни срещи и преобразуване на обсъдените действия в задачи за Jira.

## Технологии

- Next.js, React, TypeScript
- Tailwind CSS
- PostgreSQL и Supabase
- Groq API за транскрипция и AI анализ
- Jira REST API

## Локално стартиране

Необходим е Node.js 24 и npm.

```bash
npm ci
npm run dev
```

Приложението е достъпно на http://localhost:3000.

### С Docker

Docker е алтернативен начин за стартиране и не е задължителен.

```bash
docker compose run --rm app npm ci
docker compose up
```


## Проверки

```bash
npm run lint
npx tsc --noEmit
npm run build
```

При работа с Docker тези команди могат да се изпълнят чрез `docker compose run --rm app`.

Не се качват пароли, API ключове и локални `.env` файлове.