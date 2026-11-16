# rules-src

Source PDFs for the AI chat's rules search. Everything in this folder except this README is
gitignored, so PDFs are never committed.

## Official free PDFs

`rules/sources.json` lists the official free downloads from warhammer-community.com that the
index is built from (title, URL, version, date). Download each file into this folder under
the `file` name given there, then rebuild:

```sh
node tools/build-rules-index.mjs
node tools/eval-rules.mjs
```

## Your own rulebooks

You may drop in PDFs you legally own, for example the Middle-earth SBG Rules Manual (a paid
book, so it is not indexed by default). Name the file after its game so the build knows
which system it belongs to:

- `40k-<anything>.pdf`
- `aos-<anything>.pdf`
- `mesbg-<anything>.pdf`, e.g. `mesbg-rules-manual.pdf`

Then run the build again. Extra files are picked up automatically.

Think before you deploy an index built from a paid book: the chat quotes short passages
from it to anyone who visits the site. Copyright stays with Games Workshop. Keep such an
index for local use unless you are sure you are allowed to publish the quotes.
