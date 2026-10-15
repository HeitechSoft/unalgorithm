---
'@unalgorithm/server': minor
---

`SIGNUP=open` lets every address its provider verified create an account, with no allowlist or invite (the default,
`SIGNUP=allowlist`, is unchanged). Emailed sign-in codes are now limited to 5 an address an hour (was 5 in 15 minutes),
so an open server cannot be used to flood someone's mailbox; a refused request never reaches Better Auth and logs
`auth.code_limited` without the address.
