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

## Потвърждение на имейл при регистрация

Локално потвърждението е изключено (`enable_confirmations = false` в `supabase/config.toml`), затова `POST /api/auth/sign-up` създава сесия веднага.

Когато потвърждението е включено, шаблонът **Confirm signup** в Supabase (Authentication → Email Templates) трябва да сочи към `/auth/confirm`, а **Site URL** трябва да е адресът на приложението:

```html
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">Потвърди имейла</a>
```

С `&next=/път` потребителят се пренасочва към друга страница от приложението след потвърждение. Външни адреси се игнорират. При липсващ, невалиден или изтекъл линк пренасочването е към `/?error=confirmation_failed`.

## Проверки

```bash
npm run lint
npx tsc --noEmit
npm run build
```

При работа с Docker тези команди могат да се изпълнят чрез `docker compose run --rm app`.

Не се качват пароли, API ключове и локални `.env` файлове.