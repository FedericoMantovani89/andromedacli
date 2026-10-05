Project guidance for this Java plan:
- Write the goal of each activity as one deliverable with a clear test: an endpoint, a migration, a service method. Name the module or package and the tests that must pass.
- Keep schema changes (migrations, indexes, constraints) in their own activity for the dba profile, and ask for the backend work that depends on them only after the migration is merged.
- Two activities must not edit the same class or the same migration at once: split by module or by layer instead.
- Say in the goal which documents the work changes (README.md, CHANGELOG.md) so the last step updates them.
