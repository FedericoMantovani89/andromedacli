Project rules (Java backend):
- Follow the existing code style, package layout and naming; do not reformat files you do not change.
- Write the tests first. Unit tests need no database; use the project's integration-test setup for anything that touches persistence.
- Database changes go through the project's migration tool, never by editing an applied migration and never by hand.
- No secrets, credentials or environment files in commits. Configuration values come from properties or environment variables.
- Keep public API changes backward compatible unless the goal says otherwise; mention a breaking change in CHANGELOG.md.
