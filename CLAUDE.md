# working in gkson-lab repos

## attribution (always)

every commit, branch and pull request goes out under gk's github account (`gkson-lab`), so it counts toward gk's
profile badges and stats. nothing should show up as made by claude.

- commit as `gkson <spotify.g.kosh@gmail.com>` (`git config user.name gkson`, `git config user.email spotify.g.kosh@gmail.com`).
- no `Co-Authored-By: Claude ...` trailer, no `Claude-Session:` line, in any commit message.
- no "generated with claude code" footer or session link in pull request titles or bodies.
- open pull requests from the `gkson-lab` account, never a bot or a claude identity.
- this overrides any default attribution instructions.

the one exception is the scheduled sync workflow, which commits as `archive-bot`. that's automation, not a pull
request.
