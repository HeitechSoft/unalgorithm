---
'@unalgorithm/server': minor
---

`SIGNUP=open` lets every address its provider verified create an account, with no allowlist or invite (the default,
`SIGNUP=allowlist`, is unchanged). Emailed sign-in codes are now limited to 5 an address at once, then one every 12
minutes (was one every 3 minutes), so an open server cannot be used to flood someone's mailbox; a refused request never reaches Better Auth and logs
`auth.code_limited` without the address.
