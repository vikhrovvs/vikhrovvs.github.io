# vikhrovvs.github.io

Личная страница с небольшими веб-проектами. Главная страница служит индексом, каждый проект живёт в собственной подпапке и не зависит от сборщика.

## Структура

```text
site/
├── index.html          # главная страница
├── home.css
└── anagrams/           # Словограф
    ├── index.html
    ├── styles.css
    ├── app.js
    └── data/graph.json
```

Чтобы добавить проект, создайте новую папку в `site/` и добавьте карточку-ссылку на главную страницу.

## Локальный запуск

```bash
python3 -m http.server 4173 --directory site
```

После запуска доступны:

- главная: http://localhost:4173/
- Словограф: http://localhost:4173/anagrams/

## Публикация

Push в `main` запускает `.github/workflows/pages.yml`. В настройках репозитория GitHub Pages должен использовать источник **GitHub Actions**.

Данные Словографа основаны на частотном списке DetCorpus под CC0. Атрибуция и способ пересборки находятся в `THIRD_PARTY_NOTICES.md` и `scripts/build-data.mjs`.
