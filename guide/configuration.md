# Configuration

Settings live in `%APPDATA%\andromedacli\config.json` (or `CONSOLE_CONFIG_DIR`) and are edited in the **Options** dialog, which has two groups. *Global*: models, profiles, budget and limits, guard, notifications, language, prerequisites, plugins and secrets (the values here are the defaults for new projects). *This project*: the project's own settings (test command, optional test commands per moment — ticket, merge, release —, model, limits, template, copy from another open project) and git (initialise or clone). One **Save** applies every change, after checking all of them: if one is refused, nothing is saved and every refusal is listed with the limits. An invalid entry in the file never blocks the console: the default is used and the problem is shown.

The interface is translated through `src/i18n/messages_<lang>.properties` (English and Italian today; a new language is just a new file).
