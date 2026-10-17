---
'@unalgorithm/core': minor
'@unalgorithm/web': patch
'@unalgorithm/extension': patch
---

The balance's estimate follows your server's current price. The account page reads its price lines and the amounts
one purchase may add from the server's `/prices.json`, and the extension's "about N posts" uses the price in the
server's discovery document (`classifyPrice`), falling back to the bundled schedule for a server that sends none.
The extension reads that document again at most every 5 minutes while the server classifies for it, not only when
you sign in, so its price lines follow a price change too.
`creditFacts`, `creditsMarkdown` and `calculatorData` take a price book (by default `DEFAULT_PRICE_BOOK`, today's
prices) instead of a schedule, and `balanceLine` takes the server's price. No price changes.
