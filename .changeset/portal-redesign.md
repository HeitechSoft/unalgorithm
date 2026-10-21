---
"@unalgorithm/web": minor
"@unalgorithm/ui": patch
---

The server's pages are redesigned along Apple's Human Interface Guidelines (docs/design/portal.md). Sign-in, the
extension's sign-in and the setup link are one card under the server's name; the account and admin pages have a top
bar with the signed-in address and Sign out, and admins get a sidebar to every admin page. Type is a step larger, pages
show a spinner instead of a blank screen while they load, and every form opens in a sheet. The admin overview opens
with today's figures, lists people in a table, copies the message for an invite, and shows the server's health and its
last 30 days as a chart. `Dialog` takes a `className`, and the icon set adds Mail, Pencil and
UserRound.
