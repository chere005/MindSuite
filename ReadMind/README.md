# ReadMind

A bookshelf with notes, for CalMind accounts.

## Disclaimer

Feel free to deploy this on your own website, etc.

**This is a personal project to have some fun with claude code, which generated essentially all of the code, and the rest of this readme:**

## Quick start / Install

- Web: [seancheren.com/ReadMind](https://seancheren.com/ReadMind). Sign in with a [CalMind](https://github.com/chere005/CalMind) account.
- Your own host: plain PHP, no build step. Copy the tree and point it at a CalMind API, see Building.

## Platforms

- Web

## Usage

Search Open Library, add books to your shelf, write a rich-text note per book.

## Notes

- Sign-in is CalMind's. Nothing is stored here but your username.
- Data is encrypted JSON on disk, one file per user per kind (books, notes, preferences).
- Three instances on the host: prod, test, dev, each with its own session cookie.

## Building

```sh
php -S 127.0.0.1:8795 -t public     # sign-in needs a reachable CalMind
php tools/test.php                  # lint, store round-trip, mocked login
```

Deploy: `./deploy.sh` (test) or `./deploy.sh all`. Release: `sh tools/dtp.sh` (`--full` runs the test first). The tag is the version.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): the tree, the login, the data model, the instances, the release lane.
- [AGENTS.md](AGENTS.md): rules for anyone, human or agent, changing the code.

## Contributing

Issues and pull requests are welcome. Read AGENTS.md first; `php tools/test.php` must pass. BSD 3-Clause, see [LICENSE](LICENSE).
