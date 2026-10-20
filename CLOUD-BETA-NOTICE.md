# unAlgorithm Cloud beta privacy notice

Last updated: 19 October 2026

unAlgorithm Feed by HeitechSoft hides noise in your LinkedIn and Facebook feeds. This notice covers only unAlgorithm
Cloud, HeitechSoft's hosted AI service at `cloud.unalgorithm.app`, during its beta. The extension itself is covered by
the unAlgorithm privacy policy. Someone else's unAlgorithm server is not unAlgorithm Cloud, and this
notice does not cover it.

## 1. Who we are

unAlgorithm Cloud is run by HeitechSoft, in Ontario, Canada. The beta is invite-only: you can sign in only after we
invite your email address. It is free during the beta.

## 2. What the Cloud receives, and does not keep

When you choose unAlgorithm Cloud as your AI source, the extension sends it only what is needed to classify a post:

- the post's text, capped at 2,000 characters, with email addresses and phone numbers masked, and @mentions and tagged
  names masked unless you turned that off,
- the kind of media and, for a shared link, the website's domain and title,
- whether the author is a person or a page, and whether the post is a reshare,
- your interest profile: the topics you want more and less of, your optional "About you" note, and short summaries of
  posts you rated, if you turned that on.

It never sends author names, profile links, group names, comments, images or your browsing history. Facebook posts
that aren't public are never sent: the extension leaves them out, and the Cloud refuses any that reach it.

The Cloud handles these fields in memory to classify the posts, answers, and discards them. Post text, link titles,
interest profiles, classification results, prompts and AI answers are never logged or stored. An automated test runs
the server with marker text in every field and fails if the marker shows up in any log or database table.

If you use Fact-check through the Cloud, the one post you chose is sent the same way, without your interests. If you
use UnEcho Chamber, the post's text is not sent: only the link it shares and that link's title, the platform (and, on
Facebook, who can see the post), and the web addresses and leans of the source list you chose. The Cloud asks Anthropic
to search the web for the claims in the post, or for the story's search words. The job, with the source list it
carries, is kept in memory only, and is gone at most 10 minutes after it ends.

## 3. What the Cloud stores

- Your email address. No name and no picture.
- Your devices: one row for each copy of the extension you signed in, with the short name it gave itself (such as
  "Chrome on Windows" or "Firefox on Linux"), when it signed in and when it was last used. Sign-in tokens and codes are
  stored only as hashes.
- Passkeys, if you add one: the public key and its label. Never a private key or biometric data.
- If you sign in with Google: Google's id for your Google account and the verified address Google gave. Never a Google
  access, refresh or ID token.
- Usage counts and costs: one row per AI request, with the time, the device, the number of posts, token counts, the
  model and the cost. No post content. Each quarter we publish totals of fact-checks and UnEcho Chamber comparisons
  across all accounts, never costs; totals under 10 are shown as 'fewer than 10', and nothing in them identifies an
  account.
- A credit ledger: each grant, each adjustment and, for each AI request, the number of posts, the model and the amount
  charged; never the posts. To give the starter credit once per person we keep a keyed hash of your normalised email
  address (not the address), also after the account is deleted, so the same mailbox cannot claim it again. Ledger
  entries cannot be changed. When you delete your account, its credit records are erased with it, except the keyed hash
  of your email address that keeps the starter credit to one per mailbox. Buying credit is not available during the
  beta; how records of purchases are kept will be stated here before it is.
- Synced settings, only if you turn sync on (section 4): your settings, interests and exceptions, and your own
  UnEcho Chamber source list (outlet names, web addresses and the leans you gave them). Never API keys or post text.
- For fact-checks of public posts: a 24-hour shared cache of verdicts and their short explanations, keyed by a hash of
  each claim, with the public sources found. Never the claim, the post, or who checked it.
- Problem reports that anyone sends from the extension with *Send report*, with or without an account: versions,
  counts, codes and the person's answers and, for a correction, their own words and a reply email if they gave one.
  Never an IP address or an account; deleting your account clears your address from any report that gave it. Reports
  are deleted after 90 days, a reply email 30 days after we answer and never more than 60 days after it arrived. The
  unAlgorithm privacy policy describes them in full, under *Report a problem*.
- A nightly encrypted backup of the database, kept for 14 nights.

Access logs and the server's own logs hold no post content, query strings or IP addresses. When a request fails, the
web server's error log can record your IP address and the requested address; these logs are kept for 14 days (the
host's log rotation). A sign-in page session stores your IP address and browser type and expires after one day;
expired session records are deleted when you delete your account.

## 4. Accounts and sync

You sign in with a code we email you, with Google, or with a passkey you added. Google is optional: if you use it,
Google knows you signed in to unAlgorithm Cloud, under Google's own privacy policy.

Sync is off until you turn it on in the extension. Then the Cloud stores your settings, interests and exceptions (the
names and profile identifiers you chose to always show or hide), and your own UnEcho Chamber source list (outlet names,
web addresses and the leans you gave them), one item per setting or outlet with the time it was changed.
Deleted entries are kept as markers for 90 days, then removed. A record of each sync request (which items, never their
values) is kept for 24 hours. Sync never carries API keys, endpoint tokens, refresh tokens, AI source settings, learned
topics, votes, statistics, cached results or post text, and the Cloud refuses items that look like API keys.

On your account page at `https://cloud.unalgorithm.app/account` you can see your devices and revoke any of them, add
or remove passkeys, download your data and delete your account (section 8).

## 5. Subprocessors

These companies process data for unAlgorithm Cloud:

| Subprocessor | What for | Where |
|---|---|---|
| Anthropic | Classification, and the searches for Fact-check and UnEcho Chamber | United States |
| SMTP2GO | Delivering sign-in emails (your email address and the code) | |
| OVHcloud | Hosting the server and its database | Beauharnois, Quebec, Canada |

Google is not among them: Google acts as a sign-in provider you choose, not as a processor of Cloud data. We do not use
Cloudflare, and we take no payments during the beta.

## 6. How long Anthropic keeps what it receives

Anthropic receives the post fields above, under its commercial API terms. As of 15 October 2026, Anthropic's
published retention for commercial use ([How long do you store my organization's data?](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data),
dated 1 July 2026) says it deletes inputs and outputs "within 30 days of receipt or generation". Inputs and outputs
flagged for a usage policy violation can be kept for up to 2 years. HeitechSoft has no separate retention agreement
with Anthropic yet. We will update this notice if that changes.

## 7. Sending data outside Canada

The Cloud is hosted in Canada, but post text is sent to Anthropic in the United States to be classified. Under
Quebec's privacy law (Law 25) we are assessing this transfer; that privacy impact assessment is under way.

## 8. How long we keep your data, and your rights

We keep your account data until you delete your account. Export and deletion are self-service on your account page at
`https://cloud.unalgorithm.app/account`:

- "Download your data" gives everything the Cloud stores about you as JSON: your account, devices, passkeys, Google
  link, page sessions, usage counts, synced settings and your credit ledger's entries, with no token, hash or code. The
  ledger is also shown on the account page.
- Deleting your account is immediate: it removes all of it at once, except the keyed hash of your email address
  described in section 3, and signs out every device. Your credit records are erased with it. Deleted data stays in the
  encrypted backups until they age out.

To see or correct your data, or for any other request, email the privacy contact (section 9). We answer within 30 days.
A problem report carries nothing that ties it to you: to see or delete one, mention the reference it showed you.

## 9. Contact

Privacy contact: Tom Heiber, HeitechSoft, privacy@heitechsoft.com

## 10. Changes

When this notice changes, we update the date at the top and say what changed in the release notes.
