# vikhrovvs.github.io

Личная страница с небольшими веб-проектами. Главная страница служит индексом, каждый проект живёт в собственной подпапке и не зависит от сборщика.

## Структура

```text
site/
├── index.html          # главная страница
├── home.css
├── anagrams/           # Словограф и общие данные графа
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── data/graph.json
├── word-route/         # ежедневная игра на том же графе
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── word-grid/          # поиск квадрата 4 × 4 для заданных слов
    ├── index.html
    ├── styles.css
    ├── app.js
    ├── worker.js
    ├── solver.py
    └── ALGORITHM.md
```

Чтобы добавить проект, создайте новую папку в `site/` и добавьте карточку-ссылку на главную страницу.

## Локальный запуск

```bash
python3 -m http.server 4173 --directory site
```

После запуска доступны:

- главная: http://localhost:4173/
- Словограф: http://localhost:4173/anagrams/
- Словесный маршрут: http://localhost:4173/word-route/
- Словесный квадрат: http://localhost:4173/word-grid/

## Проверка

```bash
python3 scripts/check_site.py
```

Команда проверяет структуру сайта, локальные ссылки, синтаксис Python-решателя и инварианты `graph.json`. Отдельные тесты алгоритма запускаются через `python3 scripts/test_word_grid.py`. Если установлен npm, доступен эквивалентный алиас `npm run check`.

Инструкции для Codex находятся в `AGENTS.md`, а устойчивый контекст проекта — в `MEMORY.md`.

## Публикация

Push в `main` запускает `.github/workflows/pages.yml`. В настройках репозитория GitHub Pages должен использовать источник **GitHub Actions**.

Данные Словографа основаны на частотном списке DetCorpus под CC0. Атрибуция и способ пересборки находятся в `THIRD_PARTY_NOTICES.md` и `scripts/build-data.mjs`.
