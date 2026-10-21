# Portal design guidelines

The portal is the set of pages an unAlgorithm server serves on its own origin (`apps/web`): sign-in, the extension's
sign-in, the setup link, the account page, the public source list and the admin pages. unAlgorithm Cloud is one such
server; anyone else's server shows the same pages under its own name.

These guidelines apply Apple's Human Interface Guidelines to that portal. The extension's own surfaces follow
[ux-spec.md](ux-spec.md); the two share `packages/ui` and should feel like one product. Where this document and
the code disagree, fix one of them in the same pull request.

## Principles

| Principle | In the portal |
|---|---|
| **Clarity** | Every page answers one question ("Who is signed in?", "What do people pay?"). Its title says which, in a word or two. Text is large enough to read without leaning in. One primary action per view |
| **Deference** | Content leads, chrome recedes. Neutral surfaces, one accent colour, no decoration that carries no meaning. The page belongs to whoever runs the server, so it shows the server's name, never the unAlgorithm logo |
| **Depth** | Overview first, detail one click away. A list shows what tells its rows apart; the rest opens in a sheet or a detail view. Editing happens in a sheet, not by unfolding forms in the middle of a list |
| **Consistency** | The same thing looks and behaves the same on every page: a person's devices and an admin's outlets are both inset grouped lists with the action at the trailing edge |
| **Feedback** | Every action answers at once: a spinner on the button that was pressed, a toast when it is done, an error next to what failed. Nothing waits on a blank screen |
| **User control** | Destructive actions ask first, in an alert that names what is lost. Cancel is always the default. Nothing is deleted by a single click |

## Structure

### The shell

Every page sits in one of two frames (`Page.tsx`):

- **Focus** (`layout="focus"`): one centred column, 440 px wide, for a single task: signing in, the extension's
  sign-in, the setup link, an error that stops the page. The server's monogram and name sit above a card that holds the
  task, and the name is the page's heading: whoever signs in sees which server they are signing in to. Nothing else
  competes with it.
- **App** (`layout="app"`): a top bar and the page. The top bar holds the server's monogram and name on the leading
  edge and, when someone is signed in, their address and *Sign out* on the trailing edge. It stays on screen while the
  page scrolls, on a translucent material.

An admin also gets a **sidebar**, laid out as the extension's Settings is (macOS System Settings): *Account*, then the
admin pages under an *Admin* heading, each with its coloured icon tile. The page that is open is marked with
`aria-current="page"`. Below 900 px the sidebar becomes a row of tabs under the top bar that scrolls sideways.

### A page

1. **Large title** (`h1`): the page's name ("Pricing"), never the server's name with a suffix. The server's name is
   already in the top bar and the browser tab (`<title>`: "Pricing · unAlgorithm Cloud").
2. **Subtitle**: one sentence of what the page is for, in secondary text. Longer explanations go in a section footer.
3. **Toolbar** (optional): the page's primary action on the trailing edge of the title ("Invite", "Add outlet").
4. **Sections**, each a heading (`h2`) and an inset grouped list, a card or a table. A section footer explains the
   section in one or two short sentences.

Content is at most 760 px wide (lists and forms) or 1120 px (tables, dashboards). Lines of prose stay under 75
characters.

### Navigation

- Pages are real addresses (`/account`, `/admin/sources`), so the back button, bookmarks and new tabs all work.
- Within a page (a report group, one report) the view changes in place, the heading takes the focus, and a *Back*
  button with a chevron sits above the heading, saying where it goes.
- A link to another page of the portal opens in place. A link to another site opens in a new tab and carries the
  external-link icon.

## Layout and spacing

- 4-point grid (`--ua-space-*`). Between sections: 32 px. Between a section heading and its content: 8 px. Inside a
  card: 16 px, 20 px on wide screens.
- Page margins: 16 px on a phone, 32 px from 900 px up.
- Rows are at least 44 px tall (Apple's minimum hit target) and 52 px with a subtitle. On a touch screen every
  control is at least 44 × 44 px; with a mouse at least 28 px tall.
- Group related things, separate unrelated ones: a separator inside a group, 32 px of space between groups. Never a
  box inside a box inside a box.

## Typography

The portal reads on a desktop browser, so its type is a step larger than the extension's. It overrides the type tokens
in `web.css`; components keep using the tokens.

| Style | Size / line | Weight | Use |
|---|---|---|---|
| Large title | 32 / 38 | Bold | The page title (`h1`) |
| Title 2 | 20 / 26 | Semibold | Section headings (`h2`), sheet titles |
| Title 3 | 17 / 22 | Semibold | Card titles, the account's address |
| Headline | 15 / 20 | Semibold | Row titles that need weight, labels of figures |
| Body | 15 / 22 | Regular | Row titles, prose, fields |
| Callout | 14 / 20 | Regular | Banners, sheet descriptions |
| Subhead | 13 / 18 | Medium | Field labels, list group headers (`h3`) |
| Footnote | 13 / 18 | Regular | Row subtitles, section footers |
| Caption | 12 / 16 | Medium | Badges, chart axes |
| Figure | 40 / 44 | Bold | The one number a card is about (a balance) |

- System font stack (San Francisco on Apple devices, Segoe UI Variable on Windows).
- Figures use tabular numerals (`font-variant-numeric: tabular-nums`) and line up on the trailing edge.
- Never below 12 px. Secondary text uses `--ua-text-secondary`, never a lighter grey than that for anything that must
  be read.

## Colour and materials

- **Neutral surfaces**: the page is `--ua-bg-grouped`; cards and lists are `--ua-bg-grouped-raised`. Elevation comes
  from the surface colour and a hairline shadow (`--ua-shadow-1`), not from borders.
- **One accent**: Lagoon (`--ua-accent`) marks what can be pressed and what is selected. The primary button is the
  only filled accent on a view.
- **Semantic colour only for meaning**: green for healthy or credit added, orange for needs attention, red for errors
  and destructive actions, Iris (`--ua-ai`) only for AI. Colour never stands alone: a status dot has a word next to it,
  a chart has labels and a table.
- **Materials** (`--ua-material-*`) only on layers that float over content: the top bar, toasts. Each has an opaque
  fallback for `prefers-reduced-transparency`.
- **Dark mode** follows the system. Every colour is a token defined with `light-dark()`; nothing is hard-coded.

## Components

All from `@unalgorithm/ui`, with the portal's own pieces in `apps/web/src/ui.tsx`.

### Lists (inset grouped)

The default way to show a set of things. A row has a leading icon tile when the rows are of different kinds, a title,
an optional subtitle, and one trailing element: a figure, a control, a button or a chevron.

- **Subtitles** say at most two or three things, separated by " · ". A row that needs more facts shows them as
  separate figures (a dashboard tile, a sheet), not as a longer chain.
- **Actions that add** are the group's last row, in accent colour with a plus: "Add a passkey". Not a floating
  button under the list.
- **Empty lists** show one row in secondary text saying so ("No passkeys yet."), and the add row if there is one.
- **A row that opens something** is the whole row (a button or a link) with a chevron. Where a row also holds other
  controls (a report group's resolution and *Mark handled*), it keeps a *View* button instead.

### Buttons

| Kind | Use |
|---|---|
| Primary (filled accent) | The one action the view is for: "Send code", "Save", "Add credit". At most one per view |
| Secondary (grey fill) | Other actions: "Sign out", "Manage", "Cancel" |
| Plain (accent text) | Quiet actions in a line of text or a toolbar: "Back", "Use another email" |
| Destructive (red tint) | Starts a destructive action, which then asks: "Remove…" |
| Destructive solid (red fill) | Only inside the alert that confirms it |

- Labels are verbs: "Remove access", not "Access". House style is sentence case ("Add a passkey"), as in the extension.
- A trailing ellipsis ("Delete account…") means the action needs more input before it runs (here, the address typed
  again). A plain confirmation alert doesn't earn one: "Revoke", "Remove".
- A button that sends a request shows its spinner and is disabled until the answer; the rest of the view stays
  usable unless it would conflict.
- In a sheet or a form the primary button is on the trailing edge, Cancel before it. On a phone they stack, primary on
  top.
- A disabled Save says why, in a footnote under it. Never a disabled button without a reason in sight.

### Forms and fields

- Labels sit above fields, in Subhead. Hints sit below, in Footnote; an error replaces the hint, in red, once the
  person has left the field or tried to save.
- Fields are 40 px tall (44 px on the focus pages), 15 px text, and fill the width of their sheet or card up to 400 px.
- The keyboard fits the field: `type="email"`, `inputMode="numeric"`, `autoComplete="one-time-code"`.
- Pressing Return submits. The first field has the focus when a sheet opens.

### Sheets, alerts and inline confirmation

| Pattern | Use | Built with |
|---|---|---|
| **Sheet** | Editing or creating something with more than one field: an outlet, a price, a person's settings | `Sheet` (a modal `Dialog`, 560 px) |
| **Alert** | Confirming something destructive or irreversible: delete, revoke, remove access | `Dialog alert`, Cancel focused first |
| **Inline** | A single field next to its value, a toggle that applies at once | In the row |

Alerts name what will happen, not "Are you sure?": "Revoke Chrome on Windows? It's signed out at once and has to
sign in again." The destructive button repeats the verb ("Revoke"), never "OK".

### Feedback

- **Loading**: a page shows a centred spinner that fades in after 300 ms (`PageLoading`); a section shows its heading
  and a spinner where its rows will be (`SectionLoading`). Never a blank page. `aria-busy` marks what is loading.
- **Success**: a toast for a change the person can't otherwise see ("Passkey removed."); none when the change is
  visible in place.
- **Errors**: a banner at the top of what failed, with *Try again* when trying again can help. Field errors stay next
  to their field.
- **Status**: a coloured dot and a word ("Healthy", "Failed"), never colour alone.

### Figures, charts and tables

- A dashboard opens with **stat tiles**: a label, one large figure and at most one line of context ("of $5.00 a day").
- **Charts** are simple bars with a value on hover, hidden from screen readers, with the same numbers as a table
  under *Show as a table* (`<details>`). One colour per series, labelled in a legend.
- **Tables** are for data people compare across rows (outlets, daily usage): header in Footnote secondary, rows 44 px,
  figures right-aligned, the table scrolling sideways inside its card on a narrow screen. Not for anything a list can
  show.

### Badges

Small capsules for a state a row is in ("Admin", "Removed", "Late"), in the tint of its meaning. One or two per row.

## Writing

- Calm, short, plain, as in [ux-spec.md](ux-spec.md#voice). Say what happened and what to do next.
- Name things the way the person knows them: "Devices", not "Sessions"; "Sign out", not "Log out".
- Numbers: "1,200 posts", "$0.15", "Oct 15, 2026". Times the server keeps in UTC say "UTC".
- Don't repeat the page title in every section, or a section heading in every row.

## Accessibility

- Landmarks: `header` (top bar), `nav` (sidebar), `main`, `footer`. One `h1` per page; headings in order.
- Everything works with a keyboard, the focus is always visible, and a view that changes in place moves the focus to
  its heading.
- Contrast at least WCAG AA in light and dark. Links inside text are underlined.
- Motion uses the motion tokens and collapses with `prefers-reduced-motion`; `forced-colors` keeps every control
  visible.
- Every icon-only button has an accessible name that says what it acts on ("Edit Harbor Times").

## Responsive behaviour

| Width | Layout |
|---|---|
| Under 600 px | One column, 16 px margins, buttons in sheets stack, tables scroll in their card, the sidebar is tabs |
| 600–899 px | One column, 32 px margins, the sidebar is tabs |
| 900 px and up | Sidebar (240 px) and content, dashboards in two columns |

## Review

Run `pnpm --dir apps/web gallery` to see every page in each of its states against the test suite's fake server (no
server or database needed), in light and dark (`?theme=dark`). Before a portal change is merged, look at the pages it
touches at 390 px and 1280 px in both themes, and check:

- [ ] One primary action per view, and the page's title says what it is for.
- [ ] Nothing loads into a blank page; every request has a spinner, every failure a message.
- [ ] Destructive actions ask, with Cancel focused.
- [ ] Rows say at most three things; nothing is a run-on chain of facts.
- [ ] Text is at least 12 px; contrast holds in both themes.
- [ ] The keyboard reaches everything, in order, with the focus visible.
